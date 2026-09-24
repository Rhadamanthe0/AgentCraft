'use strict'

// Atelier de deblocage C0 / D04 / D06 / D10 / D15 / D19 / D25-D27 / D31 / D51.
//
// Module AUTONOME a backend injecte, NON DEPLOYE tant que l'isolation OS et le
// pont (bridge) de production restent des questions non tranchees : lifecycle
// testable hors prod uniquement, pas un sandbox. Ne pas brancher a un bot en
// production, ne pas pretendre qu'une installation ou une execution isolee est
// satisfaite quand les adapters correspondants sont absents.
//
// Cible lue : ARCHITECTURE.md (C0, D04/D06/D10/D15/D19/D25-D27/D31/D51).
// Reutilise les contrats EXISTANTS, sans les redefinir :
//   - transport Go : `bot/llm.js` (`llm.call`, Muse via /responses) passe par
//     l'adapter injecte `callGo(system, user, { signal }) -> { content }` ;
//   - escalade Astra : `bot/opencode-client.js` (`createOpenCodeClient().call`)
//     passe par l'adapter injecte optionnel `callAstra` de meme forme ;
//   - versions : `supervisor/candidate-store.js`
//     (`prepare({ baseVersion?, changes, reason, version? })`, `verify(version)`,
//     `getDescriptor(version)`) passe par `candidateStore` injecte ;
//   - activation : `supervisor/core.js`
//     (`activate(version)`, `confirmTrial(version, proof)`, `rollback(reason)`)
//     passe par `supervisor` injecte (callbacks validate trusted du host).
//
// Hypothese d'autorite documentee, NON revendiquee par ce service : le scope
// et la protection des outils (`tools.readFile`, `tools.fetchDocumentation`)
// sont supposees cote host (injection) ; ce service transmet les refus host
// (`outside-scope`, `protected`, ...) sans pretendre filtrer lui-meme. De meme,
// les `checks` d'un descripteur sont reverifies par le noyau trusted
// (`validateCandidate` disque + `checkQuiescent` + `validateTrial`), jamais crus
// sur parole ici : ce service n'exige que leur forme et laisse le core trancher.
//
// Ce que le service fait :
//   - pause du travail (callback host, survie hors contrat ; bail `release`
//     conditionnel si `pauseWork` rend un bail, et AUCUNE reprise si
//     `getStopState()` signale un stop, si l'etat d'arret est ILLISIBLE
//     (exception/forme/timeout => unknown), si le noyau tient un etat
//     uncertain/failed-both/activating/rolling-back (ou status illisible),
//     ou si le job est verrouille uncertain (compensation en echec).
//     Sans ces sondes : mode legacy/test pur ; en prod elles sont requises.
//     Objectif INTACT a chaque tour, doctrine (version + TEXTE) fournie a
//     CHAQUE appel y compris l'escalade, sortie JSON bornee d'operations
//     lisibles, jamais executee ;
//   - acces code/Internet UNIQUEMENT via les outils injectes : aucun fallback fs
//     libre, aucun shell, aucune installation dans ce worker (un changement de
//     dependances exige `buildIsolated`, sinon refus `deps-unsupported`) ;
//   - patch : prepare/check -> EXIGENCE descripteur (pending-trial, digest
//     SHA256 64 hex, doctrine liee au prompt, checks non vides) -> activate
//     (TRIAL) -> trialRunner (mesures reelles) -> preuve noyau
//     `{ essai:'reel-observe', version, jobId, nonce, doctrineVersion,
//     measurements }` (decision du host, jamais un bool LLM recopie) ->
//     confirmTrial SSI acceptation trusted ET retain vrai ; retain faux =
//     temporaire (pas de lastGood, cleanup VERIFIE sinon failed/uncertain) ;
//     echec = rollback SANS annuler les faits du monde (re-observer) ;
//   - compensation garantie : apres TOUT activate commis, un `finally` rollback
//     meme sur annulation (abort pendant activate lent ou trialRunner sourd au
//     signal => `cancelled` MAIS trial compense, jamais orphelin) ; fenetre
//     d'annulation explicite avant chaque confirm (jamais de promotion tardive) ;
//   - un seul job a la fois, budget maxRounds en filet, progres determine par
//     des preuves mesurees (pas par du texte LLM) ; stagnation ou impasse Go
//     declaree => UNE escalade Astra (jamais pilote), sinon attente honnete ;
//   - erreurs `announce`/`record`/`resumeWork`/`getStopState` ignorees et
//     resumees en traces `*-unknown`, jamais corruptives ;
//   - propositions de doctrine ENREGISTREES, jamais appliquees.
//
// Ce que le service NE fait PAS (limites explicites, voir LIMITS) :
//   - aucune isolation OS de production, aucun pont prod prouve ;
//   - aucune installation de dependances ni execution isolee sans adapter ;
//   - aucun reset du monde, aucune administration de stack, aucune mutation de
//     la doctrine ou du noyau de secours.

const nodeCrypto = require('node:crypto')

const OPS = Object.freeze([
  'read_file',
  'fetch_document',
  'propose_patch',
  'explain',
  'propose_doctrine',
  'escalate'
])

const LIMITS = 'module atelier autonome non deplooye : isolation OS de production ' +
  'non tranchee et pont prod non prouve ; aucune installation de dependances ni ' +
  'execution isolee sans adapter buildIsolated ; statut pending-trial jusqu a ' +
  'preuve jeu mesuree (trialRunner) + confirmTrial trusted ; rollback code ne ' +
  'restaure pas l etat du monde (re-observer) ; doctrine proposee jamais appliquee ; ' +
  'autorite des outils (scope/protection) supposee host par injection, documentee ici et non revendiquee.'

const DEFAULTS = Object.freeze({
  maxRounds: 6,
  stagnationRepeats: 3,
  contentMaxChars: 8000,
  opsMaxPerRound: 6,
  traceMaxEvents: 80,
  traceDetailChars: 500,
  stopStateTimeoutMs: 2000
})

const VERSION_RE = /^[A-Za-z0-9._-]{1,64}$/
const DIGEST_RE = /^[0-9a-fA-F]{64}$/
const PROOF_MARK = 'reel-observe'

