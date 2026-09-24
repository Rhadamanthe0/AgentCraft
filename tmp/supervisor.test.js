'use strict'
// Tests du noyau de supervision D12/D51 (ARCHITECTURE C4/C9, D04/D15) :
// pipeline trial/confirm `supervisor/core.js` + lifecycle `supervisor/process-backend.js`.
//
// Conventions : node:test + assert/strict, CommonJS, zero dependance externe.
// Ecriture EXCLUSIVE : seuls supervisor/core.js, supervisor/process-backend.js
// et ce test existent (candidate-store lu, jamais modifie).
// Tous les fichiers (candidate-store, fixtures workers, controles) vivent sous
// os.tmpdir(). Aucun runtime bot modifie, aucun deploiement.
// Verdict isolation : vrai processus fils, meme UID => lifecycle testable,
// AUCUNE isolation OS de production assuree (non tranchee, ne pas deployer).
//
// Pipeline prouve : CONTROLES host trusted (validateCandidate reverifie le
// digest disque via le VRAI candidate-store, checkQuiescent host a nonce)
// PUIS essai reel (trial, startup ready != succes metier) PUIS promotion
// lastGood uniquement via confirmTrial valide par validateTrial trusted.
// Toute preuve appelant/worker (quiescentProof:1, checks auto-declares) est
// ignoree ou refusee. Les hangs CPU sont de VRAIS fils (stall busy-loop).
// Deux limites terminees ici : anti-boucle restauration (UNE restauration puis
// failed-both si rechute avant stabilite, cause preservee) et quiescence `at`
// verifiee noyau (fake horloge : stale/future/generation/nonce refuses).
// Hypothese honnete : le callback validateCandidate est protege par le host
// (doubles memoire ou vrai store : reverifies, jamais crus sur parole).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { createSupervisor } = require('../supervisor/core')
const { createProcessBackend } = require('../supervisor/process-backend')
const { createCandidateStore } = require('../supervisor/candidate-store')

const SECRET_MARKERS = ['opencode-go', 'PLANNER_API_KEY', 'TYPESAFE_API_KEY', 'sk-', 'Bearer']

const WORKER_CODE = `'use strict';
const fs = require('node:fs');
const ctlPath = process.argv[2];
let ctl = { mode: 'normal', version: 'v1' };
try { ctl = Object.assign(ctl, JSON.parse(fs.readFileSync(ctlPath, 'utf8'))); } catch (e) { /* defaut */ }
const BEAT_MS = 200;
let seq = 0;
function beat(v) { seq += 1; console.log('HEARTBEAT ' + v + ' ' + seq); }
function stay() { setInterval(function () {}, 1000); }
if (ctl.ignoreSigterm) { process.on('SIGTERM', function () {}); }
else { process.on('SIGTERM', function () { process.exit(0); }); }
if (ctl.mode === 'crash') { console.error('boom ' + ctl.version); process.exit(1); }
if (ctl.mode === 'noisy') {
  let junk = '';
  for (let i = 0; i < 400; i++) { junk += 'ligne-bruit-' + i + '-xxxxxxxxxx\\n'; }
  process.stdout.write(junk);
}
if (ctl.mode === 'split') {
  process.stdout.write('REA');
  setTimeout(function () {
    process.stdout.write('DY ' + ctl.version + '\\n');
    setInterval(function () { beat(ctl.version); }, BEAT_MS);
  }, 300);
  stay();
} else if (ctl.mode === 'flip') {
  console.log('READY ' + ctl.version);
  setTimeout(function () { console.log('READY ' + ctl.flipTo); }, 100);
  setTimeout(function () { setInterval(function () { beat(ctl.flipTo); }, BEAT_MS); }, 150);
  stay();
} else if (ctl.mode === 'stall') {
  console.log('READY ' + ctl.version);
  let n = 0;
  const iv = setInterval(function () {
    n += 1; beat(ctl.version);
    if (n >= 3) { clearInterval(iv); const end = Date.now() + 25000; while (Date.now() < end) {} }
  }, BEAT_MS);
  stay();
} else if (ctl.mode === 'no-beat') {
  setTimeout(function () { console.log('READY ' + ctl.version); }, Number(ctl.readyDelayMs) || 0);
  stay();
} else {
  const reported = ctl.wrongVersion || ctl.version;
  setTimeout(function () {
    console.log('READY ' + reported);
    setInterval(function () { beat(reported); }, BEAT_MS);
  }, Number(ctl.readyDelayMs) || 0);
  stay();
}
`

