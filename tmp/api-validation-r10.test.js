'use strict'
// R10 : validation stricte des routes AVANT tout effet de bord.
// Toute requete qui rend 4xx ne doit avoir modifie ni la conversation (cancel),
// ni les touches (lease), ni l admission, ni l objectif, ni le chat en jeu.
// Cas couverts : false / "false" / 0 / "0" / null / absent / malforme pour
// state, nombres non finis ou hors bornes, objectif vide ou trop long.

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { createApi } = require('../bot/api')

let server
let base
// Compteurs stables pour tout le fichier : les apps partagees gardent les
// memes references (reset = remise a zero en place, jamais de remplacement).
const calls = {
  cancel: 0, acquire: 0, release: 0, admission: 0,
  chat: [], objective: [], objectiveArgs: [], stop: 0, intent: 0
}

function resetCalls () {
  calls.cancel = 0
  calls.acquire = 0
  calls.release = 0
  calls.admission = 0
  calls.chat.length = 0
  calls.objective.length = 0
  calls.objectiveArgs.length = 0
  calls.stop = 0
  calls.intent = 0
}

function buildApp (opts = {}) {
  const rt = {
    bot: { chat: message => calls.chat.push(message) },
    spawned: true,
    lastPathStatus: null,
    rescueCount: 0,
    followMode: null
  }
  const recentChat = []
  const deps = {
    BOT_USERNAME: 'TestBot',
    CHAT_HISTORY_MAX: 50,
    CMD_PREFIX: '!',
    CONTROL_KEYS: ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint'],
    HANDLERS: { stop: () => { calls.stop++ } },
    MC_VERSION: '26.1',
    activeControls: () => [],
    conversation: { cancel: () => { calls.cancel++ } },
    controlLease: {
      acquire: async () => { calls.acquire++ },
      release: async () => { calls.release++ }
    },
    craft: { snapshot: () => null },
    durableCorrupted: () => false,
    durablePersistError: () => null,
    handleHardStop: () => {},
    handleResume: () => {},
    inLiquid: () => false,
    isHardStopText: () => false,
    isResumeText: () => false,
    isSoftStopText: () => false,
    memory: { snapshot: () => ({}), FILE: 'memoire', persistError: null },
    missionRunner: {
      isRunning: () => Boolean(opts.missionRunning),
      status: () => ({}),
      setFeatures: () => ({}),
      SUPPLY: 'harvest'
    },
    navigator: { toPosition: async () => ({ reached: true }), status: () => ({}) },
    objectivesSnapshotSafe: () => [],
    physicalExecutor: null,
    planner: { isEnabled: () => false, lastError: 'eteint' },
    recentChat,
    requireAdmissionOrThrow: () => {
      calls.admission++
      if (opts.admissionRefused) {
        const err = new Error('executeur occupe')
        err.code = 'busy'
        throw err
      }
    },
    requireBot: (req, res, next) => (rt.bot ? next() : res.status(409).json({ ok: false })),
    rescue: async () => {},
    resolveIntent: async () => { calls.intent++; return { ok: true, relation: 'question' } },
    // Enveloppe d executeur realiste (voir executor.unwrapExecutionEnvelope) :
    // un admitted n execute pas la physique dans ces tests.
    runPhysical: async () => ({ outcome: 'completed', value: {}, cancelled: false }),
    skills: { COMMANDS: {}, ACTIONS: {}, KINDS: {}, LANDMARKS: {}, RESOURCES: {}, TARGETS: {} },
    startObjectiveDurable: async (objective, requester, options) => {
      calls.objective.push(objective)
      calls.objectiveArgs.push({ objective, requester, options })
      return { ok: true }
    },
    stopPathfinding: () => {},
    validateModeFirst: (req, res, next) => next()
  }
  return { app: createApi(rt, deps), rt, recentChat }
}

let post

before(async () => {
  resetCalls()
  const { app } = buildApp({ admissionRefused: true })
  server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const port = server.address().port
  base = `http://127.0.0.1:${port}`
  post = async (route, body, raw) => {
    const init = { method: 'POST', headers: { 'content-type': 'application/json' } }
    if (raw !== undefined) {
      init.body = raw
    } else if (body !== undefined) {
      init.body = JSON.stringify(body)
    }
    const res = await fetch(`${base}${route}`, init)
    let json = null
    try { json = await res.json() } catch (_) {}
    return { status: res.status, json }
  }
})

