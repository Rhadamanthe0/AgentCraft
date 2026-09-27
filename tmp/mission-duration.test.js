'use strict'

process.env.MISSION_MAX_DURATION_MS = '1000'
process.env.MISSION_TICK_MS = '1'
process.env.MISSION_QUEUE_TICK_MS = '1'
// Pas d annonce « Je réfléchis… » : ses timers fausseraient l ordre de ceux du parcours.
process.env.MISSION_BRIEF_NOTICE_MS = '0'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const planner = require('../bot/planner')
const craft = require('../bot/craft')
const { createMissionRunner } = require('../bot/mission')
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)) }
const brief = { kind: 'recolte', kindConfidence: 1, resource: 'bois', resourceConfidence: 1, landmark: 'ici', door: false, doorProbability: 0 }

function fixture (t, route = false, executor = null) {
  let now = 1000000
  t.mock.method(Date, 'now', () => now)
  t.mock.method(planner, 'isEnabled', () => true)
  t.mock.method(craft, 'targetCriteria', () => ({}))
  t.mock.method(planner, 'readBrief', async () => route
    ? { ...brief, kind: 'geste', resource: 'aucune', route: [{ type: 'rejoindre' }] } : brief)
  const plans = []
  t.mock.method(planner, 'plan', (state, _kind, _supply, _extra, _image, { signal }) => new Promise((resolve, reject) => {
    plans.push({ state, resolve, signal })
    signal.addEventListener('abort', () => reject(new Error('appel annule')), { once: true })
  }))
  const bot = { entity: { position: new Vec3(0, 65, 0), yaw: 0, pitch: 0 },
    registry: { blocksByName: {}, itemsByName: {} }, inventory: { items: () => [] }, players: {}, entities: {},
    findBlocks: () => [], findBlock: () => null, blockAt: () => null, clearControlStates () {} }
  const navigations = []
  const runner = createMissionRunner({ getBot: () => bot, isReady: () => true,
    inLiquid: () => false, stopPathfinding () {}, chat () {},
    navigateToPlayer: (_name, { signal }) => new Promise(resolve => navigations.push({ resolve, signal })) }, { executor })
  t.after(() => runner.stop('test cleanup'))
  return { runner, plans, navigations, advance: ms => { now += ms } }
}