function sha256hex (bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

// Rejet attendu par CODE exact (l'API contractuelle), pas par message.
async function rejectsCode (promise, ...codes) {
  await assert.rejects(promise, (err) => err && codes.includes(err.code),
    `attendu code ${codes.join('/')} (recu autre)`)
}

function memoryStore (fail) {
  const flags = fail || {}
  let saved = null
  return {
    save (snap) {
      if (flags.save) throw new Error('persist-hs')
      saved = JSON.parse(JSON.stringify(snap))
    },
    load () {
      if (flags.load) throw new Error('lecture-hs')
      return saved ? JSON.parse(JSON.stringify(saved)) : null
    },
    _saved () { return saved }
  }
}

// Registre trusted IN-MEMORY (host double de test) : digest recalcule a chaque
// validation, comme le fait le vrai store sur disque. Aucun bool appelant cru.
function memoryRegistry () {
  const map = new Map()
  return {
    add (version, extra) {
      const bytes = JSON.stringify({ version, ...(extra || {}) })
      map.set(version, { bytes, digest: sha256hex(Buffer.from(bytes, 'utf8')) })
    },
    tamper (version) {
      const entry = map.get(version)
      if (entry) entry.bytes += ' '
    },
    async validate (version) {
      const entry = map.get(version)
      if (!entry) {
        const err = new Error(`version inconnue : ${version}`)
        err.code = 'version-unknown'
        throw err
      }
      if (sha256hex(Buffer.from(entry.bytes, 'utf8')) !== entry.digest) {
        const err = new Error(`alteration detectee : ${version}`)
        err.code = 'tamper'
        throw err
      }
      return Object.freeze({
        version,
        manifestDigest: entry.digest,
        checks: Object.freeze([{ name: 'controls', ok: true }]),
        proof: Object.freeze({ status: 'pending-trial', by: 'host-test' }),
        status: 'pending-trial'
      })
    }
  }
}

// Quiescence host trusted : nonce vue une seule fois, version conforme,
// verdict horodate `at` (meme horloge injectee que le noyau pour les tests).
// `armed.fail=true` => refus (test quiescence refusee).
// `armed.verdict='old'|'future'|'badgen'|'badnonce'` => verdict adversarial.
function hostQuiescence (opts) {
  const nowFn = (opts && opts.nowFn) || Date.now
  const seen = new Set()
  const calls = []
  const api = {
    calls,
    armed: { fail: false, verdict: null },
    async check ({ version, at, nonce, generation }) {
      calls.push({ version, at, nonce, generation })
      if (api.armed.fail) {
        const err = new Error('point non coherent (host)')
        err.code = 'quiescent'
        throw err
      }
      if (typeof version !== 'string' || version === '') throw Object.assign(new Error('version requise'), { code: 'quiescent' })
      if (typeof at !== 'string' || at === '') throw Object.assign(new Error('horodatage requis'), { code: 'quiescent' })
      if (typeof nonce !== 'string' || nonce === '' || seen.has(nonce)) {
        throw Object.assign(new Error('nonce reuse ou absent'), { code: 'quiescent-reuse' })
      }
      seen.add(nonce)
      if (!Number.isInteger(generation) || generation < 0) throw Object.assign(new Error('generation requise'), { code: 'quiescent' })
      const mode = api.armed.verdict
      const echoAt = mode === 'old'
        ? new Date(nowFn() - 60000).toISOString()
        : mode === 'future'
          ? new Date(nowFn() + 60000).toISOString()
          : new Date(nowFn()).toISOString()
      return {
        ok: true,
        version,
        nonce: mode === 'badnonce' ? `${nonce}-forge` : nonce,
        generation: mode === 'badgen' ? generation + 1 : generation,
        at: echoAt
      }
    }
  }
  return api
}

// Preuve d'essai host trusted : seul `essai: 'reel-observe'` vaut confirmation.
function hostTrial () {
  const calls = []
  return {
    calls,
    async validate ({ version, proof }) {
      calls.push({ version, proof })
      if (proof && typeof proof === 'object' && proof.essai === 'reel-observe') {
        return { ok: true, version, at: new Date().toISOString() }
      }
      const err = new Error('preuve d\'essai insuffisante')
      err.code = 'trial-unproven'
      throw err
    }
  }
}

// Backend stub pilote, heartbeat-aware. Les hangs CPU restent des vrais fils.
function stubBackend (opts) {
  const autoHeal = !opts || opts.autoHeal !== false
  let health = { alive: false, version: null, heartbeatAgeMs: null, heartbeatSeq: null, readyCount: 0, probeOk: null }
  let exit = null
  let starts = 0
  let stops = 0
  let gen = 0
  const order = []
  let onStart = null
  return {
    order,
    stats: () => ({ starts, stops }),
    setHealth (h) { gen += 1; health = { ...h } },
    setOnStart (fn) { onStart = fn },
    crash (code) { gen += 1; exit = { code: code == null ? 1 : code, signal: null }; health = { alive: false, version: null, heartbeatAgeMs: null, heartbeatSeq: null, readyCount: 0, probeOk: null } },
    async start (c) {
      starts += 1
      order.push(`start:${c.version}`)
      exit = null
      if (onStart) await onStart(c)
      if (autoHeal) {
        const g = ++gen
        const timer = setTimeout(() => {
          if (g === gen) health = { alive: true, version: c.version, heartbeatAgeMs: 0, heartbeatSeq: 1, readyCount: 1, probeOk: null }
        }, 20)
        if (timer && typeof timer.unref === 'function') timer.unref()
      }
      return { pid: 0 }
    },
    async stop () { stops += 1; order.push('stop'); health = { alive: false, version: null, heartbeatAgeMs: null, heartbeatSeq: null, readyCount: 0, probeOk: null }; return { stopped: true } },
    async waitExit () { order.push('waitExit'); return { ...(exit || { code: 0, signal: null }) } },
    async checkHealth () { return { ...health } },
    getExit () { return exit ? { ...exit } : null },
    getPid () { return null },
    isChildAlive () { return health.alive === true }
  }
}

function freshDir (prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  assert.ok(dir.startsWith(os.tmpdir()), 'fixtures sous tmpdir OS uniquement')
  return dir
}

function writeWorker (dir) {
  const worker = path.join(dir, 'worker.js')
  const ctl = path.join(dir, 'ctl.json')
  fs.writeFileSync(worker, WORKER_CODE, 'utf8')
  fs.writeFileSync(ctl, JSON.stringify({ mode: 'normal', version: 'v1' }), 'utf8')
  assert.ok(worker.startsWith(os.tmpdir()) && ctl.startsWith(os.tmpdir()))
  return { worker, ctl }
}

function setCtl (ctl, obj) {
  fs.writeFileSync(ctl, JSON.stringify(obj), 'utf8')
}

function realBackend (dir, worker, ctl, over) {
  return createProcessBackend({
    command: process.execPath,
    args: [worker, ctl],
    cwd: dir,
    stopGraceMs: 400,
    killTimeoutMs: 1500,
    logBytesMax: 8192,
    ...(over || {})
  })
}

function collectEvents () {
  const events = []
  return { events, onEvent: (e) => { events.push(e) } }
}

async function shutdown (sup, backend) {
  try { if (sup) sup.close() } catch { /* ignore */ }
  try { if (backend) await backend.stop('test-cleanup') } catch { /* ignore */ }
  try { if (backend) backend.close() } catch { /* ignore */ }
}

function pidDead (pid) {
  try { process.kill(pid, 0); return false } catch { return true }
}

async function awaitPidDead (pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pidDead(pid)) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return pidDead(pid)
}