after(async () => {
  await new Promise(resolve => server.close(resolve))
})

test('/api/control : false, "false", 0, "0" relachent, sans effet sur 400', async () => {
  for (const state of [false, 'false', 0, '0']) {
    const { app } = buildApp()
    const srv = app.listen(0, '127.0.0.1')
    await new Promise(resolve => srv.once('listening', resolve))
    try {
      const releaseBefore = calls.release
      const admissionBefore = calls.admission
      const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/control`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ control: 'forward', state })
      })
      assert.equal(res.status, 200, `release 200 pour ${JSON.stringify(state)}`)
      assert.equal(calls.release, releaseBefore + 1)
      assert.equal(calls.admission, admissionBefore, 'release sans admission')
    } finally {
      await new Promise(resolve => srv.close(resolve))
    }
  }
  for (const state of [true, 'true', 1, '1']) {
    const { app } = buildApp()
    const srv = app.listen(0, '127.0.0.1')
    await new Promise(resolve => srv.once('listening', resolve))
    try {
      const acquireBefore = calls.acquire
      const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/control`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ control: 'forward', state })
      })
      assert.equal(res.status, 200, `acquire 200 pour ${JSON.stringify(state)}`)
      assert.equal(calls.acquire, acquireBefore + 1)
    } finally {
      await new Promise(resolve => srv.close(resolve))
    }
  }
})

test('/api/control : 400 sans toucher au lease ni a l admission', async () => {
  const bad = [
    { control: 'forward' }, // state absent
    { control: 'forward', state: null },
    { control: 'forward', state: 'oui' },
    { control: 'forward', state: 2 },
    { control: 'forward', state: [] },
    { control: 'forward', state: {} },
    { control: 'voler', state: true }, // touche inconnue
    { control: 123, state: true },
    {} // corps vide
  ]
  for (const body of bad) {
    const snap = { acquire: calls.acquire, release: calls.release, admission: calls.admission }
    const res = await post('/api/control', body)
    assert.equal(res.status, 400, `400 pour ${JSON.stringify(body)}`)
    assert.equal(calls.acquire, snap.acquire, 'pas d acquire')
    assert.equal(calls.release, snap.release, 'pas de release')
    assert.equal(calls.admission, snap.admission, 'pas d admission')
  }
})

test('/api/mission : 400 AVANT le cancel conversation', async () => {
  const bad = [
    {}, // objectif absent
    { objective: '' },
    { objective: '   ' },
    { objective: 'x'.repeat(241) }, // trop long
    { objective: 123 }, // non-chaine
    { objective: null },
    { objective: ['coupe'] },
    { objective: 'coupe un arbre', requester: 123 } // demandeur malforme
  ]
  for (const body of bad) {
    const cancelBefore = calls.cancel
    const objectiveBefore = calls.objective.length
    const res = await post('/api/mission', body)
    assert.equal(res.status, 400, `400 pour ${JSON.stringify(body).slice(0, 60)}`)
    assert.equal(calls.cancel, cancelBefore, 'pas de cancel conversation sur 400')
    assert.equal(calls.objective.length, objectiveBefore, 'pas d objectif sur 400')
  }
  // JSON malforme : 400 par le filet, toujours sans cancel.
  const cancelBefore = calls.cancel
  const raw = await post('/api/mission', undefined, '{objectif:')
  assert.equal(raw.status, 400)
  assert.equal(calls.cancel, cancelBefore, 'pas de cancel sur JSON malforme')
})

test('/api/mission : valide => cancel PUIS objectif, demandeur par defaut', async () => {
  const cancelBefore = calls.cancel
  const res = await post('/api/mission', { objective: 'coupe un arbre' })
  assert.equal(res.status, 200)
  assert.equal(calls.cancel, cancelBefore + 1, 'cancel apres validation')
  assert.deepEqual(calls.objective.at(-1), 'coupe un arbre')
  assert.equal(calls.objectiveArgs.at(-1).requester, 'api')
  const res2 = await post('/api/mission', { objective: 'coupe un arbre', requester: 'Steve' })
  assert.equal(res2.status, 200)
  assert.equal(calls.objectiveArgs.at(-1).requester, 'Steve')
})

