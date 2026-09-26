'use strict'

process.env.MISSION_TICK_MS = '1'
process.env.MISSION_QUEUE_TICK_MS = '1'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const planner = require('../bot/planner')
const craft = require('../bot/craft')
const { createMissionRunner } = require('../bot/mission')
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)) }

async function simulate (t, { inventory, height = 6, refuseAt = null, noLanding = false, wrongBlock = false, retryError = false, loseStock = false, logY = 74 }) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000000 })
  t.mock.method(planner, 'isEnabled', () => true)
  t.mock.method(craft, 'targetCriteria', () => ({}))
  t.mock.method(planner, 'readBrief', async () => ({ kind: 'recolte', kindConfidence: 1,
    resource: 'bois', resourceConfidence: 1, landmark: 'ici', door: false, doorProbability: 0 }))
  const states = []
  const stopsAtPlans = []
  let staleAborted = false
  t.mock.method(planner, 'plan', async (state, _kind, _supply, _extra, _image, { signal }) => {
    states.push(state)
    stopsAtPlans.push(stops)
    const step = (action, choices = {}) => ({ action, choices, scale: 0, scaleLevel: null })
    const steps = states.length === 1 ? [step('piler', { hauteur: height }), step('dire', { texte: 'OLD QUEUE' })]
      : states.length === 2 ? [step('dire', { texte: 'OLD PREFETCH' })] : [step('terminer')]
    if (states.length === 2) signal.addEventListener('abort', () => { staleAborted = true }, { once: true })
    return { ms: 0, seconds: 1, rejected: [], done: 0, finished: false, steps }
  })
  const stock = inventory.map(item => ({ ...item }))
  const blocks = new Map([['0,64,0', 'stone'], [`1,${logY},0`, 'oak_log']])
  const placements = []
  const commands = []
  const messages = []
  const bot = { entity: { position: new Vec3(0.5, 65, 0.5), yaw: 0, pitch: 0, onGround: true },
    registry: { blocksByName: { oak_log: { id: 1 }, dirt: { id: 2, boundingBox: 'block' },
      coarse_dirt: { id: 3, boundingBox: 'block' }, oak_planks: { id: 4, boundingBox: 'block' },
      birch_planks: { id: 5, boundingBox: 'block' }, fake_planks: { id: 6, boundingBox: 'empty' } }, itemsByName: {} },
    inventory: { items: () => stock.filter(item => item.count > 0) }, players: {}, entities: {},
    findBlocks: ({ matching }) => matching.includes(1) ? [new Vec3(1, logY, 0)] : [], findBlock: () => null,
    blockAt: p => { const position = p.floored(); const name = blocks.get(`${position.x},${position.y},${position.z}`) ?? 'air'
      return { name, position, boundingBox: name === 'air' ? 'empty' : 'block', shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]] } },
    clearControlStates () {},
    setControlState (control, value) {
      commands.push({ control, value })
      if (control === 'jump' && value) { bot.entity.position.y = Math.floor(bot.entity.position.y) + 1.1; bot.entity.onGround = false }
      if (control === 'jump' && !value) {
        while (bot.entity.position.y > 65 && !blocks.has(`0,${Math.floor(bot.entity.position.y) - 1},0`)) bot.entity.position.y -= 1
        bot.entity.position.y = Math.floor(bot.entity.position.y)
        bot.entity.onGround = !noLanding
      }
    },
    equip: async item => { commands.push({ equip: item.name }); bot.heldItem = item }, lookAt: async () => {},
    placeBlock: async support => {
      if (placements.length + 1 === refuseAt) throw new Error('server refused')
      const name = wrongBlock ? 'coarse_dirt' : bot.heldItem.name
      blocks.set(`0,${support.position.y + 1},0`, name)
      bot.heldItem.count--
      placements.push(name)
      if (loseStock) stock.forEach(item => { item.count = 0 })
      if (retryError) throw new Error('late server error')
    } }
  let stops = 0
  const runner = createMissionRunner({ getBot: () => bot, isReady: () => true, inLiquid: () => false,
    stopPathfinding () { stops++ }, chat: text => messages.push(text) })
  t.after(() => runner.stop('test cleanup'))
  await runner.start('casse cet arbre', 'human')
  for (let i = 0; i < 600 && runner.isRunning(); i++) { t.mock.timers.tick(50); await flush() }
  assert.equal(runner.isRunning(), false)
  const status = runner.status()
  return { status, step: status.historique.find(step => step.action === 'piler'), placements, commands, states, messages, staleAborted, stopsAtPlans }
}

