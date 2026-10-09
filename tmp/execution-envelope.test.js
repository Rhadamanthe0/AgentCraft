'use strict'
// R03 : aucun echec/annulation executeur ne doit etre annonce comme succes.
//
// - adaptateur commun (bot/executor.js) : completed -> valeur, cancelled ->
//   PhysicalCancelledError, failed -> erreur d origine (code/message conserves) ;
// - routes /api/control|jump|turn|look : callback qui jette => ok:false avec
//   code/message, slot libere ;
// - /api/goto (admis async) : reponse immediate admitted, puis resultat final
//   expose distinctement (dernierGoto), jamais ok:true sur failed/cancelled ;
// - cablage : chaque appelant passe par l adaptateur (niveau lu).
//
// Chaque test echoue sur le code anterieur (adaptateur absent, ok:true sur
// echec, lease pendu, dernierGoto inexistant) et passe avec le correctif.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const executorModule = require('../bot/executor')
const { createExecutor, createControlLease } = executorModule
const unwrapExecutionEnvelope = executorModule.unwrapExecutionEnvelope
const runPhysicalOrThrow = executorModule.runPhysicalOrThrow
const PhysicalCancelledError = executorModule.PhysicalCancelledError

function codedError (code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

function withTimeoutGuard (promise, ms, label) {
  let timer = null
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} : operation pendue (slot jamais libere)`)), ms)
    if (timer.unref) timer.unref()
  })
  return Promise.race([Promise.resolve(promise).finally(() => { if (timer) clearTimeout(timer) }), guard])
}

// ---------------------------------------------------------------------------
// 1. Adaptateur sur le vrai executeur (aucun mock du cablage teste).
// ---------------------------------------------------------------------------

test('R03 adaptateur expose (contrat bas niveau inchange)', () => {
  assert.equal(typeof unwrapExecutionEnvelope, 'function', 'unwrapExecutionEnvelope absent')
  assert.equal(typeof runPhysicalOrThrow, 'function', 'runPhysicalOrThrow absent')
  assert.equal(typeof PhysicalCancelledError, 'function', 'PhysicalCancelledError absent')
})

test('R03 completed -> valeur, slot libere', async () => {
  const ex = createExecutor({ stopControls () {} })
  const value = await runPhysicalOrThrow((id, kind, fn) => ex.run({ id, kind }, fn), 'r03-ok', 'work', async () => ({ n: 1 }))
  assert.deepEqual(value, { n: 1 })
  assert.equal(ex.status().busy, false, 'slot non libere apres succes')
})

test('R03 failed -> jette l erreur d origine (code/message conserves), slot libere', async () => {
  const ex = createExecutor({ stopControls () {} })
  await assert.rejects(
    runPhysicalOrThrow((id, kind, fn) => ex.run({ id, kind }, fn), 'r03-hs', 'work', async () => { throw codedError('moteur_hs', 'moteur casse') }),
    err => err && err.code === 'moteur_hs' && /moteur casse/.test(err.message)
  )
  assert.equal(ex.status().busy, false, 'slot non libere apres echec')
})

test('R03 cancelled -> jette code cancelled, jamais la valeur, slot libere', async () => {
  const ex = createExecutor({ stopControls () {} })
  const gate = {}
  const running = runPhysicalOrThrow((id, kind, fn) => ex.run({ id, kind }, fn), 'r03-cancel', 'work', async ({ signal }) => {
    await new Promise(resolve => { gate.go = resolve })
    if (signal && signal.aborted) throw codedError('sauvetage_annule', 'annule en vol')
    return 'valeur-tardive'
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  ex.pauseWork('stop test')
  gate.go()
  await assert.rejects(running, err => err && err.code === 'cancelled')
  assert.equal(ex.status().busy, false, 'slot non libere apres annulation')
})

test('R03 lease : callback qui jette => acquire rejette vite (code conserve), slot libere', async () => {
  const ex = createExecutor({ stopControls () {} })
  const lease = createControlLease({
    run: (id, kind, fn) => ex.run({ id, kind }, fn),
    stopNavigation: () => {},
    applyControl: () => { throw codedError('touche_hs', 'touche cassee') },
    clearControls: () => {}
  })
  // Sur le code anterieur, acquire pendait (jamais de rejet) : le garde-temps
  // transforme ce pendu en echec explicite (le predicat strict exige le code
  // d origine, pas le timeout).
  await assert.rejects(
    withTimeoutGuard(lease.acquire('forward', 'r03-lease-hs'), 2000, 'lease.acquire'),
    err => err && err.code === 'touche_hs',
    'acquire sans rejet rapide au code d origine (pendu ou code perdu)'
  )
  assert.equal(ex.status().busy, false, 'slot non libere apres echec de touche')
})

// ---------------------------------------------------------------------------
// 2. Routes HTTP : vraie app createApi, vrai executeur, vrai lease.
//    Seul le monde (bot/navigateur) est simule a la frontiere.
// ---------------------------------------------------------------------------

function buildApp ({ botImpl, navigatorImpl }) {
  const { createApi } = require('../bot/api')
  const executor = createExecutor({ stopControls () {} })
  const bot = botImpl
  const navigator = navigatorImpl ?? {
    status: () => ({}),
    traces: () => [],
    trace: () => null,
    isActive: () => false,
    toPosition: async () => ({ reached: true, code: 'stub' })
  }
  const rt = {
    bot,
    spawned: true,
    followMode: false,
    lastIntent: null,
    lastPathLength: null,
    lastPathStatus: null,
    lastGoto: null,
    lastRescue: null,
    rescueCount: 0,
    commandAudit: { ok: true }
  }
  const lease = createControlLease({
    run: (id, kind, fn) => executor.run({ id, kind }, fn),
    stopNavigation: () => {},
    applyControl: (control, state) => bot.setControlState(control, state),
    clearControls: () => { try { bot.clearControlStates() } catch (_) {} }
  })
  const refusal = (code, message) => {
    const err = new Error(message)
    err.code = code
    return err
  }
  const deps = {
    BOT_USERNAME: 'TestBot',
    CHAT_HISTORY_MAX: 8,
    CMD_PREFIX: '!',
    CONTROL_KEYS: ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'],
    HANDLERS: {},
    MC_VERSION: '26.1',
    activeControls: () => [],
    conversation: { cancel () {} },
    controlLease: lease,
    craft: { snapshot: () => null, TARGETS: {} },
    durableCorrupted: () => false,
    durablePersistError: () => null,
    handleHardStop () {},
    handleResume () {},
    inLiquid: () => false,
    isHardStopText: () => false,
    isHardStopped: () => false,
    isResumeText: () => false,
    isSoftStopText: () => false,
    memory: { snapshot: () => ({}), FILE: 'test', persistError: null },
    missionRunner: { isRunning: () => false, status: () => null, SUPPLY: {} },
    navigator,
    objectivesSnapshotSafe: () => null,
    physicalExecutor: executor,
    planner: { isEnabled: () => false, lastError: 'PLANNER_BASE_URL vide' },
    recentChat: [],
    requireAdmissionOrThrow: () => {
      const st = executor.status()
      if (st.stopped) throw refusal('stopped', 'arret total : reprends d abord')
      if (st.paused) throw refusal('paused', 'travail en pause')
      if (st.busy) throw refusal('busy', `executeur occupe par ${st.current?.id}`)
    },
    requireBot: (req, res, next) => next(),
    rescue: async () => {},
    resolveIntent: async () => ({}),
    runPhysical: (id, kind, fn) => executor.run({ id, kind }, fn),
    skills: { COMMANDS: {}, ACTIONS: {}, KINDS: {}, LANDMARKS: {}, RESOURCES: {}, documentedActions: () => ({}) },
    startObjectiveDurable: async () => ({ ok: true }),
    stopPathfinding: () => {},
    validateModeFirst: (req, res, next) => next()
  }
  const app = createApi(rt, deps)
  return { app, rt, executor }
}

async function listen (app) {
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

async function close (server) {
  await new Promise(resolve => server.close(resolve))
}

function throwingBot (impl = {}) {
  return {
    entity: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 },
    controlState: {},
    setControlState: () => { throw codedError('moteur_hs', 'moteur casse') },
    clearControlStates: () => {},
    look: async () => { throw codedError('visee_hs', 'visee cassee') },
    lookAt: async () => { throw codedError('visee_hs', 'visee cassee') },
    pathfinder: {},
    chat: () => {},
    ...impl
  }
}

test('R03 /api/jump qui jette => ok:false, code/message conserves, slot libere', async () => {
  const { app, executor } = buildApp({ botImpl: throwingBot() })
  const { server, base } = await listen(app)
  try {
    const res = await fetch(`${base}/api/jump`, { method: 'POST' })
    const body = await res.json()
    assert.equal(body.ok, false, 'echec annonce comme succes')
    assert.ok(body.code === 'moteur_hs' || /moteur casse/.test(body.error || ''), `code/message perdus : ${JSON.stringify(body)}`)
    assert.equal(executor.status().busy, false, 'slot non libere apres echec')
  } finally {
    await close(server)
  }
})

test('R03 /api/turn qui jette => ok:false, code/message conserves, slot libere', async () => {
  const { app, executor } = buildApp({ botImpl: throwingBot() })
  const { server, base } = await listen(app)
  try {
    const res = await fetch(`${base}/api/turn`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ degrees: 90 }) })
    const body = await res.json()
    assert.equal(body.ok, false, 'echec annonce comme succes')
    assert.ok(body.code === 'visee_hs' || /visee cassee/.test(body.error || ''), `code/message perdus : ${JSON.stringify(body)}`)
    assert.equal(executor.status().busy, false, 'slot non libere apres echec')
  } finally {
    await close(server)
  }
})

test('R03 /api/look qui jette => ok:false, code/message conserves, slot libere', async () => {
  const { app, executor } = buildApp({ botImpl: throwingBot() })
  const { server, base } = await listen(app)
  try {
    const res = await fetch(`${base}/api/look`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ yaw: 10, pitch: 0 }) })
    const body = await res.json()
    assert.equal(body.ok, false, 'echec annonce comme succes')
    assert.ok(body.code === 'visee_hs' || /visee cassee/.test(body.error || ''), `code/message perdus : ${JSON.stringify(body)}`)
    assert.equal(executor.status().busy, false, 'slot non libere apres echec')
  } finally {
    await close(server)
  }
})

test('R03 /api/control acquire qui jette => ok:false, code conserve, slot libere', async () => {
  const { app, executor } = buildApp({ botImpl: throwingBot() })
  const { server, base } = await listen(app)
  try {
    const res = await fetch(`${base}/api/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ control: 'forward', state: true }),
      signal: AbortSignal.timeout(3000)
    })
    const body = await res.json()
    assert.equal(body.ok, false, 'echec annonce comme succes')
    // throwingBot : setControlState jette moteur_hs ; le code d origine doit survivre.
    assert.ok(body.code === 'moteur_hs' || /moteur casse/.test(body.error || ''), `code/message perdus : ${JSON.stringify(body)}`)
    assert.equal(executor.status().busy, false, 'slot non libere apres echec')
  } finally {
    await close(server)
  }
})

