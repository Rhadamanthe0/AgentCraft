'use strict'
// Un etabli pose plus loin que 4-6 blocs reste l etabli de la mission : le
// solveur ne doit pas en reclamer un autre des que le bot part miner
// (craft/furnace, 28d5096 : allers-retours bouleau/pierre pendant 4 min).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const craft = require('../bot/craft')

test('placedTable cherche dans le rayon de reutilisation (24 blocs par defaut)', () => {
  const asked = []
  const bot = {
    registry: { blocksByName: { crafting_table: { id: 7 } } },
    findBlock: ({ matching, maxDistance }) => { asked.push(maxDistance); return matching === 7 && maxDistance >= 20 ? { position: { x: 20, y: 0, z: 0 } } : null }
  }
  assert.equal(craft.TABLE_REUSE_RADIUS, 24)
  assert.deepEqual(craft.placedTable(bot)?.position, { x: 20, y: 0, z: 0 })
  assert.deepEqual(asked, [24])
})

test('placedTable sans registre ni findBlock : null, jamais une exception', () => {
  assert.equal(craft.placedTable({}), null)
  assert.equal(craft.placedTable({ registry: { blocksByName: { crafting_table: { id: 7 } } }, findBlock: () => { throw new Error('chunk') } }), null)
})
