'use strict'

process.env.MISSION_TICK_MS = '1'
process.env.MISSION_QUEUE_TICK_MS = '1'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const planner = require('../bot/planner')
const craft = require('../bot/craft')
const { createMissionRunner } = require('../bot/mission')

test('piler au bord rejoint un appui avant montage ; echec navigateur interdit saut et pose', async t => {
  // Geometry measured by RCON; model, navigation and world calls are simulated.
  t.mock.method(planner, 'isEnabled', () => true)
  t.mock.method(craft, 'targetCriteria', () => ({}))
  t.mock.method(planner, 'readBrief', async () => ({ kind: 'recolte', kindConfidence: 1,
    resource: 'bois', resourceConfidence: 1, landmark: 'ici', door: false, doorProbability: 0 }))
  let plans = 0
  t.mock.method(planner, 'plan', async () => ({ ms: 0, seconds: 1, rejected: [], done: 0, finished: false,
    steps: [{ action: plans++ === 0 ? 'piler' : 'terminer', scale: 0, scaleLevel: null, choices: { hauteur: 6 } }] }))
  const support = new Vec3(43, 64, -106)
  const logs = [74, 75, 76].map(y => new Vec3(44, y, -106))
  const controls = []
  let poses = 0
  const bot = { entity: { position: new Vec3(44.2972686662726, 65, -105.69279768165282),
    yaw: 0, pitch: 0, onGround: true },
  registry: { blocksByName: { oak_log: { id: 1 }, grass_block: { id: 2 } }, itemsByName: {} },
  inventory: { items: () => [{ name: 'dirt', count: 6 }] }, players: {}, entities: {},
  findBlocks: ({ matching }) => matching.includes(1) ? logs : matching.includes(2) ? [support] : [],
  findBlock: () => null,
  blockAt: p => {
    const position = p.floored()
    const name = position.equals(support) ? 'grass_block' : logs.some(log => log.equals(position)) ? 'oak_log' : 'air'
    return { name, position, boundingBox: name === 'air' ? 'empty' : 'block', shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]] }
  },
  clearControlStates () {}, setControlState: (control, state) => controls.push({ control, state }),
  placeBlock: async () => { poses++ }, dig: async () => { throw new Error('no digging in preparation') } }
  const navigations = []
  const runner = createMissionRunner({ getBot: () => bot, isReady: () => true, inLiquid: () => false,
    stopPathfinding () {}, chat () {}, navigateToPosition: async (position, options) => {
      navigations.push({ position, options })
      return { reached: false, code: 'no_path' }
    } })
  t.after(() => runner.stop('test cleanup'))
  assert.equal(bot.entity.onGround, true)
  assert.equal(bot.blockAt(bot.entity.position.floored().offset(0, -1, 0)).name, 'air')
  await runner.start('casse tout cet arbre', 'human')
  for (let i = 0; i < 100 && runner.isRunning(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(runner.isRunning(), false)
  const step = runner.status().historique.find(step => step.action === 'piler')
  assert.equal(step.echec, true)
  assert.equal(poses, 0)
  assert.equal(controls.some(control => control.control === 'jump' && control.state), false)
  assert.equal(navigations.length, 1, `preparation manquante : ${step.resultat}`)
})
