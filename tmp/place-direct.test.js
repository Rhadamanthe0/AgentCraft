'use strict'
// build.placeOne : une case deja a portee se pose d ici, sans trajet (vu sur
// craft/stone-pickaxe : etabli jamais pose, trajet vers un poste en echec).
//   NODE_PATH=bot/node_modules node --test tmp/place-direct.test.js
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const build = require('../bot/build')

function world (botAt) {
  const placed = []
  const moves = []
  const blockAt = p => {
    const solid = p.y < 64
    return { name: solid ? 'stone' : 'air', position: p, boundingBox: solid ? 'block' : 'empty' }
  }
  const bot = {
    entity: { position: botAt, onGround: true },
    blockAt,
    inventory: { items: () => [{ name: 'crafting_table', count: 1, type: 1 }] },
    heldItem: null,
    registry: { itemsByName: { crafting_table: { id: 1 } } },
    equip: async item => { bot.heldItem = item },
    lookAt: async () => {},
    placeBlock: async (ref, face) => { placed.push(ref.position.plus(face)) },
    pathfinder: { setGoal: () => moves.push('goal') },
    setControlState: () => moves.push('control'),
    clearControlStates: () => {}
  }
  return { bot, placed, moves }
}

test('case voisine a portee : posee sans se deplacer', async () => {
  const { bot, placed, moves } = world(new Vec3(0.5, 64, 0.5))
  const r = await build.placeOne(bot, new Vec3(2, 64, 0), 'crafting_table')
  assert.equal(r, 'pose')
  assert.deepEqual(placed.map(p => p.toString()), [new Vec3(2, 64, 0).toString()])
  assert.deepEqual(moves, [])
})

test('sixieme couche d une tour : un poste au sol est propose (5 blocs sous la case)', () => {
  const { bot } = world(new Vec3(10.5, 64, 10.5))
  const target = new Vec3(0, 69, 0)
  bot.blockAt = p => {
    const solid = p.y < 64 || (p.x >= 0 && p.x <= 1 && p.z >= 0 && p.z <= 1 && p.y < 69)
    return { name: solid ? 'dirt' : 'air', position: p, boundingBox: solid ? 'block' : 'empty' }
  }
  const vantages = build.findVantages(bot, target)
  assert.ok(vantages.some(v => v.stand.y === 64), 'poste au sol a portee')
})
