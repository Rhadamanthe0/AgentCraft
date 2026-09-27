'use strict'

process.env.MISSION_TICK_MS = '1'
process.env.MISSION_QUEUE_TICK_MS = '1'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const planner = require('../bot/planner')
const craft = require('../bot/craft')
const skills = require('../bot/skills')
const { createMissionRunner } = require('../bot/mission')
planner.isEnabled = () => true
craft.targetCriteria = () => ({})

// Sol plat en y=64 partout ; l arbre (buche) n est visible qu a moins de
// 20 blocs, et il est a 22 blocs du depart : hors de vue au debut.
function fixture ({ tree }) {
  planner.readBrief = async () => ({ kind: 'recolte', kindConfidence: 1, resource: 'bois', resourceConfidence: 1,
    landmark: 'ici', door: false, doorProbability: 0 })
  const results = []
  let plans = 0
  planner.plan = async state => {
    if (state?.dernieres_etapes?.length) results.push(state.dernieres_etapes.at(-1))
    plans += 1
    return { ms: 0, seconds: 1, rejected: [], done: 0, finished: false,
      steps: [{ action: plans === 1 ? 'explorer' : 'terminer', scale: 0, scaleLevel: null, choices: { distance: 16 } }] }
  }
  const trips = []
  const bot = { entity: { position: new Vec3(0.5, 65, 0.5), yaw: 0, pitch: 0, onGround: true },
    registry: { blocksByName: { oak_log: { id: 1 } }, itemsByName: {} },
    inventory: { items: () => [] }, players: {}, entities: {},
    findBlocks: ({ matching }) => (tree && matching.includes(1) &&
      bot.entity.position.distanceTo(tree) < 20) ? [tree] : [],
    findBlock: () => null,
    blockAt: position => {
      if (tree && position.equals(tree)) return { name: 'oak_log', position, shapes: [[0, 0, 0, 1, 1, 1]] }
      if (position.y <= 64) return { name: 'grass_block', position, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
      return { name: 'air', position, boundingBox: 'empty', shapes: [] }
    },
    clearControlStates () {}, look: async () => {}, lookAt: async () => {}, setControlState () {}
  }
  const r = createMissionRunner({ getBot: () => bot, isReady: () => true, inLiquid: () => false,
    stopPathfinding () {}, chat () {},
    navigateToPosition: async point => {
      trips.push(point)
      bot.entity.position = new Vec3(point.x, point.y, point.z)
      return { reached: true, code: 'arrived', travelled: 16 }
    } })
  return { r, trips, results }
}

async function finished (r) {
  for (let i = 0; i < 600 && r.isRunning(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  return r.status()
}

test('explorer : trajets calcules jusqu a voir la matiere, jamais deux fois la meme zone', async () => {
  const f = fixture({ tree: new Vec3(-20, 65, 10) })
  await f.r.start('coupe un arbre', 'test')
  await finished(f.r)
  assert.ok(f.trips.length >= 1 && f.trips.length <= 4, `trajets : ${f.trips.length}`)
  for (let i = 1; i < f.trips.length; i++) {
    for (let j = 0; j < i; j++) assert.ok(f.trips[i].distanceTo(f.trips[j]) >= 4, 'zone revisitee')
  }
  const r = f.results.find(x => x.action === 'explorer')
  assert.ok(r, 'resultat explorer vu par le modele')
  assert.match(r.resultat, /oak_log en vue/)
})

test('explorer : rien trouve apres 4 trajets => echec franc', async () => {
  const f = fixture({ tree: null })
  await f.r.start('coupe un arbre', 'test')
  await finished(f.r)
  assert.equal(f.trips.length, 4)
  const r = f.results.find(x => x.action === 'explorer')
  assert.match(r.resultat, /rien de la matiere visee en vue apres 4 trajet/)
})

test('interrupteur explorer', () => {
  skills.setFeatureEnabled('explorer', false)
  assert.equal(skills.actionsFor('recolte', 'harvest', true).includes('explorer'), false)
  skills.setFeatureEnabled('explorer', true)
  assert.equal(skills.actionsFor('recolte', 'harvest', true).includes('explorer'), true)
})
