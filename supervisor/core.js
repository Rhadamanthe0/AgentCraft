'use strict'

// Noyau de supervision externe D12/D51 (ARCHITECTURE C4/C9, D04/D15).
//
// Petit mecanisme de secours INDEPENDANT du processus surveille : arret total,
// activation versionnee, retour a la derniere version fonctionnelle. Il ne fait
// ni strategie de jeu ni changement de doctrine (C4) et n'est pas modifiable
// par le code qu'il surveille (D51 : toute evolution exige le proprietaire).
// Isolation OS de production NON tranchee : ne pas deployer comme sandbox.
//
// Pipeline D15 (controles PUIS essai reel, jamais l'inverse) :
//   1. CONTROLES (host trusted) : `validateCandidate(version)` reverifie le
//      digest sur disque et renvoie le descripteur canonique ; AUCUN booleen
//      de l'appelant ni du worker n'est cru. Puis `checkQuiescent()` du host
//      (nonce fraiche, generation) : aucune "preuve" worker acceptee.
//   2. ESSAI REEL : la version tourne en `trial` (pending-trial). Startup
//      ready (processus repondant) != succes metier.
// 3. PROMOTION : `lastGood` ne change que via `confirmTrial(version, proof)`
//      valide par le callback trusted `validateTrial`. Sinon, previous
//      lastGood inchange. confirmTrial versionne le CONTROLE (preuve d'essai),
//      jamais la doctrine, jamais par booleen.
//
// Deux limites terminees ici (pas de deploiement prod) :
// A. ANTI-BOUCLE restauration : un lastGood qui READY puis hang a chaque
//    restart ne boucle jamais. Borne par epoque/incident : UNE restauration,
//    puis si la meme version retombe avant `stabilityWindowMs` mesuree =>
//    failed-both/hardstop, cause diagnostique preservee (evenement failed-both
//    { unstable, firstCause }), aucune autoboucle. Le rollback manuel explicite
//    reste possible (intention operateur, journalisee).
// B. QUIESCENCE verifyee noyau : le verdict host est controle (ok, version,
//    nonce EXACTE anti-replay, generation EXACTE, `at` frais : ni plus vieux
//    que `maxQuiescenceAgeMs`, ni plus futur que `maxQuiescenceFutureMs`).
//    Horloge injectable (`nowFn`) pour tests deterministes.
// Hypothese honnete restante : le callback `validateCandidate` lui-meme est
// protege par le host (le noyau reverifie via lui avant chaque usage disque,
// mais ne peut pas prouver son integrite : pas un backend de production).
//
// Perimetre :
// - ce noyau ne connait que le cycle de vie injecte `backend` (start / stop /
//   waitExit / checkHealth). Aucun Docker, aucun RCON, aucun socket ici.
// - apres crash/recovery on REOBSERVE le monde, on ne restaure jamais un actif.
// - totalStop latch PREEMPTE tous les catch/rollback : un failed-both survenant
//   pendant un arret total ne blanchit jamais le latch `stopped`.
// - une attente de sortie bornee qui expire n'est PAS une preuve de kill :
//   statut `uncertain` (pid vivant) + INTERDICTION de nouveau process tant que
//   la sortie n'est pas reobservee (recheck() ou surveillance).
//
// Contrat backend injecte (lifecycle, sans isolation supposee) :
//   start(descriptorFige) -> Promise<{ pid? }>  // reponse API, pas readiness
//   stop(reason?)          -> Promise<{ stopped, ... }> // verdict honnete
//   waitExit()             -> Promise<{ code, signal }> // SORTIE REELLE
//   checkHealth()          -> Promise<{ alive, version, pid, heartbeatAgeMs,
//                            heartbeatSeq, readyCount, probeOk }>
//   getExit?()             -> { code, signal } | null
//   getPid?()              -> number | null
//   isChildAlive?()        -> boolean
//   destroy?()             -> void (cleanup sans orphelin)
//
// Callbacks host TRUSTED (requis, le noyau refuse de demarrer sans eux) :
//   validateCandidate(version: string) -> descripteur canonique fige
//     { version, manifestDigest, checks, proof, status: 'pending-trial', ... }.
//     Le callback reverifie le digest sur disque (ex. candidate-store.verify)
//     ; il leve (tamper, version-unknown...) en cas de doute.
//   checkQuiescent({ version, at, nonce, generation }) -> { ok: true, ... }.
//     Mesure propre au process host (jamais une preuve worker). Nonce fraiche
//     par tentative, generation serie des stops.
//   validateTrial({ version, proof }) -> { ok: true, version, ... }.
//     Verdict de preuve d'essai reel ; leve (trial-unproven...) sinon.
//
// Contrat store injecte (canonique) :
//   save(snapshot) + (load() | read()) ; snapshot = { lastGood, trial, savedAt }
//   (identifiants { version, manifestDigest }, re-verifies a chaque usage).
//   Panne de persistance => fail closed : on quiesce, rien n'est promu.
//
// Etats : idle | activating | trial | active | rolling-back | failed-both |
//   stopped. `uncertain` est un drapeau orthogonal (pid vivant non rejoint).
// Les descripteurs exposes (active / trial / candidate / lastGood) sont figes.
//
// API exacte :
//   createSupervisor({ backend, store, validateCandidate, checkQuiescent,
//                      validateTrial, readinessTimeoutMs, pollMs,
//                      heartbeatTimeoutMs, requireHeartbeat, stopWaitMs,
//                      stabilityWindowMs, maxQuiescenceAgeMs,
//                      maxQuiescenceFutureMs, nowFn, onEvent })
//     -> { activate(version), confirmTrial(version, proof), rollback(reason),
//          totalStop(reason), resume(), status(), recheck(), close() }
// `close()` arrete le poller ET detruit le fils gere (aucun orphelin).

