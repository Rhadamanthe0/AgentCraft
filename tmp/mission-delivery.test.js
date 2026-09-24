'use strict'
// Preuves RUNNER REEL (createMissionRunner) : faux planificateur (donner en
// boucle) + faux bot. Aucun live, aucun rebuild. Le planificateur est stubbe
// par mutation du module (restaure en fin de fichier), sans toucher aux
// sources bot/skills/planner/index.
process.env.MISSION_TICK_MS = '40'
process.env.MISSION_QUEUE_TICK_MS = '10'
process.env.MISSION_MAX_STEPS = '40'
process.env.MISSION_MAX_DURATION_MS = '120000'

const { test, after } = require('node:test')
const assert = require('node:assert/strict')

const planner = require('../bot/planner')
const _origPlanner = { isEnabled: planner.isEnabled, plan: planner.plan, readBrief: planner.readBrief }
after(() => {
  planner.isEnabled = _origPlanner.isEnabled
  planner.plan = _origPlanner.plan
  planner.readBrief = _origPlanner.readBrief
})
planner.isEnabled = () => true
planner.readBrief = async () => ({
  kind: 'recolte',
  kindConfidence: 0.9,
  resource: 'aucune',
  resourceConfidence: 0.9,
  resourceProbabilities: null,
  landmark: 'ici',
  door: false,
  doorProbability: 0
})
// Planificateur scripte : 'donner:<q>' ou 'fini', un appel = une entree.
// Plans a UNE seule etape : jamais de prefetch, sequence deterministe.
function scriptedPlan (script) {
  let calls = 0
  planner.plan = async () => {
    calls += 1
    const op = script[Math.min(calls, script.length) - 1]
    if (op === 'fini') {
      return { ms: 1, why: 'test-fini', rejected: [], finished: true, done: 0.95, steps: [], seconds: 0 }
    }
    const q = Number(op.split(':')[1])
    return {
      ms: 1,
      why: 'test-donner',
      rejected: [],
      finished: false,
      done: 0,
      steps: [{ action: 'donner', scale: null, scaleLevel: null, choices: { objet: 'oak_planks', quantite: q, destinataire: 'Alice' } }],
      seconds: 1
    }
  }
  return { calls: () => calls }
}

const { createMissionRunner } = require('../bot/mission')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function pos (x, y, z) {
  return {
    x, y, z,
    floored () { return pos(Math.floor(x), Math.floor(y), Math.floor(z)) },
    offset (dx, dy, dz) { return pos(x + dx, y + dy, z + dz) },
    distanceTo (o) { return Math.hypot(x - o.x, y - o.y, z - o.z) }
  }
}

function fakeMissionBot ({ stock = [], spawnDrops = false } = {}) {
  const inv = stock.map((s, i) => ({ name: s.name, count: s.count, type: s.type ?? (300 + i), metadata: s.metadata ?? 0 }))
  const handlers = {}
  const bot = {
    username: 'TestBot',
    entity: { position: pos(0, 64, 0), yaw: 0, pitch: 0, onGround: true },
    health: 20,
    pathfinder: { isMoving: () => false },
    players: { Alice: { entity: { position: pos(1, 64, 0) } } },
    entities: {},
    registry: null,
    inventory: {
      items: () => inv.filter(e => e.count > 0)
        .map(e => ({ name: e.name, type: e.type, metadata: e.metadata, count: e.count, _entry: e }))
    },
    on: (evt, fn) => { (handlers[evt] ??= []).push(fn) },
    removeListener: (evt, fn) => {
      const l = handlers[evt]
      if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1) }
    },
    emit: (evt, ...args) => { for (const fn of [...(handlers[evt] ?? [])]) fn(...args) },
    clearControlStates: () => { bot.clearCalls.push(Date.now()) },
    lookAt: async (p) => { bot.looks.push({ x: p.x, y: p.y, z: p.z }) },
    blockAt: () => ({ name: 'air', boundingBox: 'empty', shapes: [] }),
    tossCalls: [],
    looks: [],
    clearCalls: [],
    _nextId: 500
  }
  const drop = (itemName, count) => {
    const id = bot._nextId++
    const e = { id, kind: 'drop', itemName, count, position: pos(0.5, 64, 0) }
    bot.entities[id] = e
    bot.emit('itemDrop', e)
    bot.emit('entitySpawn', e)
  }
  bot.tossStack = async (stack) => {
    bot.tossCalls.push({ mode: 'stack', name: stack.name, count: stack.count })
    await sleep(10)
    const e = stack._entry
    if (!e || e.count <= 0) throw Object.assign(new Error('stack vide'), { code: 'empty' })
    const n = e.count
    e.count = 0
    if (spawnDrops) drop(e.name, n)
    return n
  }
  bot.toss = async (type, metadata, count) => {
    bot.tossCalls.push({ mode: 'toss', type, metadata, count })
    await sleep(10)
    const e = inv.find(x => x.type === type && x.metadata === metadata && x.count > 0)
    if (!e) throw Object.assign(new Error('aucun stack'), { code: 'no_stack' })
    if (count > e.count) throw Object.assign(new Error('overshoot'), { code: 'overshoot_mock' })
    e.count -= count
    if (spawnDrops) drop(e.name, count)
    return count
  }
  bot._inv = inv
  return bot
}

