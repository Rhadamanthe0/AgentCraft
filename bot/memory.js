'use strict'

// Memoire du planificateur : ce que le modele s ecrit d un tour a l autre pour
// garder ses actions coherentes.
//
// Pourquoi ce module, et pourquoi il est minuscule : la boucle de mission est
// sans etat cote modele. Chaque appel rend un plan et repart de zero. Sans
// memoire, il redecouvre a chaque tour ou il en etait — d ou les boucles
// « explorer puis casser » et les arrets declares trop tot. La memoire est le
// seul fil que le modele tisse lui-meme.
//
// TROIS ESPACES, des plafonds separes (architecture « cache en couches », voir
// docs/context-management.md) :
//   - `travail`    : le fil de la mission en cours, en AJOUT SEUL — chaque note
//                    s ajoute a la fin, donc le prefixe deja en cache chez le
//                    gateway reste valide. Au-dela de WORK_COMPACT_AT jetons,
//                    un compacteur resume le fil sous WORK_COMPACT_TO : la
//                    reecriture paie une invalidation, puis le cache repart
//                    sur le resume.
//   - `pending`    : le tampon des ecritures long terme de la mission en
//                    cours. Tant qu on n a pas commite, rien n ecrit ni
//                    longTerm ni le fichier : la couche long terme ne bouge
//                    donc qu UNE fois par mission (au finish) et reste en
//                    cache le reste du temps. Les notes en attente restent
//                    visibles dans le snapshot sous `a_retenir`, dans la
//                    couche volatile.
//   - `long_terme` : conservee dans MEMORY_FILE, rechargee au demarrage. Pour
//                    ce qui survit aux missions (le monde, les habitudes).
//
// R25 : le transitoire (`travail` + `pending`) est SCOPE PAR OBJECTIF : chaque
// mission a son contexte { work, pending, revision }, `longTerm` (persiste) et
// `generation` restant globaux. Choix explicite : scope = objectiveId (stable
// a la suspension/reprise, y compris apres restart), a defaut l id de mission,
// a defaut 'defaut' (legacy : tests, API sans mission). Changer de scope
// n ecrit ni ne commit jamais : suspendre conserve, demarrer active un autre
// contexte (resetWork ne vide que lui), finir commit le pending du contexte
// actif, reprendre reactive exactement l ancien. Pas de commit force a la
// suspension, pas de singleton partagé effacable par la mission suivante.
//
// R06 : chaque mutation d un contexte incremente sa `revision`. writeWork
// capture la revision avant d attendre le compacteur (async) et abandonne si
// elle a bouge — ou si le scope actif a change : aucun resume obsolete
// n ecrase une note, un reset ou un effacement intervenus pendant l attente.
//
// `generation` s incremente quand `longTerm` change (commit, effacement). C est
// le compteur qui fait reconstruire la couche « memoire long terme » du prompt
// du planificateur uniquement quand elle a vraiment bouge (cle de cache
// `kind|supply|docs.generation|memory.generation`, voir planner.js).
//
// Le compacteur est INJECTE (setCompactor) et jamais importe : ce module ne
// doit rien savoir du transport llm.js, et une memoire pleine doit rester un
// refus propre meme sans modele disponible.
//
// REGLE DE CONCEPTION : la memoire long terme vit dans la couche 3 du prompt
// systeme mis en cache (reconstruit seulement quand `generation` change), et la
// memoire de mission dans la couche 4, recoltee a chaque appel. Le message
// utilisateur ne porte que les compteurs. Une ecriture de travail n'invalide
// donc rien : le fil est en ajout seul, et la compaction ne reecrit qu'une
// fois par seuil franchi.

const fs = require('fs')
const path = require('path')

const FILE = process.env.MEMORY_FILE || path.join(__dirname, 'data', 'memory.json')

// Une variable mal saisie (MEMORY_WORK_TOKENS=abc) donnerait NaN, et tout test
// `total > NaN` serait faux : plus aucun refus, donc le budget saute. On retombe
// donc sur la valeur par defaut des que ce n est pas un nombre positif.
function positiveNumber (value, fallback) {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? num : fallback
}

