'use strict'

process.env.MISSION_TICK_MS = '1'
process.env.MISSION_QUEUE_TICK_MS = '1'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const perception = require('../bot/perception')
const planner = require('../bot/planner')
const craft = require('../bot/craft')
const { createMissionRunner } = require('../bot/mission')
const { createWorld, worldFromSnapshot, createBot } = require('./sim-world')
const { replay } = require('./replay-snapshot')

// Sol de pierre en y = 64, derniere buche d un tronc entame en (4, 74, 0) :
// les buches du dessous, deja coupees, masqueraient sinon la ligne de vue.
function foret () {
  return createWorld().fill(-4, 64, -4, 10, 64, 4, 'stone').set(4, 74, 0, 'oak_log')
}

test('perception : hauteur de pilier mesuree, plafond dit avec son niveau', () => {
  const world = foret()
  const bot = createBot(world, { position: new Vec3(3.5, 65, 0.5) })
  const centre = new Vec3(4.5, 74.5, 0.5)
  assert.deepEqual(perception.hauteurDePilier(bot, bot.entity.position, 65, centre, 1), { hauteur: 6 })
  world.set(3, 68, 0, 'stone')
  assert.deepEqual(perception.hauteurDePilier(bot, bot.entity.position, 65, centre, 1), { obstacle: 'stone', niveau: 3 })
  // Les feuilles sur la montee sont degagees par piler : elles ne bloquent pas.
  world.set(3, 68, 0, 'oak_leaves')
  assert.deepEqual(perception.hauteurDePilier(bot, bot.entity.position, 65, centre, 1), { hauteur: 6 })
})

test('perception : postes au sol autour de la cible, hors tronc, plus court puis plus proche', () => {
  const world = foret()
  const bot = createBot(world, { position: new Vec3(0.5, 65, 0.5) })
  const cible = new Vec3(4, 74, 0)
  const postes = perception.postesDePilier(bot, cible, cible.offset(0.5, 0.5, 0.5), new Set())
  assert.ok(postes.length >= 4)
  for (const p of postes) assert.notEqual(p.cle, '4,65,0')
  assert.equal(postes[0].hauteur, 6)
  assert.equal(postes[0].cle, '3,65,0', 'le plus proche du bot parmi les plus courts')
  // Emprise de chantier et postes deja essayes exclus.
  const sans = perception.postesDePilier(bot, cible, cible.offset(0.5, 0.5, 0.5), new Set(['3,65,0']),
    { emprise: { x0: 4, x1: 6, z0: -4, z1: 4 } })
  assert.ok(sans.every(p => p.cle !== '3,65,0' && Number(p.cle.split(',')[0]) < 4))
})

test('instantane : aller-retour exact, cases hors region inconnues', () => {
  const world = foret().set(2, 66, 1, 'oak_leaves')
  const bot = createBot(world, { position: new Vec3(0.5, 65, 0.5) })
  const snap = perception.instantane(bot, bot.entity.position, { rayon: 5, bas: 2, haut: 10 })
  assert.deepEqual(snap.taille, { x: 11, y: 13, z: 11 })
  const relu = worldFromSnapshot(snap)
  for (const [x, y, z] of [[2, 66, 1], [4, 74, 0], [0, 64, 0], [1, 65, 1], [-5, 63, -5]]) {
    assert.equal(relu.get(x, y, z), world.get(x, y, z), `${x},${y},${z}`)
  }
  assert.equal(relu.blockAt(new Vec3(30, 65, 0)), null)
  // Le rejeu dit la meme chose que la perception sur le monde vivant.
  const r = replay({ position: { x: 3.5, y: 65, z: 0.5 }, monde: perception.instantane(createBot(world, { position: new Vec3(3.5, 65, 0.5) }), new Vec3(3.5, 65, 0.5)) })
  const haute = r.find(c => c.position === '(4, 74, 0)')
  assert.deepEqual(haute.ici, { hauteur: 6 })
})

test('monde simule : saut et retombee sur la colonne ou se tient le bot, pas la colonne 0', async () => {
  const world = createWorld().fill(-2, 64, -2, 6, 64, 2, 'stone')
  const bot = createBot(world, { position: new Vec3(4.5, 65, 0.5), inventory: [{ name: 'dirt', count: 2 }] })
  await bot.equip({ name: 'dirt' })
  bot.setControlState('jump', true)
  await bot.placeBlock(bot.blockAt(new Vec3(4, 64, 0)))
  bot.setControlState('jump', false)
  assert.equal(bot.entity.position.y, 66)
  assert.equal(world.get(4, 65, 0), 'dirt')
})

// Bout en bout : le bot est sous un plafond, la buche est a +9. Le code
// cherche le poste, s y rend, monte le pilier mesure et la buche est a portee
// au sommet. L ancien harness ne faisait atterrir qu en colonne 0.
test('avancer : plafond ici, poste rejoint, pilier monte, buche a portee', async t => {
  t.mock.method(planner, 'isEnabled', () => true)
  t.mock.method(craft, 'targetCriteria', () => ({}))
  t.mock.method(planner, 'readBrief', async () => ({ kind: 'recolte', kindConfidence: 1, resource: 'bois',
    resourceConfidence: 1, landmark: 'ici', door: false, doorProbability: 0 }))
  let plans = 0
  t.mock.method(planner, 'plan', async () => ({ ms: 0, seconds: 1, rejected: [], done: 0, finished: false,
    steps: [{ action: plans++ === 0 ? 'avancer' : 'terminer', scale: 0, scaleLevel: null, choices: {} }] }))
  const world = createWorld().fill(-4, 64, -4, 10, 64, 4, 'stone').set(4, 74, 0, 'oak_log').set(0, 67, 0, 'stone')
  const bot = createBot(world, { position: new Vec3(0.5, 65, 0.5), inventory: [{ name: 'dirt', count: 8 }] })
  const trajets = []
  const runner = createMissionRunner({ getBot: () => bot, isReady: () => true, inLiquid: () => false,
    stopPathfinding () {}, chat () {},
    navigateToPosition: async position => {
      trajets.push(position.clone())
      bot.entity.position = position.clone()
      return { reached: true, code: 'arrived' }
    } })
  t.after(() => runner.stop('test'))
  await runner.start('ramasse du bois', 'human')
  for (let i = 0; i < 2000 && runner.isRunning(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  const step = runner.status().historique.find(h => h.action === 'avancer')
  assert.equal(trajets.length >= 1, true)
  assert.match(step.resultat, /^poste de pilier rejoint en 3,65,0 \(pilier de 6 mesure\) ; cible haute oak_log : pilier de 6\/6/)
  assert.equal(step.code, 'pilier')
  assert.equal(bot.placements.length, 6)
})