function fakeHost (bot) {
  const chats = []
  return {
    host: {
      isReady: () => true,
      getBot: () => bot,
      chat: (t) => { chats.push(String(t)) },
      stopPathfinding: () => {},
      navigateToPlayer: async () => ({ reached: true, code: 'arrived', remaining: 0 }),
      navigateToPosition: async () => ({ reached: true, code: 'arrived', remaining: 0 }),
      recentChat: () => [],
      inLiquid: () => false
    },
    chats
  }
}

async function waitFor (cond, timeoutMs, label) {
  const t0 = Date.now()
  for (;;) {
    const v = await cond()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout attente ${label}`)
    await sleep(60)
  }
}

async function waitEtat (runner, timeoutMs = 25000) {
  return waitFor(() => {
    const s = runner.status()
    return (s && (s.etat === 'done' || s.etat === 'failed' || s.etat === 'stopped')) ? s : null
  }, timeoutMs, 'fin de mission')
}

const DON2 = 'donne 2 planches à Alice'

test('runner reel : boucle donner 2 + preuve inconnue => UN toss, removed 2, fini refuse', async () => {
  const bot = fakeMissionBot({ stock: [{ name: 'oak_planks', count: 2, type: 36, metadata: 0 }], spawnDrops: false })
  const { host } = fakeHost(bot)
  const runner = createMissionRunner(host)
  const plans = scriptedPlan(['donner:2', 'donner:2', 'donner:2',
    'fini', 'fini', 'fini', 'fini', 'fini', 'fini', 'fini', 'fini', 'fini', 'fini'])
  const started = await runner.start(DON2, 'Alice')
  assert.equal(started.ok, true)
  const end = await waitEtat(runner)
  assert.equal(bot.tossCalls.length, 1, 'UN SEUL toss malgre la boucle donner')
  assert.notEqual(end.etat, 'done', 'signal fini refuse sur incertain : jamais done')
  assert.equal(end.etat, 'failed')
  assert.match(end.raison ?? '', /incertain|sans preuve/)
  const liv = end.livraison ?? []
  assert.equal(liv.length, 1)
  assert.deepEqual([liv[0].tente, liv[0].retire, liv[0].prouve, liv[0].incertain], [2, 2, 0, 2])
  assert.equal(liv[0].invocations.length, 1)
  assert.ok(plans.calls() >= 4, 'le planificateur a bien signale fini (refuse)')
})

test('runner reel : revision preserve l incertain, aucun retoss', async () => {
  const bot = fakeMissionBot({ stock: [{ name: 'oak_planks', count: 2, type: 36, metadata: 0 }], spawnDrops: false })
  const { host } = fakeHost(bot)
  const runner = createMissionRunner(host)
  scriptedPlan(new Array(30).fill('donner:2'))
  const started = await runner.start(DON2, 'Alice')
  assert.equal(started.ok, true)
  await waitFor(() => {
    const l = (runner.status().livraison ?? [])[0]
    return l && l.incertain === 2 ? true : null
  }, 15000, 'livre incertain')
  const before = bot.tossCalls.length
  assert.equal(before, 1)
  const rev = await runner.revise(DON2, 'Alice')
  assert.equal(rev.ok, true)
  await sleep(1200)
  assert.equal(bot.tossCalls.length, before, 'aucun retoss apres revision')
  const liv = (runner.status().livraison ?? [])[0]
  assert.deepEqual([liv.retire, liv.prouve, liv.incertain], [2, 0, 2])
  runner.stop()
})

test('runner reel : succes 2/2 done, quota ressource (16 par defaut) non requis', async () => {
  const bot = fakeMissionBot({ stock: [{ name: 'oak_planks', count: 2, type: 36, metadata: 0 }], spawnDrops: true })
  const { host } = fakeHost(bot)
  const runner = createMissionRunner(host)
  scriptedPlan(['donner:2', 'fini', 'fini', 'fini', 'fini', 'fini', 'fini', 'fini'])
  const started = await runner.start(DON2, 'Alice')
  assert.equal(started.ok, true)
  const end = await waitEtat(runner)
  assert.equal(end.etat, 'done')
  assert.equal(bot.tossCalls.length, 1)
  // Les compteurs ressource n ont rien vu : ni casse, ni collecte.
  assert.equal(end.objets_recoltes, 0)
  assert.equal(end.blocs_casses, 0)
  const liv = (end.livraison ?? [])[0]
  assert.deepEqual([liv.plafond, liv.prouve, liv.incertain], [2, 2, 0])
})

test('runner reel : appels donner 1+1 plafonnes 2, troisieme sans toss, done', async () => {
  const bot = fakeMissionBot({ stock: [{ name: 'oak_planks', count: 2, type: 36, metadata: 0 }], spawnDrops: true })
  const { host } = fakeHost(bot)
  const runner = createMissionRunner(host)
  scriptedPlan(['donner:1', 'donner:1', 'donner:1', 'fini', 'fini', 'fini', 'fini', 'fini'])
  const started = await runner.start(DON2, 'Alice')
  assert.equal(started.ok, true)
  const end = await waitEtat(runner)
  assert.equal(end.etat, 'done')
  assert.equal(bot.tossCalls.length, 2, 'deux invocations seulement, la troisieme couverte')
  const liv = (end.livraison ?? [])[0]
  assert.deepEqual([liv.plafond, liv.tente, liv.retire, liv.prouve, liv.incertain], [2, 2, 2, 2, 0])
})
