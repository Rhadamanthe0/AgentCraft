'use strict'
// Reproduce captured geometry against the candidate source; no live world access.
process.env.MISSION_TICK_MS = '1'
process.env.MISSION_QUEUE_TICK_MS = '1'
process.env.MEMORY_FILE = '/tmp/tree-target-memory.json'
process.env.ACTIONS_DOC_FILE = '/tmp/tree-target-actions.json'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { Vec3 } = require('vec3')
const data = require('minecraft-data')('26.1')
const source = process.env.TEST_BOT_SOURCE || path.resolve(__dirname, '../bot')
const planner = require(path.join(source, 'planner'))
const craft = require(path.join(source, 'craft'))
const { createMissionRunner } = require(path.join(source, 'mission'))
const { blockInReach, clearSegment } = require(path.join(source, 'navigation'))
const geometry = JSON.parse(fs.readFileSync(path.join(__dirname, 'tree-materials-ray-diagnostic.json'), 'utf8').replace(/^\uFEFF/, ''))
const A = new Vec3(45, 74, -108)
const B = new Vec3(44, 75, -106)
const cube = [[0, 0, 0, 1, 1, 1]]
function fixture ({ noLeaves = false, bodyBlocked = false } = {}) {
  const cells = new Map(geometry.blocks.map(b => [`${b.x},${b.y},${b.z}`, b.name]))
  const bot = { entity: { position: new Vec3(44.3625, 73, -105.3072), yaw: 0, pitch: 0, onGround: true },
    registry: data, inventory: { items: () => [{ name: 'oak_planks', count: 4 }, { name: 'oak_log', count: 8 }] },
    players: {}, entities: {}, health: 20, food: 20,
    clearControlStates () {}, findBlock: () => null,
    findBlocks: ({ matching }) => [A, B].filter(() => matching.includes(data.blocksByName.oak_log.id)),
    blockAt (position) {
      const p = position.floored()
      let name = cells.get(`${p.x},${p.y},${p.z}`) || 'air'
      if (name === 'oak_log' && !p.equals(A) && !p.equals(B)) name = 'air'
      if (noLeaves && name === 'oak_leaves') name = 'air'
      if (bodyBlocked && p.equals(new Vec3(44, 74, -106))) name = 'oak_leaves'
      return { position: p, name, type: data.blocksByName[name]?.id ?? 0, shapes: name === 'air' ? [] : cube, boundingBox: name === 'air' ? 'empty' : 'block' }
    }, dig: async () => { throw new Error('No live or simulated harvesting allowed') },
    setControlState: () => { throw new Error('No physical control allowed') } }
  return bot
}
test('measured supported body is free; lower A occluded, higher B reachable', () => {
  const bot = fixture()
  assert.equal(clearSegment(bot, bot.entity.position, bot.entity.position, true), true)
  assert.equal(blockInReach(bot, bot.entity.position, A.offset(0.5, 0.5, 0.5)), false)
  assert.equal(blockInReach(bot, bot.entity.position, B.offset(0.5, 0.5, 0.5)), true)
})
test('remove occluding leaves: A becomes reachable', () => {
  const bot = fixture({ noLeaves: true })
  assert.equal(blockInReach(bot, bot.entity.position, A.offset(0.5, 0.5, 0.5)), true)
})
test('blocked body rejects both targets', () => {
  const bot = fixture({ bodyBlocked: true })
  for (const target of [A, B]) assert.equal(blockInReach(bot, bot.entity.position, target.offset(0.5, 0.5, 0.5)), false)
})
test('planner state should select reachable B instead of occluded lower A', async () => {
  const bot = fixture()
  planner.isEnabled = () => true
  craft.targetCriteria = () => ({})
  planner.readBrief = async () => ({ kind: 'recolte', kindConfidence: 1, resource: 'bois', resourceConfidence: 1, landmark: 'ici', door: false, doorProbability: 0 })
  let deliver
  const captured = new Promise(resolve => { deliver = resolve })
  planner.plan = async state => {
    deliver(state)
    r.stop('diagnostic state captured, no action')
    return { ms: 0, seconds: 0, rejected: [], done: 0, finished: false, steps: [] }
  }
  const r = createMissionRunner({ getBot: () => bot, isReady: () => true, inLiquid: () => false, stopPathfinding () {}, chat () {} })
  try {
    await r.start('Finir cet arbre et recuperer son bois', 'Rhadamanthe0')
    const state = await Promise.race([captured, new Promise((_, reject) => setTimeout(() => reject(new Error('No planner state captured')), 1500).unref())])
    console.log('CAPTURED_ENVIRONMENT', JSON.stringify(state.environnement))
    assert.equal(state.environnement.bloc_cible_a_portee, true, 'A visible actionable target exists: B; lower occluded A must not mask it')
  } finally { r.stop('test finished') }
})