// Budgets separes par couche. Le plafond d une portee ne se partage pas avec
// l autre : une mission bavarde ne peut plus affamer la memoire longue, et
// inversement.
const LONG_TERM_TOKENS = positiveNumber(process.env.MEMORY_LONG_TERM_TOKENS, 10000)
const WORK_TOKENS = positiveNumber(process.env.MEMORY_WORK_TOKENS, 10000)
// La compaction ne se declenche qu au-dela du seuil, et vise la cible : entre
// les deux, le fil reste en ajout seul et le cache de prefixe vit.
const WORK_COMPACT_AT = positiveNumber(process.env.MEMORY_WORK_COMPACT_AT, 8000)
const WORK_COMPACT_TO = positiveNumber(process.env.MEMORY_WORK_COMPACT_TO, 4000)
// Une note isolee ne peut pas non plus etre enorme : sans cette borne, un seul
// `memoriser` pourrait remplir toute la memoire d un coup.
const NOTE_MAX = positiveNumber(process.env.MEMORY_NOTE_MAX, 4000)
// Estimation conservatrice : un texte francais fait plutot 3 a 3,5 caracteres
// par jeton. Sous-estimer ferait deborder le contexte reel ; surestimer ne fait
// que refuser une ecriture un peu tot. On prend donc la borne basse.
const CHARS_PER_TOKEN = 3.5
// Garde-fou contre un compacteur qui reduirait par trop petites touches : au
// bout de ce nombre de passages sans descendre sous la cible, on refuse.
const MAX_COMPACT_ROUNDS = 5

const SCOPES = ['travail', 'long_terme']

// Ramene une portee ecrite par le modele (casse melangee, espaces) a sa forme
// canonique, ou `fallback`. `clear` ne prend pas de repli : une portee absente
// ne doit jamais valoir « tout » par accident.
function normalizeScope (value, fallback = null) {
  const scope = String(value ?? '').trim().toLowerCase()
  return SCOPES.includes(scope) ? scope : fallback
}

let longTerm = ''
let generation = 0
let compactor = null
let persistError = null
// R25 : contextes transitoires scopes par objectif (voir l en-tete).
const DEFAULT_SCOPE = 'defaut'
const contexts = new Map() // scope -> { work, pending, revision }
let activeScope = DEFAULT_SCOPE

function normalizeScopeId (value) {
  const id = String(value ?? '').trim()
  return id ? id : DEFAULT_SCOPE
}

function contextFor (scope) {
  let ctx = contexts.get(scope)
  if (!ctx) {
    ctx = { work: '', pending: '', revision: 0 }
    contexts.set(scope, ctx)
  }
  return ctx
}

function activeContext () {
  return contextFor(activeScope)
}
// R24 : fichier illisible ou schema invalide -> memoire fige en lecture seule.
// `corrupted` bloque commit/clear persistants tant qu une reparation explicite
// (repairCorrupted, avec backup .corrupt-<timestamp>) n a pas eu lieu. Le
// fichier est toujours preserve : load ne reecrit jamais, commit/clear
// n ecrivent qu APRES une ecriture atomique reussie (R07).
let corrupted = false
let corruptError = null
let tmpCounter = 0