test('stock1 hauteur6 : refus integral avant equipement saut ou pose', async t => {
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 1 }] })
  assert.equal(f.step.echec, true)
  assert.equal(f.step.code, 'stock_echafaudage_insuffisant')
  assert.deepEqual(f.placements, [])
  assert.deepEqual(f.commands, [])
  assert.equal(f.stopsAtPlans[2], f.stopsAtPlans[0], 'preflight ne stoppe pas la physique')
  assert.equal(f.states[0].environnement.cible_haute.cible, 'oak_log')
  assert.equal(f.states[0].environnement.dirt_secondaire_admise, true)
})

test('planches seules utilisables et reobservation apres montee complete', async t => {
  const f = await simulate(t, { inventory: [{ name: 'oak_planks', count: 6 }] })
  assert.equal(f.step.echec, false)
  assert.deepEqual(f.placements, Array(6).fill('oak_planks'))
  assert.equal(f.states[0].inventaire.echafaudage.total, 6)
  assert.equal(f.states[0].inventaire.dirt_en_inventaire, 0)
  assert.equal(f.states[0].environnement.cible_haute.cible, 'oak_log')
  assert.equal(f.states[0].environnement.dirt_secondaire_admise, false)
  assert.equal(f.states[2].bot.position.y, 71)
  assert.equal(f.staleAborted, true)
  assert.equal(f.messages.some(message => /OLD QUEUE|OLD PREFETCH/.test(message)), false)
  assert.equal(f.status.blocs_casses, 0)
})

test('dirt prioritaire puis planches, pas de credit recolte pour la pose', async t => {
  const f = await simulate(t, { inventory: [{ name: 'oak_planks', count: 5 }, { name: 'dirt', count: 1 }] })
  assert.equal(f.step.echec, false)
  assert.deepEqual(f.placements, ['dirt', ...Array(5).fill('oak_planks')])
  assert.equal(f.status.dirt_secondaire, 0)
  assert.equal(f.status.blocs_casses, 0)
})

test('sable gravier feuilles et fausses planches exclus du stock', async t => {
  const f = await simulate(t, { inventory: ['sand', 'gravel', 'oak_leaves', 'fake_planks', 'unknown_planks'].map(name => ({ name, count: 64 })) })
  assert.equal(f.states[0].inventaire.echafaudage.total, 0)
  assert.equal(f.step.echec, true)
  assert.deepEqual(f.commands, [])
})

test('refus niveau2 : premiere pose prouvee mais montee partielle en echec', async t => {
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 6 }], refuseAt: 2 })
  assert.deepEqual(f.placements, ['dirt'])
  assert.equal(f.step.echec, true)
  assert.match(f.step.resultat, /1\/6/)
})

test('bloc different du materiau choisi ne prouve pas la pose', async t => {
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 1 }], height: 1, wrongBlock: true, logY: 69 })
  assert.equal(f.step.echec, true)
  assert.match(f.step.resultat, /non pose|different/)
})

test('pose presente sans atterrissage prouve reste un echec mesure', async t => {
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 1 }], height: 1, noLanding: true, logY: 69 })
  assert.equal(f.step.echec, true)
  assert.match(f.step.resultat, /1\/1.*atterrissage/)
})

test('stock perdu apres premiere pose : echec partiel mesure et pas de vieux plan', async t => {
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 6 }], loseStock: true })
  assert.deepEqual(f.placements, ['dirt'])
  assert.equal(f.step.echec, true)
  assert.match(f.step.resultat, /1\/6.*plus de blocs/)
  assert.equal(f.messages.some(message => /OLD QUEUE|OLD PREFETCH/.test(message)), false)
})

test('retry ne valide jamais un bloc different du materiau choisi', async t => {
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 2 }], height: 1, wrongBlock: true, retryError: true, logY: 69 })
  assert.equal(f.step.echec, true)
  assert.match(f.step.resultat, /pilier impossible/)
})

test('hauteur trop courte pour la buche la plus basse : refus qui dit le minimum', async t => {
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 6 }], height: 1 })
  assert.equal(f.step.echec, true)
  assert.match(f.step.resultat, /piler au moins 6/)
  assert.deepEqual(f.placements, [])
})
