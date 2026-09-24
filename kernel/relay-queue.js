'use strict'

// kernel/relay-queue.js — File serveur du relais Windows (D53), cote noyau.
//
// PERIMETRE : ce module est la file imposee par `bridge/relay-contract.md`
// (§2-§4). Le worker est fige : `bridge/opencode-relay.ps1` (PowerShell 7,
// Windows, loopback). Ce fichier ne touche PAS au worker : agent fini,
// aucune ecriture bridge. Endpoints servis EXACTEMENT ceux du contrat,
// ni plus ni moins :
//   POST /relay/jobs/claim            (§2.1)
//   POST /relay/jobs/{id}/result      (§2.2, Complete, idempotent)
//   POST /relay/jobs/{id}/fail        (§2.3, Fail / dead-letter)
//   POST /relay/jobs/{id}/cancel      (§2.4, restitution volontaire du lease)
// AUCUNE route publique d enqueue : `enqueue` serait un bypass du pilote
// (un appelant reseau forgerait un job sans passer par le unlock-service
// hote). L unique entree hote est `requestTrusted()` (appel in-process du
// unlock-service, scope Astra-aide fixe). Aucune route GET/PUT/DELETE,
// aucun `/relay/jobs` d ecriture, aucun status HTTP (voir `status()`).
//
// SCOPE FIXE (hote non fiable, contrat §1) : la file ordonnance, le worker
// infere. `model`/`variant`/`directory` d un job sont un ECHO informatif
// ignore par le worker. La file impose donc :
//   RELAY_MODEL = 'openai/gpt-6-astra', RELAY_VARIANT = 'high' (fixes) ;
//   `directory` = echo `options.directoryEcho` (defaut ''), jamais utilise
//   pour la securite. Un `model`/`variant`/`directory` fourni a
//   `requestTrusted()` est IGNORE (documente, jamais une erreur silencieuse
//   de routage).
//
// AUTH : `Authorization: Bearer <RELAY_QUEUE_TOKEN>`, scope LLM uniquement,
// compare en temps constant (`crypto.timingSafeEqual`). 401 neutre, sans
// detail. Le token n est JAMAIS logue, jamais persisté, jamais renvoye.
// Contexte d auth EXTERNE : la factory recoit le token par option (ou
// `process.env.RELAY_QUEUE_TOKEN` en repli) ; elle ne lit aucun autre
// secret, ne gere aucun credential Desktop (inconnus ici).
//
// BIND / LOOPBACK : la factory N ECOUTE JAMAIS par defaut (pas de
// `listen`). Elle expose `handle(req, res)` pour integration dans un
// `http.createServer()` de l hote. C est a l hote de binder en loopback
// strict (`127.0.0.1`, port ephemere en test) et de ne jamais exposer hors
// loopback sans TLS + auth dediee (contrat §7, hors perimetre). La file ne
// valide pas l URL d ecoute (elle ne la voit pas) ; la restriction est
// documentee ici et verifiee par l appelant. Restrictions route cote
// appelant (worker) : URLs file/Desktop loopback `http(s)` sans
// credentials, `-Directory` hote explicite — rappelees ici, appliquees par
// le worker, pas par la file.
//
// CYCLE DE VIE (contrat §4) :
//   queued -> claimed(lease) -> completed | failed | expired | cancelled
//   claimed --(worker cancel)--> queued (reclamable, meme id, nouveau lease)
//   AUCUN passage automatique claimed -> queued (ni requeue, ni nouvelle
//   inference) : un crash relai apres inference avant upload est AMBIGU
//   (resultat peut-etre calcule cote Desktop puis perdu). La file ne doit
//   pas creer deux leases actifs ni relancer une inference sans signal hote
//   (policy) : le job reste `claimed` jusqu a expiry, puis `expired`
//   (terminal) ; seul un nouveau `requestTrusted()` hote explicite rejoue.
// IDEMPOTENCE resultat : re-emission meme `(id, leaseId, fingerprint)`
// (fingerprint = sha256(content)) => `200 {stored:true, duplicate:true}`
// sans effet ; contenu divergent sous le meme lease => `409` (le premier
// upload gagne). `failed`/`cancelled`/`expired`/`interrupted` + resultat
// tardif => `409` (jamais promu). `cancel` worker sur terminal ou lease
// perime => `409` (refus).
// DEADLINE : `requestTrusted()` porte `deadlineAt`/`timeoutMs` (defaut =
// `createdAt + leaseTtlMs`). Passe la deadline, le job devient `expired`
// (unknown), la promesse hote REJETTE (`JOB_EXPIRED`), jamais resolve.
// Un `result` posterieur est `409`, un `fail JOB_EXPIRED` posterieur reste
// accepte comme dead-letter si le lease correspond.
// HOST CANCEL : `signal` aborte (ou `cancelRequest(id)`) => `cancelled`
// terminal, promesse rejetee (`RELAY_ABORTED`), futur `claim` refuse (le
// job ne redevient jamais `queued`), resultat tardif `409` non promu.
//
// QUOTAS / FORME (anti huge/malicious) :
//   - `system`+`user` UTF-8 <= `maxMessageBytes` (defaut 1 Mo, contrat §1) ;
//     `content` resultat <= `maxContentBytes` (defaut 1 Mo) ;
//     message `fail` <= `maxFailMessageChars` (defaut 2000, le worker borne
//     a 500) ; `usage` opaque JSON borne (<= 16 Ko serialise) ;
//   - `maxPending` (defaut 16) jobs actifs (`queued`+`claimed`) max ;
//     au-dela, `requestTrusted()` rejette `QUEUE_FULL` (pas de file
//     infinie) ;
//   - tout JSON (entree HTTP ou `usage`) : objet/array plain, profondeur
//     <= 10, <= 200 cles totales, chaines <= bornes ci-dessus, refus de
//     `__proto__`/`constructor`/`prototype` a toute profondeur, refus des
//     non-JSON (undefined/function/symbol/bigint) ;
//   - `id`/`leaseId` `^[A-Za-z0-9_-]{1,128}$`, `workerId` chaine 1..128.
//
// RESTART : `store` injecte optionnel `{ load(), save(snapshot) }`
// (compatible `bot/state-store.js` : `createStateStore({file,eventFile})`
// avec `load()`/`save()` ; seuls ces deux membres sont utilises). Au
// demarrage, tout job `queued`/`claimed` persiste est marque
// `interrupted` (failure `RELAY_RESTART`, message borne, resultat
// `unknown`) et persiste aussitot. Il n est JAMAIS refile ni reclaime :
// seul un nouveau `requestTrusted()` hote explicite rejoue. Le store ne
// recoit JAMAIS de secret (ni token, ni env, ni credentials).
//
// OBSERVABILITE : `status()` rend des COMPTEURS rediges
// (`{queued,claimed,completed,failed,cancelled,expired,interrupted}`,
// `total`, `maxPending`, `model`, `variant`), jamais les prompts.
// `lookupJob(id)` (in-process, option `enableLookup`, defaut vrai) rend
// une copie du job pour audit hote — jamais expose via HTTP. Aucun log
// d auth ni de prompt : ce module ne logue rien du tout.
// `checkExpiries()` (maintenance, utilise par les tests a horloge
// factice) balaye les deadlines/leases echus.
//
// ZERO DEPENDANCE : seul `node:crypto` (ids, sha256, timingSafeEqual).
// Aucun acces fichier, aucun lancement de processus, aucun Docker, aucune
// connexion Minecraft, aucun appel OpenCode/Desktop ici (le worker infere,
// la file ordonnance).
//
// Retour integration (pour la tache bridge de bout en bout) : monter
// `handle` sur un serveur loopback ephemere, appeler `requestTrusted()`
// cote hote (unlock-service), laisser le worker `claim -> inference ->
// result|fail -> claim...` tourner. Compat prouvee par
// `tmp/relay-queue.test.js` (vrai HTTP loopback + fake clock/store).