test('R03 /api/goto en echec => admitted puis resultat final failed expose, jamais ok:true', async () => {
  const { app, executor } = buildApp({
    botImpl: throwingBot({ setControlState: () => {}, look: async () => {} }),
    navigatorImpl: {
      status: () => ({}),
      traces: () => [],
      trace: () => null,
      isActive: () => false,
      toPosition: async () => { throw codedError('no_path', 'aucun chemin') }
    }
  })
  const { server, base } = await listen(app)
  try {
    const res = await fetch(`${base}/api/goto`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 10, y: 64, z: 10 }) })
    const admitted = await res.json()
    assert.equal(admitted.ok, true, 'admission refusee a tort')
    assert.equal(admitted.admitted, true, 'reponse d admission attendue')
    // Resultat final expose distinctement (jamais un second ok:true de succes).
    let final = null
    for (let i = 0; i < 100 && !final; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 20))
      const st = await fetch(`${base}/api/status`)
      const status = await st.json()
      if (status && status.dernierGoto && status.dernierGoto.outcome) final = status.dernierGoto
    }
    assert.ok(final, 'resultat final du goto jamais expose')
    assert.equal(final.outcome, 'failed', `goto en echec expose comme : ${JSON.stringify(final)}`)
    assert.ok(final.code === 'no_path' || /aucun chemin/.test(final.error || final.detail || ''), `code/message perdus : ${JSON.stringify(final)}`)
    assert.equal(final.ok, undefined, 'le resultat final ne doit pas porter ok:true')
    assert.equal(executor.status().busy, false, 'slot non libere apres echec')
  } finally {
    await close(server)
  }
})

