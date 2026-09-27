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
  const calls = []
  let enFour = 0
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    registry: { blocksByName: { furnace: { id: 99 } } },
    inventory: { items: () => [...stock].filter(([, c]) => c > 0).map(([name, count]) => ({ name, count, type: types[name] })) },
    findBlock: () => ({ name: 'furnace', position: new Vec3(1, 64, 0) }),
    lookAt: async () => {},
    openFurnace: async () => ({
      outputItem: () => enFour > 0 ? { name: 'iron_ingot', count: enFour } : null,
      takeOutput: async () => { stock.set('iron_ingot', (stock.get('iron_ingot') ?? 0) + enFour); enFour = 0 },
      putFuel: async (type, meta, n) => { calls.push(['fuel', names[type], n]); stock.set(names[type], stock.get(names[type]) - n) },
      putInput: async (type, meta, n) => { calls.push(['input', names[type], n]); stock.set(names[type], stock.get(names[type]) - n); enFour = n },
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
