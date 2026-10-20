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

test('pioche en fer : minerai a la pioche en pierre, puis cuisson au four', () => {
  const p = plan('iron_pickaxe')
  assert.equal(p.ok, true)
  const fer = p.etapes.find(s => s.objet === 'raw_iron')
  assert.equal(fer.op, 'recolter')
  assert.equal(fer.bloc, 'iron_ore')
  assert.equal(fer.outil, 'stone_pickaxe')
  assert.equal(p.bloque.length, 0)
  const cuire = p.etapes.find(s => s.op === 'cuire' && s.objet === 'iron_ingot')
  assert.equal(cuire.depuis, 'raw_iron')
  assert.ok(p.etapes.indexOf(cuire) > p.etapes.findIndex(s => s.objet === 'furnace'))
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

test('cibles de fabrication en francais : outil a matiere, objets courants, pluriels', () => {
  const { normalizeFabricationTarget } = skills
  assert.equal(normalizeFabricationTarget('pioche en pierre'), 'stone_pickaxe')
  assert.equal(normalizeFabricationTarget('hache en bois'), 'wooden_axe')
  assert.equal(normalizeFabricationTarget('épée en diamant'), 'diamond_sword')
  assert.equal(normalizeFabricationTarget('une pioche'), 'pioche')
  assert.equal(normalizeFabricationTarget('un four'), 'furnace')
  assert.equal(normalizeFabricationTarget('torches'), 'torch')
  assert.equal(normalizeFabricationTarget('planches'), 'planches')
  const { resolveFabricationCible } = require('../bot/mission')
  assert.equal(resolveFabricationCible({ registry: md }, 'torches'), 'torch')
  assert.equal(resolveFabricationCible({ registry: md }, 'furnaces'), 'furnace')
  assert.equal(resolveFabricationCible({ registry: md }, 'constructor'), null)
  // Matiere dite une fois pour un groupe d outils, jamais prise a une autre
  // demande de la phrase (revue de #75).
  const { fabricationPrecisee } = skills
  const groupe = 'une pioche, une hache et une épée en pierre'
  assert.deepEqual(['pioche', 'hache', 'épée', 'sword'].map(r => fabricationPrecisee(r, groupe)),
    ['stone_pickaxe', 'stone_axe', 'stone_sword', 'stone_sword'])
  assert.deepEqual(['pioche', 'hache'].map(r => fabricationPrecisee(r, 'une pioche en bois et une hache en fer')),
    ['wooden_pickaxe', 'iron_axe'])
  assert.equal(fabricationPrecisee('wooden_pickaxe', groupe), null)
  // Les nombres comptent les outils du groupe, ils ne le coupent pas.
  for (const texte of ['deux pioches et trois pelles en fer', '2 pioches et 3 pelles en fer', 'des pioches et des pelles en fer',
    'une pioche et onze pelles en fer', 'une pioche et vingt pelles en fer', 'une pioche et quatre-vingt-douze pelles en fer']) {
    assert.equal(fabricationPrecisee('pioche', texte), 'iron_pickaxe', texte)
  }
  assert.equal(fabricationPrecisee('hache', 'une hache et deux épées en pierre'), 'stone_axe')
  for (const [brut, texte] of [['pioche', 'Fabrique une pioche. Construis une maison en pierre.'],
    ['hache', 'une hache ; puis un pont en bois'], ['pelle', 'une pelle puis une porte en fer'],
    ['pioche', 'une pioche et une maison en pierre'], ['pioche', 'une pioche et deux planches en fer'],
    ['pioche', 'une pioche. deux pelles en fer'], ['pioche', 'une pioche et 11 planches en pierre'],
    ['pioche', 'une pioche et onze planches en pierre'], ['pioche', 'une pioche. deux haches en pierre'],
    ['pioche', 'une pioche en constructor'], ['constructor', 'un constructor en fer'], ['pioche', 'une pioche en tostring']]) {
    assert.equal(fabricationPrecisee(brut, texte), null, texte)
  }
  // Pluriel sans nombre : au moins deux objets a poser (nommeAuPluriel).
  assert.ok(skills.nommeAuPluriel('eclaire-la avec des torches', 'torch'))
  assert.ok(skills.nommeAuPluriel('une ligne de rails', 'rail'))
  assert.ok(!skills.nommeAuPluriel('pose une torche', 'torch'))
  assert.ok(!skills.nommeAuPluriel('des torches', 'rail'))
  assert.ok(skills.nommeAuPluriel('une ligne avec des rails accelerateurs', 'powered_rail'))
  assert.ok(!skills.nommeAuPluriel('des rails et un rail accelerateur', 'powered_rail'))
})

test('four deja pose : pas de nouveau four ni de pierre pour lui', () => {
  const sans = plan('iron_ingot', { raw_iron: 3, oak_planks: 4 })
  assert.ok(sans.etapes.some(e => e.op === 'fabriquer' && e.objet === 'furnace'))
  const avec = plan('iron_ingot', { raw_iron: 3, oak_planks: 4 }, { furnaceNearby: true })
  assert.equal(avec.etapes.some(e => e.objet === 'furnace'), false)
  assert.equal(avec.etapes.some(e => e.op === 'recolter'), false)
  assert.ok(avec.etapes.some(e => e.op === 'cuire'))
})

test('combustible : planches de toute essence en poche, aucune recolte de bois', () => {
  const p = plan('iron_pickaxe', { raw_iron: 3, birch_planks: 4, stick: 4 }, { furnaceNearby: true, tableNearby: true })
  assert.equal(p.ok, true)
  assert.equal(p.etapes.some(e => e.op === 'recolter'), false)
})
