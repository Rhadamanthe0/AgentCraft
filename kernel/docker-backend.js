'use strict'

// kernel/docker-backend.js — Backend lifecycle Docker pour le noyau (D52 isole).
//
// PERIMETRE : lifecycle compatible `supervisor/core.js` (start / stop /
// waitExit / checkHealth + getExit / isChildAlive / destroy / getLogs), sans
// Docker CLI, sans socket cote bot, sans RCON, sans connexion bot. Le transport
// Docker Engine passe par HTTP `node:http` sur socket Unix (option host
// `socketPath`), injectable par `request` pour les tests (mock pur, aucun
// conteneur reel). Zero dependance externe : `node:http` + `node:querystring`
// implicite uniquement.
//
// DELEGATION EXPLICITE : ce backend NE build PAS et NE npm PAS (tache future
// distincte). `imageResolver(descriptor)` (host TRUSTED) rend une reference
// image IMMUABLE pre-construite `repo@sha256:<64hex>` + le `manifestDigest`
// correspondant ; le backend valide les deux et refuse tout `image` /
// `source` / `auto` / `path` venu du worker/descripteur (ignore, jamais lu).
//
// PROPRIETE : seuls les conteneurs crees par ce backend (registre `owned`)
// sont touches. Labels FORCES : `kernel.managed=true` + `kernel.project` +
// `kernel.version` + `kernel.manifest` + `kernel.instance`. Chaque operation
// (stop/kill/remove/inspect) re-inspecte et exige labels + version + digest
// EXACTS ; un conteneur Minecraft/legacy/autre projet est refuse, meme avec
// `service=bot` seul (insuffisant). Aucun `GET /containers/json` (liste),
// aucun proxy d endpoint arbitraire : le wrapper `docker()` n emet que les
// 7 routes du conteneur gere.
//
// CONFIG FORCEE a la creation : `User 1000:1000`, `CapDrop ALL`, `CapAdd []`,
// `Privileged false`, `ReadonlyRootfs true`, `SecurityOpt no-new-privileges`,
// `Tmpfs /tmp`, mounts = SEUL volume nomme trusted (`dataVolume` -> `/data`)
// + contenu de l image trusted (jamais de bind host). JAMAIS : socket Docker,
// host PID/IPC/network, devices, binds host, credentials rcon/control.
// Reseau = `networkName` trusted (projet). Env worker = allowlist explicite
// (jeux model publics + PLANNER_API_KEY/REPAIR_API_KEY pour le pilote ;
// ces cles pilote != controle kernel).
//
// SANTE : `checkHealth()` = preuve APP fraiche (≠ mission) : inspect
// `State.Running` + IP Docker decouverte + sonde HTTP interne
// (`probe.port/path` trusted, JAMAIS une URL caller) vers `/api/status`,
// reponse bornee (`responseMaxBytes`) + timeout (`probeTimeoutMs`). Retour
// compatible core : `{ alive, version, pid:null, heartbeatAgeMs,
// heartbeatSeq, readyCount, probeOk }` ; `heartbeatAgeMs` = age de la derniere
// sonde OK (0 si fraiche), `null` si jamais OK. Le noyau juge la fraicheur
// via `requireHeartbeat` (voir `supervisor/core.js:responsiveEnough`).
//
// ARRET : `stop()` = `POST stop` (grace) puis `POST kill` si encore Running,
// puis attente `State.Running==false` avec horodatage ; timeout =>
// `{ stopped:false, unknown:true }`, JAMAIS de liveness factice. `waitExit()`
// = preuve `Running==false` (code `State.ExitCode`). `getLogs()` = tail
// borne + REDACTED (jamais stdout full, jamais de secret).
//
// PRIVILEGES (integrateur) : le socket Docker equivaut a root sur l hote.
// Ce backend est TRUSTED kernel-only : `socketPath` host, jamais expose au
// worker/modele/reseau. Un socket monte `ro` N EST PAS une API readonly
// (le daemon ne distingue pas) : ne jamais monter le socket dans le worker,
// ne jamais passer `DOCKER_HOST` au worker (filtre par allowlist).
//
// LIMITATIONS : images pre-construites uniquement (pas de build ici) ;
// `destroy()` synchrone = best-effort async fire-and-forget (orphelin
// possible sans boucle evenementielle : preferer `stop`+`waitExit` avant
// `close`) ; pas de PID hote (`pid:null`, `isChildAlive` = Running cache) ;
// l ordonnancement reseau/volumes est externe (noms trusted fournis).
//
// API exacte :
//   createDockerBackend({ request?, socketPath?, imageResolver, project,
//     networkName, dataVolume?, instanceId, workerEnv?, probe, httpProbe?,
//     stopGraceMs?, stopWaitMs?, opTimeoutMs?, probeTimeoutMs?,
//     responseMaxBytes?, logBytesMax?, nowFn? })
//     -> { start(d), stop(r?), waitExit(), checkHealth(), getExit(),
//          getPid(), isChildAlive(), getLogs(n?), getStats(), destroy(),
//          close() }