function isPlainObject (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

// Estimation grossiere mais volontairement conservatrice (voir CHARS_PER_TOKEN).
// On ne veut pas d un tokenizer : le but est d empecher un depassement du
// contexte, pas de facturer au jeton pres.
function estimateTokens (text) {
  const value = String(text ?? '')
  return value.length === 0 ? 0 : Math.ceil(value.length / CHARS_PER_TOKEN)
}

// Ce que le modele recoit a chaque tour : ses deux memoires, le tampon long
// terme en attente, les plafonds et ce qui reste par portee. Sans les jetons
// restants, il ne saurait pas quand s arreter avant de se faire refuser.
function snapshot () {
  // R25 : lit le contexte ACTIF (travail + pending de la mission courante),
  // le long terme restant global. `contexte` est additif.
  const ctx = activeContext()
  const travail = estimateTokens(ctx.work)
  const longTerme = estimateTokens(longTerm)
  const aRetenir = estimateTokens(ctx.pending)
  const used = travail + longTerme + aRetenir
  // Champs historiques, gardes pour /api/memory, /api/status et l interface
  // web, qui consomment les totaux et non les champs par portee ci-dessus.
  const totalMax = LONG_TERM_TOKENS + WORK_TOKENS

  return {
    travail: ctx.work || null,
    long_terme: longTerm || null,
    a_retenir: ctx.pending || null,
    jetons: { travail, long_terme: longTerme, a_retenir: aRetenir },
    plafonds: {
      travail: WORK_TOKENS,
      long_terme: LONG_TERM_TOKENS,
      compaction: { seuil: WORK_COMPACT_AT, cible: WORK_COMPACT_TO }
    },
    restants: {
      travail: Math.max(0, WORK_TOKENS - travail),
      // Le tampon compte dans le plafond long terme : c est lui qu on finira
      // par commiter, pas la peine de laisser croire la place libre.
      long_terme: Math.max(0, LONG_TERM_TOKENS - longTerme - aRetenir)
    },
    generation,
    // R25 : scope du contexte lu (additif : les consommateurs historiques
    // ignorent cette cle, comme corrompue/erreurCorruption/erreurEcriture).
    contexte: activeScope,
    // R24 : etat de corruption expose (lecture seule, fichier preserve). Additif :
    // les consommateurs historiques ignorent ces cles.
    corrompue: corrupted,
    erreurCorruption: corruptError,
    erreurEcriture: persistError,
    // Champs historiques, gardes pour /api/memory, /api/status et l interface
    // web (voir le commentaire au-dessus de totalMax).
    jetons_utilises: used,
    jetons_max: totalMax,
    jetons_restants: Math.max(0, totalMax - used)
  }
}

// R24 : etat compact pour GET /api/memory/status (voir bot/api.js).
function status () {
  return {
    fichier: FILE,
    corrompue: corrupted,
    erreur: corruptError,
    erreurEcriture: persistError,
    generation,
    // R25 : scope actif (additif).
    contexte: activeScope
  }
}

// ---------------------------------------------------------------------------
// Persistance : seule la portee long terme est ecrite sur disque, et UNIQUEMENT
// au commit — jamais pendant la mission.
// ---------------------------------------------------------------------------

function load () {
  // R24 : ENOENT = memoire vide silencieuse OK. Tout autre echec (lecture,
  // JSON illisible, schema invalide) fige en lecture seule et preserve le
  // fichier : jamais de reinit silencieuse qui serait ecrasee au commit.
  // R25 : le transitoire est vierge au chargement (demarrage) : tous les
  // contextes sont oublies, le scope actif retombe sur le defaut.
  contexts.clear()
  activeScope = DEFAULT_SCOPE
  try {
    if (!fs.existsSync(FILE)) {
      longTerm = ''
      corrupted = false
      corruptError = null
      return
    }
  } catch (_) { /* existsSync a echoue : on tente la lecture, qui tranchera */ }
  let text
  try {
    text = fs.readFileSync(FILE, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      longTerm = ''
      corrupted = false
      corruptError = null
      return
    }
    corrupted = true
    corruptError = `lecture impossible (${err.message}) : fichier preserve, reparation explicite requise`
    longTerm = ''
    console.error(`[memoire] ${corruptError}`)
    return
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (err) {
    corrupted = true
    corruptError = `JSON illisible (${err.message}) : fichier preserve, reparation explicite requise`
    longTerm = ''
    console.error(`[memoire] ${corruptError}`)
    return
  }
  if (!isPlainObject(raw) || (raw.long_terme !== undefined && typeof raw.long_terme !== 'string')) {
    corrupted = true
    corruptError = 'schema invalide (objet { long_terme: string } attendu) : fichier preserve, reparation explicite requise'
    longTerm = ''
    console.error(`[memoire] ${corruptError}`)
    return
  }
  longTerm = raw.long_terme || ''
  corrupted = false
  corruptError = null
  if (longTerm) {
    const tokens = estimateTokens(longTerm)
    console.log(`[memoire] ${tokens} jeton(s) recharge(s) depuis ${FILE}`)
    // Si le plafond a ete baisse entre deux demarrages, on peut repartir
    // au-dessus : on le signale plutot que de tronquer en silence.
    if (tokens > LONG_TERM_TOKENS) {
      console.warn(`[memoire] la memoire longue (${tokens}) depasse le plafond (${LONG_TERM_TOKENS}) : oublier avant d ecrire`)
    }
  }
}

// R07 : ecriture atomique crash-safe (meme contrat que state-store). Le
// fichier cible n est remplace que par le rename final : tant qu il n a pas eu
// lieu, l ancienne donnee reste intacte. Contrairement a l ancien save(), un
// echec se propage a l appelant (throw) au lieu d etre masque : commit/clear
// traduisent en { ok: false } SANS muter l etat (voir ci-dessous).
// Garantie annoncee : contrat observable (pas de ok:true mensonger, tampon
// conserve, ancien fichier valide), pas de durabilite materielle absolue.
function persistAtomically (nextLongTerm) {
  const text = JSON.stringify({ long_terme: nextLongTerm }, null, 2)
  const dir = path.dirname(FILE)
  fs.mkdirSync(dir, { recursive: true })
  const base = path.basename(FILE)
  tmpCounter += 1
  const workDir = (dir === '.' || dir === '') ? process.cwd() : dir
  const tmp = path.join(workDir,
    `.${base}.tmp-${process.pid}-${Date.now().toString(36)}-${tmpCounter.toString(36)}`)
  let fd = null
  try {
    fd = fs.openSync(tmp, 'w', 0o600)
    fs.writeFileSync(fd, text, 'utf8')
    // R07 : le fsync fichier est significatif : une erreur injectee ici doit
    // refuser le commit (pas de best-effort silencieux).
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    try { fs.chmodSync(tmp, 0o600) } catch (_) { /* Windows : droits non POSIX, ignore */ }
    fs.renameSync(tmp, FILE)
    // Fsync du repertoire : best-effort (indisponible sous Windows). Un echec
    // ici ne remet pas en cause le rename deja effectue.
    try {
      const dfd = fs.openSync(workDir, 'r')
      try { fs.fsyncSync(dfd) } catch (_) { /* ignore */ }
      fs.closeSync(dfd)
    } catch (_) { /* ignore */ }
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd) } catch (_) { /* ignore */ } }
    try { fs.unlinkSync(tmp) } catch (_) { /* ignore */ }
    throw err
  }
}

