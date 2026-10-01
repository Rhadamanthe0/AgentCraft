'use strict'

process.env.MISSION_TICK_MS = '1'
process.env.MISSION_QUEUE_TICK_MS = '1'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { createTrace, resumer } = require('../bot/trace')
const planner = require('../bot/planner')
const craft = require('../bot/craft')
const { createMissionRunner } = require('../bot/mission')

test('trace : bornee, horodatee, resumee par action et par code', () => {
  let now = 1000
  const tr = createTrace({ max: 3, now: () => now })
  now = 1010
  tr.push({ type: 'plan', ms: 40 })
  tr.push({ type: 'etape', action: 'casser', ms: 100, echec: true, code: 'cible_haute' })
  tr.push({ type: 'etape', action: 'casser', ms: 50, echec: false, sans_effet: true })
  tr.push({ type: 'etape', action: 'avancer', ms: 20, echec: true, code: 'avancer_echec' })
  assert.equal(tr.evenements().length, 3)
  assert.equal(tr.perdus(), 1)
  assert.equal(tr.evenements()[0].t, 10)
  assert.deepEqual(resumer([{ type: 'plan', ms: 40 }, { type: 'etape', action: 'casser', ms: 100, echec: true, code: 'cible_haute' },
    { type: 'etape', action: 'casser', ms: 50, sans_effet: true }]), {
    plans: 1, planMs: 40, parAction: { casser: { n: 2, echecs: 1, sansEffet: 1, ms: 150 } }, parCode: { cible_haute: 1 }
  })
})

test('mission : plans, etapes et fin dans la trace servie par le runner', async () => {
  planner.isEnabled = () => true
  craft.targetCriteria = () => ({})
  planner.readBrief = async () => ({ kind: 'recolte', kindConfidence: 1, resource: 'bois', resourceConfidence: 1,
    landmark: 'ici', door: false, doorProbability: 0 })
  let plans = 0
  planner.plan = async () => ({ ms: 7, seconds: 1, rejected: [], done: 0, finished: false,
    steps: [{ action: plans++ === 0 ? 'fabriquer' : 'terminer', scale: 0, scaleLevel: null, choices: { objet: 'truc' } }] })
  const bot = { entity: { position: new Vec3(0.5, 65, 0.5), yaw: 0, pitch: 0, onGround: true },
    registry: { blocksByName: { oak_log: { id: 1 } }, itemsByName: {} }, inventory: { items: () => [] },
    players: {}, entities: {}, findBlocks: () => [], findBlock: () => null,
    blockAt: position => ({ name: 'air', position, boundingBox: 'empty', shapes: [] }),
    clearControlStates () {}, setControlState () {}, look: async () => {} }
  const r = createMissionRunner({ getBot: () => bot, isReady: () => true, inLiquid: () => false,
    stopPathfinding () {}, chat () {} })
  await r.start('coupe du bois', 'human')
  for (let i = 0; i < 400 && r.isRunning(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  const trace = r.trace()
  assert.equal(trace.mission, r.status().id)
  const types = trace.evenements.map(e => e.type)
  assert.ok(types.includes('plan') && types.includes('etape') && types.at(-1) === 'fin', types.join(','))
  const etape = trace.evenements.find(e => e.type === 'etape' && e.action === 'fabriquer')
  assert.equal(etape.echec, true)
  assert.equal(etape.code, 'fabriquer_echec')
  assert.deepEqual(etape.de, { x: 0.5, y: 65, z: 0.5 })
  assert.equal(trace.resume.parAction.fabriquer.echecs, 1)
})
