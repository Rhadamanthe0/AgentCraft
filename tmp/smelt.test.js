'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const craft = require('../bot/craft')

// Four deja pose a cote du bot ; la fenetre rend un lingot par putInput au
// premier releve. Verifie entree, combustible choisi et produit mesure.
function fixture (inv) {
  const stock = new Map(Object.entries(inv))
  const types = { raw_iron: 1, oak_planks: 2, coal: 3, iron_ingot: 4, oak_log: 5, charcoal: 6 }
  const names = Object.fromEntries(Object.entries(types).map(([k, v]) => [v, k]))
  const par = { coal: 8, charcoal: 8, oak_log: 1.5, oak_planks: 1.5 }
  const calls = []
  let entree = 0
  let sortie = 0
  let feu = 0 // cuissons restantes du combustible pose
  // Le four cuit tout ce que le feu permet a chaque releve.
  const cuire = () => {
    const n = Math.min(entree, Math.floor(feu + 1e-9))
    entree -= n; feu -= n; sortie += n
  }
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    registry: { blocksByName: { furnace: { id: 99 } } },
    inventory: { items: () => [...stock].filter(([, c]) => c > 0).map(([name, count]) => ({ name, count, type: types[name] })) },
    findBlock: () => ({ name: 'furnace', position: new Vec3(1, 64, 0) }),
    lookAt: async () => {},
    openFurnace: async () => ({
      get fuel () { return feu >= 1 ? 1 : 0 },
      fuelItem: () => null,
      inputItem: () => entree > 0 ? { name: 'raw_iron', count: entree } : null,
      outputItem: () => { cuire(); return sortie > 0 ? { name: 'iron_ingot', count: sortie } : null },
      takeOutput: async () => { stock.set('iron_ingot', (stock.get('iron_ingot') ?? 0) + sortie); sortie = 0 },
      takeInput: async () => { calls.push(['reprise', 'raw_iron', entree]); stock.set('raw_iron', (stock.get('raw_iron') ?? 0) + entree); entree = 0 },
      putFuel: async (type, meta, n) => { calls.push(['fuel', names[type], n]); stock.set(names[type], stock.get(names[type]) - n); feu += n * par[names[type]] },
      putInput: async (type, meta, n) => { calls.push(['input', names[type], n]); stock.set(names[type], stock.get(names[type]) - n); entree += n },
      close () {}
    })
  }
  return { bot, calls, stock }
}

test('cuisson : minerai cru en lingots, charbon prefere aux planches', async () => {
  const f = fixture({ raw_iron: 3, oak_planks: 8, coal: 2 })
  const r = await craft.smelt(f.bot, 'iron_ingot', 3)
  assert.equal(r.produced, 3)
  assert.deepEqual(f.calls, [['fuel', 'coal', 1], ['input', 'raw_iron', 3]])
})

test('cuisson : planches en combustible (2 pour 3 objets)', async () => {
  const f = fixture({ raw_iron: 3, oak_planks: 8 })
  const r = await craft.smelt(f.bot, 'iron_ingot', 3)
  assert.equal(r.produced, 3)
  assert.deepEqual(f.calls[0], ['fuel', 'oak_planks', 2])
})

test('cuisson sans minerai ni combustible : erreur missing, jamais un succes', async () => {
  await assert.rejects(craft.smelt(fixture({ oak_planks: 4 }).bot, 'iron_ingot', 2), e => e.code === 'missing' && e.missing[0].name === 'raw_iron')
  await assert.rejects(craft.smelt(fixture({ raw_iron: 2 }).bot, 'iron_ingot', 2), e => e.code === 'missing')
})

test('cuisson : combustible recharge quand le premier s epuise (buche puis planches)', async () => {
  const f = fixture({ raw_iron: 3, oak_log: 1, oak_planks: 1 })
  const r = await craft.smelt(f.bot, 'iron_ingot', 3)
  assert.equal(r.produced, 3)
  assert.deepEqual(f.calls.filter(c => c[0] === 'fuel'), [['fuel', 'oak_log', 1], ['fuel', 'oak_planks', 1]])
  assert.equal(f.stock.get('raw_iron'), 0)
})

test('cuisson : combustible insuffisant refuse avant de remplir le four', async () => {
  const f = fixture({ raw_iron: 3, oak_log: 1 })
  await assert.rejects(craft.smelt(f.bot, 'iron_ingot', 3), e => e.code === 'missing' && /1 cuisson/.test(e.message))
  assert.equal(f.calls.length, 0)
  assert.equal(f.stock.get('raw_iron'), 3)
})
