'use strict'
// Ne jamais s enfermer (decision du proprietaire, 2026-10-01) : le bloc qui
// fermerait la derniere sortie a pied se pose depuis l exterieur, le bot
// sorti d abord (composite/cabin-from-scratch 7d76b18 : enferme 38 min).
//   NODE_PATH=bot/node_modules node --test tmp/enclosure.test.js
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const build = require('../bot/build')

// Sol de pierre en y 63, enceinte de 2 de haut (y 64-65) autour de la piece
// x -1..1, z -1..1 ; une seule ouverture en (2, 64-65, 0), sauf `ouverture`.
function world ({ botAt = new Vec3(0.5, 64, 0.5), ouverture = 'air', mur = 'oak_planks' } = {}) {
  const extra = new Map()
  const placed = []
  const moves = []
  const kind = p => {
    const k = `${p.x},${p.y},${p.z}`
    if (extra.has(k)) return extra.get(k)
    if (p.y < 64) return 'stone'
    if (p.y > 65) return 'air'
    const ring = Math.max(Math.abs(p.x), Math.abs(p.z)) === 2
    if (!ring) return 'air'
    if (p.x === 2 && p.z === 0) return ouverture
    return mur
  }
  const blockAt = p => {
    const position = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
    const name = kind(position)
    return { name, position, boundingBox: name === 'air' ? 'empty' : 'block' }
  }
  const bot = {
    entity: { position: botAt.clone(), onGround: true },
    blockAt,
    inventory: { items: () => [{ name: 'oak_planks', count: 64, type: 1 }] },
    heldItem: null,
    registry: { itemsByName: { oak_planks: { id: 1 } } },
    equip: async item => { bot.heldItem = item },
    lookAt: async () => {},
    placeBlock: async (ref, face) => {
      const at = ref.position.plus(face)
      placed.push({ at, from: bot.entity.position.clone() })
      extra.set(`${at.x},${at.y},${at.z}`, 'oak_planks')
    },
    pathfinder: { setGoal: () => {} },
    setControlState: () => {},
    clearControlStates: () => {}
  }
  const move = async stand => { moves.push(stand.clone()); bot.entity.position = stand.clone(); return true }
  return { bot, placed, moves, move, extra }
}

test('bloc qui ferme la derniere ouverture, bot dedans : enceinte detectee', () => {
  const { bot } = world()
  assert.ok(build.walkRegion(bot, bot.entity.position).escape, 'sortie par l ouverture')
  const inside = build.enclosureBy(bot, new Vec3(2, 64, 0))
  assert.ok(inside, 'la pose du bas de l ouverture enfermerait le bot')
  assert.ok(inside.has('0,64,0'))
  // Le corps tient sur deux cases : boucher le haut seul ferme aussi.
  assert.ok(build.enclosureBy(bot, new Vec3(2, 65, 0)), 'le haut de l ouverture enfermerait aussi')
})

test('bot dehors, ou bloc ailleurs : rien a proteger', () => {
  assert.equal(build.enclosureBy(world({ botAt: new Vec3(6.5, 64, 0.5) }).bot, new Vec3(2, 64, 0)), null)
  assert.equal(build.enclosureBy(world().bot, new Vec3(0, 64, 1)), null)
})

test('porte en bois dans l ouverture : passage, pas d enceinte ; porte de fer : deja enferme', () => {
  const bois = world({ ouverture: 'oak_door' }).bot
  assert.ok(build.walkRegion(bois, bois.entity.position).escape)
  const fer = world({ ouverture: 'iron_door' }).bot
  assert.equal(build.walkRegion(fer, fer.entity.position).escape, false)
  // Deja enferme : la pose n y change rien, aucune sortie forcee.
  assert.equal(build.enclosureBy(fer, new Vec3(0, 64, 1)), null)
})

test('placeOne : le bot sort, puis pose le dernier bloc depuis l exterieur', async () => {
  const f = world({ botAt: new Vec3(1.5, 64, 0.5) })
  const r = await build.placeOne(f.bot, new Vec3(2, 64, 0), 'oak_planks', { move: f.move })
  assert.equal(r, 'pose')
  assert.equal(f.placed.length, 1)
  const from = f.placed[0].from
  assert.ok(Math.max(Math.abs(Math.floor(from.x)), Math.abs(Math.floor(from.z))) > 2, `pose depuis l exterieur, pas depuis ${from}`)
  assert.ok(f.moves.length >= 1, 'sorti avant la pose')
})

test('placeOne sans enceinte : toujours la pose directe d ici', async () => {
  const f = world()
  const r = await build.placeOne(f.bot, new Vec3(0, 64, 1), 'oak_planks', { move: f.move })
  assert.equal(r, 'pose')
  assert.deepEqual(f.moves, [])
})