test('/api/turn et /api/look : nombres finis et bornes, 400 avant admission', async () => {
  for (const degrees of ['abc', null, true, 500, -361, undefined]) {
    const admissionBefore = calls.admission
    const body = degrees === undefined ? {} : { degrees }
    const res = await post('/api/turn', body)
    assert.equal(res.status, 400, `turn 400 pour ${String(degrees)}`)
    assert.equal(calls.admission, admissionBefore, 'pas d admission sur 400')
  }
  const ok = await post('/api/turn', { degrees: 30 })
  assert.equal(ok.status, 409, 'turn valide passe la validation (admission refusee par le mock)')
  assert.equal(calls.admission > 0, true)

  for (const body of [{ yaw: null, pitch: 0 }, { yaw: 0, pitch: 95 }, { yaw: 720, pitch: 0 }, { yaw: 'abc', pitch: 0 }, {}]) {
    const admissionBefore = calls.admission
    const res = await post('/api/look', body)
    assert.equal(res.status, 400, `look 400 pour ${JSON.stringify(body)}`)
    assert.equal(calls.admission, admissionBefore, 'pas d admission sur 400')
  }
  const okLook = await post('/api/look', { yaw: 10, pitch: -20 })
  assert.equal(okLook.status, 409, 'look valide passe la validation')
})

test('/api/goto : coordonnees strictes, range entier borne', async () => {
  const bad = [
    { x: null, y: 64, z: 0 }, // Number(null) valait 0 : destination 0,0,0 admise
    { x: 0, y: 64, z: 0, range: 'abc' }, // range silencieux retombait a 1
    { x: 0, y: 64, z: 0, range: 99 },
    { x: 0, y: 64, z: 0, range: 0 },
    { x: 0, y: 64, z: 0, range: 1.5 },
    { x: 1e9, y: 64, z: 0 }, // hors monde
    { x: true, y: 64, z: 0 },
    {}
  ]
  for (const body of bad) {
    const admissionBefore = calls.admission
    const res = await post('/api/goto', body)
    assert.equal(res.status, 400, `goto 400 pour ${JSON.stringify(body)}`)
    assert.equal(calls.admission, admissionBefore, 'pas d admission sur 400')
  }
  const ok = await post('/api/goto', { x: 1, y: 64, z: -3 })
  assert.equal(ok.status, 409, 'goto valide passe la validation (admission refusee par le mock)')
})

test('/api/goto admis : admitted sans attendre, cible bornee', async () => {
  const { app } = buildApp() // admission acceptee, enveloppe completed
  const srv = app.listen(0, '127.0.0.1')
  await new Promise(resolve => srv.once('listening', resolve))
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/goto`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 1, y: 64, z: -3 })
    })
    assert.equal(res.status, 200)
    const json = await res.json()
    assert.equal(json.admitted, true)
    assert.deepEqual(json.target, { x: 1, y: 64, z: -3, range: 1 })
  } finally {
    await new Promise(resolve => srv.close(resolve))
  }
})

test('/api/chat : chaine reelle exigee, jamais [object Object]', async () => {
  const chatBefore = calls.chat.length
  for (const message of [123, null, {}, '']) {
    const res = await post('/api/chat', { message })
    assert.equal(res.status, 400, `chat 400 pour ${JSON.stringify(message)}`)
  }
  const tooLong = await post('/api/chat', { message: 'x'.repeat(241) })
  assert.equal(tooLong.status, 400)
  assert.equal(calls.chat.length, chatBefore, 'rien ne part au jeu sur 400')
  const ok = await post('/api/chat', { message: 'bonjour' })
  assert.equal(ok.status, 200)
  assert.equal(calls.chat.at(-1), 'bonjour')
})

test('/api/instruction : 400 avant inbox et avant tout arret', async () => {
  const { app, recentChat } = buildApp()
  const srv = app.listen(0, '127.0.0.1')
  await new Promise(resolve => srv.once('listening', resolve))
  try {
    const url = `http://127.0.0.1:${srv.address().port}/api/instruction`
    const send = async body => {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return res.status
    }
    assert.equal(await send({ message: '', requester: 'A' }), 400)
    assert.equal(await send({ message: 'x' }), 400)
    assert.equal(await send({ message: 12, requester: 'A' }), 400)
    assert.equal(await send({ message: 'x'.repeat(1001), requester: 'A' }), 400)
    assert.equal(recentChat.length, 0, 'inbox intouchee sur 400')
    assert.equal(calls.stop, 0, 'pas de stop sur 400')
    assert.equal(await send({ message: 'que fais-tu ?', requester: 'A' }), 200)
    assert.equal(recentChat.length, 1, 'inbox remplie sur valide')
  } finally {
    await new Promise(resolve => srv.close(resolve))
  }
})