function supDefaults (over) {
  return {
    readinessTimeoutMs: 4000,
    pollMs: 50,
    heartbeatTimeoutMs: 1200,
    stopWaitMs: 6000,
    ...(over || {})
  }
}

// Pipeline candidate-store reel : botRoot + doctrine sous tmpdir.
function makePipeline () {
  const base = freshDir('sup-pipe-')
  const botRoot = path.join(base, 'bot')
  const versionsRoot = path.join(base, 'versions')
  const hostDir = path.join(base, 'host')
  fs.mkdirSync(botRoot, { recursive: true })
  fs.mkdirSync(versionsRoot, { recursive: true })
  fs.mkdirSync(hostDir, { recursive: true })
  fs.writeFileSync(path.join(botRoot, 'index.js'), `'use strict'\nmodule.exports = 1\n`, 'utf8')
  fs.writeFileSync(path.join(botRoot, 'package.json'), JSON.stringify({ name: 'bot-fixture', version: '0.0.1' }), 'utf8')
  const doctrinePath = path.join(hostDir, 'doctrine.txt')
  fs.writeFileSync(doctrinePath, 'doctrine-courante-v3 : stop prioritaire\n', 'utf8')
  const doctrine = {
    path: doctrinePath,
    version: 'doctrine-v3',
    digest: sha256hex(fs.readFileSync(doctrinePath))
  }
  const candStore = createCandidateStore({ versionsRoot, botRoot, doctrine })
  return { base, botRoot, versionsRoot, candStore }
}

test('pipeline nominal : controles trusted, trial sans promotion, confirm promeut', async (t) => {
  const { versionsRoot, candStore } = makePipeline()
  const descriptor = await candStore.prepare({
    reason: 'pipeline nominal',
    changes: [{ path: 'note.js', content: `'use strict'\nmodule.exports = 'n1'\n` }]
  })
  assert.equal(descriptor.status, 'pending-trial')
  assert.equal(descriptor.proof.status, 'pending-trial')
  const version = descriptor.version
  const dir = freshDir('sup-pipe-run-')
  const { worker, ctl } = writeWorker(dir)
  setCtl(ctl, { mode: 'normal', version })
  const raw = realBackend(dir, worker, ctl)
  // Liaison descripteur<->process : le backend refuse un digest non verifie.
  const seen = []
  const origStart = raw.start.bind(raw)
  raw.start = async (d) => {
    seen.push({ version: d.version, digest: d.manifestDigest })
    const expected = candStore.getDescriptor(d.version)
    assert.equal(d.manifestDigest, expected.manifestDigest, 'digest demarre == digest verifie disque')
    return origStart(d)
  }
  const quiescence = hostQuiescence()
  const trial = hostTrial()
  const store = memoryStore()
  const { events, onEvent } = collectEvents()
  const sup = createSupervisor({
    backend: raw,
    store,
    validateCandidate: async (v) => { await candStore.verify(v); return candStore.getDescriptor(v) },
    checkQuiescent: quiescence.check,
    validateTrial: trial.validate,
    onEvent,
    ...supDefaults()
  })
  t.after(() => shutdown(sup, raw))
  // Startup ready != succes metier : trial pret, previous lastGood inchange.
  const st = await sup.activate(version)
  assert.equal(st.state, 'trial')
  assert.equal(st.trial.version, version)
  assert.equal(st.lastGood, null, 'aucune promotion sans confirmTrial')
  assert.equal(seen.length, 1)
  assert.ok(quiescence.calls.length === 1 && typeof quiescence.calls[0].nonce === 'string')
  assert.ok(store._saved() && store._saved().trial.version === version, 'trial persiste')
  assert.ok(events.some((e) => e.type === 'trial-ready'))
  // Promotion uniquement sur preuve validee par le host.
  const promoted = await sup.confirmTrial(version, { essai: 'reel-observe', detail: 'comportement constate' })
  assert.equal(promoted.state, 'active')
  assert.equal(promoted.lastGood.version, version)
  assert.equal(promoted.trial, null)
  assert.ok(store._saved().lastGood.version === version)
  assert.ok(events.some((e) => e.type === 'promoted'))
  void versionsRoot
})

test('candidate_store tamper : alteration disque refusee, 0 start', async (t) => {
  const { versionsRoot, candStore } = makePipeline()
  const descriptor = await candStore.prepare({
    reason: 'tamper test',
    changes: [{ path: 'note.js', content: `'use strict'\nmodule.exports = 1\n` }]
  })
  fs.appendFileSync(path.join(versionsRoot, descriptor.version, 'index.js'), '\n// tamper\n', 'utf8')
  const dir = freshDir('sup-tamper-')
  const { worker, ctl } = writeWorker(dir)
  const raw = realBackend(dir, worker, ctl)
  const quiescence = hostQuiescence()
  const trial = hostTrial()
  const sup = createSupervisor({
    backend: raw,
    store: memoryStore(),
    validateCandidate: async (v) => { await candStore.verify(v); return candStore.getDescriptor(v) },
    checkQuiescent: quiescence.check,
    validateTrial: trial.validate,
    ...supDefaults({ readinessTimeoutMs: 2000 })
  })
  t.after(() => shutdown(sup, raw))
  await rejectsCode(sup.activate(descriptor.version), 'tamper')
  assert.equal(raw.getStats().starts, 0, 'validation refusee avant tout start')
  assert.equal(sup.status().lastGood, null)
  assert.equal(sup.status().trial, null)
})