test('pause longue exclue du budget et planning actif compte jusqu a la limite', async t => {
  const f = fixture(t)
  await f.runner.start('coupe du bois', 'human')
  const before = f.runner.status()
  f.advance(600)
  assert.equal(f.runner.pauseWork(), true)
  await flush()
  f.advance(900000)
  assert.equal(f.runner.resumeWork(), true)
  assert.equal(f.runner.isRunning(), true)
  assert.equal(f.plans.length, 2, 'la reprise doit pouvoir demander un plan')
  assert.equal(f.plans[1].state.progression.temps_ecoule_s, 1)
  assert.equal(f.runner.status().debut, before.debut)
  assert.equal(f.runner.status().id, before.id)
  f.advance(500)
  f.plans[1].resolve({ ms: 500, seconds: 0, rejected: [], done: 0, finished: false,
    steps: [{ action: 'dire', scale: 0, scaleLevel: null, choices: { texte: 'test' } }] })
  for (let i = 0; i < 20 && f.runner.isRunning(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(f.runner.status().etat, 'stopped')
  assert.match(f.runner.status().raison, /limite/)
  assert.equal(f.plans.length, 2, 'pas de nouveau planning apres epuisement actif')
  assert.equal(f.runner.status().etapes, 0, 'un planning trop long ne lance pas son action')
})

test('revision conserve le temps actif consomme et le debut original', async t => {
  const f = fixture(t)
  await f.runner.start('coupe du bois', 'human')
  const before = f.runner.status()
  f.advance(800)
  await f.runner.revise('coupe le meme bois', 'human')
  assert.equal(f.plans.at(-1).state.progression.temps_ecoule_s, 1)
  assert.equal(f.runner.status().debut, before.debut)
  f.advance(250)
  f.runner.pauseWork()
  await flush()
  f.advance(50000)
  f.runner.resumeWork()
  assert.equal(f.runner.status().etat, 'stopped')
})

test('pause puis reprise immediate ne duplique pas la boucle apres ancien abort', async t => {
  const f = fixture(t)
  await f.runner.start('coupe du bois', 'human')
  f.advance(100)
  f.runner.pauseWork()
  f.runner.resumeWork()
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(f.runner.isRunning(), true)
  assert.equal(f.plans.length, 2, 'un seul planning par segment actif')
})

test('suspension et autre mission ne consomment pas le budget de la premiere', async t => {
  const f = fixture(t)
  await f.runner.start('coupe du bois', 'human', { objectiveId: 'first' })
  f.advance(600)
  f.runner.suspend()
  await flush()
  await f.runner.start('autre objectif', 'human', { objectiveId: 'second' })
  f.advance(100000)
  f.runner.stop()
  await flush()
  assert.equal(f.runner.resumeSuspended('first').ok, true)
  assert.equal(f.runner.isRunning(), true)
  assert.equal(f.plans.at(-1).state.progression.temps_ecoule_s, 1)
})

test('parcours partage le budget restant et un ancien timer ne touche pas la reprise', async t => {
  const f = fixture(t, true)
  const timers = []
  t.mock.method(global, 'setTimeout', (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer })
  t.mock.method(global, 'clearTimeout', () => {})
  await f.runner.start('viens', 'human')
  assert.equal(timers[0].ms, 1000)
  f.advance(600)
  f.runner.pauseWork()
  f.advance(900000)
  f.runner.resumeWork()
  assert.equal(timers[1].ms, 400, 'le parcours reprend avec le budget restant')
  const resumed = f.navigations[1]
  timers[0].callback()
  assert.equal(resumed.signal.aborted, false, 'ancien timer limite au signal original')
  f.navigations[0].resolve({ reached: false, code: 'cancelled' })
  await flush()
  assert.equal(f.runner.isRunning(), true, 'ancienne continuation ne clot pas la reprise')
  f.advance(400)
  timers[1].callback()
  assert.equal(resumed.signal.aborted, true)
  resumed.resolve({ reached: false, code: 'cancelled' })
  await flush()
  assert.equal(f.runner.isRunning(), false)
  assert.match(f.runner.status().raison, /delai/)
})

test('timer reel de parcours expire sur le reste et non sur un budget neuf', async t => {
  const f = fixture(t, true)
  await f.runner.start('viens', 'human')
  f.advance(850)
  f.runner.pauseWork()
  f.navigations[0].resolve({ reached: false, code: 'cancelled' })
  await flush()
  f.advance(900000)
  f.runner.resumeWork()
  const resumed = f.navigations[1]
  resumed.signal.addEventListener('abort', () => resumed.resolve({ reached: false, code: 'cancelled' }), { once: true })
  f.advance(150)
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(resumed.signal.aborted, true)
  assert.equal(f.runner.isRunning(), false)
  assert.match(f.runner.status().raison, /delai/)
})

test('ancienne enveloppe executeur ne libere pas le token du parcours repris', async t => {
  const envelopes = []
  const executor = { run: async (_task, execute) => {
    const value = await execute()
    return new Promise(resolve => envelopes.push(() => resolve({ value })))
  } }
  const f = fixture(t, true, executor)
  await f.runner.start('viens', 'human')
  const firstToken = f.runner.getStepToken()
  f.runner.pauseWork()
  f.navigations[0].resolve({ reached: false, code: 'cancelled' })
  await flush()
  assert.equal(envelopes.length, 1)
  f.runner.resumeWork()
  const resumedToken = f.runner.getStepToken()
  assert.notEqual(resumedToken, firstToken)
  envelopes[0]()
  await flush()
  assert.equal(f.runner.getStepToken(), resumedToken)
  f.runner.pauseWork()
  f.navigations[1].resolve({ reached: false, code: 'cancelled' })
  await flush()
  envelopes[1]()
  await flush()
})
