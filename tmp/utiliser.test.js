'use strict'

process.env.MISSION_TICK_MS = '1'
process.env.MISSION_QUEUE_TICK_MS = '1'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const planner = require('../bot/planner')
const { createMissionRunner } = require('../bot/mission')
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)) }

// utiliser {objet} (lot 3 des actions generiques, A/B `utiliser`) : le bloc
// actionne est un parametre ; un passage est ouvert puis franchi comme
// ouvrir_porte, un levier est actionne sur place. Meme monde que
// tmp/ouvrir-porte.test.js.
async function ouvrir (t, { porte = 'oak_door', plancher = false, contre = false, action = 'utiliser', choices = { objet: 'door' } } = {}) {
  // plancher : la piece (x <= 3, porte comprise) a un plancher en y=65, une
  // marche au-dessus du sol du dehors (cabane du banc 5a0fe24).
  const sol = plancher ? 66 : 65
  // contre : le bot est tout contre la porte, du cote de sa tranche fermee.
  const depart = new Vec3(contre ? 2.5 : 1.5, sol, 0.5)
  t.mock.method(planner, 'isEnabled', () => true)
  t.mock.method(planner, 'readBrief', async () => ({ kind: 'geste', kindConfidence: 1, resource: null,
    resourceConfidence: 0, landmark: 'ici', door: false, doorProbability: 0 }))
  let plans = 0
  t.mock.method(planner, 'plan', async () => {
    plans++
    const step = action => ({ action, scale: 0, scaleLevel: null, choices: {} })
    return { ms: 0, seconds: 1, rejected: [], done: 0, finished: false, steps: plans === 1 ? [{ ...step(action), choices }] : [step('terminer')] }
  })
  const state = { open: false }
  const activated = []
  const moves = []
  const isDoor = p => p.x === 3 && p.z === 0 && (p.y === sol || p.y === sol + 1)
  const solid = p => p.y === 64 || (plancher && p.y === 65 && p.x <= 3)
  const bot = {
    entity: { position: depart.clone(), yaw: 0, pitch: 0, onGround: true },
    registry: { blocksByName: { [porte]: { id: 7, name: porte }, stone: { id: 1, name: 'stone' } }, itemsByName: {} },
    inventory: { items: () => [] }, players: {}, entities: {},
    findBlocks: () => [],
    findBlock: ({ matching }) => matching.includes(7) ? bot.blockAt(new Vec3(3, sol + 1, 0)) : null,
    blockAt: p => {
      const position = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      if (isDoor(position)) {
        return { name: porte, position, shapes: [[0, 0, 0, 0.1875, 1, 1]],
          getProperties: () => ({ open: state.open, facing: 'east', half: position.y === sol ? 'lower' : 'upper' }) }
      }
      return solid(position) ? { name: 'stone', position, shapes: [[0, 0, 0, 1, 1, 1]] } : { name: 'air', position, shapes: [] }
    },
    activateBlock: async block => { activated.push(block.position.clone()); if (porte !== 'iron_door') state.open = !state.open },
    clearControlStates () {}, look: async () => {}, lookAt: async () => {}, setControlState () {}
  }
  const runner = createMissionRunner({ getBot: () => bot, isReady: () => true, inLiquid: () => false,
    stopPathfinding () {}, chat () {},
    navigateToPosition: async target => {
      moves.push(target.clone())
      // On ne tient pas debout dans une porte fermee.
      if (isDoor(new Vec3(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z))) && !state.open) {
        return { reached: false, code: 'no_path' }
      }
      // Comme navigation.arrived : une case en l air n est jamais atteinte.
      if (!solid(new Vec3(Math.floor(target.x), Math.floor(target.y) - 1, Math.floor(target.z)))) {
        return { reached: false, code: 'no_path' }
      }
      bot.entity.position = target.clone()
      return { reached: true, code: 'arrived' }
    } })
  runner.setFeatures({ reset: true, utiliser: true })
  t.after(() => { runner.stop('test cleanup'); runner.setFeatures({ reset: true }) })
  await runner.start('ouvre la porte et sors', 'human')
  for (let i = 0; i < 150 && runner.isRunning() && !runner.status().historique?.some(s => s.action === action); i++) {
    await flush()
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  runner.stop('fin du test')
  const step = runner.status().historique.find(s => s.action === action)
  return { step, activated, moves, bot, state }
}

const skills = require('../bot/skills')

test('utiliser door : porte fermee ouverte une fois, franchie de l autre cote', async t => {
  const f = await ouvrir(t)
  assert.ok(f.step, 'utiliser jouee')
  assert.equal(f.state.open, true)
  assert.deepEqual(f.activated.map(p => [p.x, p.y, p.z]), [[3, 65, 0]], 'moitie basse actionnee')
  assert.match(f.step.resultat, /ouverte et franchie/)
  assert.ok(f.bot.entity.position.x > 3, 'de l autre cote')
})

test('utiliser nom exact, piece a plancher : franchie, au sol du dehors', async t => {
  const f = await ouvrir(t, { plancher: true, choices: { objet: 'oak_door' } })
  assert.match(f.step.resultat, /ouverte et franchie/)
  assert.ok(f.bot.entity.position.x > 3 && f.bot.entity.position.y === 65)
})

test('utiliser un levier : actionne sur place, pas de passage', async t => {
  const f = await ouvrir(t, { porte: 'lever', choices: { objet: 'lever' } })
  assert.equal(f.activated.length, 1)
  assert.match(f.step.resultat, /lever actionne/)
  assert.equal(f.moves.length <= 1, true, 'aucun franchissement')
})

test('utiliser un nom hors registre : refus objet_inconnu', async t => {
  const f = await ouvrir(t, { choices: { objet: 'licorne' } })
  assert.equal(f.activated.length, 0)
  assert.match(f.step.resultat, /n est pas un bloc du jeu/)
})

test('mode utiliser : ouvrir_porte et poser_porte remplacees, poser servie', () => {
  const { createMissionRunner: creer } = require('../bot/mission')
  const r = creer({ getBot: () => null })
  r.setFeatures({ reset: true })
  let a = skills.actionsFor('construction')
  assert.ok(a.includes('poser_porte') && a.includes('ouvrir_porte') && !a.includes('utiliser') && !a.includes('poser'))
  r.setFeatures({ utiliser: true })
  a = skills.actionsFor('construction')
  assert.ok(!a.includes('poser_porte') && !a.includes('ouvrir_porte') && a.includes('utiliser') && a.includes('poser'))
  r.setFeatures({ reset: true })
})

test('mode utiliser : emplacement de cuire servi seulement avec le mode, postes du jeu', () => {
  const { createMissionRunner: creer } = require('../bot/mission')
  const craft = require('../bot/craft')
  const r = creer({ getBot: () => null })
  r.setFeatures({ reset: true })
  assert.equal(skills.jsonParamsFor('cuire').emplacement, undefined)
  r.setFeatures({ utiliser: true })
  assert.ok(skills.jsonParamsFor('cuire').emplacement)
  assert.deepEqual(craft.POSTES_CUISSON, ['furnace', 'smoker', 'blast_furnace'])
  r.setFeatures({ reset: true })
})