test('quiescence forgee ignoree : preuve appelant sans effet, host seul decide', async (t) => {
  const registry = memoryRegistry()
  registry.add('vQ')
  const dir = freshDir('sup-quiesc-')
  const { worker, ctl } = writeWorker(dir)
  setCtl(ctl, { mode: 'normal', version: 'vQ' })
  const raw = realBackend(dir, worker, ctl)
  const quiescence = hostQuiescence()
  const trial = hostTrial()
  const sup = createSupervisor({
    backend: raw,
    store: memoryStore(),
    validateCandidate: registry.validate,
    checkQuiescent: quiescence.check,
    validateTrial: trial.validate,
    ...supDefaults()
  })
  t.after(() => shutdown(sup, raw))
  // Preuve appelant forgee ({quiescentProof:1}) : ignoree, le host decide.
  const st = await sup.activate('vQ', { quiescentProof: 1 })
  assert.equal(st.state, 'trial')
  assert.equal(quiescence.calls.length, 1, 'quiescence host mesuree, pas la preuve appelant')
  assert.ok(typeof quiescence.calls[0].nonce === 'string' && quiescence.calls[0].nonce !== '1')
  // Host arme en refus : aucun start, essai refuse.
  quiescence.armed.fail = true
  registry.add('vQ2')
  setCtl(ctl, { mode: 'normal', version: 'vQ2' })
  const raw2 = realBackend(dir, worker, ctl)
  const sup2 = createSupervisor({
    backend: raw2,
    store: memoryStore(),
    validateCandidate: registry.validate,
    checkQuiescent: quiescence.check,
    validateTrial: trial.validate,
    ...supDefaults()
  })
  t.after(() => shutdown(sup2, raw2))
  await rejectsCode(sup2.activate('vQ2'), 'quiescent')
  assert.equal(raw2.getStats().starts, 0, 'quiescence refusee avant tout start')
})

test('nonce fraicheur + generation : jamais de rejeu, stop serialise', async (t) => {
  const registry = memoryRegistry()
  registry.add('vN1')
  registry.add('vN2')
  const dir = freshDir('sup-nonce-')
  const { worker, ctl } = writeWorker(dir)
  setCtl(ctl, { mode: 'normal', version: 'vN1' })
  const raw = realBackend(dir, worker, ctl)
  const quiescence = hostQuiescence()
  const trial = hostTrial()
  const sup = createSupervisor({
    backend: raw,
    store: memoryStore(),
    validateCandidate: registry.validate,
    checkQuiescent: quiescence.check,
    validateTrial: trial.validate,
    ...supDefaults()
  })
  t.after(() => shutdown(sup, raw))
  await sup.activate('vN1')
  setCtl(ctl, { mode: 'normal', version: 'vN2' })
  const genBefore = sup.status().generation
  await sup.activate('vN2')
  assert.equal(quiescence.calls.length, 2)
  assert.ok(quiescence.calls[0].nonce !== quiescence.calls[1].nonce, 'nonce fraiche par tentative')
  await sup.totalStop('serialisation')
  sup.resume()
  assert.equal(sup.status().generation, genBefore + 1, 'stop serialise la generation')
})

test('promotion avant trial refusee ; confirm idempotent', async (t) => {
  const registry = memoryRegistry()
  registry.add('vP')
  const backend = stubBackend()
  const quiescence = hostQuiescence()
  const trial = hostTrial()
  const sup = createSupervisor({
    backend,
    store: memoryStore(),
    validateCandidate: registry.validate,
    checkQuiescent: quiescence.check,
    validateTrial: trial.validate,
    ...supDefaults({ readinessTimeoutMs: 1000 })
  })
  t.after(() => shutdown(sup, backend))
  // Aucun essai : promotion refusee.
  await rejectsCode(sup.confirmTrial('vP', { essai: 'reel-observe' }), 'no-trial')
  assert.equal(sup.status().lastGood, null)
  await sup.activate('vP')
  assert.equal(sup.status().lastGood, null, 'trial ne promeut pas')
  // Preuve insuffisante : pas de promotion.
  await rejectsCode(sup.confirmTrial('vP', { essai: 'on-dit' }), 'trial-unproven')
  assert.equal(sup.status().lastGood, null)
  const callsBefore = trial.calls.length
  const promoted = await sup.confirmTrial('vP', { essai: 'reel-observe' })
  assert.equal(promoted.lastGood.version, 'vP')
  assert.equal(promoted.state, 'active')
  // Idempotent : deja confirme, sans essai, sans revalidation.
  const again = await sup.confirmTrial('vP', { essai: 'reel-observe' })
  assert.equal(again.lastGood.version, 'vP')
  assert.equal(trial.calls.length, callsBefore + 1, 'aucune revalidation sur confirm idempotent')
})

test('confirm re-verifie disque : tamper entre trial et confirm refuse', async (t) => {
  const { versionsRoot, candStore } = makePipeline()
  const descriptor = await candStore.prepare({
    reason: 'confirm tamper',
    changes: [{ path: 'note.js', content: `'use strict'\nmodule.exports = 1\n` }]
  })
  const version = descriptor.version
  const dir = freshDir('sup-confirm-tamper-')
  const { worker, ctl } = writeWorker(dir)
  setCtl(ctl, { mode: 'normal', version })
  const raw = realBackend(dir, worker, ctl)
  const quiescence = hostQuiescence()
  const trial = hostTrial()
  const sup = createSupervisor({
    backend: raw,
    store: memoryStore(),
    validateCandidate: async (v) => { await candStore.verify(v); return candStore.getDescriptor(v) },
    checkQuiescent: quiescence.check,
    validateTrial: trial.validate,
    ...supDefaults()
  })
  t.after(() => shutdown(sup, raw))
  await sup.activate(version)
  assert.equal(sup.status().state, 'trial')
  fs.appendFileSync(path.join(versionsRoot, version, 'index.js'), '\n// tamper tardif\n', 'utf8')
  await rejectsCode(sup.confirmTrial(version, { essai: 'reel-observe' }), 'tamper')
  assert.equal(sup.status().lastGood, null, 'promotion refusee sur essai altere')
  assert.equal(sup.status().trial.version, version, 'essai conserve, a re-prouver apres correction')
})