// Reparation explicite R24 : sauvegarde le fichier corrompu en
// `<fichier>.corrupt-<timestamp>` (option backup, defaut vrai) puis reinit une
// memoire vide. Le tampon `pending` ecrit APRES le load corrompu est conserve
// (recuperable au prochain commit) ; seul le long terme illisible est abandonne
// dans le backup. Incremente generation pour invalider le cache du prompt.
function repairCorrupted (opts = {}) {
  const backup = opts.backup !== false
  if (!corrupted) return { ok: true, backup: null, snapshot: snapshot() }
  let backupPath = null
  try {
    if (backup) {
      let exists = false
      try { exists = fs.existsSync(FILE) } catch (_) { exists = true }
      if (exists) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        backupPath = `${FILE}.corrupt-${stamp}`
        fs.renameSync(FILE, backupPath)
      }
    } else {
      try { fs.unlinkSync(FILE) } catch (err) {
        if (!err || err.code !== 'ENOENT') throw err
      }
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }
  longTerm = ''
    corrupted = false
    corruptError = null
    persistError = null
    generation += 1
    return { ok: true, backup: backupPath, snapshot: snapshot() }
  }

// ---------------------------------------------------------------------------
// Ecriture
// ---------------------------------------------------------------------------

// Deux formes acceptees : write('travail', 'note') et la forme historique
// write({ texte, portee }) encore passee par mission.js. Le resultat est une
// promesse des que la compaction peut se declencher (le compacteur est async) :
// les appelants await — mission.js le fait.
async function write (scopeOrNote, noteArg) {
  let scope
  let note
  if (scopeOrNote !== null && typeof scopeOrNote === 'object') {
    scope = normalizeScope(scopeOrNote.portee, 'travail')
    note = String(scopeOrNote.texte ?? '')
  } else {
    scope = normalizeScope(scopeOrNote, 'travail')
    note = String(noteArg ?? '')
  }
  note = note.trim()
  if (!note) return { ok: false, error: 'note vide' }
  if (note.length > NOTE_MAX) {
    return { ok: false, error: `note trop longue (${note.length} caracteres, ${NOTE_MAX} au maximum)` }
  }

  return scope === 'long_terme' ? writePending(note) : writeWork(note)
}