test('/api/control : touche inconnue rend 400 en francais', async () => {
  const res = await post('/api/control', { control: 'voler', state: true })
  assert.equal(res.status, 400)
  assert.notEqual(res.json.error, 'Invalid control', 'message anglais non uniformise')
  assert.match(res.json.error, /parmi/, 'message francais attendu (config.parseRequestEnum)')
})

test('/api/control release : expose released, idempotent sans 400', async () => {
  const { createExecutor, createControlLease } = require('../bot/executor')
  const ex = createExecutor({ stopControls: () => {} })
  const lease = createControlLease({
    run: (id, kind, fn) => ex.run({ id, kind }, fn),
    stopNavigation: () => {},
    applyControl: () => {},
    clearControls: () => {}
  })
  const rt = { bot: { chat: () => {} }, spawned: true, lastPathStatus: null, rescueCount: 0, followMode: null }
  const deps = {
    BOT_USERNAME: 'TestBot',
    CHAT_HISTORY_MAX: 50,
    CMD_PREFIX: '!',
    CONTROL_KEYS: ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint'],
    HANDLERS: { stop: () => {} },
    MC_VERSION: '26.1',
    activeControls: () => [],
    conversation: { cancel: () => {} },
    controlLease: lease,
    craft: { snapshot: () => null },
    durableCorrupted: () => false,
    durablePersistError: () => null,
    handleHardStop: () => {},
    handleResume: () => {},
    inLiquid: () => false,
    isHardStopText: () => false,
    isResumeText: () => false,
    isSoftStopText: () => false,
    isHardStopped: () => false,
    memory: { snapshot: () => ({}), FILE: 'memoire', persistError: null },
    missionRunner: { isRunning: () => false, status: () => ({}), setFeatures: () => ({}), SUPPLY: 'harvest' },
    navigator: { toPosition: async () => ({ reached: true }), status: () => ({}) },
    objectivesSnapshotSafe: () => [],
    physicalExecutor: ex,
    planner: { isEnabled: () => false, lastError: 'eteint' },
    recentChat: [],
    requireAdmissionOrThrow: () => {},
    requireBot: (req, res, next) => (rt.bot ? next() : res.status(409).json({ ok: false })),
    rescue: async () => {},
    resolveIntent: async () => ({ ok: true }),
    runPhysical: (id, kind, fn) => ex.run({ id, kind }, fn),
    skills: { COMMANDS: {}, ACTIONS: {}, KINDS: {}, LANDMARKS: {}, RESOURCES: {}, TARGETS: {} },
    startObjectiveDurable: async () => ({ ok: true }),
    stopPathfinding: () => {},
    validateModeFirst: (req, res, next) => next()
  }
  const { app } = { app: createApi(rt, deps) }
  const srv = app.listen(0, '127.0.0.1')
  await new Promise(resolve => srv.once('listening', resolve))
  try {
    const url = `http://127.0.0.1:${srv.address().port}/api/control`
    const send = async body => {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: res.status, json: await res.json() }
    }
    // Sans touche tenue : idempotent, ok:true avec released:false (jamais 400).
    const vide = await send({ control: 'forward', state: false })
    assert.equal(vide.status, 200)
    assert.equal(vide.json.ok, true)
    assert.equal(vide.json.released, false)
    // Acquire puis release : released:true.
    const acquis = await send({ control: 'forward', state: true })
    assert.equal(acquis.status, 200)
    const libere = await send({ control: 'forward', state: false })
    assert.equal(libere.status, 200)
    assert.equal(libere.json.released, true)
  } finally {
    await new Promise(resolve => srv.close(resolve))
  }
})