test('totalStop pendant rollback : stopped, jamais ecrase par failed-both', async (t) => {
  const registry = memoryRegistry()
  registry.add('v1')
  registry.add('v2')
  const backend = stubBackend()
  const { events, onEvent } = collectEvents()
  const quiescence = hostQuiescence()
  const trial = hostTrial()
  const sup = createSupervisor({
    backend,
    store: memoryStore(),
    validateCandidate: registry.validate,
    checkQuiescent: quiescence.check,
    validateTrial: trial.validate,
    onEvent,
    ...supDefaults({ readinessTimeoutMs: 1000 })
  })
  t.after(() => shutdown(sup, backend))
  await sup.activate('v1')
  await sup.confirmTrial('v1', { essai: 'reel-observe' })
  assert.equal(sup.status().lastGood.version, 'v1')
  // v2 crashe ; le redemarrage v1 reste bloque derriere une barriere.
  const origStart = backend.start.bind(backend)
  let releaseRestart = null
  backend.start = async (c) => {
    if (c.version === 'v2') {
      await origStart(c)
      backend.crash(1)
      return { pid: 0 }
    }
    await new Promise((resolve) => { releaseRestart = resolve })
    return origStart(c)
  }
  const pending = sup.activate('v2')
  pending.catch(() => {}) // promesse flottante : echec constate via rejectsCode
  await new Promise((r) => setTimeout(r, 300))
  assert.ok(events.some((e) => e.type === 'rollback-start'), 'rollback en cours')
  const stopped = await sup.totalStop('preemption rollback')
  assert.equal(stopped.state, 'stopped')
  assert.equal(stopped.totalStopped, true)
  releaseRestart()
  await rejectsCode(pending, 'crash')
  const st = sup.status()
  assert.equal(st.state, 'stopped', 'stopped jamais ecrase par failed-both')
  assert.equal(st.failedBoth, false)
  assert.ok(!events.some((e) => e.type === 'failed-both'), 'aucun failed-both pendant latch total')
})

test('waitExit non borne : uncertain, interdiction nouveau process, recheck', async (t) => {
  let released = false
  let releaseExit = null
  let starts = 0
  const backend = {
    async start () { starts += 1; return { pid: 4242 } },
    async stop () { return { stopped: false } },
    waitExit () {
      if (released) return Promise.resolve({ code: 1, signal: null })
      return new Promise((resolve) => { releaseExit = resolve })
    },
    async checkHealth () {
      if (starts > 0) {
        return { alive: true, version: 'vU', heartbeatAgeMs: 0, heartbeatSeq: 1, readyCount: 1, probeOk: null }
      }
      return { alive: false, version: null, heartbeatAgeMs: null, heartbeatSeq: null, readyCount: 0, probeOk: null }
    },
    getExit () { return released ? { code: 1, signal: null } : null },
    getPid () { return released ? null : 4242 },
    isChildAlive () { return !released }
  }
  const registry = memoryRegistry()
  registry.add('vU')
  const quiescence = hostQuiescence()
  const trial = hostTrial()
  const sup = createSupervisor({
    backend,
    store: memoryStore(),
    validateCandidate: registry.validate,
    checkQuiescent: quiescence.check,
    validateTrial: trial.validate,
    ...supDefaults({ stopWaitMs: 500 })
  })
  t.after(() => shutdown(sup, backend))
  const stopped = await sup.totalStop('timeout waitExit')
  assert.equal(stopped.state, 'stopped')
  assert.deepEqual(stopped.uncertain, { pid: 4242, since: stopped.uncertain.since, reason: 'total-stop' })
  // `uncertain` survit au resume (seule une sortie reobservee le leve) ;
  // le latch total prime d'abord, puis l'interdiction uncertain.
  sup.resume()
  assert.equal(sup.status().totalStopped, false)
  assert.ok(sup.status().uncertain, 'uncertain persiste apres resume')
  // Timeout waitExit != preuve de kill : aucun nouveau process.
  await rejectsCode(sup.activate('vU'), 'uncertain')
  await rejectsCode(sup.confirmTrial('vU', { essai: 'reel-observe' }), 'uncertain')
  assert.equal(starts, 0, 'interdiction nouveau process tant qu incertain')
  // Sortie reobservee plus tard : recheck leve l'interdiction.
  released = true
  releaseExit({ code: 1, signal: null })
  const after = sup.recheck()
  assert.equal(after.uncertain, null)
  const st = await sup.activate('vU')
  assert.equal(starts, 1)
  assert.equal(st.state, 'trial')
})

test('READY fragmente : deux writes separes reconstitues, trial ok', async (t) => {
  const registry = memoryRegistry()
  registry.add('vF')
  const dir = freshDir('sup-split-')
  const { worker, ctl } = writeWorker(dir)
  setCtl(ctl, { mode: 'split', version: 'vF' })
  const raw = realBackend(dir, worker, ctl)
  const quiescence = hostQuiescence()
  const trial = hostTrial()
  const sup = createSupervisor({
    backend: raw,
    store: memoryStore(),
    validateCandidate: registry.validate,
    checkQuiescent: quiescence.check,
    validateTrial: trial.validate,
    ...supDefaults()
  })
  t.after(() => shutdown(sup, raw))
  const st = await sup.activate('vF')
  assert.equal(st.state, 'trial')
  const stats = raw.getStats()
  assert.equal(stats.readyCount, 1, 'READY fragmente reconstitue exactement une fois')
  const health = await raw.checkHealth()
  assert.equal(health.version, 'vF')
})

test('second READY autre version : observe, wrong-version, rien de promu', async (t) => {
  const registry = memoryRegistry()
  registry.add('vA')
  const dir = freshDir('sup-flip-')
  const { worker, ctl } = writeWorker(dir)
  setCtl(ctl, { mode: 'flip', version: 'vA', flipTo: 'vB' })
  const raw = realBackend(dir, worker, ctl)
  const quiescence = hostQuiescence()
  const trial = hostTrial()
  const sup = createSupervisor({
    backend: raw,
    store: memoryStore(),
    validateCandidate: registry.validate,
    checkQuiescent: quiescence.check,
    validateTrial: trial.validate,
    ...supDefaults({ readinessTimeoutMs: 3000 })
  })
  t.after(() => shutdown(sup, raw))
  await rejectsCode(sup.activate('vA'), 'wrong-version')
  assert.ok(raw.getStats().versionChanges >= 1, 'second READY observe, pas ignore')
  assert.equal(sup.status().lastGood, null)
  assert.equal(sup.status().trial, null)
})