const nodeCrypto = require('node:crypto')

const RELAY_MODEL = 'openai/gpt-6-astra'
const RELAY_VARIANT = 'high'

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const CODE_RE = /^[A-Z0-9_]{1,64}$/

const DEFAULTS = Object.freeze({
  maxPending: 16,
  maxMessageBytes: 1048576,
  maxContentBytes: 1048576,
  maxUsageBytes: 16384,
  maxFailMessageChars: 2000,
  leaseTtlMs: 300000,
  maxJobAgeMs: 300000,
  claimBodyMaxBytes: 16384,
  resultBodyMaxBytes: 2097152
})

// Connus du contrat §2.3 (informatif : tout CODE_RE reste accepte pour ne
// pas casser un worker futur ; seuls ces codes sont documentes).
const KNOWN_FAIL_CODES = Object.freeze([
  'JOB_EXPIRED',
  'RELAY_BAD_JOB',
  'RELAY_JOB_TOO_LARGE',
  'RELAY_HTTP',
  'RELAY_NO_TOOLS',
  'RELAY_BAD_RESPONSE',
  'RELAY_MODEL_ERROR',
  'RELAY_EMPTY',
  'RELAY_TIMEOUT',
  'RELAY_ABORTED',
  'RELAY_DESKTOP_ERROR'
])

function isPlainObject (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function utf8Bytes (text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8')
}

function errWith (code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

// Validation JSON anti huge/malicious : profondeur, nombre de cles,
// chaines bornees, refus proto-pollution et valeurs non-JSON.
function assertSafeJson (value, { depth = 0, seen = null, strMax = 1048576 } = {}) {
  const counter = seen || { keys: 0 }
  if (depth > 10) throw errWith('invalid_body', 'profondeur JSON excessive')
  if (counter.keys > 200) throw errWith('invalid_body', 'trop de cles JSON')
  if (typeof value === 'string') {
    if (value.length > strMax) throw errWith('too_large', 'chaine JSON trop longue')
    return
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    if (typeof value === 'number' && !Number.isFinite(value)) throw errWith('invalid_body', 'nombre non fini')
    return
  }
  if (Array.isArray(value)) {
    if (value.length > 500) throw errWith('invalid_body', 'tableau JSON trop long')
    for (const item of value) assertSafeJson(item, { depth: depth + 1, seen: counter, strMax })
    return
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw errWith('invalid_body', 'cle JSON interdite')
      }
      if (key.length > 256) throw errWith('invalid_body', 'cle JSON trop longue')
      counter.keys += 1
      if (counter.keys > 200) throw errWith('invalid_body', 'trop de cles JSON')
      assertSafeJson(value[key], { depth: depth + 1, seen: counter, strMax })
    }
    return
  }
  throw errWith('invalid_body', 'valeur JSON non supportee')
}

