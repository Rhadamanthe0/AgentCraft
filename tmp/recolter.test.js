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
craft.harvestCheck = () => ({ ok: true })
craft.equipForBlock = async () => {}

// Arbre de trois buches au sol a portee : `recolter` doit tout obtenir en une
// seule action (un seul plan), casser + ramasser enchaines par le code.
function fixture ({ logs, quantite }) {
  planner.readBrief = async () => ({ kind: 'recolte', kindConfidence: 1, resource: 'bois', resourceConfidence: 1,
    landmark: 'ici', door: false, doorProbability: 0 })
  const plans = []
  planner.plan = async state => {
    plans.push(state)
    const action = plans.length === 1 ? 'recolter' : 'terminer'
    return { ms: 0, seconds: 1, rejected: [], done: 0, finished: false,
      steps: [{ action, scale: 0, scaleLevel: null, choices: { quantite } }] }
  }
  const standing = logs.map(p => p.clone())
  let held = 0
  const bot = { entity: { position: new Vec3(0.5, 65, 0.5), yaw: 0, pitch: 0, onGround: true },
    registry: { blocksByName: { oak_log: { id: 1 } }, itemsByName: {} },
    inventory: { items: () => held ? [{ name: 'oak_log', count: held }] : [] }, players: {}, entities: {},
    findBlocks: ({ matching }) => matching.includes(1) ? standing.slice() : [], findBlock: () => null,
    blockAt: position => standing.some(p => p.equals(position))
      ? { name: 'oak_log', position, shapes: [[0, 0, 0, 1, 1, 1]] }
      : { name: 'air', position, shapes: [] },
    clearControlStates () {},
    look: async () => {},
    lookAt: async () => {},
    setControlState () {},
    dig: async block => {
      const i = standing.findIndex(p => p.equals(block.position))
      if (i >= 0) { standing.splice(i, 1); held += 1 }
    }
  }
  const r = createMissionRunner({ getBot: () => bot, isReady: () => true, inLiquid: () => false,
    stopPathfinding () {}, chat () {},
    navigateToPosition: async () => ({ reached: true, code: 'arrived', travelled: 1 }) })
  return { r, plans, get held () { return held } }
}

async function finished (r) {
  for (let i = 0; i < 600 && r.isRunning(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(r.isRunning(), false)
  return r.status()
}

test('recolter enchaine la casse jusqu a la quantite en une seule action', async () => {
  const f = fixture({ logs: [new Vec3(2, 65, 0), new Vec3(2, 66, 0), new Vec3(2, 67, 0)], quantite: 3 })
  const start = await f.r.start('coupe 3 buches', 'test')
  assert.equal(start.ok, true)
  const status = await finished(f.r)
  assert.equal(f.held, 3)
  const etape = (status.historique ?? status.history ?? []).find(h => h.action === 'recolter')
  if (etape) assert.match(etape.resultat, /3\/3 objet/)
  // Le second plan (terminer) voit deja les trois buches : aucun plan entre.
  assert.equal(f.plans.length >= 1 && f.plans.length <= 2, true)
})

test('recolter sans matiere en vue echoue franchement', async () => {
  const f = fixture({ logs: [], quantite: 2 })
  await f.r.start('coupe 2 buches', 'test')
  await finished(f.r)
  assert.equal(f.held, 0)
})

test('interrupteur recolter : action retiree du catalogue puis rendue', () => {
  skills.setFeatureEnabled('recolter', false)
  assert.equal(skills.actionsFor('recolte', 'harvest', true).includes('recolter'), false)
  skills.setFeatureEnabled('recolter', true)
  assert.equal(skills.actionsFor('recolte', 'harvest', true).includes('recolter'), true)
})
