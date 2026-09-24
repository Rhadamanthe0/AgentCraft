'use strict'

// Integration reelle offline de l'atelier : `bot/unlock-service.js` pilote le
// VRAI `supervisor/candidate-store.js` (prepare/verify) + le VRAI
// `supervisor/core.js` + `supervisor/process-backend.js` (fils fixture sous
// os.tmpdir(), protocole READY/HEARTBEAT), avec un trialRunner qui MESURE
// l'effet fixture (octets + SHA256 du fichier candidate) et un `validateTrial`
// host lie job/version/nonce/mesure. Aucun monde de jeu, aucun socket Docker,
// aucun reseau : tout est processus local jete apres test.
//
// Format commun prouve : la preuve confirmee est
// `{ essai:'reel-observe', version, jobId, nonce, doctrineVersion,
// measurements }`, construite par le service depuis les mesures du runner.
// Un booleen LLM recopie ne passe jamais `validateTrial`.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { createUnlockService, PROOF_MARK } = require('../bot/unlock-service')
const { createCandidateStore } = require('../supervisor/candidate-store')
const { createSupervisor } = require('../supervisor/core')
const { createProcessBackend } = require('../supervisor/process-backend')

const DOCTRINE_VERSION = 'doctrine-v3'

const WORKER_CODE = `'use strict';
const fs = require('node:fs');
const vfile = process.argv[2];
let v = 'unknown';
try { v = String(fs.readFileSync(vfile, 'utf8')).trim().split(/\\s+/)[0] || 'unknown'; } catch (e) { v = 'unknown'; }
console.log('READY ' + v);
let seq = 0;
setInterval(() => { seq += 1; console.log('HEARTBEAT ' + v + ' ' + seq); }, 150);
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`