test('hung apres ready : rollback, surveillance continue, pas de boucle', async (t) => {
  const registry = memoryRegistry()
  registry.add('vH')
  const dir = freshDir('sup-stall-')
  const { worker, ctl } = writeWorker(dir)
  setCtl(ctl, { mode: 'normal', version: 'vH' })
  const raw = realBackend(dir, worker, ctl)
  const { events, onEvent } = collectEvents()
  const quiescence = hostQuiescence()
  const trial = hostTrial()
  const sup = createSupervisor({
    backend: raw,
    store: memoryStore(),
    validateCandidate: registry.validate,
    checkQuiescent: quiescence.check,
    validateTrial: trial.validate,
    onEvent,
    ...supDefaults({ heartbeatTimeoutMs: 800 })
  })
  t.after(() => shutdown(sup, raw))
  await sup.activate('vH')
  await sup.confirmTrial('vH', { essai: 'reel-observe' })
  assert.equal(sup.status().lastGood.version, 'vH')
  // Le meme binaire cale APRES READY : trial d'abord pret (beats frais),
  // puis busy-loop (vrai fils) => la surveillance continue declenche le rollback.
  setCtl(ctl, { mode: 'stall', version: 'vH' })
  const trial2 = await sup.activate('vH')
  assert.equal(trial2.state, 'trial', 'essai pret avant le calage (startup != metier)')
  // Pendant le rollback, remettre un ctl sain : le redemarrage doit etre frais.
  const flipped = { done: false }
  const watcher = setInterval(() => {
    if (sup.status().state === 'rolling-back' && !flipped.done) {
      flipped.done = true
      setCtl(ctl, { mode: 'normal', version: 'vH' })
    }
  }, 50)
  try {
    await new Promise((r) => setTimeout(r, 5000))
  } finally {
    clearInterval(watcher)
  }
  assert.ok(flipped.done, 'ctl assaini pendant le rollback')
  const st = sup.status()
  assert.equal(st.state, 'active', 'version restauree et surveillee')
  assert.equal(st.active.version, 'vH')
  assert.equal(events.filter((e) => e.type === 'rollback-done').length, 1, 'rollback exactement une fois')
  assert.ok(events.some((e) => e.type === 'rollback-start' && e.cause === 'hang'), 'cause hang constatee')
  // Surveillance continue : beats frais, plus aucun rollback.
  const health = await raw.checkHealth()
  assert.equal(health.alive, true)
  assert.ok(typeof health.heartbeatAgeMs === 'number' && health.heartbeatAgeMs < 800, 'heartbeats frais apres restauration')
  await new Promise((r) => setTimeout(r, 800))
  assert.equal(events.filter((e) => e.type === 'rollback-done').length, 1, 'pas de boucle de rollback')
})

test('heartbeat requis : READY sans beat ne suffit pas', async (t) => {
  const registry = memoryRegistry()
  registry.add('vN')
  const dir = freshDir('sup-nobeat-')
  const { worker, ctl } = writeWorker(dir)
  setCtl(ctl, { mode: 'no-beat', version: 'vN' })
  const raw = realBackend(dir, worker, ctl)
  const quiescence = hostQuiescence()
  const trial = hostTrial()
  const sup = createSupervisor({
    backend: raw,
    store: memoryStore(),
    validateCandidate: registry.validate,
    checkQuiescent: quiescence.check,
    validateTrial: trial.validate,
    ...supDefaults({ readinessTimeoutMs: 1500 })
  })
  t.after(() => shutdown(sup, raw))
  await rejectsCode(sup.activate('vN'), 'readiness-timeout')
  assert.match(sup.status().lastError.message, /no-heartbeat/)
  assert.equal(sup.status().trial, null, 'latch READY seul ne vaut pas essai')
})

test('version adverse : identifiant exige, regex fermee, jamais interpolee', async (t) => {
  const registry = memoryRegistry()
  registry.add('v1')
  let validatorCalls = 0
  const backend = stubBackend()
  const sup = createSupervisor({
    backend,
    store: memoryStore(),
    validateCandidate: async (v) => { validatorCalls += 1; return registry.validate(v) },
    checkQuiescent: hostQuiescence().check,
    validateTrial: hostTrial().validate,
    ...supDefaults({ readinessTimeoutMs: 500 })
  })
  t.after(() => shutdown(sup, backend))
  await rejectsCode(sup.activate('v.*'), 'candidate-version')
  await rejectsCode(sup.activate({ version: 'v1' }), 'candidate-version')
  await rejectsCode(sup.activate(''), 'candidate-version')
  assert.equal(validatorCalls, 0, 'identifiant invalide refuse avant tout callback')
  // Backend direct : version non conforme refusee avant spawn.
  const dir = freshDir('sup-vers-')
  const raw = createProcessBackend({ command: process.execPath, args: ['-e', '1'], cwd: dir })
  await rejectsCode(raw.start({ version: 'v(x)' }), 'version')
  assert.equal(raw.getStats().starts, 0)
  raw.close()
})

test('crash startup sans lastGood : echec constate, idle, worker mort', async (t) => {
  const registry = memoryRegistry()
  registry.add('vX')
  const dir = freshDir('sup-crash-')
  const { worker, ctl } = writeWorker(dir)
  setCtl(ctl, { mode: 'crash', version: 'vX' })
  const raw = realBackend(dir, worker, ctl)
  const sup = createSupervisor({
    backend: raw,
    store: memoryStore(),
    validateCandidate: registry.validate,
    checkQuiescent: hostQuiescence().check,
    validateTrial: hostTrial().validate,
    ...supDefaults({ readinessTimeoutMs: 3000 })
  })
  t.after(() => shutdown(sup, raw))
  await rejectsCode(sup.activate('vX'), 'crash')
  const st = sup.status()
  assert.equal(st.active, null)
  assert.equal(st.trial, null)
  assert.equal(st.state, 'idle', 'aucun actif ni essai promu')
  const health = await raw.checkHealth()
  assert.equal(health.alive, false, 'worker reellement sorti')
  assert.equal(raw.getStats().starts, 1, 'un seul start, pas de boucle')
})