function refusal (code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

function isPlainObject (value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// Redaction avant toute trace/annonce. Motifs cle=valeur insensibles a la
// casse : un fait contenant ces mots SANS separateur cle/valeur (`:` ou `=`)
// n'est jamais expurge (pas de redaction par mot isole ni par octet).
// Valeurs brutes connues (porteurs opencode-go/sk-*, Bearer) : redigees.
const SECRET_RES = [
  /opencode-go-[A-Za-z0-9._~-]{4,}/g,
  /sk-[A-Za-z0-9._~-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._~+/-]{4,}=*/g,
  /(password|passwd|api[_-]?key|secret|token)\s*[:=]\s*['"]?\S+['"]?/gi,
  /opencode_[a-z0-9_]*key[a-z0-9_]*\s*[:=]\s*['"]?\S+['"]?/gi,
  /opencode_[a-z0-9_]+\s*[:=]\s*['"]?\S+['"]?/gi
]

function redactSecrets (text) {
  let out = String(text ?? '')
  for (const re of SECRET_RES) {
    re.lastIndex = 0
    out = out.replace(re, '[redacted]')
  }
  return out
}

function boundText (text, max) {
  const s = String(text ?? '')
  return s.length > max ? s.slice(0, max) : s
}

// Lecture JSON stricte, sans execution : jamais eval/Function/require sur le
// contenu du modele. Tolere une phrase autour comme llm.parseJson, sans plus.
// Les champs inconnus du plan sont ignores, jamais transmis (pas de recopie
// aveugle vers confirmTrial : la preuve noyau est construite ici).
function parseModelJson (content) {
  const raw = String(content ?? '').trim()
  if (!raw) throw refusal('schema-unknown', 'reponse modele vide (pas de JSON)')
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch (_) {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start === -1 || end <= start) throw refusal('schema-unknown', 'reponse illisible (pas de JSON)')
    try {
      return JSON.parse(cleaned.slice(start, end + 1))
    } catch {
      throw refusal('schema-unknown', 'reponse illisible (JSON invalide)')
    }
  }
}

function assertChangesShape (changes) {
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > 300) {
    throw refusal('schema-unknown', 'propose_patch.changes tableau non vide requis')
  }
  for (const change of changes) {
    if (!isPlainObject(change) || typeof change.path !== 'string' || change.path === '') {
      throw refusal('schema-unknown', 'propose_patch.change exige { path, content } ou { path, delete: true }')
    }
    if (change.delete === true) {
      if ('content' in change && change.content != null) {
        throw refusal('schema-unknown', 'propose_patch.delete et content exclusifs')
      }
    } else if (typeof change.content !== 'string') {
      throw refusal('schema-unknown', 'propose_patch.content texte requis')
    }
  }
}

// Sortie JSON bornee, operations lisibles uniquement. `retain` est EXIGE sur
// chaque propose_patch (choix de conservation explicite du debloqueur, D19).
// Tout op inconnu ou champ manquant => `schema-unknown` (refus, pas d'exec).
function validateUnlockJson (raw, opsMax) {
  if (!isPlainObject(raw)) throw refusal('schema-unknown', 'plan objet JSON requis')
  const ops = raw.ops
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > opsMax) {
    throw refusal('schema-unknown', `ops tableau borne requis (1..${opsMax})`)
  }
  const checked = []
  for (const op of ops) {
    if (!isPlainObject(op) || typeof op.op !== 'string') {
      throw refusal('schema-unknown', 'operation { op, ... } requise')
    }
    if (!OPS.includes(op.op)) throw refusal('schema-unknown', `operation inconnue : ${op.op}`)
    if (op.op === 'read_file') {
      if (typeof op.path !== 'string' || op.path === '' || op.path.length > 256) {
        throw refusal('schema-unknown', 'read_file.path texte requis (1..256)')
      }
      checked.push({ op: 'read_file', path: op.path })
    } else if (op.op === 'fetch_document') {
      if (typeof op.ref !== 'string' || op.ref === '' || op.ref.length > 512) {
        throw refusal('schema-unknown', 'fetch_document.ref texte requis (1..512)')
      }
      checked.push({ op: 'fetch_document', ref: op.ref })
    } else if (op.op === 'propose_patch') {
      if (typeof op.reason !== 'string' || op.reason.trim() === '') {
        throw refusal('schema-unknown', 'propose_patch.reason motif requis')
      }
      if (typeof op.retain !== 'boolean') {
        throw refusal('schema-unknown', 'propose_patch.retain booleen explicite requis (D19)')
      }
      assertChangesShape(op.changes)
      checked.push({ op: 'propose_patch', changes: op.changes, reason: op.reason, retain: op.retain })
    } else if (op.op === 'explain') {
      if (typeof op.text !== 'string' || op.text.trim() === '') {
        throw refusal('schema-unknown', 'explain.text requis')
      }
      checked.push({ op: 'explain', text: op.text.slice(0, 2000) })
    } else if (op.op === 'propose_doctrine') {
      if (typeof op.text !== 'string' || op.text.trim() === '') {
        throw refusal('schema-unknown', 'propose_doctrine.text requis')
      }
      checked.push({ op: 'propose_doctrine', text: op.text.slice(0, 4000) })
    } else if (op.op === 'escalate') {
      if (typeof op.reason !== 'string' || op.reason.trim() === '') {
        throw refusal('schema-unknown', 'escalate.reason requis')
      }
      checked.push({ op: 'escalate', reason: op.reason.slice(0, 1000) })
    }
  }
  let impasse = null
  if (raw.impasse != null) {
    if (!isPlainObject(raw.impasse) || typeof raw.impasse.reason !== 'string' || raw.impasse.reason.trim() === '') {
      throw refusal('schema-unknown', 'impasse { reason } requise si presente')
    }
    impasse = { reason: raw.impasse.reason.slice(0, 1000) }
  }
  return { ops: checked, impasse }
}

// Exigence descripteur avant tout activate : pending-trial (jamais un
// descripteur deja confirme), digest SHA256 64 hex, doctrine liee a la version
// du prompt (mismatch refuse), checks non vides (forme seulement : la
// verification appartient au noyau trusted, jamais crue ici).
function requireDescriptor (descriptor, doctrineVersion) {
  if (!isPlainObject(descriptor) || typeof descriptor.version !== 'string' || !VERSION_RE.test(descriptor.version)) {
    throw refusal('descriptor', 'descripteur.version identifiant requis')
  }
  if (descriptor.status !== 'pending-trial') {
    throw refusal('already-promoted', 'activation d un trial uniquement, jamais d un descripteur deja confirme')
  }
  if (typeof descriptor.manifestDigest !== 'string' || !DIGEST_RE.test(descriptor.manifestDigest)) {
    throw refusal('descriptor', 'descripteur.manifestDigest SHA256 64 hex requis')
  }
  if (!Array.isArray(descriptor.checks) || descriptor.checks.length === 0) {
    throw refusal('descriptor', 'descripteur.checks non vide requis (forme ; verification par le noyau trusted)')
  }
  for (const check of descriptor.checks) {
    if (!isPlainObject(check) || typeof check.name !== 'string' || check.name === '') {
      throw refusal('descriptor', 'descripteur.checks exige des { name }')
    }
  }
  const doctrine = descriptor.doctrine
  if (!isPlainObject(doctrine) || typeof doctrine.version !== 'string' || doctrine.version !== doctrineVersion) {
    throw refusal('doctrine-mismatch', `doctrine du descripteur (${doctrine && doctrine.version}) != doctrine du prompt (${doctrineVersion})`)
  }
  return descriptor
}

// Preuve noyau : format commun explicite, construit ICI depuis les mesures du
// trialRunner, jamais recopie d'un champ LLM. Le host (`validateTrial`) decide :
// `essai: 'reel-observe'` + version + jobId + nonce + doctrineVersion +
// measurements mesurees. Un texte du modele ne peut pas forger une acceptation.
function toCoreProof ({ runnerResult, version, jobId, nonce, doctrineVersion }) {
  if (!isPlainObject(runnerResult) || runnerResult.accept !== true) {
    throw refusal('trial-unproven', 'essai reel non accepte : aucune promotion (faits monde conserves, pas de replay aveugle)')
  }
  if (!isPlainObject(runnerResult.measurements)) {
    throw refusal('trial-unproven', 'mesures d essai requises (objet measurements mesure, pas du texte)')
  }
  return Object.freeze({
    essai: PROOF_MARK,
    version,
    jobId,
    nonce,
    doctrineVersion,
    measurements: runnerResult.measurements,
    observedAt: new Date().toISOString()
  })
}

function freshNonce () {
  return nodeCrypto.randomBytes(12).toString('hex')
}

function isDepsChange (changes) {
  return changes.some((c) => {
    const base = String(c.path || '').split('/').pop().toLowerCase()
    return base === 'package.json' || base === 'package-lock.json'
  })
}

function errorSignature (err) {
  const code = (err && err.code) || 'error'
  const msg = String((err && err.message) || err).split('\n')[0].slice(0, 160)
  return `${code} :: ${msg}`
}

// Annulation normalisee : un AbortError SANS code (rejet DOM/fetch, outil qui
// ne type pas) vaut `cancelled` des qu'un signal est aborte ou que le nom
// l'indique. Jamais interprete comme stagnation, jamais de nouvel appel.
const CANCEL_CODES = new Set(['cancelled', 'cancelled-tool', 'aborted', 'abort'])

function isAbortLike (err, signal) {
  if (signal && signal.aborted) return true
  if (!err) return false
  if (typeof err.code === 'string' && CANCEL_CODES.has(err.code)) return true
  if (err.name === 'AbortError') return true
  return false
}

function asCancelled (detail) {
  return refusal('cancelled', detail || 'annule (stop prioritaire, sans nouvel appel)')
}

// Borne d'attente pour les sondes d'arret : un getStopState/supervisor.status
// qui pend vaut unknown (reprise interdite), jamais une attente infinie.
function withGate (promise, ms, code, message) {
  let timer = null
  const gate = new Promise((_, reject) => {
    timer = setTimeout(() => reject(refusal(code, message)), ms)
  })
  return Promise.race([promise, gate]).then(
    (value) => { clearTimeout(timer); return value },
    (err) => { clearTimeout(timer); throw err }
  )
}

function buildSystemPrompt (doctrine, objective) {
  return [
    'Tu es le debloqueur (atelier C0/D04). Tu respectes la doctrine fournie a CHAQUE appel.',
    `Doctrine version ${doctrine.version} :`,
    doctrine.text,
    '',
    'Regles : objectif intact (ne jamais l effacer pour simuler une reussite) ;',
    'progres = preuves mesurees, pas texte ; reponse = JSON borne { ops, impasse? } ;',
    'ops lisibles : read_file, fetch_document, propose_patch (retain booleen EXPLICITE),',
    'explain, propose_doctrine (proposition seulement), escalate.',
    'Patch via prepare/check->TRIAL->preuves->confirm SSI acceptation + retain vrai.',
    'D19 : choix conserver explicite. D51 : doctrine/secours non modifiables par toi.',
    'D10 : code/Internet via outils fournis uniquement. D11 : jamais de reset monde.',
    `Objectif intact : ${objective}`
  ].join('\n')
}

function buildUserPrompt (input) {
  const parts = [
    `Objectif : ${input.objective}`,
    `Tour ${input.round}/${input.maxRounds} (voie ${input.lane}, escalade deja faite : ${input.escalated ? 'oui' : 'non'})`,
    `Faits : ${boundText(JSON.stringify(input.facts ?? null), 3000)}`,
    `Traces : ${boundText(JSON.stringify(input.traces ?? null), 3000)}`,
    `Code : ${boundText(JSON.stringify(input.codeRefs ?? null), 1500)}`,
    `Historique : ${boundText(JSON.stringify(input.history ?? []), 3000)}`
  ]
  return parts.join('\n')
}

function createUnlockService (deps) {
  if (!isPlainObject(deps)) throw new TypeError('dependances objet requises')
  const {
    doctrineProvider,
    callGo,
    callAstra = null,
    tools,
    candidateStore,
    supervisor,
    trialRunner,
    pauseWork,
    resumeWork,
    announce,
    record,
    buildIsolated = null,
    getStopState = null,
    config = {}
  } = deps

  const hasDoctrineGet = doctrineProvider && typeof doctrineProvider.get === 'function'
  const hasDoctrineFn = typeof doctrineProvider === 'function'
  if (!hasDoctrineGet && !hasDoctrineFn) throw new TypeError('doctrineProvider requis : fonction ou { get }')
  if (typeof callGo !== 'function') throw new TypeError('callGo adapter requis (llm.call Muse Responses)')
  if (callAstra != null && typeof callAstra !== 'function') throw new TypeError('callAstra doit etre une fonction ou null')
  if (!isPlainObject(tools) || typeof tools.readFile !== 'function' || typeof tools.fetchDocumentation !== 'function') {
    throw new TypeError('tools requis : { readFile, fetchDocumentation } (autorite host supposee, jamais de fs local)')
  }
  if (!isPlainObject(candidateStore) || typeof candidateStore.prepare !== 'function' || typeof candidateStore.verify !== 'function') {
    throw new TypeError('candidateStore requis : { prepare, verify } (contrat existant)')
  }
  if (!isPlainObject(supervisor) || typeof supervisor.activate !== 'function' ||
    typeof supervisor.confirmTrial !== 'function' || typeof supervisor.rollback !== 'function') {
    throw new TypeError('supervisor requis : { activate, confirmTrial, rollback } (API actuelle)')
  }
  if (typeof trialRunner !== 'function') throw new TypeError('trialRunner requis (preuves reelles mesurees)')
  if (typeof pauseWork !== 'function') throw new TypeError('pauseWork callback requis (travail + survie hors contrat)')
  if (typeof resumeWork !== 'function') throw new TypeError('resumeWork callback requis')
  if (typeof announce !== 'function') throw new TypeError('announce callback requis')
  if (typeof record !== 'function') throw new TypeError('record callback requis')
  if (getStopState != null && typeof getStopState !== 'function') throw new TypeError('getStopState doit etre une fonction ou null')
  if (buildIsolated != null && typeof buildIsolated !== 'function' && !isPlainObject(buildIsolated)) {
    throw new TypeError('buildIsolated doit etre un adapter ou null (jamais invente)')
  }

  const maxRounds = Number(config.maxRounds == null ? DEFAULTS.maxRounds : config.maxRounds)
  const stagnationRepeats = Number(config.stagnationRepeats == null ? DEFAULTS.stagnationRepeats : config.stagnationRepeats)
  const contentMaxChars = Number(config.contentMaxChars == null ? DEFAULTS.contentMaxChars : config.contentMaxChars)
  const opsMaxPerRound = Number(config.opsMaxPerRound == null ? DEFAULTS.opsMaxPerRound : config.opsMaxPerRound)
  const traceMaxEvents = Number(config.traceMaxEvents == null ? DEFAULTS.traceMaxEvents : config.traceMaxEvents)
  const traceDetailChars = Number(config.traceDetailChars == null ? DEFAULTS.traceDetailChars : config.traceDetailChars)
  const stopStateTimeoutMs = Number(config.stopStateTimeoutMs == null ? DEFAULTS.stopStateTimeoutMs : config.stopStateTimeoutMs)
  if (!Number.isFinite(maxRounds) || maxRounds < 1 || maxRounds > 12) throw new TypeError('config.maxRounds borne 1..12 requise (filet)')
  if (!Number.isFinite(stagnationRepeats) || stagnationRepeats < 2 || stagnationRepeats > 6) {
    throw new TypeError('config.stagnationRepeats borne 2..6 requise')
  }
  if (!Number.isFinite(stopStateTimeoutMs) || stopStateTimeoutMs < 50 || stopStateTimeoutMs > 10000) {
    throw new TypeError('config.stopStateTimeoutMs borne 50..10000 requise')
  }

  const state = {
    running: false,
    jobId: null,
    rounds: 0,
    lane: null,
    outcome: null,
    uncertain: false,
    lastError: null,
    escalated: false,
    traces: [],
    doctrineProposals: [],
    internalAbort: null
  }

  function pushTrace (type, detail) {
    const safe = boundText(redactSecrets(detail), traceDetailChars)
    state.traces.push({ type, at: new Date().toISOString(), detail: safe })
    if (state.traces.length > traceMaxEvents) {
      state.traces.splice(0, state.traces.length - traceMaxEvents)
    }
    try {
      record({ type, at: new Date().toISOString(), detail: safe })
    } catch (err) {
      // record host best-effort : erreur ignoree, resumee en trace unknown.
      try {
        state.traces.push({ type: 'record-unknown', at: new Date().toISOString(), detail: boundText(errorSignature(err), traceDetailChars) })
      } catch { /* jamais corruptif */ }
    }
  }

  async function getDoctrine () {
    let raw = null
    try {
      raw = hasDoctrineGet ? await doctrineProvider.get() : await doctrineProvider()
    } catch (err) {
      throw refusal('doctrine-missing', `doctrine indisponible : ${String((err && err.message) || err).slice(0, 160)}`)
    }
    if (!isPlainObject(raw) || typeof raw.version !== 'string' || !VERSION_RE.test(raw.version) ||
      typeof raw.text !== 'string' || raw.text.trim() === '' || raw.text.length > 16000) {
      throw refusal('doctrine-missing', 'doctrine { version, text } trusted requise a chaque appel')
    }
    return { version: raw.version, text: raw.text }
  }

  function throwIfCancelled (signal) {
    if (state.internalAbort && state.internalAbort.aborted) {
      throw refusal('cancelled', 'deblocage annule (stop prioritaire, aucune activation tardive)')
    }
    if (signal && signal.aborted) {
      throw refusal('cancelled', 'deblocage annule (stop prioritaire, aucune activation tardive)')
    }
  }

  // Sondage d'arret avant toute reprise. Regle : UNKNOWN INTERDIT LA REPRISE.
  // getStopState absent = mode legacy/test pur (reprise locale) ; en prod ce
  // callback est requis (preuve d'arret / version attendue). Exception, forme
  // invalide ou borne depassee => unknown => aucune reprise. Un stop constate
  // (ou un latch uncertain du job) n'est jamais revoque par un appel suivant.
  async function readStopState () {
    if (typeof getStopState !== 'function') return { stopped: false, unknown: false, legacy: true }
    let st = null
    try {
      st = await withGate(getStopState(), stopStateTimeoutMs, 'stopstate-timeout', `getStopState sans reponse en ${stopStateTimeoutMs} ms`)
    } catch (err) {
      pushTrace('stopstate-unknown', errorSignature(err))
      return { stopped: false, unknown: true }
    }
    if (typeof st === 'boolean') return { stopped: st, unknown: false }
    if (isPlainObject(st)) {
      const keys = ['stopped', 'totalStopped', 'hardstop']
      const known = keys.some((k) => typeof st[k] === 'boolean')
      if (!known) {
        pushTrace('stopstate-unknown', 'getStopState forme invalide (booleen stopped/totalStopped/hardstop attendu)')
        return { stopped: false, unknown: true }
      }
      return { stopped: keys.some((k) => st[k] === true), unknown: false }
    }
    pushTrace('stopstate-unknown', 'getStopState forme invalide (booleen ou objet attendu)')
    return { stopped: false, unknown: true }
  }

  // Garde noyau : un superviseur en etat uncertain/failed-both/activating/
  // rolling-back interdit aussi la reprise (trial peut-etre vivant). Absence de
  // `supervisor.status` = mode legacy (mocks) : on ne suppose rien.
  async function readSupervisorHold () {
    if (!supervisor || typeof supervisor.status !== 'function') return { hold: false, unknown: false, legacy: true }
    let st = null
    try {
      st = await withGate(supervisor.status(), stopStateTimeoutMs, 'supervisor-status-timeout', `supervisor.status sans reponse en ${stopStateTimeoutMs} ms`)
    } catch (err) {
      pushTrace('supervisor-unknown', errorSignature(err))
      return { hold: false, unknown: true, reason: 'status-illisible' }
    }
    if (!isPlainObject(st)) {
      pushTrace('supervisor-unknown', 'supervisor.status forme invalide (objet attendu)')
      return { hold: false, unknown: true, reason: 'status-invalide' }
    }
    if (st.uncertain != null) return { hold: true, unknown: false, reason: 'uncertain' }
    if (st.failedBoth === true) return { hold: true, unknown: false, reason: 'failed-both' }
    const fsm = st.state || st.fsm
    if (fsm === 'activating' || fsm === 'rolling-back') return { hold: true, unknown: false, reason: fsm }
    return { hold: false, unknown: false }
  }

  async function safeRollback (reason) {
    try {
      await supervisor.rollback(reason)
      pushTrace('rollback', `retour version confirmee (${reason}) ; faits monde conserves, re-observer avant reprise`)
      return true
    } catch (err) {
      pushTrace('rollback-failed', errorSignature(err))
      return false
    }
  }

  // Patch complet D15 : prepare/check -> exigence descripteur -> TRIAL ->
  // mesures -> preuve noyau -> confirm SSI acceptation trusted ET retain vrai.
  // Compensation garantie : des qu'un activate est commis, TOUTE sortie
  // (echec, annulation pendant activate lent, trialRunner sourd, acceptation
  // tardive) rollback avant de rendre la main. Jamais d'essai orphelin.
  // Compensation en echec => latch `job.uncertain` global (aucune reprise,
  // aucun succes revendique). Retain faux = temporaire explicite : le rollback
  // de cleanup est VERIFIE, sinon `failed/uncertain` sans faux "retour base".
  async function handlePatch (patchOp, signal, ctx) {
    if (isDepsChange(patchOp.changes) && !buildIsolated) {
      throw refusal('deps-unsupported',
        'patch touche package.json/package-lock.json sans adapter build isole : non activable (installation/execution isolee absente, non simulee)')
    }
    throwIfCancelled(signal)
    let descriptor = null
    try {
      descriptor = await candidateStore.prepare({ changes: patchOp.changes, reason: patchOp.reason })
    } catch (err) {
      if (err && err.code) throw err
      throw refusal('prepare-failed', String((err && err.message) || err).slice(0, 300))
    }
    requireDescriptor(descriptor, ctx.doctrineVersion)
    throwIfCancelled(signal)
    try {
      await candidateStore.verify(descriptor.version)
    } catch (err) {
      if (err && err.code) throw err
      throw refusal('check-failed', String((err && err.message) || err).slice(0, 300))
    }
    // Stop entre prepare et activate : on n'active jamais en retard.
    throwIfCancelled(signal)
    const nonce = freshNonce()
    let committedVersion = null
    let settled = false
    try {
      // Activate LENT + abort : l'essai peut demarrer malgre le stop. Le
      // `committedVersion` ci-dessous garantit la compensation en `catch`.
      await supervisor.activate(descriptor.version)
      committedVersion = descriptor.version
      // Fenetre 1 : abort pendant l'activate lent => compense, jamais de suite.
      throwIfCancelled(signal)
      let runnerResult = null
      try {
        runnerResult = await trialRunner({
          version: descriptor.version,
          descriptor,
          nonce,
          jobId: ctx.jobId,
          doctrineVersion: ctx.doctrineVersion,
          signal
        })
      } catch (err) {
        // trialRunner sourd au signal / AbortError sans code : normalise en
        // `cancelled` (pas de stagnation, pas de nouvel appel), compense en
        // catch unifie.
        if (isAbortLike(err, signal)) throw asCancelled('essai annule (stop prioritaire, trial compense)')
        if (err && err.code) throw err
        throw refusal('trial-failed', `preuves d essai indisponibles : ${String((err && err.message) || err).slice(0, 200)}`)
      }
      const coreProof = toCoreProof({
        runnerResult,
        version: descriptor.version,
        jobId: ctx.jobId,
        nonce,
        doctrineVersion: ctx.doctrineVersion
      })
      if (patchOp.retain !== true) {
        // Temporaire assume : jamais lastGood. Le cleanup est VERIFIE : un
        // rollback en echec ne revendique ni succes ni "retour base", il
        // verrouille `uncertain` (faits monde preserves, aucune reprise).
        const cleaned = await safeRollback(`temporaire ${descriptor.version} (retain faux, cap explicite)`)
        settled = true
        if (!cleaned) {
          if (ctx.job) ctx.job.uncertain = true
          pushTrace('compensation-failed-uncertain', `cleanup temporaire ${descriptor.version} echoue : base non restauree, faits monde preserves, aucune reprise`)
          return {
            outcome: 'failed',
            version: descriptor.version,
            retain: false,
            uncertain: true,
            code: 'rollback-failed',
            reason: `cleanup temporaire ${descriptor.version} impossible : base non restauree (faits monde preserves, aucune reprise, durcir via futur adapter)`,
            cleanup: null
          }
        }
        return {
          outcome: 'temp-applied',
          version: descriptor.version,
          retain: false,
          cleanup: 'retour base quiescente ; capacite temporaire non promue lastGood ; futur adapter requis pour durcir'
        }
      }
      // Fenetre 2 : acceptation tardive (runner sourd, abort entre-temps) =>
      // aucune promotion tardive, compensation en catch.
      throwIfCancelled(signal)
      try {
        await supervisor.confirmTrial(descriptor.version, coreProof)
      } catch (err) {
        if (err && err.code) throw err
        throw refusal('confirm-failed', String((err && err.message) || err).slice(0, 300))
      }
      settled = true
      return { outcome: 'confirmed', version: descriptor.version, retain: true, nonce }
    } catch (err) {
      if (committedVersion && !settled) {
        const compensated = await safeRollback(`compensation ${committedVersion} (${(err && err.code) || 'error'}) ; faits monde conserves, re-observer`)
        if (!compensated && ctx.job) {
          ctx.job.uncertain = true
          pushTrace('compensation-failed-uncertain', `compensation ${committedVersion} echouee : base non restauree, faits monde preserves, aucune reprise`)
        }
      }
      throw err
    }
  }

  async function runModelRound (lane, callFn, job, round) {
    const doctrine = await getDoctrine()
    const system = buildSystemPrompt(doctrine, job.objective)
    const user = buildUserPrompt({
      objective: job.objective,
      facts: job.facts,
      traces: job.traces,
      codeRefs: job.codeRefs,
      round,
      maxRounds,
      lane,
      escalated: state.escalated,
      history: job.history
    })
    throwIfCancelled(job.signal)
    let answer = null
    try {
      answer = await callFn(system, user, { signal: job.signal })
    } catch (err) {
      if (state.internalAbort && state.internalAbort.aborted) throw refusal('cancelled', 'appel annule (stop)')
      if (job.signal && job.signal.aborted) throw refusal('cancelled', 'appel annule (stop)')
      throw err
    }
    const content = answer && answer.content
    if (typeof content !== 'string' || content.trim() === '') {
      throw refusal('schema-unknown', 'reponse modele sans contenu')
    }
    if (content.length > contentMaxChars) throw refusal('schema-unknown', `reponse modele trop longue (>${contentMaxChars})`)
    // Doctrine fournie a CHAQUE appel : le test compte les lectures.
    job.doctrineCalls += 1
    job.doctrineVersions.push(doctrine.version)
    job.doctrineVersion = doctrine.version
    return { doctrine, content }
  }

  function noteErrorStagnation (job, err) {
    const sig = errorSignature(err)
    job.errorCounts.set(sig, (job.errorCounts.get(sig) || 0) + 1)
    job.lastSignature = sig
    pushTrace('round-error', sig)
    return sig
  }

  function isStagnant (job) {
    if (job.lastSignature && (job.errorCounts.get(job.lastSignature) || 0) >= stagnationRepeats) return true
    // Meme erreur textuelle du modele sans nouvelle preuve : pas du progres (D26).
    if (job.rounds >= 2 && job.proofCount === 0 && job.rounds >= stagnationRepeats) return true
    return false
  }

  async function executeOps (plan, job, lane) {
    for (const op of plan.ops) {
      throwIfCancelled(job.signal)
      if (op.op === 'read_file') {
        try {
          const res = await tools.readFile(op.path, { signal: job.signal })
          const text = typeof res === 'string' ? res : (res && res.content) || JSON.stringify(res)
          if (text && String(text).trim()) job.proofCount += 1
          job.history.push({ op: 'read_file', path: op.path, bytes: String(text || '').length })
          pushTrace('read_file', `${op.path} (${String(text || '').length} o)`)
        } catch (err) {
          // AbortError sans code (signal ou nom) => `cancelled`, jamais une
          // stagnation qui declencherait un nouvel appel.
          if (isAbortLike(err, job.signal)) throw asCancelled(`read_file ${op.path} annule (stop prioritaire, sans nouvel appel)`)
          throw err.code ? err : refusal('tool-failed', `read_file ${op.path} : ${String((err && err.message) || err).slice(0, 200)}`)
        }
      } else if (op.op === 'fetch_document') {
        try {
          const res = await tools.fetchDocumentation(op.ref, { signal: job.signal })
          const text = typeof res === 'string' ? res : (res && res.content) || JSON.stringify(res)
          if (text && String(text).trim()) job.proofCount += 1
          job.history.push({ op: 'fetch_document', ref: op.ref, bytes: String(text || '').length })
          pushTrace('fetch_document', `${op.ref} (${String(text || '').length} o)`)
        } catch (err) {
          if (isAbortLike(err, job.signal)) throw asCancelled(`fetch_document ${op.ref} annule (stop prioritaire, sans nouvel appel)`)
          throw err.code ? err : refusal('tool-failed', `fetch_document ${op.ref} : ${String((err && err.message) || err).slice(0, 200)}`)
        }
      } else if (op.op === 'propose_patch') {
        const res = await handlePatch(op, job.signal, { jobId: job.jobId, doctrineVersion: job.doctrineVersion, job })
        job.proofCount += 1
        job.patchResult = res
        pushTrace(res.outcome === 'confirmed' ? 'patch-confirmed' : (res.outcome === 'temp-applied' ? 'patch-temp' : 'patch-failed'),
          `${res.version} retain=${res.retain} ; ${res.cleanup || res.reason || 'ni promotion ni cleanup revendiques'}`)
        if (res.outcome === 'confirmed' || res.outcome === 'temp-applied') {
          job.finished = res
          return res
        }
        // Echec franc du patch (ex. cleanup temporaire impossible) : remonte
        // tel quel, sans rejouer ni replanifier par-dessus.
        if (res && res.outcome === 'failed') {
          if (res.uncertain) job.uncertain = true
          job.finished = res
          return res
        }
      } else if (op.op === 'explain') {
        try { await announce(boundText(redactSecrets(op.text), 500)) } catch (err) {
          pushTrace('announce-unknown', errorSignature(err))
        }
        pushTrace('explain', op.text)
      } else if (op.op === 'propose_doctrine') {
        // Enregistree, jamais appliquee (D09/D51) : la doctrine courante reste.
        state.doctrineProposals.push({ text: boundText(op.text, 4000), at: new Date().toISOString(), lane })
        pushTrace('doctrine-proposal', `proposition enregistree (${op.text.length} car.), jamais appliquee sans proprietaire`)
      } else if (op.op === 'escalate') {
        job.escalateAsked = op.reason
        pushTrace('escalate-asked', op.reason)
        return { escalate: true, reason: op.reason }
      }
    }
    return null
  }

  async function escalationOnce (job) {
    if (state.escalated) return null
    if (typeof callAstra !== 'function') {
      pushTrace('impasse-no-astra', 'escalade Astra indisponible (aucun acces fourni) : attente honnete, jamais pilote de substitution')
      return {
        outcome: 'impasse',
        escalated: false,
        reason: `escalade Astra indisponible (aucun acces fourni), attente honnete : ${job.escalateAsked || job.impasseReason || 'stagnation sans acces Astra'}`
      }
    }
    state.escalated = true
    pushTrace('escalate-astra', `escalade unique Astra (${job.escalateAsked || job.impasseReason || 'stagnation'}) ; Astra aide, jamais pilote`)
    try { await announce('Je transmets a l aide de dernier recours, je reste en attente.') } catch (err) {
      pushTrace('announce-unknown', errorSignature(err))
    }
    const round = await runModelRound('astra', callAstra, job, job.rounds + 1)
    const plan = validateUnlockJson(parseModelJson(round.content), opsMaxPerRound)
    const res = await executeOps(plan, job, 'astra')
    if (res && (res.outcome === 'confirmed' || res.outcome === 'temp-applied')) {
      return { outcome: res.outcome, version: res.version, retain: res.retain, cleanup: res.cleanup, escalated: true }
    }
    if (res && res.escalate) {
      // Astra ne re-escalade pas : une seule escalade par job.
      pushTrace('impasse', 'Astra sans progres mesurable : attente honnete')
      return { outcome: 'impasse', escalated: true, reason: res.reason }
    }
    if (plan.impasse) {
      return { outcome: 'impasse', escalated: true, reason: plan.impasse.reason }
    }
    return { outcome: 'impasse', escalated: true, reason: 'Astra sans correctif prouve : attente honnete' }
  }

  async function requestUnlock (request, opts) {
    if (state.running) throw refusal('busy', 'un deblocage est deja en cours (single-job, sans file)')
    const objective = request && request.objective
    if (typeof objective !== 'string' || objective.trim() === '') {
      throw refusal('objective-required', 'objectif intact requis (texte d origine, jamais efface)')
    }
    const externalSignal = opts && opts.signal ? opts.signal : null
    if (externalSignal && typeof externalSignal.aborted !== 'boolean') {
      throw new TypeError('opts.signal doit etre un AbortSignal')
    }
    state.running = true
    state.jobId = `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(16)}`
    state.rounds = 0
    state.outcome = null
    state.uncertain = false
    state.lastError = null
    state.escalated = false
    state.doctrineProposals = []
    state.internalAbort = new AbortController()
    const onExternalAbort = () => {
      try { state.internalAbort.abort() } catch { /* ignore */ }
    }
    if (externalSignal) {
      if (externalSignal.aborted) state.internalAbort.abort()
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }
    const job = {
      objective: objective.trim(),
      facts: request.facts ?? null,
      traces: request.traces ?? null,
      codeRefs: request.codeRefs ?? null,
      signal: state.internalAbort.signal,
      externalSignal,
      rounds: 0,
      history: [],
      errorCounts: new Map(),
      lastSignature: null,
      proofCount: 0,
      escalateAsked: null,
      impasseReason: null,
      finished: null,
      patchResult: null,
      uncertain: false,
      doctrineCalls: 0,
      doctrineVersions: [],
      doctrineVersion: null,
      jobId: state.jobId
    }
    // Pause du travail : la survie vit dans les callbacks host (hors contrat).
    // Bail conditionnel : si pauseWork rend { release }, c'est lui qui libere.
    let pauseLease = null
    try {
      pauseLease = await pauseWork({ objective: job.objective, jobId: state.jobId })
    } catch (err) {
      state.running = false
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort)
      throw refusal('pause-failed', `pause du travail impossible : ${String((err && err.message) || err).slice(0, 200)}`)
    }
    const hasLeaseRelease = pauseLease && typeof pauseLease.release === 'function'
    pushTrace('start', `deblocage ${state.jobId} : objectif intact "${boundText(job.objective, 200)}" (limites : ${LIMITS.slice(0, 120)}...)`)
    try { await announce('Je mets le travail en pause et je cherche comment debloquer.') } catch (err) {
      pushTrace('announce-unknown', errorSignature(err))
    }
    async function runBody () {
      for (let round = 1; round <= maxRounds; round += 1) {
        throwIfCancelled(job.signal)
        job.rounds = round
        state.rounds = round
        state.lane = 'go'
        let content = null
        try {
          const turn = await runModelRound('go', callGo, job, round)
          content = turn.content
        } catch (err) {
          if (err && err.code === 'cancelled') throw err
          noteErrorStagnation(job, err)
          pushTrace('go-unavailable', errorSignature(err))
          if (isStagnant(job) || (err && (err.code === 'LLM_TIMEOUT' || err.code === 'LLM_NETWORK' || err.code === 'LLM_HTTP'))) {
            // Go en panne repetee : une seule escalade si l'impasse est justifiee.
            if (!state.escalated && (isStagnant(job) || job.rounds >= 2)) {
              const esc = await escalationOnce(job)
              if (esc && (esc.outcome === 'confirmed' || esc.outcome === 'temp-applied')) {
                state.outcome = esc.outcome
                return finishOk(job, esc)
              }
              if (esc) {
                state.outcome = esc.outcome
                return finishOk(job, esc)
              }
            }
          }
          continue
        }
        let plan = null
        try {
          plan = validateUnlockJson(parseModelJson(content), opsMaxPerRound)
        } catch (err) {
          noteErrorStagnation(job, err)
          pushTrace('schema-refused', errorSignature(err))
          if (isStagnant(job) && !state.escalated) {
            const esc = await escalationOnce(job)
            if (esc) {
              state.outcome = esc.outcome
              return finishOk(job, esc)
            }
          }
          continue
        }
        try {
          const res = await executeOps(plan, job, 'go')
          if (res && (res.outcome === 'confirmed' || res.outcome === 'temp-applied')) {
            state.outcome = res.outcome
            return finishOk(job, { ...res, escalated: state.escalated })
          }
          // Echec franc du patch (cleanup impossible, base non restauree) :
          // statut failed/uncertain, faits monde preserves, sans rejouer.
          if (res && res.outcome === 'failed') {
            if (res.uncertain) job.uncertain = true
            state.outcome = 'failed'
            state.lastError = {
              code: res.code || 'rollback-failed',
              message: String(res.reason || 'echec patch').slice(0, 300),
              at: new Date().toISOString()
            }
            return finishOk(job, { outcome: 'failed', escalated: state.escalated, error: state.lastError })
          }
          if (res && res.escalate) {
            job.escalateAsked = res.reason
            const esc = await escalationOnce(job)
            if (esc) {
              state.outcome = esc.outcome
              return finishOk(job, esc)
            }
            state.outcome = 'impasse'
            return finishOk(job, { outcome: 'impasse', escalated: state.escalated, reason: res.reason })
          }
          if (plan.impasse) {
            job.impasseReason = plan.impasse.reason
            const esc = await escalationOnce(job)
            if (esc) {
              state.outcome = esc.outcome
              return finishOk(job, esc)
            }
            state.outcome = 'impasse'
            return finishOk(job, { outcome: 'impasse', escalated: state.escalated, reason: plan.impasse.reason })
          }
        } catch (err) {
          if (err && err.code === 'cancelled') throw err
          // Echec patch/outil : compensation deja tentee dans handlePatch ; on
          // constate sans rejouer aveuglement, puis on evalue la stagnation.
          noteErrorStagnation(job, err)
          if (err && (err.code === 'trial-unproven' || err.code === 'trial-failed' ||
            err.code === 'activate-failed' || err.code === 'deps-unsupported' ||
            err.code === 'descriptor' || err.code === 'doctrine-mismatch' || err.code === 'already-promoted' ||
            err.code === 'rollback-failed')) {
            job.history.push({ op: 'patch-failed', code: err.code })
          }
          if (isStagnant(job) && !state.escalated) {
            const esc = await escalationOnce(job)
            if (esc) {
              state.outcome = esc.outcome
              return finishOk(job, esc)
            }
          }
          continue
        }
        if (isStagnant(job) && !state.escalated) {
          const esc = await escalationOnce(job)
          if (esc) {
            state.outcome = esc.outcome
            return finishOk(job, esc)
          }
        }
      }
      // Budget epuise (filet) sans preuve : pas de succes texte, escalade si
      // stagnation justifiee, sinon attente honnete.
      if (!state.escalated && isStagnant(job)) {
        const esc = await escalationOnce(job)
        if (esc) {
          state.outcome = esc.outcome
          return finishOk(job, esc)
        }
      }
      state.outcome = 'impasse'
      return finishOk(job, {
        outcome: 'impasse',
        escalated: state.escalated,
        reason: 'budget epuise sans preuve mesuree : attente honnete, reprise sur faits re-observes'
      })
    }
    let result = null
    try {
      result = await runBody()
    } catch (err) {
      if (err && err.code === 'cancelled') {
        state.outcome = 'cancelled'
        pushTrace('cancelled', 'pipeline annule (stop) : trial compense si commis, aucune promotion tardive, faits monde conserves')
        try { await announce('Deblocage annule, je reprends sur les faits actuels.') } catch (announceErr) {
          pushTrace('announce-unknown', errorSignature(announceErr))
        }
        result = finishOk(job, { outcome: 'cancelled', escalated: state.escalated, reason: 'annule (stop prioritaire)' })
      } else {
        state.lastError = { code: (err && err.code) || 'error', message: String((err && err.message) || err).slice(0, 300) }
        pushTrace('failed', `${state.lastError.code} :: ${state.lastError.message}`)
        state.outcome = 'failed'
        result = finishOk(job, { outcome: 'failed', escalated: state.escalated, error: state.lastError })
      }
    }
    if (!result) {
      state.outcome = 'failed'
      state.lastError = { code: 'error', message: 'resultat indisponible', at: new Date().toISOString() }
      result = finishOk(job, { outcome: 'failed', escalated: state.escalated, error: state.lastError })
    }
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort)
    state.running = false
    state.uncertain = Boolean(job.uncertain)
    // Reprise INTERDITE par defaut des qu'un doute subsiste : stop explicite,
    // etat d'arret illisible (exception/forme/timeout => unknown), garde
    // noyau (uncertain/failed-both/activation en cours, ou status illisible),
    // ou latch uncertain du job (compensation en echec). Un `stopstate: false`
    // posterieur ne revoque jamais une decision de non-reprise.
    // Sans getStopState ni supervisor.status : mode legacy/test pur (reprise
    // locale) ; en prod ces sondes sont requises (preuve d'arret / version).
    const stop = await readStopState()
    const hold = await readSupervisorHold()
    const blocks = []
    if (stop.stopped) blocks.push('hardstop')
    if (stop.unknown) blocks.push('stop-unknown')
    if (hold.hold) blocks.push(`supervisor-${hold.reason}`)
    if (hold.unknown) blocks.push('supervisor-unknown')
    if (job.uncertain === true) blocks.push('job-uncertain')
    if (blocks.length > 0) {
      const kind = stop.stopped
        ? 'resume-skipped-hardstop'
        : (job.uncertain === true && blocks.length === 1 ? 'resume-skipped-uncertain' : 'resume-skipped-unknown')
      pushTrace(kind, `reprise interdite (${blocks.join(',')}) : travail non reveille, faits monde preserves`)
    } else if (hasLeaseRelease) {
      try {
        await pauseLease.release({ jobId: state.jobId, outcome: state.outcome })
      } catch (err) {
        pushTrace('resume-unknown', errorSignature(err))
      }
    } else {
      try { await resumeWork({ jobId: state.jobId, outcome: state.outcome }) } catch (err) {
        pushTrace('resume-unknown', errorSignature(err))
      }
    }
    result.traces = state.traces.map((t) => ({ ...t }))
    result.uncertain = Boolean(job.uncertain)
    return result
  }

  function finishOk (job, res) {
    return {
      outcome: res.outcome,
      jobId: state.jobId,
      rounds: job.rounds,
      lane: state.escalated ? 'go+astra' : 'go',
      escalated: Boolean(state.escalated),
      uncertain: Boolean(job.uncertain || res.uncertain),
      version: res.version || null,
      retain: res.retain ?? null,
      cleanup: res.cleanup || null,
      reason: res.reason || null,
      error: res.error || null,
      doctrineCalls: job.doctrineCalls,
      doctrineVersions: [...job.doctrineVersions],
      doctrineProposals: state.doctrineProposals.map((p) => ({ ...p })),
      proofCount: job.proofCount,
      traces: state.traces.map((t) => ({ ...t })),
      limits: LIMITS
    }
  }

  function cancel (reason) {
    if (!state.running) return { cancelled: false }
    try { state.internalAbort.abort() } catch { /* ignore */ }
    pushTrace('cancel-asked', String(reason || 'stop'))
    return { cancelled: true }
  }

  function status () {
    return {
      running: state.running,
      jobId: state.jobId,
      rounds: state.rounds,
      lane: state.lane,
      outcome: state.outcome,
      uncertain: state.uncertain,
      escalated: state.escalated,
      lastError: state.lastError,
      doctrineProposals: state.doctrineProposals.map((p) => ({ ...p })),
      traces: state.traces.map((t) => ({ ...t })),
      limits: LIMITS
    }
  }

  return { requestUnlock, cancel, status }
}

module.exports = { createUnlockService, OPS, LIMITS, DEFAULTS, PROOF_MARK, toCoreProof, requireDescriptor }