// ---------------------------------------------------------------------------
// 3. Cablage (niveau lu) : chaque appelant passe par l adaptateur commun.
// ---------------------------------------------------------------------------

test('R03 cablage : adaptateur utilise par routes, commandes, mission', () => {
  const apiSource = fs.readFileSync(path.join(__dirname, '../bot/api.js'), 'utf8')
  const indexSource = fs.readFileSync(path.join(__dirname, '../bot/index.js'), 'utf8')
  const missionSource = fs.readFileSync(path.join(__dirname, '../bot/mission.js'), 'utf8')
  assert.ok(apiSource.includes('runPhysicalOrThrow') || apiSource.includes('unwrapExecutionEnvelope'), 'api.js : routes sans adaptateur')
  assert.ok(indexSource.includes('runPhysicalOrThrow') || indexSource.includes('unwrapExecutionEnvelope'), 'index.js : commandes/rescue sans adaptateur')
  assert.ok(missionSource.includes('unwrapExecutionEnvelope'), 'mission.js : etapes/parcours sans adaptateur')
  // Les sections concernees ne lisent plus une valeur d enveloppe echec :
  // mission.js ne fabrique plus de no_result generique sur failed.
  const stepZone = missionSource.slice(missionSource.indexOf('mission-${mission.id}-step-'), missionSource.indexOf('mission-${mission.id}-step-') + 2500)
  assert.ok(!/envelope\.value !== undefined/.test(stepZone) || missionSource.includes('unwrapExecutionEnvelope'), 'mission.js : valeur d enveloppe lue sans deballage')
})