test('both fail : previous lastGood intact, failed-both, reprise explicite', async (t) => {
  const registry = memoryRegistry()
  registry.add('v1')
  registry.add('v2')
  registry.add('v3')
  const dir = freshDir('sup-both-')
  const { worker, ctl } = writeWorker(dir)
  setCtl(ctl, { mode: 'normal', version: 'v1' })
  const raw = realBackend(dir, worker, ctl)
  const { events, onEvent } = collectEvents()
  const quiescence = hostQuiescence()
  const trial = hostTrial()
  const sup = createSupervisor({
    backend: raw,
    store: memoryStore(),
    validateCandidate: registry.validate,
    checkQuiescent: quiescence.check,
    validateTrial: trial.validate,
    onEvent,
    ...supDefaults({ readinessTimeoutMs: 3000 })
  })
  t.after(() => shutdown(sup, raw))
  await sup.activate('v1')
  await sup.confirmTrial('v1', { essai: 'reel-observe' })
  // Tout redemarrage casse (ctl, pas le disque) : candidate + rollback en echec.
  setCtl(ctl, { mode: 'crash', version: 'v2' })
  await rejectsCode(sup.activate('v2'), 'crash')
  const st = sup.status()
  assert.equal(st.state, 'failed-both')
  assert.equal(st.failedBoth, true)
  assert.equal(st.active, null)
  assert.equal(st.trial, null)
  assert.ok(events.some((e) => e.type === 'failed-both'), 'evenement failed-both emis')
  const startsBefore = raw.getStats().starts
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(raw.getStats().starts, startsBefore, 'aucune reprise automatique')
  const health = await raw.checkHealth()
  assert.equal(health.alive, false, 'hardstop : worker mort')
  await rejectsCode(sup.activate('v3'), 'failed-both')
  sup.resume()
  setCtl(ctl, { mode: 'normal', version: 'v3' })
  const trial3 = await sup.activate('v3')
  assert.equal(trial3.state, 'trial', 'reprise explicite en essai, pas en actif')
  const after = await sup.confirmTrial('v3', { essai: 'reel-observe' })
  assert.equal(after.lastGood.version, 'v3')
})

test('store en panne : fail closed quiesce, previous lastGood inchange', async (t) => {
  const registry = memoryRegistry()
  registry.add('v1')
  const dir = freshDir('sup-store-')
  const { worker, ctl } = writeWorker(dir)
  setCtl(ctl, { mode: 'normal', version: 'v1' })
  const raw = realBackend(dir, worker, ctl)
  const sup = createSupervisor({
    backend: raw,
    store: memoryStore({ save: true }),
    validateCandidate: registry.validate,
    checkQuiescent: hostQuiescence().check,
    validateTrial: hostTrial().validate,
    ...supDefaults()
  })
  t.after(() => shutdown(sup, raw))
  await rejectsCode(sup.activate('v1'), 'persist')
  assert.equal(sup.status().trial, null, 'fail closed : aucun essai sans persistance')
  assert.equal(sup.status().lastGood, null)
  const health = await raw.checkHealth()
  assert.equal(health.alive, false, 'quiesce : worker candidat arrete')
})

test('close cleanup : aucun orphelin, pid mort, backend vide', async (t) => {
  const registry = memoryRegistry()
  registry.add('vC')
  const dir = freshDir('sup-close-')
  const { worker, ctl } = writeWorker(dir)
  setCtl(ctl, { mode: 'normal', version: 'vC' })
  const raw = realBackend(dir, worker, ctl)
  const sup = createSupervisor({
    backend: raw,
    store: memoryStore(),
    validateCandidate: registry.validate,
    checkQuiescent: hostQuiescence().check,
    validateTrial: hostTrial().validate,
    ...supDefaults()
  })
  t.after(() => shutdown(sup, raw))
  await sup.activate('vC')
  const pid = raw.getPid()
  assert.ok(typeof pid === 'number' && pid !== process.pid, 'vrai fils')
  sup.close()
  assert.ok(await awaitPidDead(pid, 3000), 'fils tue au close, aucun orphelin')
  assert.equal(raw.getPid(), null, 'backend vide apres close')
})

test('externalProbe bornee : sonde qui pend => non vivant, trial refuse', async (t) => {
  const registry = memoryRegistry()
  registry.add('vE')
  const dir = freshDir('sup-probe-')
  const { worker, ctl } = writeWorker(dir)
  setCtl(ctl, { mode: 'normal', version: 'vE' })
  const raw = realBackend(dir, worker, ctl, {
    externalProbe: () => new Promise(() => {}), // sonde qui ne repond jamais
    probeTimeoutMs: 100
  })
  const sup = createSupervisor({
    backend: raw,
    store: memoryStore(),
    validateCandidate: registry.validate,
    checkQuiescent: hostQuiescence().check,
    validateTrial: hostTrial().validate,
    ...supDefaults({ readinessTimeoutMs: 1500 })
  })
  t.after(() => shutdown(sup, raw))
  await rejectsCode(sup.activate('vE'), 'readiness-timeout')
  assert.ok(raw.getStats().probeCalls > 0, 'sonde appelee')
  assert.ok(raw.getStats().probeFails > 0, 'timeout de sonde comptabilise, borne respecte')
  assert.equal(sup.status().trial, null)
})

test('logs bornes sans secrets, meme UID : pas d isolation OS de production', async (t) => {
  const registry = memoryRegistry()
  registry.add('vL')
  const dir = freshDir('sup-logs-')
  const { worker, ctl } = writeWorker(dir)
  setCtl(ctl, { mode: 'noisy', version: 'vL' })
  const raw = realBackend(dir, worker, ctl)
  const sup = createSupervisor({
    backend: raw,
    store: memoryStore(),
    validateCandidate: registry.validate,
    checkQuiescent: hostQuiescence().check,
    validateTrial: hostTrial().validate,
    ...supDefaults()
  })
  t.after(() => shutdown(sup, raw))
  await sup.activate('vL')
  const logs = raw.getLogs()
  assert.ok(logs.stdoutBytes <= 8192 && logs.bounded, `logs bornes (mesure ${logs.stdoutBytes} octets)`)
  const blob = logs.stdoutTail + logs.stderrTail
  for (const marker of SECRET_MARKERS) {
    assert.ok(!blob.includes(marker), `secret absent des logs : ${marker}`)
  }
  if (typeof process.getuid === 'function') {
    assert.equal(typeof process.getuid(), 'number', 'UID parent observable, herite par le fils')
  }
  assert.ok(raw.getPid() !== process.pid, 'fils distinct mais meme utilisateur : isolation OS NON assuree')
})