test('/api/goto concurrent : prise effective avant admitted, second busy => 409', async () => {
  // I1 : la pre-admission est volontairement permeable ici ; seule la prise
  // effective du slot (vrai executeur) peut refuser le second goto.
  const { createExecutor } = require('../bot/executor')
  const ex = createExecutor({ stopControls: () => {} })
  let libererTrajet = null
  const trajetGate = new Promise(resolve => { libererTrajet = resolve })
  const rt = { bot: { chat: () => {} }, spawned: true, lastPathStatus: null, lastGoto: null, rescueCount: 0, followMode: null }
  const deps = {
    BOT_USERNAME: 'TestBot',
    CHAT_HISTORY_MAX: 50,
    CMD_PREFIX: '!',
    CONTROL_KEYS: ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint'],
    HANDLERS: { stop: () => {} },
    MC_VERSION: '26.1',
    activeControls: () => [],
    conversation: { cancel: () => {} },
    controlLease: null,
    craft: { snapshot: () => null },
    durableCorrupted: () => false,
    durablePersistError: () => null,
    handleHardStop: () => {},
    handleResume: () => {},
    inLiquid: () => false,
    isHardStopText: () => false,
    isResumeText: () => false,
    isSoftStopText: () => false,
    isHardStopped: () => false,
    memory: { snapshot: () => ({}), FILE: 'memoire', persistError: null },
    missionRunner: { isRunning: () => false, status: () => ({}), setFeatures: () => ({}), SUPPLY: 'harvest' },
    navigator: { toPosition: async () => { await trajetGate; return { reached: true } }, status: () => ({}) },
    objectivesSnapshotSafe: () => [],
    physicalExecutor: ex,
    planner: { isEnabled: () => false, lastError: 'eteint' },
    recentChat: [],
    requireAdmissionOrThrow: () => {},
    requireBot: (req, res, next) => (rt.bot ? next() : res.status(409).json({ ok: false })),
    rescue: async () => {},
    resolveIntent: async () => ({ ok: true }),
    runPhysical: (id, kind, fn) => ex.run({ id, kind }, fn),
    skills: { COMMANDS: {}, ACTIONS: {}, KINDS: {}, LANDMARKS: {}, RESOURCES: {}, TARGETS: {} },
    startObjectiveDurable: async () => ({ ok: true }),
    stopPathfinding: () => {},
    validateModeFirst: (req, res, next) => next()
  }
  const { app } = { app: createApi(rt, deps) }
  const srv = app.listen(0, '127.0.0.1')
  await new Promise(resolve => srv.once('listening', resolve))
  try {
    const url = `http://127.0.0.1:${srv.address().port}/api/goto`
    const send = async body => {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: res.status, json: await res.json() }
    }
    const premier = await send({ x: 1, y: 64, z: -3 })
    assert.equal(premier.status, 200, 'premier goto admis')
    assert.equal(premier.json.admitted, true)
    // Trajet toujours en fond : le slot est tenu.
    assert.equal(ex.status().busy, true, 'slot pris avant admitted')
    const second = await send({ x: 2, y: 64, z: -3 })
    assert.equal(second.status, 409, 'busy concurrent refuse en 409, jamais admitted:true')
    assert.equal(second.json.admitted, undefined)
    assert.equal(second.json.code, 'busy')
    assert.equal(rt.lastGoto, null, 'refus d admission sans lastGoto malhonnete')
    libererTrajet()
    for (let i = 0; i < 200 && rt.lastGoto === null; i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(rt.lastGoto?.outcome, 'completed', 'trajet admis resolu en completed')
  } finally {
    try { libererTrajet() } catch (_) {}
    await new Promise(resolve => srv.close(resolve))
  }
})

test('/api/mission/script : structures validees avant cancel', async () => {
  const saved = process.env.MISSION_SCRIPT
  process.env.MISSION_SCRIPT = '1'
  try {
    const bad = [
      { objective: '', script: [{ action: 'dire' }] },
      { objective: 'x', script: [] },
      { objective: 'x', script: [null] },
      { objective: 'x', script: 'dire' },
      { objective: 'x', script: [{ action: 'dire' }], brief: 'x' }
    ]
    for (const body of bad) {
      const cancelBefore = calls.cancel
      const objectiveBefore = calls.objective.length
      const res = await post('/api/mission/script', body)
      assert.equal(res.status, 400, `script 400 pour ${JSON.stringify(body).slice(0, 60)}`)
      assert.equal(calls.cancel, cancelBefore, 'pas de cancel sur 400')
      assert.equal(calls.objective.length, objectiveBefore, 'pas d objectif sur 400')
    }
    const cancelBefore = calls.cancel
    const ok = await post('/api/mission/script', { objective: 'x', script: [{ action: 'dire' }] })
    assert.equal(ok.status, 200)
    assert.equal(calls.cancel, cancelBefore + 1, 'cancel apres validation')
  } finally {
    if (saved === undefined) delete process.env.MISSION_SCRIPT
    else process.env.MISSION_SCRIPT = saved
  }
})