const nodeCrypto = require('node:crypto')

const VERSION_RE = /^[A-Za-z0-9._-]{1,64}$/

function refusal (code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

// Garde-fou de FORME sur le descripteur renvoye par le callback trusted.
// Ne fait AUCUNE confiance aux valeurs checks/proof (informatives) : la
// confiance vient du callback lui-meme (reverification disque). Exige en
// revanche status 'pending-trial' : le noyau n'active jamais un descripteur
// qui se pretend deja confirme.
function requireDescriptorShape (raw, requested) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw refusal('candidate', 'validateCandidate doit renvoyer un descripteur objet')
  }
  if (typeof raw.version !== 'string' || !VERSION_RE.test(raw.version)) {
    throw refusal('candidate-version', 'descripteur.version identifiant requis')
  }
  if (raw.version !== requested) {
    throw refusal('candidate-mismatch', `descripteur ${raw.version} ne correspond pas a ${requested}`)
  }
  if (typeof raw.manifestDigest !== 'string' || raw.manifestDigest.length < 8 || raw.manifestDigest.length > 256) {
    throw refusal('candidate-manifest', 'descripteur.manifestDigest requis (chaine 8..256)')
  }
  if (!Array.isArray(raw.checks) || raw.checks.length === 0) {
    throw refusal('candidate-checks', 'descripteur.checks non vide requis')
  }
  for (const check of raw.checks) {
    if (!check || typeof check !== 'object' || typeof check.name !== 'string' || check.name === '') {
      throw refusal('candidate-checks', 'descripteur.checks exige des { name }')
    }
  }
  if (!raw.proof || (typeof raw.proof !== 'object' && typeof raw.proof !== 'string')) {
    throw refusal('candidate-proof', 'descripteur.proof requis (donnee, pas verdict)')
  }
  if (raw.status !== 'pending-trial') {
    throw refusal('already-promoted', 'le noyau active un trial, jamais un descripteur deja confirme')
  }
  const frozenChecks = Object.freeze(raw.checks.map((check) => Object.freeze({ name: check.name, ok: check.ok })))
  const frozenProof = typeof raw.proof === 'string'
    ? raw.proof
    : Object.freeze(Array.isArray(raw.proof) ? [...raw.proof] : { ...raw.proof })
  return Object.freeze({ ...raw, checks: frozenChecks, proof: frozenProof })
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