test('hang recurrent borne : une restauration puis failed-both, cause hang preservee', async (t) => {
  const registry = memoryRegistry()
  registry.add('vR')
  const dir = freshDir('sup-recur-')
  const { worker, ctl } = writeWorker(dir)
  setCtl(ctl, { mode: 'normal', version: 'vR' })
  const raw = realBackend(dir, worker, ctl)
  const { events, onEvent } = collectEvents()
  const quiescence = hostQuiescence()
  const trial = hostTrial()
  const sup = createSupervisor({
    backend: raw,
    store: memoryStore(),
    validateCandidate: registry.validate,
    checkQuiescent: quiescence.check,
    validateTrial: trial.validate,
    onEvent,
    ...supDefaults({ heartbeatTimeoutMs: 800, stabilityWindowMs: 6000 })
  })
  t.after(() => shutdown(sup, raw))
  await sup.activate('vR')
  await sup.confirmTrial('vR', { essai: 'reel-observe' })
  assert.equal(sup.status().lastGood.version, 'vR')
  assert.equal(raw.getStats().starts, 1)
  // Meme version qui READY puis cale a chaque restart (stall busy-loop reel).
  setCtl(ctl, { mode: 'stall', version: 'vR' })
  const trial2 = await sup.activate('vR')
  assert.equal(trial2.state, 'trial', 'essai pret avant le calage')
  assert.equal(raw.getStats().starts, 2)
  // Attente : hang -> restauration #1 -> rechute -> borne failed-both.
  await new Promise((r) => setTimeout(r, 11000))
  const st = sup.status()
  assert.equal(st.state, 'failed-both', 'pas de boucle infinie de restart')
  assert.equal(st.failedBoth, true)
  assert.equal(st.active, null)
  assert.equal(raw.getStats().starts, 3, 'exactement 3 starts : initial + trial + UNE restauration')
  assert.equal(st.lastRestore.version, 'vR', 'restauration tracee')
  assert.equal(st.lastError.code, 'unstable', 'diagnostic borne, pas un crash generique')
  const both = events.filter((e) => e.type === 'failed-both')
  assert.equal(both.length, 1)
  assert.equal(both[0].unstable, true)
  assert.equal(both[0].firstCause, 'hang', 'cause diagnostique preservee')
  assert.equal(events.filter((e) => e.type === 'rollback-done').length, 1, 'une seule restauration')
  // Aucune autoboucle ensuite : le compteur ne bouge plus, le worker est mort.
  await new Promise((r) => setTimeout(r, 1500))
  assert.equal(raw.getStats().starts, 3, 'aucun restart spontane apres failed-both')
  const pid = raw.getPid()
  if (typeof pid === 'number') assert.ok(await awaitPidDead(pid, 3000), 'hardstop effectif')
})

test('quiescence verdict adversarial : stale/future/generation/nonce refuses, frais accepte', async (t) => {
  const FIXED = 1700000000000
  const nowFn = () => FIXED
  const registry = memoryRegistry()
  for (const v of ['vQ1', 'vQ2', 'vQ3', 'vQ4', 'vQ5']) registry.add(v)
  const backend = stubBackend()
  const quiescence = hostQuiescence({ nowFn })
  const trial = hostTrial()
  const sup = createSupervisor({
    backend,
    store: memoryStore(),
    validateCandidate: registry.validate,
    checkQuiescent: quiescence.check,
    validateTrial: trial.validate,
    ...supDefaults({ readinessTimeoutMs: 800, maxQuiescenceAgeMs: 5000, maxQuiescenceFutureMs: 1000, nowFn })
  })
  t.after(() => shutdown(sup, backend))
  quiescence.armed.verdict = 'old'
  await rejectsCode(sup.activate('vQ1'), 'quiescent-stale')
  quiescence.armed.verdict = 'future'
  await rejectsCode(sup.activate('vQ2'), 'quiescent-future')
  quiescence.armed.verdict = 'badgen'
  await rejectsCode(sup.activate('vQ3'), 'quiescent-stale')
  quiescence.armed.verdict = 'badnonce'
  await rejectsCode(sup.activate('vQ4'), 'quiescent-replay')
  assert.equal(backend.stats().starts, 0, 'verdict non frais : aucun start')
  // Verdict frais (meme horloge) : essai autorise.
  quiescence.armed.verdict = null
  const st = await sup.activate('vQ5')
  assert.equal(st.state, 'trial')
})

test('close pendant activation : rejet borne, aucun timer orphelin', async (t) => {
  const registry = memoryRegistry()
  registry.add('vK')
  const backend = stubBackend({ autoHeal: false })
  let calls = 0
  let destroyed = false
  const origCheck = backend.checkHealth.bind(backend)
  backend.checkHealth = async () => { calls += 1; return origCheck() }
  backend.destroy = () => { destroyed = true }
  const sup = createSupervisor({
    backend,
    store: memoryStore(),
    validateCandidate: registry.validate,
    checkQuiescent: hostQuiescence().check,
    validateTrial: hostTrial().validate,
    ...supDefaults({ readinessTimeoutMs: 1500, pollMs: 50 })
  })
  t.after(() => shutdown(sup, backend))
  const pending = sup.activate('vK')
  pending.catch(() => {}) // promesse flottante : echec constate via rejectsCode
  await new Promise((r) => setTimeout(r, 150))
  sup.close()
  assert.equal(destroyed, true, 'backend detruit au close')
  await rejectsCode(pending, 'readiness-timeout')
  const settled = calls
  assert.ok(settled > 0, 'la boucle en vol a bien interroge avant de se borner')
  await new Promise((r) => setTimeout(r, 250))
  assert.equal(calls, settled, 'aucun tick liveness ni boucle apres close')
})
