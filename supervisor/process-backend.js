'use strict'

// Backend lifecycle injecte dans le noyau (ARCHITECTURE C4/C9, D12).
// Lance un executable TRUSTED de configuration (processus Node des fixtures de
// test ou commande de confiance) : JAMAIS de shell (pas de spawn shell:true,
// pas de exec, pas de commande interpretee). Meme UID que le parent : AUCUNE
// isolation OS de production n'est assuree par ce backend (lifecycle testable,
// pas un sandbox ; ne pas deployer comme isolation prod, decision non tranchee).
//
// Protocole worker observe (aucune confiance en un booleen metier) :
//   `READY <version>` (une fois, demarrage) puis `HEARTBEAT <version> <seq>`
//   periodiques. checkHealth() = { alive, version, pid, heartbeatAgeMs,
//   heartbeatSeq, readyCount, probeOk } observes. Le NOYAU juge la fraicheur
//   (heartbeatTimeoutMs) ; ce backend se contente de mesurer.
//   Dernier READY gagne : un second READY d'une autre version est OBSERVE
//   (compteur versionChanges, version courante mise a jour), jamais ignore en
//   silence : le noyau y voit un wrong-version/stale et reagit.
// Sondes externes : option `externalProbe` injectee ({ pid, version }) ->
//   valeur de verite, bornee par probeTimeoutMs ; echec/timeout => non vivant.
//   Defaut : parsing des heartbeats stdout (aucune sonde).
//
// Parser stdout orienté lignes avec report de fragment : un `READY v1\n`
// fragmente sur plusieurs chunks (deux write separes) est reconstitue.
// Lignes > maxLineBytes abandonnees (compteur droppedLines), jamais de buffer
// non borne. Les motifs sont construits depuis un charset de version FERME
// (aucune entree appelant interpolee dans une regex).
//
// stop() = grace SIGTERM bornee puis SIGKILL borne, verdict HONNETE
// (stopped:false si toujours vivant). close()/destroy() = cleanup synchrone
// sans orphelin (SIGKILL best-effort + stdio detruits + waiters soldes).
//
// API exacte :
//   createProcessBackend({ command, args, cwd, env, stopGraceMs,
//                          killTimeoutMs, logBytesMax, maxLineBytes?,
//                          externalProbe?, probeTimeoutMs? })
//     -> { start(candidate), stop(reason?), waitExit(), checkHealth(),
//          getExit(), getPid(), isChildAlive(), getLogs(maxBytes?),
//          getStats(), close(), destroy() }

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

// Charset de version FERME : aucune entree appelant n'entre dans les regex.
const VERSION_SRC = '[A-Za-z0-9._-]{1,64}'
const VERSION_RE = /^[A-Za-z0-9._-]{1,64}$/
const READY_RE = new RegExp(`^READY\\s+(${VERSION_SRC})\\s*$`)
const HEARTBEAT_RE = new RegExp(`^HEARTBEAT\\s+(${VERSION_SRC})\\s+(\\d{1,10})\\s*$`)