function assertId (value, field) {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw errWith('invalid_body', `${field} invalide`)
  }
  return value
}

function fingerprintOf (content) {
  return nodeCrypto.createHash('sha256').update(String(content), 'utf8').digest('hex')
}

function safeEqualBearer (provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  try {
    return nodeCrypto.timingSafeEqual(a, b)
  } catch (_) {
    return false
  }
}

function defaultNewId (prefix) {
  return `${prefix}-${nodeCrypto.randomBytes(12).toString('hex')}`
}

function normalizeLimit (value, fallback, min, max, name) {
  const n = value === undefined || value === null ? fallback : Number(value)
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new TypeError(`relay-queue: option ${name} hors bornes (${min}..${max})`)
  }
  return Math.floor(n)
}

function createRelayQueue (options = {}) {
  if (!isPlainObject(options)) throw new TypeError('relay-queue: options attendues sous forme d objet')
  const token = options.token !== undefined && options.token !== null
    ? String(options.token)
    : (process.env.RELAY_QUEUE_TOKEN ? String(process.env.RELAY_QUEUE_TOKEN) : '')
  if (!token) throw new TypeError('relay-queue: token Bearer explicite attendu (option token ou RELAY_QUEUE_TOKEN)')
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const newJobId = typeof options.newJobId === 'function' ? options.newJobId : () => defaultNewId('job')
  const newLeaseId = typeof options.newLeaseId === 'function' ? options.newLeaseId : () => defaultNewId('lease')
  const directoryEcho = options.directoryEcho === undefined || options.directoryEcho === null
    ? ''
    : String(options.directoryEcho)
  const enableLookup = options.enableLookup === undefined ? true : Boolean(options.enableLookup)
  const store = options.store === undefined || options.store === null ? null : options.store
  if (store !== null && (!isPlainObject(store) || typeof store.load !== 'function' || typeof store.save !== 'function')) {
    throw new TypeError('relay-queue: store attendu sous forme { load(), save() } (ex. state-store)')
  }

  const maxPending = normalizeLimit(options.maxPending, DEFAULTS.maxPending, 1, 1024, 'maxPending')
  const maxMessageBytes = normalizeLimit(options.maxMessageBytes, DEFAULTS.maxMessageBytes, 1, 4194304, 'maxMessageBytes')
  const maxContentBytes = normalizeLimit(options.maxContentBytes, DEFAULTS.maxContentBytes, 1, 4194304, 'maxContentBytes')
  const maxUsageBytes = normalizeLimit(options.maxUsageBytes, DEFAULTS.maxUsageBytes, 256, 262144, 'maxUsageBytes')
  const maxFailMessageChars = normalizeLimit(options.maxFailMessageChars, DEFAULTS.maxFailMessageChars, 100, 8000, 'maxFailMessageChars')
  const leaseTtlMs = normalizeLimit(options.leaseTtlMs, DEFAULTS.leaseTtlMs, 1000, 3600000, 'leaseTtlMs')
  const maxJobAgeMs = normalizeLimit(options.maxJobAgeMs, DEFAULTS.maxJobAgeMs, 1000, 3600000, 'maxJobAgeMs')

  // Etat memoire : Map id -> job. Les jobs terminaux sont conserves pour
  // l idempotence (meme lease+fingerprint) et les audits.
  const jobs = new Map()
  // Promesses hotes en attente : id -> { resolve, reject, timer, signal, onAbort }
  const waiters = new Map()

  function snapshot () {
    return { version: 1, jobs: [...jobs.values()].map((j) => JSON.parse(JSON.stringify(j))) }
  }

  function persist () {
    if (!store) return
    store.save(snapshot())
  }

  function activeCount () {
    let n = 0
    for (const job of jobs.values()) {
      if (job.status === 'queued' || job.status === 'claimed') n += 1
    }
    return n
  }

  function settleResolve (id, result) {
    const w = waiters.get(id)
    if (!w) return
    waiters.delete(id)
    if (w.timer) clearTimeout(w.timer)
    if (w.signal && w.onAbort) {
      try { w.signal.removeEventListener('abort', w.onAbort) } catch (_) { /* ignore */ }
    }
    w.resolve(result)
  }

  function settleReject (id, err) {
    const w = waiters.get(id)
    if (!w) return
    waiters.delete(id)
    if (w.timer) clearTimeout(w.timer)
    if (w.signal && w.onAbort) {
      try { w.signal.removeEventListener('abort', w.onAbort) } catch (_) { /* ignore */ }
    }
    w.reject(err)
  }

  // Balayage deadlines/leases : effets terminaux + rejet hote. Retourne le
  // nombre de jobs bascules. Ne requeue JAMAIS (ambiguite crash relai :
  // pas de nouvelle inference sans signal hote).
  function checkExpiries () {
    const t = now()
    let changed = 0
    for (const job of jobs.values()) {
      if (job.status !== 'queued' && job.status !== 'claimed') continue
      if (job.status === 'queued') {
        if (t < job.deadlineAtMs) continue
      } else if (t < job.deadlineAtMs && t < job.leaseExpiresAtMs) {
        continue
      }
      // Expire : terminal unknown.
      job.status = 'expired'
      job.finishedAtMs = t
      job.failure = job.failure || {
        code: 'JOB_EXPIRED',
        message: 'job expire avant resultat (dead-letter, resultat perime refuse)',
        cleanupFailed: false,
        sessionId: null
      }
      changed += 1
      settleReject(job.id, errWith('JOB_EXPIRED', `job ${job.id} expire (resultat inconnu, rerun hote explicite requis)`))
    }
    if (changed > 0) {
      try { persist() } catch (_) { /* persistance best-effort ici : l etat memoire fait foi */ }
    }
    return changed
  }

  function armDeadlineTimer (job) {
    const delay = Math.max(0, job.deadlineAtMs - now())
    // Timer reel de confort (horloge reelle). Avec horloge factice,
    // `checkExpiries()` tranche explicitement ; le timer tardif est inerte.
    const timer = setTimeout(() => {
      checkExpiries()
    }, Math.min(delay, 2147483647))
    try { if (typeof timer.unref === 'function') timer.unref() } catch (_) { /* ignore */ }
    return timer
  }

  // --- Entree hote exclusive (unlock-service) : aucune route HTTP. ---
  function requestTrusted (payload, opts = {}) {
    if (!isPlainObject(payload)) return Promise.reject(errWith('invalid_body', 'requete attendue sous forme d objet { system, user }'))
    const o = isPlainObject(opts) ? opts : {}
    // Scope fixe : model/variant/directory fournis sont IGNORES (hote non
    // fiable cote worker, echo fixe ici). On les accepte sans les lire.
    let system = payload.system
    let user = payload.user
    if (system === undefined || system === null) system = ''
    if (user === undefined || user === null) user = ''
    if (typeof system !== 'string' || typeof user !== 'string') {
      return Promise.reject(errWith('invalid_body', 'system/user attendus comme chaines'))
    }
    if (system.trim() === '' && user.trim() === '') {
      return Promise.reject(errWith('invalid_body', 'job sans contenu'))
    }
    try {
      assertSafeJson({ system, user }, { strMax: Math.max(maxMessageBytes, maxContentBytes) })
    } catch (e) {
      return Promise.reject(e)
    }
    if (utf8Bytes(system) + utf8Bytes(user) > maxMessageBytes) {
      return Promise.reject(errWith('JOB_TOO_LARGE', `messages > ${maxMessageBytes} octets (1 Mo contrat)`))
    }
    // Premier balayage avant quota : les expires ne comptent plus.
    try { checkExpiries() } catch (_) { /* ignore */ }
    if (activeCount() >= maxPending) {
      return Promise.reject(errWith('QUEUE_FULL', `file pleine (${maxPending} jobs actifs max)`))
    }
    const signal = o.signal === undefined || o.signal === null ? null : o.signal
    if (signal !== null && typeof signal !== 'object') {
      return Promise.reject(errWith('invalid_body', 'signal attendu comme AbortSignal'))
    }
    if (signal && signal.aborted) {
      return Promise.reject(errWith('RELAY_ABORTED', 'requete annulee avant enqueue'))
    }
    let deadlineAtMs
    if (o.deadlineAt !== undefined && o.deadlineAt !== null) {
      deadlineAtMs = Number(o.deadlineAt)
      if (!Number.isFinite(deadlineAtMs)) return Promise.reject(errWith('invalid_body', 'deadlineAt invalide'))
      deadlineAtMs = Math.floor(deadlineAtMs)
    } else if (o.timeoutMs !== undefined && o.timeoutMs !== null) {
      const t = Number(o.timeoutMs)
      if (!Number.isFinite(t) || t <= 0 || t > 3600000) return Promise.reject(errWith('invalid_body', 'timeoutMs invalide'))
      deadlineAtMs = now() + Math.floor(t)
    } else {
      deadlineAtMs = now() + maxJobAgeMs
    }
    const createdAtMs = now()
    // Deadline bornee : jamais au-dela de createdAt + maxJobAgeMs, jamais
    // dans le passe (au moins 1 s pour laisser le claim partir).
    deadlineAtMs = Math.min(deadlineAtMs, createdAtMs + maxJobAgeMs)
    if (deadlineAtMs <= createdAtMs) deadlineAtMs = createdAtMs + 1000

    let id
    try {
      id = String(newJobId('job'))
      assertId(id, 'id')
      if (jobs.has(id)) return Promise.reject(errWith('QUEUE_FULL', 'collision d id, reessayer'))
    } catch (e) {
      return Promise.reject(e)
    }
    const job = {
      id,
      system,
      user,
      status: 'queued',
      leaseId: null,
      leaseExpiresAtMs: null,
      deadlineAtMs,
      createdAtMs,
      finishedAtMs: null,
      result: null,
      failure: null,
      fingerprint: null
    }
    jobs.set(id, job)
    try {
      persist()
    } catch (e) {
      jobs.delete(id)
      return Promise.reject(errWith('STORE_FAILED', `persistance impossible (${e.message || e})`))
    }
    const promise = new Promise((resolve, reject) => {
      const timer = armDeadlineTimer(job)
      let onAbort = null
      if (signal) {
        onAbort = () => {
          const current = jobs.get(id)
          if (current && (current.status === 'queued' || current.status === 'claimed')) {
            current.status = 'cancelled'
            current.finishedAtMs = now()
            current.failure = { code: 'RELAY_ABORTED', message: 'requete hote annulee', cleanupFailed: false, sessionId: null }
            try { persist() } catch (_) { /* memoire fait foi */ }
          }
          settleReject(id, errWith('RELAY_ABORTED', `requete ${id} annulee (resultat tardif refuse)`))
        }
        try {
          signal.addEventListener('abort', onAbort, { once: true })
        } catch (_) { /* signal non standard : ignore */ }
      }
      waiters.set(id, { resolve, reject, timer, signal, onAbort })
    })
    // Attache pratique (non HTTP) : l hote retrouve le job de sa promesse.
    promise.jobId = id
    return promise
  }

  function cancelRequest (jobId) {
    if (typeof jobId !== 'string' || !ID_RE.test(jobId)) throw errWith('invalid_body', 'jobId invalide')
    const job = jobs.get(jobId)
    if (!job) throw errWith('not_found', `job ${jobId} inconnu`)
    if (job.status === 'queued' || job.status === 'claimed') {
      job.status = 'cancelled'
      job.finishedAtMs = now()
      job.failure = { code: 'RELAY_ABORTED', message: 'requete hote annulee (cancelRequest)', cleanupFailed: false, sessionId: null }
      try { persist() } catch (_) { /* memoire fait foi */ }
      settleReject(jobId, errWith('RELAY_ABORTED', `requete ${jobId} annulee (resultat tardif refuse)`))
      return true
    }
    return false
  }

  function status () {
    const counts = { queued: 0, claimed: 0, completed: 0, failed: 0, cancelled: 0, expired: 0, interrupted: 0 }
    for (const job of jobs.values()) {
      if (Object.prototype.hasOwnProperty.call(counts, job.status)) counts[job.status] += 1
    }
    return {
      ok: true,
      model: RELAY_MODEL,
      variant: RELAY_VARIANT,
      counts,
      total: jobs.size,
      maxPending,
      pending: counts.queued + counts.claimed
    }
  }

  function lookupJob (jobId) {
    if (!enableLookup) throw errWith('disabled', 'audit lookup desactive (option enableLookup)')
    if (typeof jobId !== 'string' || !ID_RE.test(jobId)) throw errWith('invalid_body', 'jobId invalide')
    const job = jobs.get(jobId)
    if (!job) return null
    return JSON.parse(JSON.stringify(job))
  }

  // --- HTTP : lecture corps bornee, jamais de log d auth/prompts. ---
  function readBody (req, maxBytes) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      let done = false
      function fail (e) {
        if (done) return
        done = true
        try { req.destroy() } catch (_) { /* ignore */ }
        reject(e)
      }
      req.on('data', (chunk) => {
        if (done) return
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
        size += buf.length
        if (size > maxBytes) {
          fail(errWith('too_large', 'corps trop gros'))
          return
        }
        chunks.push(buf)
      })
      req.on('end', () => {
        if (done) return
        done = true
        resolve(Buffer.concat(chunks).toString('utf8'))
      })
      req.on('error', (e) => fail(e))
    })
  }

  function send (res, httpStatus, body) {
    const text = JSON.stringify(body)
    res.writeHead(httpStatus, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text, 'utf8') })
    res.end(text)
  }

  function claimOne (workerId) {
    checkExpiries()
    let oldest = null
    for (const job of jobs.values()) {
      if (job.status !== 'queued') continue
      if (!oldest || job.createdAtMs < oldest.createdAtMs) oldest = job
    }
    if (!oldest) return null
    const t = now()
    let leaseId = String(newLeaseId('lease'))
    if (!ID_RE.test(leaseId)) leaseId = defaultNewId('lease')
    const leaseExpiresAtMs = Math.min(t + leaseTtlMs, oldest.deadlineAtMs)
    oldest.status = 'claimed'
    oldest.leaseId = leaseId
    oldest.leaseExpiresAtMs = leaseExpiresAtMs
    try { persist() } catch (_) { /* memoire fait foi ; le lease reste exclusif en memoire */ }
    return {
      id: oldest.id,
      leaseId,
      expiresAt: new Date(Math.min(leaseExpiresAtMs, oldest.deadlineAtMs)).toISOString(),
      system: oldest.system,
      user: oldest.user,
      model: RELAY_MODEL,
      variant: RELAY_VARIANT,
      directory: directoryEcho
    }
  }

  function postResult (id, body) {
    if (!isPlainObject(body)) throw errWith('invalid_body', 'corps invalide')
    try { assertSafeJson(body, { strMax: Math.max(maxContentBytes, maxUsageBytes) }) } catch (e) { throw e }
    const leaseId = body.leaseId
    const content = body.content
    assertId(leaseId, 'leaseId')
    if (typeof content !== 'string') throw errWith('invalid_body', 'content attendu comme texte')
    if (utf8Bytes(content) > maxContentBytes) throw errWith('too_large', `content > ${maxContentBytes} octets`)
    const usage = body.usage === undefined ? null : body.usage
    if (usage !== null) {
      try { assertSafeJson(usage, { strMax: 65536 }) } catch (e) { throw errWith('invalid_body', 'usage invalide') }
      if (utf8Bytes(JSON.stringify(usage)) > maxUsageBytes) throw errWith('invalid_body', 'usage trop gros')
    }
    const ms = body.ms === undefined || body.ms === null ? 0 : body.ms
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > 3600000) throw errWith('invalid_body', 'ms invalide')
    const cleanupFailed = body.cleanupFailed === undefined || body.cleanupFailed === null ? false : body.cleanupFailed
    if (typeof cleanupFailed !== 'boolean') throw errWith('invalid_body', 'cleanupFailed invalide')
    const sessionId = body.sessionId === undefined || body.sessionId === null ? null : body.sessionId
    if (sessionId !== null && (typeof sessionId !== 'string' || sessionId.length > 256)) throw errWith('invalid_body', 'sessionId invalide')
    if (sessionId !== null) {
      try { assertSafeJson({ sessionId }, { strMax: 1024 }) } catch (e) { throw errWith('invalid_body', 'sessionId invalide') }
    }

    checkExpiries()
    const job = jobs.get(id)
    if (!job) throw errWith('not_found', `job ${id} inconnu`)
    const fp = fingerprintOf(content)
    if (job.status === 'completed') {
      if (job.leaseId === leaseId && job.fingerprint === fp) {
        return { http: 200, body: { stored: true, duplicate: true } }
      }
      throw errWith('lease_conflict', 'contenu divergent sous le meme lease (premier upload gagne)')
    }
    if (job.status !== 'claimed') {
      throw errWith('lease_conflict', `job ${id} non reclame (statut ${job.status}, resultat tardif refuse)`)
    }
    if (job.leaseId !== leaseId) {
      throw errWith('lease_conflict', 'lease invalide ou perime')
    }
    const t = now()
    if (t >= job.leaseExpiresAtMs || t >= job.deadlineAtMs) {
      job.status = 'expired'
      job.finishedAtMs = t
      job.failure = job.failure || { code: 'JOB_EXPIRED', message: 'resultat perime (deadline depassee)', cleanupFailed: false, sessionId: null }
      try { persist() } catch (_) { /* ignore */ }
      settleReject(id, errWith('JOB_EXPIRED', `job ${id} expire (resultat perime refuse)`))
      throw errWith('lease_conflict', 'job expire (resultat perime refuse, fail JOB_EXPIRED attendu)')
    }
    job.status = 'completed'
    job.finishedAtMs = t
    job.fingerprint = fp
    job.result = { content, usage, ms: Math.floor(ms), cleanupFailed, sessionId }
    try { persist() } catch (_) { /* memoire fait foi */ }
    settleResolve(id, { content, usage, ms: Math.floor(ms), cleanupFailed, sessionId, jobId: id })
    return { http: 200, body: { stored: true, duplicate: false } }
  }

  function postFail (id, body) {
    if (!isPlainObject(body)) throw errWith('invalid_body', 'corps invalide')
    try { assertSafeJson(body, { strMax: 65536 }) } catch (e) { throw e }
    const leaseId = body.leaseId
    const code = body.code
    const message = body.message
    assertId(leaseId, 'leaseId')
    if (typeof code !== 'string' || !CODE_RE.test(code)) throw errWith('invalid_body', 'code invalide')
    if (typeof message !== 'string') throw errWith('invalid_body', 'message attendu comme texte')
    if (message.length > maxFailMessageChars) throw errWith('invalid_body', `message fail > ${maxFailMessageChars} caracteres`)
    const cleanupFailed = body.cleanupFailed === undefined || body.cleanupFailed === null ? false : body.cleanupFailed
    if (typeof cleanupFailed !== 'boolean') throw errWith('invalid_body', 'cleanupFailed invalide')
    const sessionId = body.sessionId === undefined || body.sessionId === null ? null : body.sessionId
    if (sessionId !== null && (typeof sessionId !== 'string' || sessionId.length > 256)) throw errWith('invalid_body', 'sessionId invalide')

    checkExpiries()
    const job = jobs.get(id)
    if (!job) throw errWith('not_found', `job ${id} inconnu`)
    // Dead-letter toleree : job deja expire mais meme lease + JOB_EXPIRED.
    if (job.status === 'expired') {
      if (job.leaseId === leaseId && code === 'JOB_EXPIRED') {
        if (!job.failure) {
          job.failure = { code, message: message.slice(0, maxFailMessageChars), cleanupFailed, sessionId }
          job.finishedAtMs = job.finishedAtMs || now()
          try { persist() } catch (_) { /* ignore */ }
        }
        return { http: 200, body: { stored: true } }
      }
      throw errWith('lease_conflict', `job ${id} expire (dead-letter JOB_EXPIRED seule acceptee)`)
    }
    if (job.status !== 'claimed') {
      throw errWith('lease_conflict', `job ${id} non reclame (statut ${job.status})`)
    }
    if (job.leaseId !== leaseId) {
      throw errWith('lease_conflict', 'lease invalide ou perime')
    }
    const t = now()
    const isExpired = t >= job.leaseExpiresAtMs || t >= job.deadlineAtMs
    if (isExpired && code !== 'JOB_EXPIRED') {
      job.status = 'expired'
      job.finishedAtMs = t
      job.failure = job.failure || { code: 'JOB_EXPIRED', message: 'job expire (fail non JOB_EXPIRED refuse)', cleanupFailed: false, sessionId: null }
      try { persist() } catch (_) { /* ignore */ }
      settleReject(id, errWith('JOB_EXPIRED', `job ${id} expire`))
      throw errWith('lease_conflict', 'job expire (fail JOB_EXPIRED attendu)')
    }
    if (isExpired && code === 'JOB_EXPIRED') {
      job.status = 'expired'
      job.finishedAtMs = t
      job.failure = { code, message: message.slice(0, maxFailMessageChars), cleanupFailed, sessionId }
      try { persist() } catch (_) { /* ignore */ }
      settleReject(id, errWith('JOB_EXPIRED', `job ${id} expire (dead-letter)`))
      return { http: 200, body: { stored: true } }
    }
    job.status = 'failed'
    job.finishedAtMs = t
    job.failure = { code, message: message.slice(0, maxFailMessageChars), cleanupFailed, sessionId }
    try { persist() } catch (_) { /* memoire fait foi */ }
    const err = errWith(code, `job ${id} echec ${code} : ${message.slice(0, 200)}`)
    err.failure = { code, message: message.slice(0, maxFailMessageChars), cleanupFailed, sessionId, jobId: id }
    settleReject(id, err)
    return { http: 200, body: { stored: true } }
  }

  function postCancel (id, body) {
    if (!isPlainObject(body)) throw errWith('invalid_body', 'corps invalide')
    try { assertSafeJson(body, { strMax: 4096 }) } catch (e) { throw e }
    const leaseId = body.leaseId
    assertId(leaseId, 'leaseId')
    checkExpiries()
    const job = jobs.get(id)
    if (!job) throw errWith('not_found', `job ${id} inconnu`)
    if (job.status !== 'claimed') {
      throw errWith('lease_conflict', `job ${id} non reclame (statut ${job.status}, cancel refuse)`)
    }
    if (job.leaseId !== leaseId) {
      throw errWith('lease_conflict', 'lease invalide ou perime')
    }
    const t = now()
    if (t >= job.leaseExpiresAtMs || t >= job.deadlineAtMs) {
      job.status = 'expired'
      job.finishedAtMs = t
      job.failure = job.failure || { code: 'JOB_EXPIRED', message: 'cancel perime (job expire)', cleanupFailed: false, sessionId: null }
      try { persist() } catch (_) { /* ignore */ }
      settleReject(id, errWith('JOB_EXPIRED', `job ${id} expire (cancel perime refuse)`))
      throw errWith('lease_conflict', 'lease expire (cancel refuse)')
    }
    // Restitution volontaire : redevient reclamable, meme id, lease efface.
    // La promesse hote reste en attente (pas d abort hote ici).
    job.status = 'queued'
    job.leaseId = null
    job.leaseExpiresAtMs = null
    try { persist() } catch (_) { /* memoire fait foi */ }
    return { http: 200, body: { cancelled: true } }
  }

  async function handle (req, res) {
    try {
      const method = String(req.method || '').toUpperCase()
      let pathname = ''
      try {
        pathname = new URL(String(req.url || '/'), 'http://loopback').pathname
      } catch (_) {
        send(res, 400, { error: 'invalid_path' })
        return
      }
      if (method !== 'POST') {
        send(res, 404, { error: 'not_found' })
        return
      }
      const auth = req.headers ? req.headers.authorization : null
      const expected = `Bearer ${token}`
      if (!safeEqualBearer(typeof auth === 'string' ? auth : '', expected)) {
        send(res, 401, { error: 'unauthorized' })
        return
      }
      if (pathname === '/relay/jobs/claim') {
        let raw
        try {
          raw = await readBody(req, DEFAULTS.claimBodyMaxBytes)
        } catch (e) {
          if (e && e.code === 'too_large') { send(res, 413, { error: 'too_large' }); return }
          send(res, 400, { error: 'invalid_body' })
          return
        }
        let body
        try {
          body = raw.trim() === '' ? {} : JSON.parse(raw)
        } catch (_) {
          send(res, 400, { error: 'invalid_body' })
          return
        }
        try {
          if (!isPlainObject(body)) throw errWith('invalid_body', 'corps invalide')
          assertSafeJson(body, { strMax: 4096 })
          const workerId = body.workerId
          if (typeof workerId !== 'string' || workerId.trim() === '' || workerId.length > 128) {
            throw errWith('invalid_body', 'workerId manquant')
          }
          const job = claimOne(workerId)
          send(res, 200, { job })
        } catch (e) {
          if (e && e.code === 'too_large') send(res, 413, { error: 'too_large' })
          else send(res, 400, { error: 'invalid_body' })
        }
        return
      }
      const m = pathname.match(/^\/relay\/jobs\/([^/]+)\/(result|fail|cancel)$/)
      if (!m) {
        // Pas de route d enqueue ni de status HTTP : tout le reste est 404
        // (ne pas inventer d endpoints).
        // On consomme le corps pour ne pas laisser la socket pendante.
        try { await readBody(req, 65536) } catch (_) { /* ignore */ }
        send(res, 404, { error: 'not_found' })
        return
      }
      const id = decodeURIComponent(m[1])
      const kind = m[2]
      if (!ID_RE.test(id)) {
        try { await readBody(req, 65536) } catch (_) { /* ignore */ }
        send(res, 404, { error: 'not_found' })
        return
      }
      const maxBytes = kind === 'result' ? DEFAULTS.resultBodyMaxBytes : 65536
      let raw
      try {
        raw = await readBody(req, maxBytes)
      } catch (e) {
        if (e && e.code === 'too_large') { send(res, 413, { error: 'too_large' }); return }
        send(res, 400, { error: 'invalid_body' })
        return
      }
      let body
      try {
        body = raw.trim() === '' ? {} : JSON.parse(raw)
      } catch (_) {
        send(res, 400, { error: 'invalid_body' })
        return
      }
      try {
        let out
        if (kind === 'result') out = postResult(id, body)
        else if (kind === 'fail') out = postFail(id, body)
        else out = postCancel(id, body)
        send(res, out.http, out.body)
      } catch (e) {
        const code = e && e.code ? e.code : 'invalid_body'
        if (code === 'not_found') send(res, 404, { error: 'not_found' })
        else if (code === 'lease_conflict') send(res, 409, { error: 'lease_conflict' })
        else if (code === 'too_large' || code === 'JOB_TOO_LARGE') send(res, 413, { error: 'too_large' })
        else send(res, 400, { error: 'invalid_body' })
      }
    } catch (_) {
      try { send(res, 500, { error: 'internal' }) } catch (_) { /* ignore */ }
    }
  }

  function close () {
    for (const [, w] of waiters) {
      if (w.timer) clearTimeout(w.timer)
      if (w.signal && w.onAbort) {
        try { w.signal.removeEventListener('abort', w.onAbort) } catch (_) { /* ignore */ }
      }
    }
  }

  // --- Reprise sur store : pending/leased -> interrupted/unknown. ---
  // Seul un nouveau requestTrusted() hote explicite rejoue (jamais de
  // requeue automatique, voir entete).
  if (store) {
    let loaded = null
    try {
      loaded = store.load()
    } catch (e) {
      throw new Error(`relay-queue: store illisible (${e.message || e})`)
    }
    if (loaded !== null && loaded !== undefined) {
      if (!isPlainObject(loaded) || !Array.isArray(loaded.jobs)) {
        throw new Error('relay-queue: snapshot store corrompu (objet { version, jobs[] } attendu)')
      }
      for (const raw of loaded.jobs) {
        if (!isPlainObject(raw) || typeof raw.id !== 'string' || !ID_RE.test(raw.id)) continue
        const job = {
          id: raw.id,
          system: typeof raw.system === 'string' ? raw.system : '',
          user: typeof raw.user === 'string' ? raw.user : '',
          status: typeof raw.status === 'string' ? raw.status : 'interrupted',
          leaseId: typeof raw.leaseId === 'string' && ID_RE.test(raw.leaseId) ? raw.leaseId : null,
          leaseExpiresAtMs: Number.isFinite(Number(raw.leaseExpiresAtMs)) ? Number(raw.leaseExpiresAtMs) : null,
          deadlineAtMs: Number.isFinite(Number(raw.deadlineAtMs)) ? Number(raw.deadlineAtMs) : now(),
          createdAtMs: Number.isFinite(Number(raw.createdAtMs)) ? Number(raw.createdAtMs) : now(),
          finishedAtMs: Number.isFinite(Number(raw.finishedAtMs)) ? Number(raw.finishedAtMs) : null,
          result: isPlainObject(raw.result) || raw.result === null ? (raw.result || null) : null,
          failure: isPlainObject(raw.failure) || raw.failure === null ? (raw.failure || null) : null,
          fingerprint: typeof raw.fingerprint === 'string' ? raw.fingerprint : null
        }
        if (job.status === 'queued' || job.status === 'claimed') {
          job.status = 'interrupted'
          job.finishedAtMs = now()
          job.failure = {
            code: 'RELAY_RESTART',
            message: 'interrompu au redemarrage (resultat unknown, rerun hote explicite requis)',
            cleanupFailed: false,
            sessionId: null
          }
        }
        jobs.set(job.id, job)
      }
      // Persiste le marquage interrupted immediatement (pas de requeue).
      try { persist() } catch (_) { /* memoire fait foi */ }
    }
  }

  return {
    requestTrusted,
    cancelRequest,
    handle,
    status,
    lookupJob,
    checkExpiries,
    close
  }
}

module.exports = {
  createRelayQueue,
  RELAY_MODEL,
  RELAY_VARIANT,
  KNOWN_FAIL_CODES,
  DEFAULTS
}
