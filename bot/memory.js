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

let work = ''
let pending = ''
let longTerm = ''
let generation = 0
let compactor = null
let persistError = null

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
  const travail = estimateTokens(work)
  const longTerme = estimateTokens(longTerm)
  const aRetenir = estimateTokens(pending)
  const used = travail + longTerme + aRetenir
  // Champs historiques, gardes pour /api/memory, /api/status et l interface
  // web, qui consomment les totaux et non les champs par portee ci-dessus.
  const totalMax = LONG_TERM_TOKENS + WORK_TOKENS

  return {
    travail: work || null,
    long_terme: longTerm || null,
    a_retenir: pending || null,
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
    // Champs historiques, gardes pour /api/memory, /api/status et l interface
    // web (voir le commentaire au-dessus de totalMax).
    jetons_utilises: used,
    jetons_max: totalMax,
    jetons_restants: Math.max(0, totalMax - used)
  }
}

// ---------------------------------------------------------------------------
// Persistance : seule la portee long terme est ecrite sur disque, et UNIQUEMENT
// au commit — jamais pendant la mission.
// ---------------------------------------------------------------------------

function load () {
  try {
    if (!fs.existsSync(FILE)) return
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    longTerm = typeof raw?.long_terme === 'string' ? raw.long_terme : ''
    if (longTerm) {
      const tokens = estimateTokens(longTerm)
      console.log(`[memoire] ${tokens} jeton(s) recharge(s) depuis ${FILE}`)
      // Si le plafond a ete baisse entre deux demarrages, on peut repartir
      // au-dessus : on le signale plutot que de tronquer en silence.
      if (tokens > LONG_TERM_TOKENS) {
        console.warn(`[memoire] la memoire longue (${tokens}) depasse le plafond (${LONG_TERM_TOKENS}) : oublier avant d ecrire`)
      }
    }
  } catch (err) {
    console.error(`[memoire] lecture impossible (${err.message}) : on repart d une memoire vide`)
  }
}

// Une ecriture ratee ne doit pas casser une mission : la memoire reste en RAM
// pour la session en cours et on le signale.
function save () {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify({ long_terme: longTerm }, null, 2))
    persistError = null
  } catch (err) {
    persistError = err.message
    console.error(`[memoire] ecriture impossible dans ${FILE} : ${err.message}`)
  }
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
  const previous = pending
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

  pending = next
  return { ok: true, portee: 'long_terme', jetons: total, en_attente: true, snapshot: snapshot() }
}

// Travail : ajout seul tant qu on reste sous le seuil de compaction. Au-dela,
// le compacteur (injecte) reecrit le fil en resume : une invalidation de cache
// payee une fois, puis le prefixe repart du resume. Sans compacteur, on refuse
// plutot que de laisser le fil grossir sans borne.
async function writeWork (note) {
  const previous = work
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

    work = current
    return { ok: true, portee: 'travail', jetons: estimateTokens(work), compacte: true, snapshot: snapshot() }
  }

  work = next
  return { ok: true, portee: 'travail', jetons: nextTokens, snapshot: snapshot() }
}

// Fin de mission : UNE seule ecriture de la couche long terme par mission.
// Fusionne le tampon, persiste, vide le tampon, et incremente `generation` —
// la cle qui dira au planificateur de reconstruire la couche « memoire long
// terme » de son prompt. Sans note en attente, rien ne change : pas de save,
// pas d increment, donc pas d invalidation de cache.
function commitLongTerm () {
  if (!pending) {
    return { ok: true, jetons: estimateTokens(longTerm) }
  }
  longTerm = longTerm ? `${longTerm}\n${pending}` : pending
  const jetons = estimateTokens(longTerm)
  pending = ''
  save()
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

  if (scope === 'tout') {
    work = ''
    pending = ''
    if (longTerm) generation += 1
    longTerm = ''
    save()
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
    if (longTerm) generation += 1
    longTerm = ''
    pending = ''
    save()
  } else {
    work = ''
  }
  return { ok: true, portee: scope, snapshot: snapshot() }
}

// Debut de mission : on vide le fil de travail ET le tampon long terme — des
// notes jamais commitees n ont pas a survivre a leur mission. La memoire longue
// deja commitee, elle, survit.
function resetWork () {
  work = ''
  pending = ''
}

module.exports = {
  load,
  write,
  clear,
  resetWork,
  commitLongTerm,
  setCompactor,
  snapshot,
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
  // Compat : getter historique (total des deux plafonds). Plus consomme par
  // mission.js, qui lit les plafonds par portee du snapshot ; garde pour
  // d'eventuels appelants externes.
  get MAX_TOKENS () { return LONG_TERM_TOKENS + WORK_TOKENS }
}
