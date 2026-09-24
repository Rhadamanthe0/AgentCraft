'use strict'

process.env.MISSION_TICK_MS = '1'
process.env.MISSION_QUEUE_TICK_MS = '1'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { Vec3 } = require('vec3')
const data = require('minecraft-data')('26.1')
const planner = require('../bot/planner')
const craft = require('../bot/craft')
const { createMissionRunner } = require('../bot/mission')
const { blockInReach } = require('../bot/navigation')
const geometry = JSON.parse(fs.readFileSync(path.join(__dirname, 'tree-materials-ray-diagnostic.json'), 'utf8').replace(/^\uFEFF/, ''))
const A = new Vec3(45, 74, -108)
const cube = [[0, 0, 0, 1, 1, 1]]
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)) }

// Real mission, geometry and reach checks; model, inventory, jump and placement are simulated.
async function scenario (t, { observeOnly = false, count = 4, noLeaves = false, obstruction = null, noSupport = false } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000000 })
  t.mock.method(planner, 'isEnabled', () => true)
  t.mock.method(craft, 'targetCriteria', () => ({}))
  t.mock.method(planner, 'readBrief', async () => ({ kind: 'recolte', kindConfidence: 1,
    resource: 'bois', resourceConfidence: 1, landmark: 'ici', door: false, doorProbability: 0 }))
  const cells = new Map(geometry.blocks.map(b => [`${b.x},${b.y},${b.z}`, b.name]))
  cells.set('44,75,-106', 'air'); cells.set('44,76,-106', 'air')
  if (obstruction) cells.set('44,75,-106', obstruction === 'unknown' ? null : obstruction)
  if (noSupport) cells.set('44,72,-106', 'air')
  const stock = { name: 'oak_planks', count }
  const placements = []; const commands = []; const states = []; const messages = []
  let staleAborted = false
  const bot = {
    entity: { position: new Vec3(44.3625, 73, -105.3072), yaw: 0, pitch: 0, onGround: true },
    registry: data, inventory: { items: () => stock.count > 0 ? [stock] : [] }, players: {}, entities: {}, health: 20, food: 20,
    clearControlStates () {}, findBlock: () => null,
    findBlocks: ({ matching }) => matching.includes(data.blocksByName.oak_log.id) ? [A] : [],
    blockAt (p) {
      const position = p.floored(); let name = cells.get(`${position.x},${position.y},${position.z}`)
      if (name == null) return null
      if (noLeaves && name === 'oak_leaves') name = 'air'
      const empty = name === 'air' || /water|lava/.test(name)
      return { name, position, type: data.blocksByName[name]?.id ?? 0,
        shapes: empty ? [] : cube, boundingBox: empty ? 'empty' : 'block' }
    },
    setControlState (control, value) {
      commands.push({ control, value })
      if (control === 'jump' && value) { bot.entity.position.y = Math.floor(bot.entity.position.y) + 1.1; bot.entity.onGround = false }
      if (control === 'jump' && !value) { bot.entity.position.y = Math.floor(bot.entity.position.y); bot.entity.onGround = true }
    },
    equip: async item => { commands.push({ equip: item.name }); bot.heldItem = item }, lookAt: async () => {},
    placeBlock: async support => {
      const p = support.position.offset(0, 1, 0)
      cells.set(`${p.x},${p.y},${p.z}`, bot.heldItem.name)
      bot.heldItem.count--; placements.push(p)
    }
  }
  const beforeCells = JSON.stringify([...cells])
  const reachableBefore = blockInReach(bot, bot.entity.position, A.offset(0.5, 0.5, 0.5))
  t.mock.method(planner, 'plan', async (state, _kind, _supply, _extra, _image, { signal }) => {
    states.push(state)
    const step = (action, choices = {}) => ({ action, choices, scale: 0, scaleLevel: null })
    if (observeOnly) { runner.stop('observation captured'); return { steps: [], rejected: [] } }
    const steps = states.length === 1 ? [step('piler', { hauteur: 1 }), step('dire', { texte: 'OLD QUEUE' })]
      : states.length === 2 ? [step('dire', { texte: 'OLD PREFETCH' })] : [step('terminer')]
    if (states.length === 2) signal.addEventListener('abort', () => { staleAborted = true }, { once: true })
    return { ms: 0, seconds: 1, rejected: [], done: 0, finished: false, steps }
  })
  const runner = createMissionRunner({ getBot: () => bot, isReady: () => true, inLiquid: () => false,
    stopPathfinding () {}, chat: text => messages.push(text) })
  t.after(() => runner.stop('cleanup'))
  await runner.start('Termine cet arbre et recupere son bois', 'human')
  for (let i = 0; i < 600 && runner.isRunning(); i++) { t.mock.timers.tick(50); await flush() }
  assert.equal(runner.isRunning(), false)
  return { states, placements, commands, messages, staleAborted, bot, reachableBefore,
    untouched: beforeCells === JSON.stringify([...cells]), step: runner.status().historique.find(s => s.action === 'piler') }
}

test('captured occluded low branch: one proved placement makes it reachable and discards stale plan', async t => {
  const f = await scenario(t)
  assert.equal(f.reachableBefore, false)
  assert.equal(f.step.echec, false, f.step.resultat)
  assert.deepEqual(f.placements.map(p => [p.x, p.y, p.z]), [[44, 73, -106]])
  assert.equal(blockInReach(f.bot, f.bot.entity.position, A.offset(0.5, 0.5, 0.5)), true)
  assert.equal(f.staleAborted, true)
  assert.equal(f.states.at(-1).bot.position.y, 74)
  assert.equal(f.messages.some(text => /OLD QUEUE|OLD PREFETCH/.test(text)), false)
})

test('height access is a distinct measured hint without fictional high target or world writes', async t => {
  const f = await scenario(t, { observeOnly: true })
  const env = f.states[0].environnement
  assert.equal(env.cible_haute, null)
  assert.equal(env.bloc_cible_a_portee, false)
  assert.deepEqual(env.acces_par_montee, { cible: { nom: 'oak_log', position: { x: 45, y: 74, z: -108 } }, hauteur_min: 1, stock: 4, manque: 0 })
  assert.equal(f.untouched, true)
  assert.deepEqual(f.commands, [])
})

test('actually reachable target still refuses unnecessary pillar', async t => {
  const f = await scenario(t, { noLeaves: true })
  assert.equal(f.reachableBefore, true)
  assert.equal(f.states[0].environnement.acces_par_montee, null)
  assert.equal(f.step.echec, true)
  assert.match(f.step.resultat, /deja a portee/)
  assert.deepEqual(f.placements, [])
})

for (const obstruction of ['oak_leaves', 'water', 'lava', 'unknown']) {
  test(`no hint through ${obstruction} in the climb column`, async t => {
    const f = await scenario(t, { observeOnly: true, obstruction })
    assert.equal(f.states[0].environnement.acces_par_montee, null)
    assert.equal(f.untouched, true)
  })
}

test('no central support cannot publish climb access despite onGround', async t => {
  const f = await scenario(t, { observeOnly: true, noSupport: true })
  assert.equal(f.states[0].environnement.acces_par_montee, null)
})

test('insufficient stock reports shortage and refuses all physical commands', async t => {
  const f = await scenario(t, { count: 0 })
  assert.equal(f.states[0].environnement.acces_par_montee.hauteur_min, 1)
  assert.equal(f.states[0].environnement.acces_par_montee.manque, 1)
  assert.equal(f.step.code, 'stock_echafaudage_insuffisant')
  assert.deepEqual(f.commands, [])
  assert.deepEqual(f.placements, [])
})