const http = require('node:http')

const VERSION_RE = /^[A-Za-z0-9._-]{1,64}$/
const IMAGE_DIGEST_RE = /^[^@\s]+@sha256:[0-9a-f]{64}$/
const CONTAINER_ID_RE = /^[0-9a-f]{64}$/
const PROJECT_RE = /^[A-Za-z0-9._-]{1,32}$/
const VOLUME_RE = /^[A-Za-z0-9_.-]{1,64}$/
const NETWORK_RE = /^[A-Za-z0-9_.-]{1,128}$/
const PROBE_PATH_RE = /^\/[A-Za-z0-9._\-/]{0,128}$/

// Allowlist ENV explicite : jeux model publics + cles pilote admises.
// Tout le reste (RCON, OPS, DOCKER_*, KERNEL_*, CONTROL, credentials) est
// JETE (jamais transmis au worker). Les cles pilote != controle kernel.
const ALLOWED_ENV = Object.freeze([
  'PLANNER_MODEL',
  'PLANNER_BASE_URL',
  'PLANNER_SESSION_ID',
  'PLANNER_TIMEOUT_MS',
  'PLANNER_PLAN_MAX',
  'REPAIR_MODEL',
  'REPAIR_BASE_URL',
  'MC_HOST',
  'MC_PORT',
  'BOT_USERNAME',
  'PLANNER_API_KEY',
  'REPAIR_API_KEY'
])
const ALLOWED_ENV_SET = new Set(ALLOWED_ENV)

const LABEL_MANAGED = 'kernel.managed'
const LABEL_PROJECT = 'kernel.project'
const LABEL_VERSION = 'kernel.version'
const LABEL_MANIFEST = 'kernel.manifest'
const LABEL_INSTANCE = 'kernel.instance'