// Long terme : on n ecrit JAMAIS ici ni longTerm ni le fichier. La note va
// dans le tampon `pending`, exposee au modele sous `a_retenir`, et ne
// rejoindra la couche persistante qu au commitLongTerm() de fin de mission.
// Le plafond se compte des maintenant sur longTerm + pending : c est l etat
// final du commit qu on borne, pas une etape intermediaire.
function writePending (note) {
  // R25 : tampon du contexte ACTIF uniquement. R06 : toute ecriture reussie
  // incremente la revision (invalide les compactions en vol du contexte).
  const ctx = activeContext()
  const previous = ctx.pending
  const next = previous ? `${previous}\n${note}` : note
  const longTermTokens = estimateTokens(longTerm)
  const total = longTermTokens + estimateTokens(next)

  if (total > LONG_TERM_TOKENS) {
    const restant = Math.max(0, LONG_TERM_TOKENS - longTermTokens - estimateTokens(previous))
    return {
      ok: false,
      error: 'memoire long terme pleine : ' +
        `l ecriture porterait a ${total} jetons sur ${LONG_TERM_TOKENS} ` +
        '(note en attente de commit incluse). ' +
        `Il reste ${restant} jeton(s) pour cette portee : oublier ou resumer avant d ecrire.`
    }
  }

  ctx.pending = next
  ctx.revision += 1
  return { ok: true, portee: 'long_terme', jetons: total, en_attente: true, snapshot: snapshot() }
}

// Travail : ajout seul tant qu on reste sous le seuil de compaction. Au-dela,
// le compacteur (injecte) reecrit le fil en resume : une invalidation de cache
// payee une fois, puis le prefixe repart du resume. Sans compacteur, on refuse
// plutot que de laisser le fil grossir sans borne.
async function writeWork (note) {
  // R25 : fil du contexte ACTIF uniquement. R06 : la revision est capturee
  // avant chaque attente du compacteur (voir ci-dessous).
  const scope = activeScope
  const ctx = activeContext()
  const previous = ctx.work
  const next = previous ? `${previous}\n${note}` : note
  const nextTokens = estimateTokens(next)

  if (nextTokens > WORK_TOKENS) {
    const restant = Math.max(0, WORK_TOKENS - estimateTokens(previous))
    return {
      ok: false,
      error: 'memoire de travail pleine : ' +
        `l ecriture porterait a ${nextTokens} jetons sur ${WORK_TOKENS}. ` +
        `Il reste ${restant} jeton(s) pour cette portee : oublier ou resumer avant d ecrire.`
    }
  }

  if (nextTokens > WORK_COMPACT_AT) {
    if (typeof compactor !== 'function') {
      return {
        ok: false,
        error: 'memoire de travail pleine : ' +
          `le fil atteindrait ${nextTokens} jetons (seuil de compaction ${WORK_COMPACT_AT}) ` +
          'et aucun compacteur n est enregistre. Oublier ou resumer avant d ecrire.'
      }
    }

    // R06 : capture avant l attente. Apres chaque retour du compacteur, si
    // la revision du contexte a bouge (note, reset, effacement intervenus
    // pendant l attente) ou si le scope actif a change (mission suivante),
    // on ABANDONNE sans rien ecrire : aucun resume obsolete ne doit ecraser
    // le nouvel etat. L appelant reessaie explicitement s il le faut. Les
    // refus ci-dessous ne mutent rien (pas d increment de revision).
    const capturedRevision = ctx.revision
    let current = next
    let rounds = 0
    while (estimateTokens(current) > WORK_COMPACT_TO) {
      if (++rounds > MAX_COMPACT_ROUNDS) {
        return {
          ok: false,
          error: 'compaction impossible : le resume reste au-dessus de la cible ' +
            `(${WORK_COMPACT_TO} jetons) apres ${MAX_COMPACT_ROUNDS} passage(s). Oublier avant d ecrire.`
        }
      }
      const before = current
      let summary = ''
      try {
        summary = String((await compactor(before)) ?? '').trim()
      } catch (err) {
        return {
          ok: false,
          error: `compaction impossible : le compacteur a echoue (${err.message}). Oublier avant d ecrire.`
        }
      }
      // Fenetre de concurrence : le compacteur a rendu pendant que le contexte
      // pouvait changer. Verification APRES chaque await, avant tout usage.
      if (activeScope !== scope || ctx.revision !== capturedRevision) {
        return {
          ok: false,
          conflit: true,
          error: 'conflit de concurrence : la memoire a change pendant la compaction, ecriture abandonnee sans rien ecraser (reessayer)'
        }
      }
      // Un resume qui n est pas plus court bouclerait sans fin : on refuse et
      // on ne touche pas au fil, qui reste dans son etat d avant l ecriture.
      if (!summary || estimateTokens(summary) >= estimateTokens(before)) {
        return {
          ok: false,
          error: 'compaction impossible : le compacteur n a rien rendu de plus court. Oublier avant d ecrire.'
        }
      }
      current = summary
    }

    // Publication synchrone apres la derniere verification : aucune attente
    // ne s intercale, le resume est donc frais pour ce contexte.
    if (activeScope !== scope || ctx.revision !== capturedRevision) {
      return {
        ok: false,
        conflit: true,
        error: 'conflit de concurrence : la memoire a change pendant la compaction, ecriture abandonnee sans rien ecraser (reessayer)'
      }
    }
    ctx.work = current
    ctx.revision += 1
    return { ok: true, portee: 'travail', jetons: estimateTokens(ctx.work), compacte: true, snapshot: snapshot() }
  }

  ctx.work = next
  ctx.revision += 1
  return { ok: true, portee: 'travail', jetons: nextTokens, snapshot: snapshot() }
}