function refusal (code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

// Sortie REELLE uniquement : exitCode/signalCode sont renseignes a l'evenement
// 'exit'. Ne JAMAIS tester `proc.killed` ici : Node le met a true des que le
// signal est envoye (meme ignore par le fils), ce qui ferait croire a tort a
// une sortie et sauterait le SIGKILL borne.
function hasExited (proc) {
  return !proc || proc.exitCode !== null || proc.signalCode !== null
}

function createProcessBackend (opts) {
  const command = opts && opts.command
  if (typeof command !== 'string' || command === '' || command.includes('\0')) {
    throw new TypeError('command executable (config trusted) requis, chaine non vide')
  }
  // Jamais de shell : on refuse explicitement toute demande d'interpretation.
  if (opts && (opts.shell === true || opts.shell === 'true')) {
    throw new TypeError('shell interdit : spawn direct sans interpretation')
  }
  if (path.isAbsolute(command) && !fs.existsSync(command)) {
    throw new TypeError(`command introuvable : ${command}`)
  }
  const args = opts.args == null ? [] : opts.args
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || a.includes('\0'))) {
    throw new TypeError('args tableau de chaines requis')
  }
  const cwd = opts && opts.cwd
  if (typeof cwd !== 'string' || cwd === '') throw new TypeError('cwd requis (repertoire valide)')
  let st = null
  try {
    st = fs.statSync(cwd)
  } catch {
    throw new TypeError(`cwd inexistant : ${cwd}`)
  }
  if (!st.isDirectory()) throw new TypeError(`cwd non repertoire : ${cwd}`)
  const extraEnv = opts.env == null ? {} : opts.env
  if (!extraEnv || typeof extraEnv !== 'object' || Array.isArray(extraEnv)) {
    throw new TypeError('env objet requis si fourni')
  }
  for (const [key, value] of Object.entries(extraEnv)) {
    if (typeof value !== 'string') throw new TypeError(`env[${key}] chaine requise`)
  }
  const stopGraceMs = Number(opts.stopGraceMs == null ? 2000 : opts.stopGraceMs)
  const killTimeoutMs = Number(opts.killTimeoutMs == null ? 2000 : opts.killTimeoutMs)
  const logBytesMax = Number(opts.logBytesMax == null ? 65536 : opts.logBytesMax)
  const maxLineBytes = Number(opts.maxLineBytes == null ? 4096 : opts.maxLineBytes)
  if (!Number.isFinite(stopGraceMs) || stopGraceMs < 50 || stopGraceMs > 30000) {
    throw new TypeError('stopGraceMs borne 50..30000 requis')
  }
  if (!Number.isFinite(killTimeoutMs) || killTimeoutMs < 50 || killTimeoutMs > 30000) {
    throw new TypeError('killTimeoutMs borne 50..30000 requis')
  }
  if (!Number.isFinite(logBytesMax) || logBytesMax < 1024 || logBytesMax > 1048576) {
    throw new TypeError('logBytesMax borne 1024..1048576 requis')
  }
  if (!Number.isFinite(maxLineBytes) || maxLineBytes < 256 || maxLineBytes > 65536) {
    throw new TypeError('maxLineBytes borne 256..65536 requis')
  }
  const externalProbe = opts.externalProbe == null ? null : opts.externalProbe
  if (externalProbe !== null && typeof externalProbe !== 'function') {
    throw new TypeError('externalProbe fonction requise si fournie')
  }
  const probeTimeoutMs = Number(opts.probeTimeoutMs == null ? 500 : opts.probeTimeoutMs)
  if (!Number.isFinite(probeTimeoutMs) || probeTimeoutMs < 50 || probeTimeoutMs > 5000) {
    throw new TypeError('probeTimeoutMs borne 50..5000 requis')
  }

  let child = null
  let exitInfo = null // { code, signal } une fois sorti (jamais fabrique)
  let exitWaiters = []
  let readySeen = false
  let readyVersion = null
  let readyCount = 0
  let versionChanges = 0
  let heartbeats = 0
  let heartbeatSeq = null
  let lastBeatAt = null
  let anomalies = 0
  let droppedLines = 0
  let probeCalls = 0
  let probeFails = 0
  let lineBuf = '' // report de fragment inter-chunks (borne par maxLineBytes)
  let stdoutBuf = ''
  let stderrBuf = ''
  let starts = 0

  function cap (buf, chunk) {
    const next = buf + chunk
    return next.length > logBytesMax ? next.slice(next.length - logBytesMax) : next
  }

  function handleLine (line) {
    const ready = READY_RE.exec(line)
    if (ready) {
      readyCount += 1
      if (!readySeen) {
        readySeen = true
        readyVersion = ready[1]
      } else if (readyVersion !== ready[1]) {
        // Second READY d'une autre version : OBSERVE (dernier gagne), le
        // noyau tranche wrong-version/stale. Jamais ignore en silence.
        versionChanges += 1
        readyVersion = ready[1]
      }
      return
    }
    const beat = HEARTBEAT_RE.exec(line)
    if (beat) {
      heartbeats += 1
      // Seul un heartbeat de la version annoncee rafraichit ; sinon anomalie.
      if (readyVersion !== null && beat[1] === readyVersion) {
        lastBeatAt = Date.now()
        heartbeatSeq = Number(beat[2])
      } else {
        anomalies += 1
      }
    }
  }

  function onStdoutChunk (chunk) {
    stdoutBuf = cap(stdoutBuf, chunk)
    lineBuf += chunk
    let idx = -1
    while ((idx = lineBuf.indexOf('\n')) >= 0) {
      let line = lineBuf.slice(0, idx)
      lineBuf = lineBuf.slice(idx + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.length > maxLineBytes) {
        droppedLines += 1
        continue
      }
      handleLine(line)
    }
    // Partiel sans newline : borne, sinon un flux sans newline gonflerait sans fin.
    // (Nos lignes protocole font < 100 o ; un partiel > maxLineBytes est du junk.)
    if (lineBuf.length > maxLineBytes) {
      droppedLines += 1
      lineBuf = ''
    }
  }

  function settleExit (code, signal) {
    if (!exitInfo) exitInfo = { code, signal }
    const waiters = exitWaiters
    exitWaiters = []
    for (const waiter of waiters) {
      try { waiter({ code, signal }) } catch { /* ignore */ }
    }
  }

  async function start (candidate) {
    if (!candidate || typeof candidate.version !== 'string' || !VERSION_RE.test(candidate.version)) {
      throw refusal('version', 'candidate.version identifiant requis pour le backend')
    }
    if (child && !hasExited(child)) throw refusal('already-running', 'un worker tourne deja : stop + sortie reelle d\'abord')
    readySeen = false
    readyVersion = null
    readyCount = 0
    versionChanges = 0
    heartbeats = 0
    heartbeatSeq = null
    lastBeatAt = null
    anomalies = 0
    droppedLines = 0
    lineBuf = ''
    stdoutBuf = ''
    stderrBuf = ''
    exitInfo = null
    starts += 1
    // Spawn DIRECT, shell:false toujours : aucune interpretation, aucun shell.
    child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true
    })
    const spawned = child
    spawned.on('error', () => { settleExit(null, null) })
    spawned.on('exit', (code, signal) => { settleExit(code, signal) })
    if (spawned.stdout) {
      spawned.stdout.setEncoding('utf8')
      spawned.stdout.on('data', (chunk) => { onStdoutChunk(String(chunk)) })
    }
    if (spawned.stderr) {
      spawned.stderr.setEncoding('utf8')
      spawned.stderr.on('data', (chunk) => { stderrBuf = cap(stderrBuf, String(chunk)) })
    }
    // Reponse API de spawn : le processus est LANCE, pas pret (readiness cote noyau).
    return { pid: spawned.pid || null, starts }
  }

  async function waitExit () {
    if (!child) return { code: null, signal: null, noChild: true }
    if (exitInfo) return { ...exitInfo }
    return new Promise((resolve) => { exitWaiters.push(resolve) })
  }

  async function pollGone (ms) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (!child || hasExited(child) || exitInfo) return true
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return !child || hasExited(child) || Boolean(exitInfo)
  }

  // Arret borne REEL et HONNETE : SIGTERM (grace), puis SIGKILL (borne).
  // stopped:false signifie "toujours vivant", jamais une preuve de kill.
  async function stop (reason) {
    if (!child) return { stopped: true, noChild: true, reason: reason || null }
    if (hasExited(child) || exitInfo) return { stopped: true, ...exitInfo }
    try { child.kill('SIGTERM') } catch { /* deja sorti */ }
    const soft = await pollGone(stopGraceMs)
    if (soft) return { stopped: true, graceful: true, ...exitInfo }
    try { child.kill('SIGKILL') } catch { /* deja sorti */ }
    const hard = await pollGone(killTimeoutMs)
    return { stopped: hard, graceful: false, ...(exitInfo || { code: null, signal: null }) }
  }

  function boundedProbe (input) {
    return new Promise((resolve) => {
      let done = false
      const timer = setTimeout(() => {
        if (!done) {
          done = true
          probeFails += 1
          resolve({ ok: false, timeout: true })
        }
      }, probeTimeoutMs)
      if (timer && typeof timer.unref === 'function') timer.unref()
      Promise.resolve()
        .then(() => externalProbe(input))
        .then(
          (value) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: !!value }) } },
          () => { if (!done) { done = true; clearTimeout(timer); probeFails += 1; resolve({ ok: false }) } }
        )
    })
  }

  async function checkHealth () {
    if (!child) return { alive: false, version: null, pid: null, heartbeatAgeMs: null, heartbeatSeq: null, readyCount, probeOk: null }
    if (exitInfo || hasExited(child)) {
      return { alive: false, version: null, pid: child.pid || null, heartbeatAgeMs: null, heartbeatSeq: null, readyCount, probeOk: null }
    }
    if (!readySeen) {
      return { alive: false, version: null, pid: child.pid || null, heartbeatAgeMs: null, heartbeatSeq: null, readyCount, probeOk: null }
    }
    const heartbeatAgeMs = lastBeatAt == null ? null : Date.now() - lastBeatAt
    let probeOk = null
    if (externalProbe) {
      probeCalls += 1
      const probed = await boundedProbe({ pid: child.pid || null, version: readyVersion })
      probeOk = probed.ok
      if (!probeOk) {
        return { alive: false, version: null, pid: child.pid || null, heartbeatAgeMs, heartbeatSeq, readyCount, probeOk: false }
      }
    }
    return { alive: true, version: readyVersion, pid: child.pid || null, heartbeatAgeMs, heartbeatSeq, readyCount, probeOk }
  }

  function getExit () {
    return exitInfo ? { ...exitInfo } : null
  }

  function getPid () {
    return child && child.pid ? child.pid : null
  }

  // Observation synchrone : le fils gere est-il encore vivant ?
  function isChildAlive () {
    return child !== null && !hasExited(child) && !exitInfo
  }

  // Logs bornes (tails) : jamais d'env ni de secret, juste stdout/stderr recents.
  function getLogs (maxBytes) {
    const bound = maxBytes == null ? logBytesMax : Number(maxBytes)
    const safe = Number.isFinite(bound) && bound > 0 ? Math.min(bound, logBytesMax) : logBytesMax
    return {
      stdoutTail: stdoutBuf.slice(-safe),
      stderrTail: stderrBuf.slice(-safe),
      stdoutBytes: stdoutBuf.length,
      stderrBytes: stderrBuf.length,
      bounded: stdoutBuf.length <= logBytesMax && stderrBuf.length <= logBytesMax,
      starts
    }
  }

  function getStats () {
    return {
      starts,
      readyCount,
      versionChanges,
      heartbeats,
      heartbeatSeq,
      anomalies,
      droppedLines,
      probeCalls,
      probeFails,
      stdoutBytes: stdoutBuf.length,
      stderrBytes: stderrBuf.length
    }
  }

  // Cleanup synchrone sans orphelin : SIGKILL best-effort, stdio detruits,
  // waiters soldes (marques destroyed, jamais une fausse preuve de sortie :
  // exitInfo n'est PAS fabrique). Idempotent.
  function destroy () {
    const target = child
    child = null
    lineBuf = ''
    if (target) {
      try { target.kill('SIGKILL') } catch { /* deja sorti */ }
      try { target.stdout && target.stdout.destroy() } catch { /* ignore */ }
      try { target.stderr && target.stderr.destroy() } catch { /* ignore */ }
      try { target.removeAllListeners() } catch { /* ignore */ }
    }
    const waiters = exitWaiters
    exitWaiters = []
    const base = exitInfo ? { ...exitInfo } : { code: null, signal: null }
    for (const waiter of waiters) {
      try { waiter({ ...base, destroyed: true }) } catch { /* ignore */ }
    }
  }

  function close () {
    destroy()
  }

  return { start, stop, waitExit, checkHealth, getExit, getPid, isChildAlive, getLogs, getStats, close, destroy }
}

module.exports = { createProcessBackend }
