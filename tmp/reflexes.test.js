'use strict'
// Detection pure des reflexes (bot/reflexes.js) sur un bot factice.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const r = require('../bot/reflexes')

function fakeBot (blocks = {}, extra = {}) {
  const pos = new Vec3(0.5, 64, 0.5)
  return {
    username: 'Bot',
    entity: { position: pos },
    blockAt: v => {
      const name = blocks[`${v.x},${v.y},${v.z}`] ?? 'air'
      return { name, position: v, boundingBox: name === 'air' || /lava|fire/.test(name) ? 'empty' : 'block' }
    },
    entities: {},
    players: {},
    inventory: { emptySlotCount: () => 30 },
    ...extra
  }
}

test('rien autour : aucun danger', () => {
  assert.equal(r.detectDanger(fakeBot({ '0,63,0': 'stone' })), null)
})

test('sable suspendu au-dessus de la tete : chute de bloc', () => {
  assert.equal(r.detectDanger(fakeBot({ '0,66,0': 'sand' })).type, 'chute_de_bloc')
  assert.equal(r.detectDanger(fakeBot({ '0,66,0': 'gravel' })).type, 'chute_de_bloc')
})

test('lave au contact : brulure ; magma sous les pieds aussi', () => {
  assert.equal(r.detectDanger(fakeBot({ '1,64,0': 'lava' })).type, 'brulure')
  assert.equal(r.detectDanger(fakeBot({ '0,63,0': 'magma_block' })).type, 'brulure')
})

test('tete dans un bloc plein : etouffement', () => {
  assert.equal(r.detectDanger(fakeBot({ '0,65,0': 'dirt' })).type, 'etouffement')
})

test('objets au sol : proches et au meme niveau seulement', () => {
  const item = (id, x, y, z) => ({ id, name: 'item', position: new Vec3(x, y, z) })
  const bot = fakeBot({}, { entities: { 1: item(1, 2.5, 64, 0.5), 2: item(2, 0.5, 70, 0.5), 3: item(3, 9, 64, 0) } })
  assert.deepEqual(r.detectDrops(bot).map(e => e.id), [1])
  bot.inventory.emptySlotCount = () => 1
  assert.deepEqual(r.detectDrops(bot), [])
})

test('joueur colle au bot, jamais le bot lui-meme', () => {
  const bot = fakeBot()
  bot.players = { Bot: { entity: bot.entity }, Alice: { entity: { position: new Vec3(0.8, 64, 0.5) } } }
  assert.equal(r.detectCrowding(bot).joueur, 'Alice')
  bot.players.Alice.entity.position = new Vec3(3, 64, 0.5)
  assert.equal(r.detectCrowding(bot), null)
})

test('monstre hostile a moins de 8 blocs ; animal ignore', () => {
  const bot = fakeBot()
  bot.entities = { 5: { type: 'hostile', name: 'zombie', position: new Vec3(4, 64, 0) }, 6: { type: 'animal', name: 'cow', position: new Vec3(1, 64, 0) } }
  assert.equal(r.detectHostile(bot).entity.name, 'zombie')
})

test('point de fuite : a l oppose de la source', () => {
  const p = r.awayFrom(new Vec3(0, 64, 0), new Vec3(2, 64, 0), 3)
  assert.ok(p.x < -2.9 && Math.abs(p.z) < 1e-9)
})