// Fin de mission : UNE seule ecriture de la couche long terme par mission.
// R07 : construit le prochain etat SANS muter, persiste en atomique, puis
// seulement publie (longTerm), vide le tampon et incremente `generation`.
// Sur echec : tampon conserve (recuperable), generation inchangee,
// { ok: false, error }. R24 : refuse en etat corrompu (lecture seule).
// R25 : committe le tampon du contexte ACTIF dans le long terme global.
// Sans note en attente, rien ne change : pas d ecriture, pas d increment.
function commitLongTerm () {
  if (corrupted) {
    return { ok: false, error: `memoire corrompue (${corruptError || 'fichier preserve'}) : reparation explicite requise avant tout commit` }
  }
  const ctx = activeContext()
  if (!ctx.pending) {
    return { ok: true, jetons: estimateTokens(longTerm) }
  }
  const next = longTerm ? `${longTerm}\n${ctx.pending}` : ctx.pending
  const jetons = estimateTokens(next)
  try {
    persistAtomically(next)
  } catch (err) {
    persistError = err.message
    console.error(`[memoire] ecriture impossible dans ${FILE} : ${err.message}`)
    return { ok: false, error: err.message }
  }
  longTerm = next
  ctx.pending = ''
  // R06 : le tampon a mute : les compactions en vol de ce contexte sont
  // invalidees (elles reessaieront sur l etat frais).
  ctx.revision += 1
  persistError = null
  generation += 1
  return { ok: true, jetons }
}

// Enregistre le compacteur async fn(texte) -> resume. Injecte, jamais importe :
// ce module ne depend pas de llm.js. Repasser une valeur non-fonction le
// desactive (et les ecritures au-dela du seuil redeviennent des refus).
function setCompactor (fn) {
  compactor = typeof fn === 'function' ? fn : null
}