function refusal (code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

function isPlainObject (value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout (promise, ms, code, message) {
  let timer = null
  const gate = new Promise((_, reject) => {
    timer = setTimeout(() => reject(refusal(code, message)), ms)
  })
  return Promise.race([promise, gate]).then(
    (value) => { clearTimeout(timer); return value },
    (err) => { clearTimeout(timer); throw err }
  )
}

// Redaction secrets : motifs + valeurs exactes des cles *_API_KEY fournies.
function redactSecrets (text, secretValues) {
  let out = String(text == null ? '' : text)
  out = out.replace(/PLANNER_API_KEY\s*=\s*[^\s"'`,;]+/g, 'PLANNER_API_KEY=[redacted]')
  out = out.replace(/REPAIR_API_KEY\s*=\s*[^\s"'`,;]+/g, 'REPAIR_API_KEY=[redacted]')
  out = out.replace(/RCON_PASSWORD\s*=\s*[^\s"'`,;]+/g, 'RCON_PASSWORD=[redacted]')
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/-]+/g, 'Bearer [redacted]')
  out = out.replace(/\bsk-[A-Za-z0-9-_]{8,}\b/g, '[redacted]')
  out = out.replace(/\bopencode-go-[A-Za-z0-9._-]{4,}\b/g, '[redacted]')
  if (Array.isArray(secretValues)) {
    for (const value of secretValues) {
      if (typeof value === 'string' && value.length >= 8 && out.includes(value)) {
        out = out.split(value).join('[redacted]')
      }
    }
  }
  return out
}

// Requete Docker par defaut : HTTP builtin sur socket Unix, corps borne.
function makeSocketRequest (socketPath, opTimeoutMs) {
  return async function socketRequest (args) {
    const method = args && args.method
    const relPath = args && args.path
    if (typeof relPath !== 'string' || !relPath.startsWith('/')) {
      throw refusal('proxy-forbidden', 'chemin docker relatif requis')
    }
    const payload = args && args.body != null ? JSON.stringify(args.body) : null
    const headers = {}
    if (payload !== null) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = Buffer.byteLength(payload)
    }
    const outcome = await withTimeout(new Promise((resolve, reject) => {
      const req = http.request(
        { socketPath, path: relPath, method, headers },
        (res) => {
          let raw = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => {
            raw += chunk
            if (raw.length > 1048576) {
              try { req.destroy() } catch { /* ignore */ }
              reject(refusal('response-huge', 'reponse docker > 1M (bornee)'))
            }
          })
          res.on('end', () => resolve({ status: res.statusCode, raw }))
          res.on('error', reject)
        }
      )
      req.on('error', reject)
      req.on('timeout', () => {
        try { req.destroy() } catch { /* ignore */ }
        reject(refusal('docker-timeout', `docker ${method} ${relPath} : delai depasse`))
      })
      req.setTimeout(opTimeoutMs)
      if (payload !== null) req.write(payload)
      req.end()
    }), opTimeoutMs, 'docker-timeout', `docker ${method} ${relPath} : delai depasse`)
    let parsed = null
    const raw = outcome.raw == null ? '' : String(outcome.raw)
    if (raw !== '') {
      try { parsed = JSON.parse(raw) } catch { parsed = raw }
    }
    if (outcome.status >= 400) {
      throw refusal('docker-error', `docker ${method} ${relPath} : HTTP ${outcome.status}`)
    }
    return { status: outcome.status, body: parsed }
  }
}

// Sonde HTTP worker par defaut : IP Docker + port/path trusted, bornee.
function defaultHttpProbe (ip, port, probePath, timeoutMs, maxBytes) {
  return withTimeout(new Promise((resolve, reject) => {
    const req = http.get(
      { host: ip, port, path: probePath, timeout: timeoutMs },
      (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          raw += chunk
          if (raw.length > maxBytes) {
            try { req.destroy() } catch { /* ignore */ }
            reject(refusal('response-huge', `sonde > ${maxBytes} o (bornee)`))
          }
        })
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(refusal('probe-unready', `sonde HTTP ${res.statusCode}`))
            return
          }
          try {
            resolve(JSON.parse(raw))
          } catch {
            reject(refusal('probe-unready', 'sonde non JSON'))
          }
        })
        res.on('error', () => reject(refusal('probe-unready', 'sonde illisible')))
      }
    )
    req.on('error', () => reject(refusal('probe-unready', 'sonde injoignable')))
    req.on('timeout', () => {
      try { req.destroy() } catch { /* ignore */ }
      reject(refusal('probe-timeout', 'sonde delai depasse'))
    })
  }), timeoutMs, 'probe-timeout', 'sonde delai depasse')
}

