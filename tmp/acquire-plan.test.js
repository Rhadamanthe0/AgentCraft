'use strict'
// Preuves PURES de bot/acquire-plan.js (solveur de prerequis) sur les vraies
// donnees 26.1 : aucun monde, aucun modele. Lancement :
//   NODE_PATH=bot/node_modules node --test tmp/acquire-plan.test.js
const { test } = require('node:test')
const assert = require('node:assert/strict')
const md = require('minecraft-data')('26.1')
const skills = require('../bot/skills')
const { planAcquire, summarize } = require('../bot/acquire-plan')

const plan = (target, inventory = {}, extra = {}) =>
  planAcquire({ registry: md, target, count: 1, inventory, resources: skills.RESOURCES, ...extra })
const ops = p => p.etapes.map(s => `${s.op}:${s.objet}`)
const before = (list, a, b) => list.indexOf(a) >= 0 && list.indexOf(a) < list.indexOf(b)

test('pioche en pierre depuis rien : bois, pioche en bois, pierre, pioche en pierre', () => {
  const p = plan('stone_pickaxe')
  assert.equal(p.ok, true)
  const o = ops(p)
  assert.ok(before(o, 'recolter:oak_log', 'fabriquer:wooden_pickaxe'))
  assert.ok(before(o, 'fabriquer:wooden_pickaxe', 'recolter:cobblestone'))
  assert.ok(before(o, 'recolter:cobblestone', 'fabriquer:stone_pickaxe'))
  const pierre = p.etapes.find(s => s.op === 'recolter' && s.objet === 'cobblestone')
  assert.equal(pierre.bloc, 'stone')
  assert.equal(pierre.matiere, 'pierre')
  assert.equal(pierre.outil, 'wooden_pickaxe')
  assert.equal(pierre.quantite, 3)
})

test('stock suffisant : aucune recolte, etabli avant l outil', () => {
  const p = plan('wooden_axe', { oak_log: 3 })
  assert.equal(p.ok, true)
  assert.ok(!p.etapes.some(s => s.op === 'recolter'))
  assert.ok(before(ops(p), 'fabriquer:crafting_table', 'fabriquer:wooden_axe'))
})

test('etabli deja pose : jamais refabrique', () => {
  const p = plan('wooden_axe', { oak_log: 2 }, { tableNearby: true })
  assert.equal(p.ok, true)
  assert.ok(!ops(p).includes('fabriquer:crafting_table'))
})

test('essence en poche preferee a une essence inventee', () => {
  const p = plan('oak_planks', {})
  assert.deepEqual(ops(p), ['recolter:oak_log', 'fabriquer:oak_planks'])
  const q = planAcquire({ registry: md, target: 'stick', count: 4, inventory: { birch_log: 1 }, resources: skills.RESOURCES })
  assert.ok(!q.etapes.some(s => s.op === 'recolter'))
})

test('torche : charbon mine plutot que charbon de bois cuit', () => {
  const p = plan('torch')
  assert.equal(p.ok, true)
  const coal = p.etapes.find(s => s.objet === 'coal')
  assert.equal(coal.op, 'recolter')
  assert.equal(coal.bloc, 'coal_ore')
  assert.equal(coal.outil, 'wooden_pickaxe')
})

test('pioche en fer : minerai a la pioche en pierre, cuisson signalee non geree', () => {
  const p = plan('iron_pickaxe')
  assert.equal(p.ok, false)
  const fer = p.etapes.find(s => s.objet === 'raw_iron')
  assert.equal(fer.op, 'recolter')
  assert.equal(fer.bloc, 'iron_ore')
  assert.equal(fer.outil, 'stone_pickaxe')
  assert.ok(p.bloque.some(b => b.objet === 'iron_ingot' && /cuire/.test(b.raison)))
  assert.ok(p.etapes.some(s => s.op === 'cuire' && s.objet === 'iron_ingot'))
})

test('objet sans aucune voie : bloque, jamais un succes invente', () => {
  const p = plan('bedrock')
  assert.equal(p.ok, false)
  assert.ok(p.bloque.length > 0)
})

test('resume : prochaine etape et totaux a recolter', () => {
  const s = summarize(plan('stone_pickaxe'))
  assert.equal(s.complet, true)
  assert.match(s.prochaine_etape, /^recolter \d+ oak_log/)
  assert.ok(s.a_recolter.some(l => /3 cobblestone .*outil wooden_pickaxe/.test(l)))
  assert.equal(s.a_fabriquer_dans_l_ordre.at(-1), 'stone_pickaxe')
})
