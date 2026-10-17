'use strict'
// Mort du bot : mesure (bot/mort.js) et suite donnee par la mission
// (signalerMort, repriseApresMort, bot.derniere_mort dans l etat).
process.env.MISSION_TICK_MS = '1'
process.env.MISSION_QUEUE_TICK_MS = '1'
process.env.MISSION_BRIEF_NOTICE_MS = '0'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const planner = require('../bot/planner')
const craft = require('../bot/craft')
const { createMissionRunner } = require('../bot/mission')
const { brancherMort } = require('../bot/mort')
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)) }
const brief = { kind: 'recolte', kindConfidence: 1, resource: 'bois', resourceConfidence: 1, landmark: 'ici', door: false, doorProbability: 0 }

test('mort.js : lieu et objets a la mort, cause du serveur, reapparition', () => {
  const bot = new EventEmitter()
  bot.username = 'TestBot'
  bot.entity = { position: new Vec3(10, 40, -3) }
  bot.inventory = { items: () => [{ count: 5 }, { count: 2 }] }
  const vus = []
  brancherMort(bot, { onMort: m => vus.push(['mort', { ...m }]), onReapparition: m => vus.push(['reapparu', m]) })
  bot.emit('spawn')
  assert.equal(vus.length, 0, 'un spawn sans mort n est pas une reapparition')
  bot.emit('death')
  bot.entity.position.set(0, 64, 0)
  bot.emit('messagestr', 'Autre fell from a high place', 'system', { translate: 'death.fell.accident.generic' })
  bot.emit('messagestr', 'TestBot fell from a high place', 'system', { translate: 'death.fell.accident.generic' })
  bot.emit('spawn')
  bot.emit('spawn')
  assert.deepEqual(vus.map(v => v[0]), ['mort', 'reapparu'])
  assert.deepEqual({ ...vus[0][1].position }, { x: 10, y: 40, z: -3 })
  assert.equal(vus[0][1].objets, 7)
  assert.equal(vus[1][1].cause, 'TestBot fell from a high place')
})

function fixture (t) {
  let now = 1000000
  t.mock.method(Date, 'now', () => now)
  t.mock.method(planner, 'isEnabled', () => true)
  t.mock.method(craft, 'targetCriteria', () => ({}))
  t.mock.method(planner, 'readBrief', async () => brief)
  const plans = []
  t.mock.method(planner, 'plan', (state, _kind, _supply, _extra, _image, { signal }) => new Promise((resolve, reject) => {
    plans.push({ state, resolve })
    signal.addEventListener('abort', () => reject(new Error('appel annule')), { once: true })
  }))
  const bot = { entity: { position: new Vec3(0, 65, 0), yaw: 0, pitch: 0 },
    registry: { blocksByName: {}, itemsByName: {} }, inventory: { items: () => [] }, players: {}, entities: {},
    findBlocks: () => [], findBlock: () => null, blockAt: () => null, clearControlStates () {}, stopDigging () {} }
  const runner = createMissionRunner({ getBot: () => bot, isReady: () => true,
    inLiquid: () => false, stopPathfinding () {}, chat () {} })
  t.after(() => runner.stop('test cleanup'))
  return { runner, plans, bot, advance: ms => { now += ms } }
}

test('mission : pause a la mort, reprise a la reapparition, etat qui la dit, echec a la troisieme', async t => {
  const f = fixture(t)
  assert.deepEqual(f.runner.signalerMort({ position: new Vec3(1, 1, 1), objets: 3 }), { mission: false })
  await f.runner.start('coupe du bois', 'human')
  assert.equal(f.plans[0].state.bot.derniere_mort, null)

  assert.deepEqual(f.runner.signalerMort({ position: new Vec3(30, 12, 40), objets: 9 }), { pause: true, morts: 1 })
  assert.equal(f.runner.isPaused(), true)
  await flush()
  f.advance(4000)
  assert.equal(f.runner.repriseApresMort({ cause: 'TestBot tried to swim in lava' }), true)
  assert.equal(f.runner.isRunning(), true)
  await flush()
  const mort = f.plans.at(-1).state.bot.derniere_mort
  assert.deepEqual(mort.position, { x: 30, y: 12, z: 40 })
  assert.equal(mort.cause, 'TestBot tried to swim in lava')
  assert.equal(mort.il_y_a_s, 4)
  assert.equal(mort.distance, Number(Math.hypot(30, 53, 40).toFixed(1)))
  assert.equal(mort.objets_laches, 9)
  assert.equal(mort.objets_encore_au_sol, true)
  assert.equal(mort.morts_dans_la_mission, 1)
  f.advance(5 * 60 * 1000)
  assert.equal(f.runner.status().etat, 'running')

  // Une pause du joueur n est pas reprise par une reapparition.
  f.runner.pauseWork('pause du joueur')
  assert.equal(f.runner.repriseApresMort({}), false)
  assert.equal(f.runner.resumeWork(), true)
  await flush()
  assert.equal(f.plans.at(-1).state.bot.derniere_mort.objets_encore_au_sol, false, 'objets effaces par le jeu apres 5 min')

  f.runner.signalerMort({ position: new Vec3(0, 0, 0), objets: 0 })
  f.runner.repriseApresMort({})
  await flush()
  assert.deepEqual(f.runner.signalerMort({ position: new Vec3(0, 0, 0), objets: 0 }), { fin: true, morts: 3 })
  assert.equal(f.runner.status().etat, 'failed')
  assert.match(f.runner.status().raison, /mort 3 fois/)
})