function createDockerBackend (opts) {
  if (!isPlainObject(opts)) throw new TypeError('options objet requises')
  const imageResolver = opts.imageResolver
  if (typeof imageResolver !== 'function') throw new TypeError('imageResolver host TRUSTED requis')
  const project = opts.project
  if (typeof project !== 'string' || !PROJECT_RE.test(project)) {
    throw new TypeError('project namespace fixe requis (1..32, [A-Za-z0-9._-])')
  }
  const networkName = opts.networkName
  if (typeof networkName !== 'string' || !NETWORK_RE.test(networkName)) {
    throw new TypeError('networkName projet trusted requis')
  }
  const dataVolume = opts.dataVolume == null ? 'bot-data' : opts.dataVolume
  if (typeof dataVolume !== 'string' || !VOLUME_RE.test(dataVolume)) {
    throw new TypeError('dataVolume volume nomme trusted requis')
  }
  const instanceId = opts.instanceId
  if (typeof instanceId !== 'string' || !VERSION_RE.test(instanceId)) {
    throw new TypeError('instanceId owner trusted requis (1..64, [A-Za-z0-9._-])')
  }
  const probe = opts.probe
  if (!isPlainObject(probe) || !Number.isInteger(probe.port) || probe.port < 1 || probe.port > 65535) {
    throw new TypeError('probe { port, path } trusted requis (port 1..65535)')
  }
  if (typeof probe.path !== 'string' || !PROBE_PATH_RE.test(probe.path)) {
    throw new TypeError('probe.path trusted requis (/..., 0..128)')
  }
  const workerEnv = opts.workerEnv == null ? {} : opts.workerEnv
  if (!isPlainObject(workerEnv)) throw new TypeError('workerEnv objet requis si fourni')
  for (const [key, value] of Object.entries(workerEnv)) {
    if (typeof value !== 'string') throw new TypeError(`workerEnv[${key}] chaine requise`)
  }
  const socketPath = opts.socketPath == null ? '/var/run/docker.sock' : opts.socketPath
  if (typeof socketPath !== 'string' || socketPath === '' || socketPath.includes('\0')) {
    throw new TypeError('socketPath host trusted requis')
  }
  const stopGraceMs = Number(opts.stopGraceMs == null ? 2000 : opts.stopGraceMs)
  const stopWaitMs = Number(opts.stopWaitMs == null ? 8000 : opts.stopWaitMs)
  const opTimeoutMs = Number(opts.opTimeoutMs == null ? 8000 : opts.opTimeoutMs)
  const probeTimeoutMs = Number(
    opts.probeTimeoutMs == null ? (probe.timeoutMs == null ? 500 : probe.timeoutMs) : opts.probeTimeoutMs
  )
  const responseMaxBytes = Number(opts.responseMaxBytes == null ? 65536 : opts.responseMaxBytes)
  const logBytesMax = Number(opts.logBytesMax == null ? 65536 : opts.logBytesMax)
  if (!Number.isFinite(stopGraceMs) || stopGraceMs < 50 || stopGraceMs > 30000) {
    throw new TypeError('stopGraceMs borne 50..30000 requise')
  }
  if (!Number.isFinite(stopWaitMs) || stopWaitMs < 500 || stopWaitMs > 30000) {
    throw new TypeError('stopWaitMs borne 500..30000 requise')
  }
  if (!Number.isFinite(opTimeoutMs) || opTimeoutMs < 200 || opTimeoutMs > 30000) {
    throw new TypeError('opTimeoutMs borne 200..30000 requise')
  }
  if (!Number.isFinite(probeTimeoutMs) || probeTimeoutMs < 50 || probeTimeoutMs > 5000) {
    throw new TypeError('probeTimeoutMs borne 50..5000 requise')
  }
  if (!Number.isFinite(responseMaxBytes) || responseMaxBytes < 1024 || responseMaxBytes > 262144) {
    throw new TypeError('responseMaxBytes borne 1024..262144 requise')
  }
  if (!Number.isFinite(logBytesMax) || logBytesMax < 1024 || logBytesMax > 1048576) {
    throw new TypeError('logBytesMax borne 1024..1048576 requise')
  }
  const nowFn = opts.nowFn == null ? Date.now : opts.nowFn
  if (typeof nowFn !== 'function') throw new TypeError('nowFn fonction requise si fournie')

  // Env filtre des la factory : allowlist seule, secrets jamais logues.
  const secretValues = []
  const filteredEnv = []
  for (const [key, value] of Object.entries(workerEnv)) {
    if (!ALLOWED_ENV_SET.has(key)) continue
    filteredEnv.push(`${key}=${value}`)
    if (key.endsWith('_API_KEY') && value.length >= 8) secretValues.push(value)
  }
  Object.freeze(filteredEnv)

  const rawRequest = typeof opts.request === 'function'
    ? opts.request
    : makeSocketRequest(socketPath, opTimeoutMs)
  const httpProbe = typeof opts.httpProbe === 'function'
    ? opts.httpProbe
    : (ip, port, probePath) => defaultHttpProbe(ip, port, probePath, probeTimeoutMs, responseMaxBytes)

  // Registre owner : id -> { version, manifestDigest }. Jamais vide par list.
  const owned = new Map()
  let activeId = null
  let activeExpected = null
  let exitInfo = null
  let lastAlive = false
  let destroyed = false
  let starts = 0
  let readyCount = 0
  let probeSeq = 0
  let lastProbeAt = null
  let probeCalls = 0
  let probeFails = 0
  let forgeriesRefused = 0

  // Wrapper ferme : 7 routes du conteneur gere, jamais de liste ni proxy.
  // Tout id present dans le chemin doit appartenir au registre `owned`.
  async function docker (args) {
    const method = args && args.method
    const relPath = args && args.path
    if ((method !== 'GET' && method !== 'POST' && method !== 'DELETE') || typeof relPath !== 'string') {
      throw refusal('proxy-forbidden', 'methode/chemin docker non autorise')
    }
    const createRe = /^(?:\/v\d+\.\d+)?\/containers\/create(?:\?.*)?$/
    const opRe = /^(?:\/v\d+\.\d+)?\/containers\/([0-9a-f]{64})\/([A-Za-z]+)(?:\?.*)?$/
    const inspectRe = /^(?:\/v\d+\.\d+)?\/containers\/([0-9a-f]{64})\/json(?:\?.*)?$/
    const removeRe = /^(?:\/v\d+\.\d+)?\/containers\/([0-9a-f]{64})(?:\?.*)?$/
    const logsRe = /^(?:\/v\d+\.\d+)?\/containers\/([0-9a-f]{64})\/logs(?:\?.*)?$/
    let idInPath = null
    let allowed = false
    if (method === 'POST' && createRe.test(relPath)) {
      allowed = true
    } else if (inspectRe.test(relPath)) {
      idInPath = relPath.match(inspectRe)[1]
      allowed = true
    } else if (opRe.test(relPath)) {
      const match = relPath.match(opRe)
      idInPath = match[1]
      const verb = match[2]
      allowed = (method === 'POST' && (verb === 'start' || verb === 'stop' || verb === 'kill')) ||
        (method === 'GET' && verb === 'json') ||
        (method === 'GET' && verb === 'logs')
    } else if (removeRe.test(relPath) && method === 'DELETE') {
      idInPath = relPath.match(removeRe)[1]
      allowed = !relPath.includes('/logs')
    } else if (logsRe.test(relPath) && method === 'GET') {
      idInPath = relPath.match(logsRe)[1]
      allowed = true
    }
    if (!allowed) throw refusal('proxy-forbidden', `route docker non autorisee : ${method} ${relPath.slice(0, 80)}`)
    if (idInPath !== null && !owned.has(idInPath)) {
      forgeriesRefused += 1
      throw refusal('unknown-container', 'conteneur hors registre owner : operation refusee')
    }
    return withTimeout(
      Promise.resolve().then(() => rawRequest({ method, path: relPath, body: args && args.body })),
      opTimeoutMs,
      'docker-timeout',
      `docker ${method} delai depasse`
    )
  }

  function labelsOf (inspectBody) {
    if (!isPlainObject(inspectBody)) return {}
    const fromConfig = inspectBody.Config && inspectBody.Config.Labels
    const direct = inspectBody.Labels
    if (isPlainObject(fromConfig)) return fromConfig
    if (isPlainObject(direct)) return direct
    return {}
  }

  // Verification propriete : labels + version + digest EXACTS du registre.
  // `service=bot` seul (ou tout label partiel) ne suffit jamais.
  async function verifyManaged (id) {
    const expected = owned.get(id)
    if (!expected) {
      forgeriesRefused += 1
      throw refusal('unknown-container', 'conteneur hors registre owner : operation refusee')
    }
    const res = await docker({ method: 'GET', path: `/containers/${id}/json` })
    const labels = labelsOf(res && res.body)
    const ok = labels[LABEL_MANAGED] === 'true' &&
      labels[LABEL_PROJECT] === project &&
      labels[LABEL_VERSION] === expected.version &&
      labels[LABEL_MANIFEST] === expected.manifestDigest &&
      labels[LABEL_INSTANCE] === instanceId
    if (!ok) {
      forgeriesRefused += 1
      throw refusal('forgery', 'conteneur non gere par ce backend (labels/version/instance) : refuse')
    }
    return res.body
  }

  function containerIp (inspectBody) {
    try {
      const nets = inspectBody && inspectBody.NetworkSettings && inspectBody.NetworkSettings.Networks
      if (isPlainObject(nets) && isPlainObject(nets[networkName]) && typeof nets[networkName].IPAddress === 'string') {
        const ip = nets[networkName].IPAddress
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip
      }
      const flat = inspectBody && inspectBody.NetworkSettings && inspectBody.NetworkSettings.IPAddress
      if (typeof flat === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(flat)) return flat
    } catch { /* ignore */ }
    return null
  }

  function buildCreateBody (resolved, descriptor) {
    // TOUT champ worker/descripteur hors { version, manifestDigest } est
    // IGNORE ici (image/source/env/mounts/network/url/command : jamais lus).
    return {
      Image: resolved.image,
      User: '1000:1000',
      Env: [...filteredEnv],
      Labels: {
        [LABEL_MANAGED]: 'true',
        [LABEL_PROJECT]: project,
        [LABEL_VERSION]: descriptor.version,
        [LABEL_MANIFEST]: descriptor.manifestDigest,
        [LABEL_INSTANCE]: instanceId
      },
      HostConfig: {
        Privileged: false,
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        CapAdd: [],
        SecurityOpt: ['no-new-privileges'],
        NetworkMode: networkName,
        Mounts: [{ Type: 'volume', Source: dataVolume, Target: '/data', ReadOnly: false }],
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m' },
        Binds: [],
        Devices: [],
        PidMode: '',
        IpcMode: '',
        AutoRemove: false,
        RestartPolicy: { Name: '', MaximumRetryCount: 0 }
      },
      NetworkingConfig: { EndpointsConfig: { [networkName]: {} } }
    }
  }

  async function start (descriptor) {
    if (destroyed) throw refusal('destroyed', 'backend detruit : aucun demarrage')
    if (activeId !== null && exitInfo === null) {
      throw refusal('already-running', 'un conteneur tourne deja : stop + sortie reelle d abord')
    }
    if (!isPlainObject(descriptor) || typeof descriptor.version !== 'string' || !VERSION_RE.test(descriptor.version)) {
      throw refusal('version', 'descriptor.version identifiant requis pour le backend')
    }
    if (typeof descriptor.manifestDigest !== 'string' ||
      descriptor.manifestDigest.length < 8 || descriptor.manifestDigest.length > 256) {
      throw refusal('candidate-manifest', 'descriptor.manifestDigest requis (chaine 8..256)')
    }
    // Resolution host TRUSTED : image IMMUABLE + digest correspondant.
    // Aucune construction ici (ni build ni npm).
    let resolved = null
    try {
      resolved = await imageResolver(descriptor)
    } catch (err) {
      throw err && err.code ? err : refusal('image-resolve', String((err && err.message) || err))
    }
    if (!isPlainObject(resolved) || typeof resolved.image !== 'string' || !IMAGE_DIGEST_RE.test(resolved.image)) {
      throw refusal('image-pinned', 'imageResolver doit rendre une reference IMMUABLE repo@sha256:<64hex> (pre-construite)')
    }
    if (resolved.manifestDigest !== descriptor.manifestDigest) {
      throw refusal('digest-mismatch', 'imageResolver.manifestDigest != descriptor.manifestDigest : refuse')
    }
    const rand = `${nowFn().toString(36)}${Math.floor(Math.random() * 0xffff).toString(16)}`
      .replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 16)
    const name = `${project}-kernel-${descriptor.version}-${rand}`.slice(0, 128)
    const body = buildCreateBody(resolved, descriptor)
    const created = await docker({
      method: 'POST',
      path: `/containers/create?name=${encodeURIComponent(name)}`,
      body
    })
    const id = created && created.body && created.body.Id
    if (typeof id !== 'string' || !CONTAINER_ID_RE.test(id)) {
      throw refusal('docker-error', 'creation conteneur : Id hex64 attendu')
    }
    owned.set(id, { version: descriptor.version, manifestDigest: descriptor.manifestDigest })
    try {
      await docker({ method: 'POST', path: `/containers/${id}/start` })
    } catch (err) {
      throw err
    }
    activeId = id
    activeExpected = { version: descriptor.version, manifestDigest: descriptor.manifestDigest }
    exitInfo = null
    lastAlive = true
    starts += 1
    readyCount = 0
    probeSeq = 0
    lastProbeAt = null
    // Reponse API de spawn : LANCE, pas pret (readiness = checkHealth sonde).
    return { id, image: resolved.image, starts }
  }

  // Arret borne HONNETE : stop (grace) puis kill si encore Running.
  // Timeout => { stopped:false, unknown:true }, jamais de preuve factice.
  async function stop (reason) {
    if (activeId === null) return { stopped: true, noChild: true, reason: reason || null }
    if (exitInfo !== null) return { stopped: true, ...exitInfo }
    const id = activeId
    await verifyManaged(id)
    const stopSecs = Math.max(1, Math.ceil(stopGraceMs / 1000))
    try {
      await docker({ method: 'POST', path: `/containers/${id}/stop?t=${stopSecs}` })
    } catch (err) {
      if (!err || (err.code !== 'docker-error' && err.code !== 'docker-timeout')) throw err
      // Stop 304/500 = deja en arret : on passe a la preuve Running.
    }
    const deadline = nowFn() + stopWaitMs
    const graceEnd = nowFn() + stopGraceMs
    let killSent = false
    for (;;) {
      const res = await docker({ method: 'GET', path: `/containers/${id}/json` })
      const state = res && res.body && res.body.State
      if (!isPlainObject(state) || state.Running !== true) {
        exitInfo = {
          code: typeof state.ExitCode === 'number' ? state.ExitCode : null,
          signal: null,
          at: new Date(nowFn()).toISOString()
        }
        lastAlive = false
        return { stopped: true, graceful: !killSent, ...exitInfo }
      }
      if (!killSent && nowFn() >= graceEnd) {
        await verifyManaged(id)
        try {
          await docker({ method: 'POST', path: `/containers/${id}/kill?signal=SIGKILL` })
        } catch { /* preuve Running ci-dessous */ }
        killSent = true
      }
      if (nowFn() >= deadline) {
        lastAlive = true
        return { stopped: false, unknown: true, graceful: false, reason: reason || null }
      }
      await sleep(50)
    }
  }

  // SORTIE REELLE : Running==false observe (avec horodatage). Sans borne
  // interne (le noyau borne via stopWaitMs) ; 404 => gone honnete.
  async function waitExit () {
    if (activeId === null) return { code: null, signal: null, noChild: true }
    if (exitInfo !== null) return { ...exitInfo }
    const id = activeId
    for (;;) {
      let res = null
      try {
        res = await docker({ method: 'GET', path: `/containers/${id}/json` })
      } catch (err) {
        if (err && err.code === 'docker-error') {
          exitInfo = { code: null, signal: null, gone: true, at: new Date(nowFn()).toISOString() }
          lastAlive = false
          return { ...exitInfo }
        }
        throw err
      }
      const state = res && res.body && res.body.State
      if (!isPlainObject(state) || state.Running !== true) {
        exitInfo = {
          code: state && typeof state.ExitCode === 'number' ? state.ExitCode : null,
          signal: null,
          at: new Date(nowFn()).toISOString()
        }
        lastAlive = false
        return { ...exitInfo }
      }
      await sleep(50)
    }
  }

  // Sante APP fraiche : Running + IP trusted + sonde HTTP bornee.
  // Compatible core : le noyau exige alive + version + heartbeat frais.
  async function checkHealth () {
    const empty = (probeOk) => ({
      alive: false,
      version: null,
      pid: null,
      heartbeatAgeMs: lastProbeAt == null ? null : nowFn() - lastProbeAt,
      heartbeatSeq: probeSeq === 0 ? null : probeSeq,
      readyCount,
      probeOk
    })
    if (activeId === null || exitInfo !== null || destroyed) return empty(null)
    const id = activeId
    const expected = owned.get(id)
    if (!expected) {
      forgeriesRefused += 1
      return empty(false)
    }
    let inspectBody = null
    try {
      inspectBody = await verifyManaged(id)
    } catch {
      probeFails += 1
      return empty(false)
    }
    const running = inspectBody && inspectBody.State && inspectBody.State.Running === true
    if (!running) {
      lastAlive = false
      probeFails += 1
      return empty(false)
    }
    lastAlive = true
    const ip = containerIp(inspectBody)
    if (!ip) {
      probeFails += 1
      return empty(false)
    }
    probeCalls += 1
    let probed = null
    try {
      probed = await withTimeout(
        Promise.resolve().then(() => httpProbe(ip, probe.port, probe.path)),
        probeTimeoutMs,
        'probe-timeout',
        'sonde delai depasse'
      )
    } catch {
      probeFails += 1
      return empty(false)
    }
    const rawLen = typeof probed === 'string' ? probed.length : JSON.stringify(probed).length
    if (!Number.isFinite(rawLen) || rawLen > responseMaxBytes) {
      probeFails += 1
      return empty(false)
    }
    if (!isPlainObject(probed)) {
      probeFails += 1
      return empty(false)
    }
    // Version observee differente : exposee telle quelle (alive) pour que le
    // noyau tranche wrong-version vite, comme un second READY process-backend.
    if (typeof probed.version === 'string' && probed.version !== expected.version) {
      return {
        alive: true,
        version: probed.version,
        pid: null,
        heartbeatAgeMs: lastProbeAt == null ? null : nowFn() - lastProbeAt,
        heartbeatSeq: probeSeq === 0 ? null : probeSeq,
        readyCount,
        probeOk: false
      }
    }
    const appReady = probed.version === expected.version &&
      (probed.spawned === true || probed.status === 'ok' || probed.ready === true) &&
      probed.audit !== false
    if (!appReady) {
      probeFails += 1
      return empty(false)
    }
    lastProbeAt = nowFn()
    probeSeq += 1
    readyCount += 1
    return {
      alive: true,
      version: expected.version,
      pid: null,
      heartbeatAgeMs: nowFn() - lastProbeAt,
      heartbeatSeq: probeSeq,
      readyCount,
      probeOk: true
    }
  }

  function getExit () {
    return exitInfo ? { ...exitInfo } : null
  }

  function getPid () {
    return null
  }

  // Observation synchrone : conteneur lance (pas preuve APP).
  function isChildAlive () {
    return activeId !== null && exitInfo === null && lastAlive === true && destroyed === false
  }

  // Logs bornes + REDACTED : jamais stdout full, jamais de secret.
  async function getLogs (maxBytes) {
    const bound = maxBytes == null ? logBytesMax : Number(maxBytes)
    const safe = Number.isFinite(bound) && bound > 0 ? Math.min(bound, logBytesMax) : logBytesMax
    if (activeId === null) {
      return { logsTail: '', bytes: 0, bounded: true, redacted: true, starts }
    }
    const id = activeId
    await verifyManaged(id)
    const res = await docker({ method: 'GET', path: `/containers/${id}/logs?stdout=1&stderr=1&tail=200` })
    const raw = typeof (res && res.body) === 'string' ? res.body : JSON.stringify(res && res.body)
    const redacted = redactSecrets(raw == null ? '' : String(raw), secretValues)
    return {
      logsTail: redacted.slice(-safe),
      bytes: redacted.length,
      bounded: redacted.length <= logBytesMax,
      redacted: true,
      starts
    }
  }

  function getStats () {
    return {
      starts,
      readyCount,
      probeCalls,
      probeFails,
      forgeriesRefused,
      owned: owned.size,
      hasActive: activeId !== null
    }
  }

  // Cleanup synchrone sans orphelin VISE : requete DELETE best-effort
  // fire-and-forget (pas d await possible en sync). Limite honnete : sans
  // boucle evenementielle, l orphelin survit ; preferer stop+waitExit avant.
  function destroy () {
    const id = activeId
    activeId = null
    activeExpected = null
    lastAlive = false
    destroyed = true
    if (id !== null && owned.has(id)) {
      try {
        const outcome = rawRequest({ method: 'DELETE', path: `/containers/${id}?force=1` })
        if (outcome && typeof outcome.catch === 'function') outcome.catch(() => {})
        if (outcome && typeof outcome.then === 'function') {
          outcome.then(() => {}, () => {})
        }
      } catch { /* best-effort */ }
    }
  }

  function close () {
    destroy()
  }

  return {
    start,
    stop,
    waitExit,
    checkHealth,
    getExit,
    getPid,
    isChildAlive,
    getLogs,
    getStats,
    destroy,
    close
  }
}

module.exports = {
  createDockerBackend,
  ALLOWED_ENV,
  LABEL_MANAGED,
  LABEL_PROJECT,
  LABEL_VERSION,
  LABEL_MANIFEST,
  LABEL_INSTANCE,
  IMAGE_DIGEST_RE
}