// Une portee absente ou invalide est REFUSEE, jamais interpretee comme « tout » :
// sinon un `oublier` du modele auquel le parametre a echappe effacerait la
// memoire longue, qui est persistante. « tout » doit etre demande explicitement.
function clear (portee) {
  const scope = String(portee ?? '').trim().toLowerCase()
  // R25 : les portees volatiles (`travail`, tampon de `long_terme`/`tout`)
  // sont celles du contexte ACTIF ; le long terme persiste reste global.
  // R06 : tout effacement reussi incremente la revision du contexte actif
  // (invalide les compactions en vol). Echec R07 : sans mutation, sans bump.
  const ctx = activeContext()

  if (scope === 'tout') {
    // R07+R24 : meme contrat que commit (atomique puis publication, echec sans
    // mutation). En etat corrompu : refus lecture seule, fichier preserve.
    if (corrupted) {
      return { ok: false, error: `memoire corrompue (${corruptError || 'fichier preserve'}) : reparation explicite requise avant tout effacement` }
    }
    const hadLong = Boolean(longTerm)
    try {
      persistAtomically('')
    } catch (err) {
      persistError = err.message
      console.error(`[memoire] ecriture impossible dans ${FILE} : ${err.message}`)
      return { ok: false, error: err.message }
    }
    ctx.work = ''
    ctx.pending = ''
    ctx.revision += 1
    longTerm = ''
    persistError = null
    if (hadLong) generation += 1
    return { ok: true, portee: 'tout', snapshot: snapshot() }
  }
  if (!SCOPES.includes(scope)) {
    return {
      ok: false,
      error: `portee invalide : "${scope || '(vide)'}" (attendu travail, long_terme ou tout)`
    }
  }

  if (scope === 'long_terme') {
    // Effacer le long terme efface aussi ce qui attendait le commit : sinon
    // une note « oubliee » reapparaitrait au prochain commitLongTerm().
    if (corrupted) {
      return { ok: false, error: `memoire corrompue (${corruptError || 'fichier preserve'}) : reparation explicite requise avant tout effacement` }
    }
    const hadLong = Boolean(longTerm)
    try {
      persistAtomically('')
    } catch (err) {
      persistError = err.message
      console.error(`[memoire] ecriture impossible dans ${FILE} : ${err.message}`)
      return { ok: false, error: err.message }
    }
    longTerm = ''
    ctx.pending = ''
    ctx.revision += 1
    persistError = null
    if (hadLong) generation += 1
  } else {
    // R24 : lecture seule stricte — meme le volatile est refuse tant que la
    // reparation explicite n a pas eu lieu (resetWork reste le seul vidage
    // de debut de mission, sans ecriture fichier).
    if (corrupted) {
      return { ok: false, error: `memoire corrompue (${corruptError || 'fichier preserve'}) : reparation explicite requise avant tout effacement` }
    }
    ctx.work = ''
    ctx.revision += 1
  }
  return { ok: true, portee: scope, snapshot: snapshot() }
}

// Debut de mission : on vide le fil de travail ET le tampon long terme DU
// CONTEXTE ACTIF — des notes jamais commitees n ont pas a survivre a leur
// mission. R25 : les autres contextes (missions suspendues) sont intacts, la
// memoire longue deja commitee survit. R06 : incremente la revision (les
// compactions en vol de ce contexte s abandonneront au lieu d ecraser).
function resetWork () {
  const ctx = activeContext()
  ctx.work = ''
  ctx.pending = ''
  ctx.revision += 1
}

// R25 : activation explicite du contexte transitoire d une mission/objectif.
// Cree le contexte s il n existe pas, le rend actif, ne touche ni aux autres
// contextes ni au long terme, ne committe jamais. Retourne la cle normalisee
// (a conserver par l appelant pour la reprise : voir mission.js
// suspend/resumeSuspended). Valeur vide/absente = contexte legacy 'defaut'.
function setActiveScope (id) {
  activeScope = normalizeScopeId(id)
  contextFor(activeScope)
  return activeScope
}

function getActiveScope () {
  return activeScope
}

module.exports = {
  load,
  write,
  clear,
  resetWork,
  commitLongTerm,
  setCompactor,
  setActiveScope,
  getActiveScope,
  DEFAULT_SCOPE,
  snapshot,
  status,
  repairCorrupted,
  recoverCorrupted: repairCorrupted,
  estimateTokens,
  SCOPES,
  FILE,
  LONG_TERM_TOKENS,
  WORK_TOKENS,
  WORK_COMPACT_AT,
  WORK_COMPACT_TO,
  NOTE_MAX,
  get generation () { return generation },
  get persistError () { return persistError },
  get corrupted () { return corrupted },
  get corruptError () { return corruptError },
  // Compat : getter historique (total des deux plafonds). Plus consomme par
  // mission.js, qui lit les plafonds par portee du snapshot ; garde pour
  // d'eventuels appelants externes.
  get MAX_TOKENS () { return LONG_TERM_TOKENS + WORK_TOKENS }
}