function sha256hex (bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function freshDir (prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  assert.ok(dir.startsWith(os.tmpdir()), 'fixtures sous tmpdir OS uniquement')
  return dir
}

function memoryStore () {
  let saved = null
  return {
    save (snap) { saved = JSON.parse(JSON.stringify(snap)) },
    load () { return saved ? JSON.parse(JSON.stringify(saved)) : null },
    _saved () { return saved }
  }
}

function hostQuiescence () {
  const seen = new Set()
  return {
    async check ({ version, at, nonce, generation }) {
      if (typeof nonce !== 'string' || !nonce || seen.has(nonce)) {
        throw Object.assign(new Error('nonce reuse ou absent'), { code: 'quiescent-reuse' })
      }
      seen.add(nonce)
      if (typeof version !== 'string' || !version) throw Object.assign(new Error('version requise'), { code: 'quiescent' })
      if (!Number.isInteger(generation) || generation < 0) throw Object.assign(new Error('generation requise'), { code: 'quiescent' })
      void at
      return { ok: true, version, nonce, generation, at: new Date().toISOString() }
    }
  }
}

// Assemblage reel : candidate-store + core + backend fils + trial mesure.
// Retourne { ctx } avec tout le cablage ; le test pilote `requestUnlock`.
function assemble (over) {
  const o = over || {}
  const base = freshDir('unlock-int-')
  const botRoot = path.join(base, 'bot')
  const versionsRoot = path.join(base, 'versions')
  const hostDir = path.join(base, 'host')
  const runDir = path.join(base, 'run')
  for (const d of [botRoot, path.join(botRoot, 'lib'), versionsRoot, hostDir, runDir]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(botRoot, 'index.js'), `'use strict'\nmodule.exports = 1\n`, 'utf8')
  fs.writeFileSync(path.join(botRoot, 'lib', 'cap.js'), `'use strict'\nmodule.exports = { v: 1 }\n`, 'utf8')
  fs.writeFileSync(path.join(botRoot, 'package.json'), JSON.stringify({ name: 'bot-fixture', version: '0.0.1' }), 'utf8')
  const doctrinePath = path.join(hostDir, 'doctrine.txt')
  fs.writeFileSync(doctrinePath, 'doctrine-courante-v3 : stop prioritaire, pas de reset monde\n', 'utf8')
  const doctrine = {
    path: doctrinePath,
    version: DOCTRINE_VERSION,
    digest: sha256hex(fs.readFileSync(doctrinePath))
  }
  const candStore = createCandidateStore({ versionsRoot, botRoot, doctrine })

  const worker = path.join(runDir, 'worker.js')
  const versionFile = path.join(runDir, 'VERSION')
  fs.writeFileSync(worker, WORKER_CODE, 'utf8')
  fs.writeFileSync(versionFile, 'v00', 'utf8')

  const raw = createProcessBackend({
    command: process.execPath,
    args: [worker, versionFile],
    cwd: runDir,
    stopGraceMs: 400,
    killTimeoutMs: 1500,
    logBytesMax: 8192
  })
  // Liaison version->process : le fichier VERSION est pose AVANT le spawn,
  // le fils annonce READY pour la version candidate reelle.
  const backend = {
    ...raw,
    async start (descriptor) {
      fs.writeFileSync(versionFile, descriptor.version, 'utf8')
      if (o.startDelayMs) await new Promise((r) => setTimeout(r, o.startDelayMs))
      return raw.start(descriptor)
    }
  }

  const quiescence = hostQuiescence()
  const nonces = new Map() // version -> nonce lie par le runner
  const measured = new Map() // version -> measurements observees
  const trialCalls = []
  const trialRunner = o.trialRunner || (async ({ version, descriptor, nonce, jobId, signal }) => {
    void descriptor
    void signal
    const abs = path.join(versionsRoot, version, 'lib', 'cap.js')
    const bytes = fs.readFileSync(abs)
    const measurements = { bytes: bytes.length, sha256: sha256hex(bytes), capObserved: bytes.toString('utf8') }
    nonces.set(version, nonce)
    measured.set(version, measurements)
    trialCalls.push({ version, jobId, nonce })
    return { accept: true, measurements }
  })
  const validateCalls = []
  const validateTrial = {
    calls: validateCalls,
    async validate ({ version, proof }) {
      validateCalls.push({ version, proof })
      if (!proof || proof.essai !== PROOF_MARK) {
        throw Object.assign(new Error('preuve d essai insuffisante (marque)'), { code: 'trial-unproven' })
      }
      if (proof.version !== version) {
        throw Object.assign(new Error('preuve non liee a la version'), { code: 'trial-unproven' })
      }
      if (proof.nonce !== nonces.get(version)) {
        throw Object.assign(new Error('preuve non liee au nonce d essai'), { code: 'trial-unproven' })
      }
      if (!jobBinding.ok || proof.jobId !== jobBinding.jobId) {
        throw Object.assign(new Error('preuve non liee au job'), { code: 'trial-unproven' })
      }
      if (proof.doctrineVersion !== DOCTRINE_VERSION) {
        throw Object.assign(new Error('preuve non liee a la doctrine du prompt'), { code: 'trial-unproven' })
      }
      const expected = measured.get(version)
      if (!proof.measurements || proof.measurements.sha256 !== (expected && expected.sha256) || !(proof.measurements.bytes > 0)) {
        throw Object.assign(new Error('mesures non liees a l essai'), { code: 'trial-unproven' })
      }
      return { ok: true, version, at: new Date().toISOString() }
    }
  }
  const jobBinding = { jobId: null, ok: false }
  const store = memoryStore()
  const sup = createSupervisor({
    backend,
    store,
    validateCandidate: async (v) => { await candStore.verify(v); return candStore.getDescriptor(v) },
    checkQuiescent: quiescence.check,
    validateTrial: validateTrial.validate,
    readinessTimeoutMs: 5000,
    pollMs: 50,
    heartbeatTimeoutMs: 1500,
    stopWaitMs: 6000
  })

  const announced = []
  const recorded = []
  const resumes = []
  const doctrineProvider = {
    async get () { return { version: DOCTRINE_VERSION, text: 'doctrine-courante : stop prioritaire, pas de reset monde' } }
  }
  const patchContent = o.patchContent || `'use strict'\nmodule.exports = { v: 2 }\n`
  const callGo = o.callGo || (async () => ({
    content: JSON.stringify({
      ops: [{ op: 'propose_patch', changes: [{ path: 'lib/cap.js', content: patchContent }], reason: o.reason || 'corrige cap fixture', retain: o.retain === undefined ? true : o.retain }]
    })
  }))
  // Enveloppe optionnelle : injecte une panne (ex. rollback) APRES le vrai
  // trial, sans toucher au noyau (perimetre : aucun autre module modifie).
  const supervisorForSvc = o.wrapSupervisor ? o.wrapSupervisor(sup) : sup
  const svc = createUnlockService({
    doctrineProvider,
    callGo,
    callAstra: null,
    tools: {
      readFile: async (p) => ({ content: `contenu ${p}` }),
      fetchDocumentation: async (r) => ({ content: `doc ${r}` })
    },
    candidateStore: candStore,
    supervisor: supervisorForSvc,
    trialRunner,
    pauseWork: async () => {},
    resumeWork: async (info) => { resumes.push(info) },
    announce: async (t) => { announced.push(t) },
    record: (e) => { recorded.push(e) },
    buildIsolated: null,
    getStopState: o.getStopState === undefined ? null : o.getStopState,
    config: { maxRounds: 2, ...(o.config || {}) }
  })
  // Preuve = fichier fixture mesure (octets + SHA256), PAS un monde de jeu :
  // aucune revendication d'apprentissage en monde reel ici.
  return { base, botRoot, versionsRoot, candStore, sup, backend: raw, svc, trialCalls, validateCalls, nonces, measured, jobBinding, announced, recorded, resumes }
}

async function shutdown (ctx) {
  try { if (ctx.sup) ctx.sup.close() } catch { /* ignore */ }
  try { if (ctx.backend) await ctx.backend.stop('test-cleanup') } catch { /* ignore */ }
  try { if (ctx.backend) ctx.backend.close() } catch { /* ignore */ }
}

describe('unlock-integration : candidate reelle + essai reel + preuve liee', () => {
  test('nominal : prepare/verify reels, trial fils reel, mesures fixture, confirm lie', async (t) => {
    const ctx = assemble({})
    t.after(() => shutdown(ctx))
    const pending = ctx.svc.requestUnlock({ objective: 'reparer cap fixture', facts: { monde: 'fixture-tmp' } })
    // Lier le jobId des que connu (poll, sans deviner la preuve).
    const deadline = Date.now() + 15000
    while (!ctx.svc.status().jobId && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    ctx.jobBinding.jobId = ctx.svc.status().jobId
    ctx.jobBinding.ok = true
    const res = await pending
    if (res.outcome !== 'confirmed') {
      console.log(`DIAG nominal: outcome=${res.outcome} reason=${res.reason || JSON.stringify(res.error)}`)
      for (const tr of res.traces) console.log(`DIAG trace ${tr.type} :: ${tr.detail}`)
    }
    assert.equal(res.outcome, 'confirmed', `attendu confirmed (recu ${res.outcome} : ${res.reason || JSON.stringify(res.error)})`)
    assert.ok(typeof res.version === 'string' && res.version.length > 0, 'version candidate reelle')
    // Descripteur reel : digest 64 hex, pending-trial, doctrine liee.
    const descriptor = ctx.candStore.getDescriptor(res.version)
    assert.match(descriptor.manifestDigest, /^[0-9a-f]{64}$/i, 'digest SHA256 64 hex reel')
    assert.equal(descriptor.status, 'pending-trial')
    assert.equal(descriptor.doctrine.version, DOCTRINE_VERSION, 'doctrine liee au prompt')
    // Trial reel : le fils a demarre pour cette version, mesures fixture.
    assert.equal(ctx.trialCalls.length, 1, 'un essai reel')
    assert.equal(ctx.trialCalls[0].version, res.version)
    const measurements = ctx.measured.get(res.version)
    assert.ok(measurements && measurements.bytes > 0, 'effet fixture mesure (octets>0)')
    assert.ok(measurements.capObserved.includes('v: 2'), 'contenu candidate observe, pas invente')
    // Preuve liee job/version/nonce/mesure, validee par le host.
    assert.equal(ctx.validateCalls.length, 1, 'validateTrial host appele une fois')
    const proof = ctx.validateCalls[0].proof
    assert.equal(proof.essai, PROOF_MARK)
    assert.equal(proof.version, res.version)
    assert.equal(proof.jobId, res.jobId)
    assert.equal(proof.nonce, ctx.nonces.get(res.version), 'nonce d essai lie')
    assert.equal(proof.doctrineVersion, DOCTRINE_VERSION)
    assert.equal(proof.measurements.sha256, measurements.sha256, 'mesures liees, pas un bool recopie')
    assert.equal(proof.accept, undefined, 'aucun bool LLM dans la preuve noyau')
    // Promotion reelle : lastGood porte la version confirmee.
    assert.equal(ctx.sup.status().lastGood.version, res.version)
    // Vrai fils : au moins un demarrage, aucun orphelin au close.
    assert.ok(ctx.backend.getStats().starts >= 1, 'fils reel demarre')
  })

  test('mesures absentes : trial-unproven, 0 confirm, lastGood intact', async (t) => {
    const ctx = assemble({
      trialRunner: async ({ version }) => ({ accept: true, measurements: null, version }),
      retain: true
    })
    t.after(() => shutdown(ctx))
    ctx.jobBinding.jobId = 'job-fictif-lie'
    ctx.jobBinding.ok = true
    const res = await ctx.svc.requestUnlock({ objective: 'reparer cap fixture' })
    assert.ok(['impasse', 'failed'].includes(res.outcome), `pas de succes sans mesures (recu ${res.outcome})`)
    assert.equal(res.version, null, 'aucune version promue')
    assert.equal(ctx.validateCalls.length, 0, 'validateTrial jamais appele sans mesures')
    assert.equal(ctx.sup.status().lastGood, null, 'lastGood intact (null)')
  })

  test('pas de monde de jeu ni de socket Docker dans ce chemin', async () => {
    const src = fs.readFileSync(require.resolve('../bot/unlock-service'), 'utf8')
    assert.ok(!src.includes('docker'), 'aucun acces Docker dans le worker')
    assert.ok(!src.includes('/var/run/docker.sock'), 'aucun socket Docker')
    assert.ok(!src.includes('rcon') && !src.includes('RCON'), 'aucun acces monde/jeu')
  })

  test('retain faux reel : sans base, failed/uncertain honnete (pas de faux cleanup)', async (t) => {
    // Noyau frais, aucun lastGood : `rollback()` refuse (no-last-good) et le
    // trial reste supervise par le noyau. Revendiquer "retour base" serait
    // faux : le service verrouille uncertain, sans reprise.
    const ctx = assemble({ retain: false })
    t.after(() => shutdown(ctx))
    const pending = ctx.svc.requestUnlock({ objective: 'cap temporaire fixture' })
    const deadline = Date.now() + 15000
    while (!ctx.svc.status().jobId && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    ctx.jobBinding.jobId = ctx.svc.status().jobId
    ctx.jobBinding.ok = true
    const res = await pending
    assert.equal(res.outcome, 'failed', `sans base : failed honnete (recu ${res.outcome})`)
    assert.equal(res.uncertain, true, 'latch uncertain global')
    assert.equal(res.cleanup, null, 'aucun "retour base quiescente" revendique')
    assert.equal(ctx.sup.status().lastGood, null, 'lastGood inchange (null)')
    assert.equal(ctx.validateCalls.length, 0, 'temporaire : aucune validation de promotion')
    assert.equal(ctx.resumes.length, 0, 'aucune reprise sur base non restauree')
    assert.ok(res.traces.some((tr) => tr.type === 'resume-skipped-uncertain'), 'non-reprise tracee')
  })

  test('retain faux reel avec base : temporaire propre, lastGood inchange, trial nettoye', async (t) => {
    const patch = (retain) => JSON.stringify({
      ops: [{ op: 'propose_patch', changes: [{ path: 'lib/cap.js', content: `'use strict'\nmodule.exports = { v: 2 }\n` }], reason: 'cap fixture', retain }]
    })
    const contents = [patch(true), patch(false)]
    let n = 0
    const ctx = assemble({ callGo: async () => ({ content: contents[Math.min(n++, contents.length - 1)] }) })
    t.after(() => shutdown(ctx))
    async function bindJob () {
      const deadline = Date.now() + 15000
      while (!ctx.svc.status().jobId && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10))
      }
      ctx.jobBinding.jobId = ctx.svc.status().jobId
      ctx.jobBinding.ok = true
    }
    // Temps 1 : confirmation d'une base (lastGood reel).
    const first = ctx.svc.requestUnlock({ objective: 'base fixture' })
    await bindJob()
    const r1 = await first
    assert.equal(r1.outcome, 'confirmed', `base confirmee (recu ${r1.outcome})`)
    const base = r1.version
    // Temps 2 : temporaire avec base existante => cleanup reel vers lastGood.
    const second = ctx.svc.requestUnlock({ objective: 'cap temporaire fixture' })
    await bindJob()
    const res = await second
    assert.equal(res.outcome, 'temp-applied', `attendu temp-applied (recu ${res.outcome})`)
    assert.equal(res.retain, false)
    assert.ok(res.cleanup && res.cleanup.includes('quiescente'), 'cleanup retour base revendique a raison')
    assert.equal(ctx.sup.status().lastGood.version, base, 'lastGood inchange (toujours la base)')
    assert.equal(ctx.sup.status().trial, null, 'trial nettoye apres cleanup')
    assert.equal(ctx.sup.status().active.version, base, 'base restauree et active')
    assert.equal(ctx.validateCalls.length, 1, 'temporaire : aucune validation de promotion (seule la base)')
  })

  test('cancel pendant activate reel : cancelled, trial compense, 0 confirm', async (t) => {
    const c = new AbortController()
    const ctx = assemble({ startDelayMs: 400 })
    t.after(() => shutdown(ctx))
    const pending = ctx.svc.requestUnlock({ objective: 'cap annulee fixture' }, { signal: c.signal })
    const deadline = Date.now() + 15000
    while (!ctx.svc.status().jobId && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    ctx.jobBinding.jobId = ctx.svc.status().jobId
    ctx.jobBinding.ok = true
    setTimeout(() => c.abort(), 100) // pendant l'activate reel ralenti
    const res = await pending
    // Noyau frais sans lastGood : la compensation echoue honnetement
    // (no-last-good), le trial reste supervise par le noyau (nettoye au
    // shutdown) : cancelled + uncertain + 0 confirm + 0 resume.
    assert.equal(res.outcome, 'cancelled', `stop pendant activate reel (recu ${res.outcome})`)
    assert.equal(res.uncertain, true, 'compensation impossible => latch uncertain')
    assert.equal(ctx.validateCalls.length, 0, 'aucune promotion apres stop')
    assert.equal(ctx.sup.status().lastGood, null, 'lastGood intact')
    assert.equal(ctx.resumes.length, 0, 'base non restauree => aucune reprise')
  })

  test('trial sourd reel : abort pendant mesures, cancelled + compense, 0 confirm', async (t) => {
    const c = new AbortController()
    let marker = null
    const ctx = assemble({
      trialRunner: async ({ version, nonce, jobId }) => {
        if (!marker) marker = path.join(ctx.base, 'TRIAL_STARTED')
        fs.writeFileSync(marker, 'started', 'utf8')
        await new Promise((r) => setTimeout(r, 400))
        // Sourd au signal : repond accept malgre le stop (tardif).
        const abs = path.join(ctx.versionsRoot, version, 'lib', 'cap.js')
        const bytes = fs.readFileSync(abs)
        const measurements = { bytes: bytes.length, sha256: sha256hex(bytes), capObserved: bytes.toString('utf8') }
        ctx.nonces.set(version, nonce)
        ctx.measured.set(version, measurements)
        ctx.trialCalls.push({ version, jobId, nonce })
        return { accept: true, measurements }
      }
    })
    t.after(() => shutdown(ctx))
    const pending = ctx.svc.requestUnlock({ objective: 'cap sourde fixture' }, { signal: c.signal })
    const deadline = Date.now() + 15000
    while (!ctx.svc.status().jobId && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    ctx.jobBinding.jobId = ctx.svc.status().jobId
    ctx.jobBinding.ok = true
    // Abort des que l'essai reel a demarre (marqueur), pendant ses mesures.
    const abortAtTrial = Date.now() + 15000
    while (Date.now() < abortAtTrial) {
      if (marker && fs.existsSync(marker)) break
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.ok(marker && fs.existsSync(marker), 'essai reel demarre avant le stop')
    c.abort()
    const res = await pending
    // Meme honnetete que l'activate annule : sans lastGood, pas de retour
    // base ; l'acceptation tardive n'est jamais promue.
    assert.equal(res.outcome, 'cancelled', `acceptation tardive refusee (recu ${res.outcome})`)
    assert.equal(res.uncertain, true, 'compensation impossible => latch uncertain')
    assert.equal(ctx.validateCalls.length, 0, 'acceptation tardive jamais promue')
    assert.equal(ctx.resumes.length, 0, 'aucune reprise sur base non restauree')
  })

  test('getStopState qui jette : confirmed mais 0 resume (unknown interdit)', async (t) => {
    const ctx = assemble({ getStopState: async () => { throw new Error('sonde prod hs') } })
    t.after(() => shutdown(ctx))
    const pending = ctx.svc.requestUnlock({ objective: 'cap sonde hs fixture' })
    const deadline = Date.now() + 15000
    while (!ctx.svc.status().jobId && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    ctx.jobBinding.jobId = ctx.svc.status().jobId
    ctx.jobBinding.ok = true
    const res = await pending
    assert.equal(res.outcome, 'confirmed', 'la promotion ne depend pas de la sonde')
    assert.equal(ctx.resumes.length, 0, 'sonde illisible => aucune reprise')
    assert.ok(res.traces.some((tr) => tr.type === 'resume-skipped-unknown'), 'non-reprise tracee')
  })

  test('validateTrial rejette job/nonce/mesures : 0 promotion, lastGood intact', async (t) => {
    // Job non lie.
    {
      const ctx = assemble({})
      t.after(() => shutdown(ctx))
      ctx.jobBinding.jobId = 'mauvais-job'
      ctx.jobBinding.ok = true
      const res = await ctx.svc.requestUnlock({ objective: 'cap job non lie' })
      assert.ok(['impasse', 'failed'].includes(res.outcome), `job non lie refuse (recu ${res.outcome})`)
      assert.equal(ctx.sup.status().lastGood, null, 'lastGood intact')
      assert.ok(ctx.validateCalls.length >= 1, 'validateTrial a tranche')
    }
    // Mesures non liees (sha forge).
    {
      const ctx = assemble({
        trialRunner: async ({ version, nonce, jobId }) => {
          ctx.nonces.set(version, nonce)
          const measurements = { bytes: 12, sha256: 'f'.repeat(64), capObserved: 'forge' }
          ctx.measured.set(version, { bytes: 12, sha256: '0'.repeat(64), capObserved: 'reel' })
          ctx.trialCalls.push({ version, jobId, nonce })
          return { accept: true, measurements }
        }
      })
      t.after(() => shutdown(ctx))
      const pending = ctx.svc.requestUnlock({ objective: 'cap mesures forgees' })
      const deadline = Date.now() + 15000
      while (!ctx.svc.status().jobId && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10))
      }
      ctx.jobBinding.jobId = ctx.svc.status().jobId
      ctx.jobBinding.ok = true
      const res = await pending
      assert.ok(['impasse', 'failed'].includes(res.outcome), `mesures forgees refusees (recu ${res.outcome})`)
      assert.equal(ctx.sup.status().lastGood, null, 'lastGood intact')
    }
  })

  test('rollback injecte en echec apres vrai trial : pas de faux cleanup, failed/uncertain, 0 resume', async (t) => {
    const failing = () => { const e = new Error('rollback injecte hs'); e.code = 'uncertain'; throw e }
    const ctx = assemble({
      retain: false,
      getStopState: async () => ({ stopped: false }),
      wrapSupervisor: (sup) => ({ ...sup, rollback: async (reason) => { void reason; return failing() } })
    })
    t.after(() => shutdown(ctx))
    const pending = ctx.svc.requestUnlock({ objective: 'cap cleanup hs fixture' })
    const deadline = Date.now() + 15000
    while (!ctx.svc.status().jobId && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    ctx.jobBinding.jobId = ctx.svc.status().jobId
    ctx.jobBinding.ok = true
    const res = await pending
    assert.equal(res.outcome, 'failed', `cleanup rate => failed (recu ${res.outcome})`)
    assert.equal(res.uncertain, true, 'latch uncertain')
    assert.equal(res.cleanup, null, 'pas de faux "retour base quiescente"')
    assert.equal(ctx.resumes.length, 0, 'stopstate false ne revoque pas uncertain : 0 resume')
    assert.equal(ctx.sup.status().lastGood, null, 'lastGood intact')
    assert.ok(res.traces.some((tr) => tr.type === 'resume-skipped-uncertain'), 'non-reprise tracee (uncertain)')
  })
})