function createSupervisor (opts) {
  const backend = opts && opts.backend
  const store = opts && opts.store
  const validateCandidate = opts && opts.validateCandidate
  const checkQuiescent = opts && opts.checkQuiescent
  const validateTrial = opts && opts.validateTrial
  if (!backend || typeof backend.start !== 'function' || typeof backend.stop !== 'function' ||
    typeof backend.waitExit !== 'function' || typeof backend.checkHealth !== 'function') {
    throw new TypeError('backend lifecycle requis : { start, stop, waitExit, checkHealth }')
  }
  if (!store || typeof store.save !== 'function' ||
    (typeof store.load !== 'function' && typeof store.read !== 'function')) {
    throw new TypeError('store canonique requis : { save, load|read }')
  }
  // Callbacks trusted du host : SANS eux, aucune activation ne peut etre prouvee.
  if (typeof validateCandidate !== 'function') throw new TypeError('validateCandidate callback trusted requis')
  if (typeof checkQuiescent !== 'function') throw new TypeError('checkQuiescent callback trusted requis')
  if (typeof validateTrial !== 'function') throw new TypeError('validateTrial callback trusted requis')
  const readinessTimeoutMs = Number(opts.readinessTimeoutMs == null ? 5000 : opts.readinessTimeoutMs)
  const pollMs = Number(opts.pollMs == null ? 200 : opts.pollMs)
  const heartbeatTimeoutMs = Number(opts.heartbeatTimeoutMs == null ? 1500 : opts.heartbeatTimeoutMs)
  const requireHeartbeat = opts.requireHeartbeat == null ? true : Boolean(opts.requireHeartbeat)
  const stopWaitMs = Number(opts.stopWaitMs == null ? 8000 : opts.stopWaitMs)
  const stabilityWindowMs = Number(opts.stabilityWindowMs == null ? 30000 : opts.stabilityWindowMs)
  const maxQuiescenceAgeMs = Number(opts.maxQuiescenceAgeMs == null ? 10000 : opts.maxQuiescenceAgeMs)
  const maxQuiescenceFutureMs = Number(opts.maxQuiescenceFutureMs == null ? 2000 : opts.maxQuiescenceFutureMs)
  const nowFn = opts.nowFn == null ? Date.now : opts.nowFn
  if (!Number.isFinite(readinessTimeoutMs) || readinessTimeoutMs <= 0) throw new TypeError('readinessTimeoutMs > 0 requis')
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new TypeError('pollMs > 0 requis')
  if (!Number.isFinite(heartbeatTimeoutMs) || heartbeatTimeoutMs < 100 || heartbeatTimeoutMs > 30000) {
    throw new TypeError('heartbeatTimeoutMs borne 100..30000 requis')
  }
  if (!Number.isFinite(stopWaitMs) || stopWaitMs < 500 || stopWaitMs > 30000) {
    throw new TypeError('stopWaitMs borne 500..30000 requis')
  }
  if (!Number.isFinite(stabilityWindowMs) || stabilityWindowMs < 500 || stabilityWindowMs > 300000) {
    throw new TypeError('stabilityWindowMs borne 500..300000 requis')
  }
  if (!Number.isFinite(maxQuiescenceAgeMs) || maxQuiescenceAgeMs < 500 || maxQuiescenceAgeMs > 120000) {
    throw new TypeError('maxQuiescenceAgeMs borne 500..120000 requis')
  }
  if (!Number.isFinite(maxQuiescenceFutureMs) || maxQuiescenceFutureMs < 0 || maxQuiescenceFutureMs > 30000) {
    throw new TypeError('maxQuiescenceFutureMs borne 0..30000 requis')
  }
  if (typeof nowFn !== 'function') throw new TypeError('nowFn fonction requis si fourni')
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null

  const state = {
    fsm: 'idle', // idle | activating | trial | active | rolling-back | failed-both | stopped
    active: null, // descripteur CONFIRME en cours d'execution
    trial: null, // descripteur pending-trial en cours d'essai
    candidate: null, // descripteur en cours d'activation
    lastGood: null, // derniere version CONFIRMEE (figee)
    totalStopped: false,
    totalStopReason: null,
    failedBoth: false,
    activating: false,
    rollingBack: false,
    uncertain: null, // { pid, since, reason } : sortie non reobservee => aucun start
    generation: 0, // serie des stops (quiescence)
    quiesceSerial: 0, // serie des nonces
    lastError: null, // { code, message, at }
    lastHealth: null, // dernier checkHealth observe
    epoch: 0,
    livenessBusy: false,
    rollbacks: 0,
    lastRestore: null // { version, at (nowFn ms), cause } : derniere restauration, anti-boucle
  }

  function emit (type, extra) {
    if (!onEvent) return
    try { onEvent({ type, at: new Date().toISOString(), ...extra }) } catch { /* jamais corruptif */ }
  }

  function noteError (err) {
    state.lastError = {
      code: (err && err.code) || 'error',
      message: String((err && err.message) || err),
      at: new Date().toISOString()
    }
  }

  function readPersisted () {
    try {
      const snap = typeof store.load === 'function' ? store.load() : store.read()
      if (!snap || typeof snap !== 'object') return null
      const lastGood = snap.lastGood
      if (!lastGood || typeof lastGood.version !== 'string' || !VERSION_RE.test(lastGood.version) ||
        typeof lastGood.manifestDigest !== 'string') {
        return null
      }
      // Reference minimale (re-verifiee via validateCandidate avant usage).
      return Object.freeze({ version: lastGood.version, manifestDigest: lastGood.manifestDigest })
    } catch (err) {
      emit('store-error', { error: String((err && err.message) || err) })
      return null
    }
  }

  // Recovery apres crash : lastGood comme REFERENCE (trial jamais restaure
  // comme actif), rien ne demarre. Reobservation explicite requise.
  const recovered = readPersisted()
  if (recovered) {
    state.lastGood = recovered
    emit('recovered', { lastGood: recovered.version })
  }

  function persistSnapshot () {
    const ident = (descriptor) => descriptor
      ? { version: descriptor.version, manifestDigest: descriptor.manifestDigest }
      : null
    store.save({ lastGood: ident(state.lastGood), trial: ident(state.trial), savedAt: new Date().toISOString() })
  }

  function safeGetExit () {
    try {
      if (typeof backend.getExit === 'function') return backend.getExit()
    } catch { /* ignore */ }
    return null
  }

  function safeGetPid () {
    try {
      if (typeof backend.getPid === 'function') return backend.getPid()
    } catch { /* ignore */ }
    return null
  }

  function safeIsAlive () {
    try {
      if (typeof backend.isChildAlive === 'function') return backend.isChildAlive()
    } catch { /* ignore */ }
    return safeGetPid() !== null && !safeGetExit()
  }

  function freshNonce () {
    state.quiesceSerial += 1
    return `${state.generation}:${state.quiesceSerial}:${Date.now().toString(36)}:${nodeCrypto.randomBytes(6).toString('hex')}`
  }

  // Verdict host de quiescence VERIFIE noyau : ok + version + nonce EXACTE
  // (anti-replay : seul le nonce frais de CETTE tentative vaut) + generation
  // EXACTE (rejet des preuves d'avant-stop) + `at` frais (ni perime au-dela
  // de maxQuiescenceAgeMs, ni futur au-dela de maxQuiescenceFutureMs).
  function verifyQuiescenceVerdict (verdict, sent) {
    if (!verdict || typeof verdict !== 'object' || verdict.ok !== true) {
      throw refusal('quiescent', 'quiescence refusee par le host (pas de point coherent)')
    }
    if (verdict.version !== sent.version) {
      throw refusal('quiescent', 'verdict quiescence : version incoherente')
    }
    if (typeof verdict.nonce !== 'string' || verdict.nonce !== sent.nonce) {
      throw refusal('quiescent-replay', 'verdict quiescence : nonce non fraiche (replay refuse)')
    }
    if (verdict.generation !== sent.generation) {
      throw refusal('quiescent-stale', 'verdict quiescence : generation perimee (stop intermediaire)')
    }
    const hostMs = Date.parse(verdict.at)
    if (!Number.isFinite(hostMs)) {
      throw refusal('quiescent', 'verdict quiescence : horodatage `at` requis')
    }
    const nowMs = nowFn()
    if (hostMs - nowMs > maxQuiescenceFutureMs) {
      throw refusal('quiescent-future', `verdict quiescence futur (+${hostMs - nowMs} ms > ${maxQuiescenceFutureMs} ms)`)
    }
    if (nowMs - hostMs > maxQuiescenceAgeMs) {
      throw refusal('quiescent-stale', `verdict quiescence perime (${nowMs - hostMs} ms > ${maxQuiescenceAgeMs} ms)`)
    }
  }
  // Responsiveness observee : vivant + version attendue + (si exige) heartbeat
  // frais. Startup ready != succes metier : ceci gate le trial, pas la promotion.
  function responsiveEnough (health, expectedVersion) {
    if (!health || typeof health !== 'object') return { ok: false, reason: 'no-health' }
    if (health.alive !== true) return { ok: false, reason: 'not-alive' }
    if (health.version !== expectedVersion) {
      return { ok: false, reason: 'version', observed: typeof health.version === 'string' ? health.version : null }
    }
    if (requireHeartbeat) {
      if (typeof health.heartbeatAgeMs !== 'number') return { ok: false, reason: 'no-heartbeat' }
      if (health.heartbeatAgeMs > heartbeatTimeoutMs) {
        return { ok: false, reason: 'stale-heartbeat', ageMs: health.heartbeatAgeMs }
      }
    }
    return { ok: true }
  }

  function clearUncertainIfSettled (why) {
    if (!state.uncertain) return false
    const exit = safeGetExit()
    if (exit || !safeIsAlive()) {
      const cleared = state.uncertain
      state.uncertain = null
      emit('uncertain-cleared', { pid: cleared.pid, via: why })
      return true
    }
    return false
  }

  // Arrete l'ancien worker et attend sa SORTIE REELLE avant tout demarrage.
  // Borne : un timeout n'est PAS une preuve de kill => uncertain + interdiction
  // de nouveau process (lance une 'stop-uncertain', jamais un start aveugle).
  async function stopAndWaitReal (reason) {
    try {
      await backend.stop(reason)
    } catch (err) {
      emit('stop-error', { reason, error: String((err && err.message) || err) })
    }
    try {
      await withTimeout(backend.waitExit(), stopWaitMs, 'stop-uncertain', `sortie non reobservee en ${stopWaitMs} ms (${reason})`)
    } catch (err) {
      if (err && err.code === 'stop-uncertain') {
        state.uncertain = { pid: safeGetPid(), since: new Date().toISOString(), reason }
        noteError(err)
        emit('exit-uncertain', { pid: state.uncertain.pid, reason })
      }
      throw err
    }
    clearUncertainIfSettled(`stop:${reason}`)
  }

  // Readiness observee : vivant + version attendue + heartbeat frais (si exige).
  // Version observee differente => wrong-version rapide. Sortie => crash.
  // Sans heartbeat frais a l'echeance => readiness-timeout (startup, pas metier).
  async function waitReady (frozen) {
    const deadline = Date.now() + readinessTimeoutMs
    let lastReason = 'no-health'
    for (;;) {
      if (state.totalStopped) throw refusal('total-stopped', 'arret total pendant readiness')
      let health = null
      try {
        health = await backend.checkHealth()
        state.lastHealth = health
      } catch {
        health = null
      }
      const verdict = responsiveEnough(health, frozen.version)
      if (verdict.ok) return health
      lastReason = verdict.reason
      if (verdict.reason === 'version' && verdict.observed) {
        throw refusal('wrong-version', `version observee ${verdict.observed}, attendue ${frozen.version}`)
      }
      const exit = safeGetExit()
      if (exit && (!health || health.alive !== true)) {
        throw refusal('crash', `worker sorti avant readiness (code=${exit.code} signal=${exit.signal})`)
      }
      if (Date.now() >= deadline) {
        const exitAtEnd = safeGetExit()
        if (exitAtEnd) throw refusal('crash', `worker sorti pendant readiness (code=${exitAtEnd.code} signal=${exitAtEnd.signal})`)
        throw refusal('readiness-timeout', `readiness ${frozen.version} non observee en ${readinessTimeoutMs} ms (${lastReason})`)
      }
      await sleep(Math.min(pollMs, Math.max(10, deadline - Date.now())))
    }
  }

  // Rollback vers lastGood (re-verifie sur disque AVANT start), UNE FOIS par
  // incident, borne anti-boucle : si la meme version retombe avant
  // `stabilityWindowMs` apres sa restauration => failed-both/hardstop, cause
  // preservee, aucun restart. Le rollback manuel explicite contourne la borne
  // (intention operateur, pas autoboucle) mais l'enregistre.
  // lastGood inverifiable ou en echec => failed-both + hardstop, sans reprise
  // auto. totalStop pendant le rollback => preemption `stopped` (le catch
  // verifie le latch AVANT tout failed-both : jamais d'ecrasement).
  async function rollbackOnce (failedVersion, cause, allowSame, opts4) {
    const manual = Boolean(opts4 && opts4.manual)
    if (state.rollingBack) return { already: true }
    if (state.totalStopped) return { preempted: true }
    if (state.uncertain) return { uncertain: true }
    const target = state.lastGood
    if (!target) {
      state.fsm = 'idle'
      state.active = null
      state.trial = null
      noteError(cause)
      emit('rollback-skipped', { reason: 'no-last-good', failed: failedVersion || null })
      return { rolledBack: false }
    }
    if (!allowSame && target.version === failedVersion) {
      state.fsm = 'idle'
      state.active = null
      state.trial = null
      noteError(cause)
      emit('rollback-skipped', { reason: 'same-version', failed: target.version })
      return { rolledBack: false }
    }
    // Borne anti-boucle : restauration recente de la meme version + rechute
    // avant fenetre de stabilite => hardstop, diagnostic preserve.
    if (allowSame && !manual && target.version === failedVersion && state.lastRestore &&
      state.lastRestore.version === target.version &&
      (nowFn() - state.lastRestore.at) < stabilityWindowMs) {
      state.rollingBack = true
      try {
        try { await stopAndWaitReal('unstable') } catch { /* uncertain honnete, hardstop maintenu */ }
        state.active = null
        state.trial = null
        state.failedBoth = true
        state.fsm = state.totalStopped ? 'stopped' : 'failed-both'
        const firstCause = state.lastRestore.cause
        const unstableErr = refusal('unstable',
          `restauration ${target.version} retombee avant ${stabilityWindowMs} ms (cause: ${(cause && cause.code) || 'error'})`)
        noteError(unstableErr)
        emit('failed-both', {
          failed: failedVersion || null,
          lastGood: target.version,
          unstable: true,
          restoredAt: state.lastRestore.at,
          firstCause,
          error: String(unstableErr.message)
        })
        return { failedBoth: state.fsm === 'failed-both' }
      } finally {
        state.rollingBack = false
      }
    }
    state.rollingBack = true
    state.fsm = 'rolling-back'
    emit('rollback-start', {
      from: failedVersion || null,
      to: target.version,
      cause: (cause && cause.code) || 'error'
    })
    try {
      // Reverification disque AVANT start : un lastGood tampered depuis ne redemarre pas.
      const fresh = requireDescriptorShape(await validateCandidate(target.version), target.version)
      if (state.totalStopped) return { preempted: true }
      if (state.uncertain) return { uncertain: true }
      await stopAndWaitReal('rollback')
      if (state.totalStopped) return { preempted: true }
      if (state.uncertain) return { uncertain: true }
      await backend.start(fresh)
      await waitReady(fresh)
      if (state.totalStopped) return { preempted: true }
      state.active = fresh
      state.trial = null
      state.fsm = 'active'
      state.rollbacks += 1
      // Epoque de restauration : une rechute de la meme version avant la
      // fenetre de stabilite ne redemarrera pas (borne anti-boucle).
      state.lastRestore = { version: fresh.version, at: nowFn(), cause: (cause && cause.code) || 'error' }
      emit('rollback-done', { active: fresh.version })
      return { rolledBack: true }
    } catch (rollbackErr) {
      // Latch totalStop d'abord : un failed-both ne blanchit jamais `stopped`.
      if (state.totalStopped || (rollbackErr && rollbackErr.code === 'total-stopped')) {
        state.candidate = null
        state.active = null
        state.trial = null
        state.fsm = 'stopped'
        noteError(rollbackErr)
        emit('rollback-preempted', { error: String((rollbackErr && rollbackErr.message) || rollbackErr) })
        return { preempted: true }
      }
      if (rollbackErr && (rollbackErr.code === 'stop-uncertain' || state.uncertain)) {
        state.candidate = null
        noteError(rollbackErr)
        emit('rollback-uncertain', { error: String((rollbackErr && rollbackErr.message) || rollbackErr) })
        return { uncertain: true }
      }
      // lastGood en echec (ou inverifiable) : failed-both + hardstop.
      try { await stopAndWaitReal('failed-both') } catch { /* quiesce au mieux */ }
      state.active = null
      state.trial = null
      state.failedBoth = true
      state.fsm = state.totalStopped ? 'stopped' : 'failed-both'
      noteError(rollbackErr)
      emit('failed-both', {
        failed: failedVersion || null,
        lastGood: target.version,
        error: String((rollbackErr && rollbackErr.message) || rollbackErr)
      })
      return { failedBoth: state.fsm === 'failed-both' }
    } finally {
      state.rollingBack = false
    }
  }

  // Activation = CONTROLES trusted puis ESSAI reel (trial). Ne promeut jamais
  // lastGood (voir confirmTrial). Prend un identifiant de version ; toute
  // preuve appelant (quiescentProof: 1, checks auto-declares) est IGNOREEE :
  // seuls les callbacks host valident.
  async function activate (version) {
    if (typeof version !== 'string' || !VERSION_RE.test(version)) {
      throw refusal('candidate-version', 'activate(version) : identifiant requis, pas un descripteur')
    }
    if (state.totalStopped) throw refusal('total-stopped', 'arret total verrouille : resume() explicite requis')
    if (state.failedBoth) throw refusal('failed-both', 'double echec verrouille : resume() explicite requis')
    if (state.uncertain) throw refusal('uncertain', 'sortie non reobservee : recheck() requis, aucun nouveau process')
    if (state.activating || state.rollingBack) throw refusal('busy', 'activation serialisee : une seule a la fois, sans file')
    // 1. CONTROLE trusted : reverification disque + descripteur canonique.
    //    Aucun effet avant ce point ; un refus ne demarre rien.
    let frozen = null
    try {
      frozen = requireDescriptorShape(await validateCandidate(version), version)
    } catch (err) {
      noteError(err)
      emit('validation-refused', { version, error: String((err && err.message) || err) })
      throw err
    }
    // 2. QUIESCENCE host (nonce fraiche, generation) : jamais une preuve worker.
    //    Le verdict est VERIFIE noyau (fraicheur `at`, nonce, generation).
    const nonce = freshNonce()
    const sentAtMs = nowFn()
    const sentGeneration = state.generation
    try {
      const verdict = await checkQuiescent({
        version: frozen.version,
        at: new Date(sentAtMs).toISOString(),
        nonce,
        generation: sentGeneration
      })
      verifyQuiescenceVerdict(verdict, {
        version: frozen.version,
        nonce,
        generation: sentGeneration,
        sentAtMs
      })
    } catch (err) {
      noteError(err)
      emit('quiescent-rejected', { version: frozen.version, error: String((err && err.message) || err) })
      throw err.code ? err : refusal('quiescent', String((err && err.message) || err))
    }
    state.activating = true
    state.candidate = frozen
    state.fsm = 'activating'
    state.epoch += 1
    emit('activating', { candidate: frozen.version, nonce })
    try {
      await stopAndWaitReal('activate')
      if (state.totalStopped) throw refusal('total-stopped', 'arret total pendant activation')
      if (state.uncertain) throw refusal('uncertain', 'sortie non reobservee pendant activation')
      await backend.start(frozen) // reponse API : lance, pas pret, pas prouve
      if (state.totalStopped) {
        await stopAndWaitReal('preempted').catch(() => {})
        throw refusal('total-stopped', 'arret total pendant activation')
      }
      await waitReady(frozen) // startup repondant (trial), pas succes metier
      if (state.totalStopped) {
        await stopAndWaitReal('preempted').catch(() => {})
        throw refusal('total-stopped', 'arret total pendant activation')
      }
      // Essai pret : previous lastGood INCHANGE, trial persiste (fail closed).
      state.trial = frozen
      state.candidate = null
      state.activating = false
      state.fsm = 'trial'
      try {
        persistSnapshot()
      } catch (persistErr) {
        await stopAndWaitReal('persist-fail').catch(() => {})
        state.trial = null
        state.activating = false
        state.fsm = state.active ? 'active' : 'idle'
        noteError(persistErr)
        emit('persist-error', { error: String((persistErr && persistErr.message) || persistErr) })
        throw refusal('persist', 'persistance impossible : essai quiesce, previous lastGood inchange')
      }
      state.lastError = null
      emit('trial-ready', { trial: frozen.version, lastGood: state.lastGood ? state.lastGood.version : null })
      return status()
    } catch (err) {
      state.activating = false
      // Latch totalStop d'abord : jamais d'ecrasement par failed-both.
      if (state.totalStopped) {
        state.candidate = null
        state.active = null
        state.trial = null
        state.fsm = 'stopped'
        noteError(err)
        emit('activation-preempted', { error: String((err && err.message) || err) })
        throw err
      }
      if (state.uncertain || (err && err.code === 'stop-uncertain')) {
        state.candidate = null
        noteError(err)
        emit('activation-failed', {
          candidate: frozen.version,
          error: String((err && err.message) || err),
          uncertain: true
        })
        throw err
      }
      // Crash / hang / timeout / wrong-version => rollback UNE FOIS vers
      // previous lastGood (sans rejouer les bits qui viennent d'echouer).
      const outcome = await rollbackOnce(frozen.version, err, false).catch((fatal) => {
        noteError(fatal)
        return { fatal: true }
      })
      state.candidate = null
      if (outcome && (outcome.rolledBack || outcome.failedBoth || outcome.preempted || outcome.already || outcome.uncertain)) {
        if (state.fsm !== 'failed-both' && state.fsm !== 'active' && state.fsm !== 'stopped') {
          state.fsm = state.active ? 'active' : (state.trial ? 'trial' : state.fsm)
        }
        noteError(err)
        emit('activation-failed', {
          candidate: frozen.version,
          error: String((err && err.message) || err),
          rolledBack: Boolean(outcome.rolledBack),
          failedBoth: Boolean(outcome.failedBoth)
        })
        throw err
      }
      state.fsm = state.active ? 'active' : (state.trial ? 'trial' : 'idle')
      noteError(err)
      emit('activation-failed', { candidate: frozen.version, error: String((err && err.message) || err) })
      throw err
    }
  }

  // Promotion : previous lastGood ne change que sur preuve d'essai validee par
  // le callback trusted. Idempotent (deja confirme => ok sans effet).
  // Versionne le CONTROLE, jamais la doctrine, jamais par booleen.
  async function confirmTrial (version, proof) {
    if (typeof version !== 'string' || !VERSION_RE.test(version)) {
      throw refusal('candidate-version', 'confirmTrial(version, proof) : identifiant requis')
    }
    if (state.totalStopped) throw refusal('total-stopped', 'arret total verrouille : resume() explicite requis')
    if (state.failedBoth) throw refusal('failed-both', 'double echec verrouille : resume() explicite requis')
    if (state.uncertain) throw refusal('uncertain', 'sortie non reobservee : recheck() requis')
    if (state.activating || state.rollingBack) throw refusal('busy', 'confirmation refuse pendant une activation')
    // Idempotent : deja confirme, rien a prouver de nouveau.
    if (!state.trial && state.lastGood && state.lastGood.version === version) return status()
    if (!state.trial || state.trial.version !== version) {
      throw refusal('no-trial', `aucun essai en cours pour ${version} : promotion avant trial refusee`)
    }
    if (!proof || (typeof proof !== 'object' && typeof proof !== 'string')) {
      throw refusal('trial-proof', 'preuve d\'essai requise (donnee pour validateTrial)')
    }
    // Reverification disque AVANT promotion : trial tampered depuis => refus.
    const reverified = requireDescriptorShape(await validateCandidate(version), version)
    if (reverified.manifestDigest !== state.trial.manifestDigest) {
      noteError(refusal('tamper', 'essai altere depuis son activation'))
      emit('confirm-refused', { version, error: 'digest changed since trial' })
      throw refusal('tamper', 'essai altere depuis son activation : promotion refusee')
    }
    let verdict = null
    try {
      verdict = await validateTrial({ version, proof })
    } catch (err) {
      noteError(err)
      emit('confirm-refused', { version, error: String((err && err.message) || err) })
      throw err.code ? err : refusal('trial-unproven', String((err && err.message) || err))
    }
    if (!verdict || typeof verdict !== 'object' || verdict.ok !== true || verdict.version !== version) {
      const err = refusal('trial-unproven', 'preuve d\'essai non validee par le host')
      noteError(err)
      emit('confirm-refused', { version, error: err.message })
      throw err
    }
    // Promotion fail closed : persister AVANT de considerer lastGood change ;
    // en cas de panne, restauration exacte de l'etat pre-promotion.
    const promoted = state.trial
    const previousGood = state.lastGood
    const previousActive = state.active
    state.lastGood = promoted
    state.active = promoted
    state.trial = null
    state.fsm = 'active'
    try {
      persistSnapshot()
    } catch (persistErr) {
      state.lastGood = previousGood
      state.active = previousActive
      state.trial = promoted
      state.fsm = 'trial'
      noteError(persistErr)
      emit('persist-error', { error: String((persistErr && persistErr.message) || persistErr) })
      throw refusal('persist', 'persistance impossible : promotion non appliquee')
    }
    state.lastError = null
    // Nouvelle base confirmee : l'historique de restauration precedent expire.
    state.lastRestore = null
    emit('promoted', { version: promoted.version })
    return status()
  }

  async function rollback (reason) {
    if (state.totalStopped) throw refusal('total-stopped', 'arret total verrouille : resume() explicite requis')
    if (state.failedBoth) throw refusal('failed-both', 'double echec verrouille : resume() explicite requis')
    if (state.uncertain) throw refusal('uncertain', 'sortie non reobservee : recheck() requis')
    if (state.activating || state.rollingBack) throw refusal('busy', 'rollback refuse pendant une activation')
    if (!state.lastGood) throw refusal('no-last-good', 'aucune derniere version confirmee')
    const current = state.active ? state.active.version : (state.trial ? state.trial.version : null)
    const outcome = await rollbackOnce(current, refusal('manual', String(reason || 'rollback manuel')), true, { manual: true })
    if (outcome && outcome.failedBoth) throw refusal('failed-both', 'lastGood en echec : failed-both')
    if (outcome && outcome.uncertain) throw refusal('uncertain', 'sortie non reobservee pendant rollback')
    return status()
  }

  // Arret total : latch durable qui PREEMPTE tout (activation, rollback,
  // readiness). Attente de sortie BORNEE : un timeout n'est pas une preuve de
  // kill => statut uncertain + interdiction de nouveau process. N'ouvre AUCUNE
  // activation en file.
  async function totalStop (reason) {
    state.totalStopped = true
    state.totalStopReason = String(reason || 'arret total')
    state.candidate = null
    state.epoch += 1
    state.generation += 1
    emit('total-stop', { reason: state.totalStopReason, generation: state.generation })
    try { await backend.stop('total-stop') } catch (err) {
      emit('stop-error', { reason: 'total-stop', error: String((err && err.message) || err) })
    }
    try {
      await withTimeout(backend.waitExit(), stopWaitMs, 'stop-uncertain', `sortie non reobservee en ${stopWaitMs} ms (total-stop)`)
    } catch (err) {
      // Timeout waitExit != preuve de kill : pid vivant, aucun nouveau process.
      state.uncertain = { pid: safeGetPid(), since: new Date().toISOString(), reason: 'total-stop' }
      state.active = null
      state.trial = null
      state.fsm = 'stopped'
      noteError(err)
      emit('exit-uncertain', { pid: state.uncertain.pid, reason: 'total-stop' })
      return status()
    }
    clearUncertainIfSettled('total-stop')
    state.active = null
    state.trial = null
    state.fsm = 'stopped'
    return status()
  }

  function resume () {
    state.totalStopped = false
    state.totalStopReason = null
    state.failedBoth = false
    if (state.fsm === 'stopped' || state.fsm === 'failed-both') state.fsm = state.active ? 'active' : (state.trial ? 'trial' : 'idle')
    emit('resume', {})
    // Ne demarre RIEN tout seul : une activation explicite reste requise.
    // `uncertain` survit au resume : seul recheck() (sortie reobservee) le leve.
    return status()
  }

  // Reobservation explicite d'une sortie incertaine. Ne leve l'interdiction que
  // sur exit constate ou fils non vivant ; sinon uncertain persiste.
  function recheck () {
    if (!state.uncertain) return status()
    clearUncertainIfSettled('recheck')
    return status()
  }

  function status () {
    let backendInfo = null
    try {
      const pid = typeof backend.getPid === 'function' ? backend.getPid() : null
      backendInfo = {
        pid: typeof pid === 'number' ? pid : null,
        alive: state.lastHealth ? state.lastHealth.alive === true : null,
        version: state.lastHealth && typeof state.lastHealth.version === 'string' ? state.lastHealth.version : null,
        heartbeatAgeMs: state.lastHealth && typeof state.lastHealth.heartbeatAgeMs === 'number'
          ? state.lastHealth.heartbeatAgeMs
          : null
      }
    } catch {
      backendInfo = { pid: null, alive: null, version: null, heartbeatAgeMs: null }
    }
    return {
      state: state.fsm,
      active: state.active,
      trial: state.trial,
      candidate: state.candidate,
      lastGood: state.lastGood,
      totalStopped: state.totalStopped,
      totalStopReason: state.totalStopReason,
      failedBoth: state.failedBoth,
      uncertain: state.uncertain ? { ...state.uncertain } : null,
      generation: state.generation,
      rollbacks: state.rollbacks,
      lastRestore: state.lastRestore ? { ...state.lastRestore } : null,
      lastError: state.lastError,
      backend: backendInfo
    }
  }

  // Surveillance CONTINUE (actif ET trial) : vivant + version + heartbeat frais.
  // Hang apres ready (beats arretes, process vivant) => rollback UNE FOIS vers
  // previous lastGood, puis la surveillance reprend sur la version restauree.
  const timer = setInterval(() => {
    if (state.activating || state.rollingBack || state.livenessBusy) return
    if (state.totalStopped || state.failedBoth || state.uncertain) {
      if (state.uncertain) clearUncertainIfSettled('liveness')
      return
    }
    const current = state.active || state.trial
    if ((state.fsm !== 'active' && state.fsm !== 'trial') || !current) return
    state.livenessBusy = true
    backend.checkHealth().then((health) => {
      state.lastHealth = health
      const verdict = responsiveEnough(health, current.version)
      if (verdict.ok) return
      const cause = verdict.reason === 'stale-heartbeat' || verdict.reason === 'no-heartbeat'
        ? refusal('hang', `heartbeat absent/perime (${verdict.reason}${verdict.ageMs != null ? ` age=${verdict.ageMs}ms` : ''})`)
        : refusal('liveness', `sante inactive/stale : observe=${health ? `${health.alive}/${health.version}` : 'injoignable'}`)
      return rollbackOnce(current.version, cause, true).then(() => {
        emit('liveness-rollback', { current: state.active ? state.active.version : (state.trial ? state.trial.version : null) })
      }).catch((err) => noteError(err))
    }).catch((err) => {
      const cause = refusal('liveness', `surveillance injoignable : ${String((err && err.message) || err)}`)
      rollbackOnce(current.version, cause, true).catch((fatal) => noteError(fatal))
    }).finally(() => { state.livenessBusy = false })
  }, pollMs)
  if (timer && typeof timer.unref === 'function') timer.unref()

  // Cleanup sans orphelin : poller arrete + fils gere detruit (best-effort).
  function close () {
    clearInterval(timer)
    try {
      if (backend && typeof backend.destroy === 'function') backend.destroy()
    } catch { /* cleanup best-effort */ }
  }

  return { activate, confirmTrial, rollback, totalStop, resume, status, recheck, close }
}

module.exports = { createSupervisor, requireDescriptorShape }
