'use strict'
// perception.trouverBlocs : meme resultat qu une recherche exhaustive, sans
// objet Block, sur un vrai monde par sections (prismarine-world/chunk 26.1)
// (2026-10-11 : le findBlocks de mineflayer avec filtre bloquait la boucle
// d evenements 2 a 13 s par etat de mission au banc ; ~6 fois plus lent).
const test = require('node:test')
const assert = require('node:assert')
const Vec3 = require('vec3').Vec3
const registry = require('prismarine-registry')('26.1')
const Chunk = require('prismarine-chunk')(registry)
const World = require('prismarine-world')(registry)
const perception = require('../bot/perception')

const MIN_Y = registry.dimensionsByName?.overworld?.minY ?? -64
const HEIGHT = registry.dimensionsByName?.overworld?.height ?? 384

// Sous-sol de pierre (y < 64), herbe a 64, quelques minerais, air au-dessus.
function monde () {
  const world = new World(null).sync
  const id = n => registry.blocksByName[n].defaultState
  for (let cx = -3; cx <= 3; cx++) {
    for (let cz = -3; cz <= 3; cz++) {
      const chunk = new Chunk({ minY: MIN_Y, worldHeight: HEIGHT })
      for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++) {
          for (let y = 30; y < 64; y++) chunk.setBlockStateId(new Vec3(x, y, z), id('stone'))
          chunk.setBlockStateId(new Vec3(x, 64, z), id('grass_block'))
          if ((x * 7 + z * 3 + cx + cz) % 23 === 0) chunk.setBlockStateId(new Vec3(x, 50, z), id('iron_ore'))
        }
      }
      world.setColumn(cx, cz, chunk)
    }
  }
  // Une tranchee : de la pierre visible.
  for (let x = 4; x < 9; x++) for (let y = 60; y < 65; y++) world.setBlockStateId(new Vec3(x, y, 3), 0)
  return world
}

function faux (world) {
  return {
    world,
    registry,
    game: { minY: MIN_Y, height: HEIGHT },
    entity: { position: new Vec3(0.5, 65, 0.5) },
    blockAt: p => world.getBlock(p)
  }
}

function exhaustif (bot, ids, filtre, maxDistance, count) {
  const etats = new Set(ids.flatMap(i => {
    const d = registry.blocks[i]; const out = []
    for (let e = d.minStateId; e <= d.maxStateId; e++) out.push(e)
    return out
  }))
  const c = bot.entity.position.floored()
  const r = []
  for (let x = c.x - maxDistance; x <= c.x + maxDistance; x++) {
    for (let y = c.y - maxDistance; y <= c.y + maxDistance; y++) {
      for (let z = c.z - maxDistance; z <= c.z + maxDistance; z++) {
        const p = new Vec3(x, y, z)
        if (p.distanceTo(c) > maxDistance || !etats.has(bot.world.getBlockStateId(p))) continue
        if (filtre && !filtre(p)) continue
        r.push(p.distanceTo(c))
      }
    }
  }
  return r.sort((a, b) => a - b).slice(0, count)
}

test('pierre exposee : memes distances qu une recherche exhaustive', () => {
  const bot = faux(monde())
  const ids = [registry.blocksByName.stone.id]
  const exposed = p => perception.blocExpose(bot, p, 65)
  const trouves = perception.trouverBlocs(bot, { ids, filtre: exposed, maxDistance: 32, count: 64 })
  const c = bot.entity.position.floored()
  assert.deepStrictEqual(trouves.map(p => p.distanceTo(c)), exhaustif(bot, ids, exposed, 32, 64))
  assert.ok(trouves.length > 0)
  assert.ok(trouves.every(exposed))
})

test('matiere absente : rien, et vite', () => {
  const bot = faux(monde())
  const debut = Date.now()
  assert.deepStrictEqual(perception.trouverBlocs(bot, { ids: [registry.blocksByName.diamond_ore.id], maxDistance: 32, count: 5 }), [])
  assert.ok(Date.now() - debut < 500)
})

test('pierre enfouie sur tout le rayon : aucun objet Block construit', () => {
  // Le findBlocks de mineflayer avec filtre construisait un Block par case
  // de chaque section contenant la matiere (~400 000 par recherche) : c est
  // ce cout, pas le temps (variable d une machine a l autre), qui est verifie.
  const world = monde()
  const bot = faux(world)
  let construits = 0
  const getBlock = world.getBlock.bind(world)
  world.getBlock = p => { construits++; return getBlock(p) }
  bot.blockAt = p => { construits++; return getBlock(p) }
  const ids = [registry.blocksByName.stone.id]
  const exposed = (p, lire) => perception.blocExpose(bot, p, 65, lire)
  const trouves = perception.trouverBlocs(bot, { ids, filtre: exposed, maxDistance: 32, count: 64 })
  assert.ok(trouves.length > 0)
  assert.strictEqual(construits, 0)
})

test('bot sans monde par sections : repli sur findBlocks avec le filtre', () => {
  let recu = null
  const bot = { entity: { position: new Vec3(0, 0, 0) }, findBlocks: o => { recu = o; return [new Vec3(1, 2, 3)] } }
  const r = perception.trouverBlocs(bot, { ids: [1], filtre: p => p.x === 1, maxDistance: 8, count: 2 })
  assert.deepStrictEqual(r, [new Vec3(1, 2, 3)])
  assert.strictEqual(recu.maxDistance, 8)
  assert.ok(recu.useExtraInfo({ position: new Vec3(1, 0, 0) }))
})

// Bot mineflayer (plugin des blocs reel) sur le monde de test.
function mineflayerBot (world) {
  const EventEmitter = require('events')
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot.registry = registry
  bot.version = '26.1'
  require('mineflayer/lib/plugins/blocks.js')(bot, { version: '26.1', hideErrors: true })
  bot.game = { minY: MIN_Y, height: HEIGHT }
  bot.world = world
  bot.entity = { position: new Vec3(0.5, 65, 0.5) }
  return bot
}

test('section uniforme (air, pierre) : palette a valeur unique lue, pas de parcours', () => {
  const world = monde()
  const section = world.getColumn(0, 0).sections[(80 >> 4) - (MIN_Y >> 4)]
  assert.ok(section && !Array.isArray(section.palette), 'section d air en conteneur a valeur unique')
  assert.deepStrictEqual(perception.paletteSection(section), [0])
  assert.strictEqual(perception.paletteSection(null), null)
})

test('findBlocks branche : les plus proches par ids, aucun Block pour une matiere absente', () => {
  const world = monde()
  const bot = mineflayerBot(world)
  perception.brancherRecherche(bot)
  perception.brancherRecherche(bot) // idempotent
  const ids = ['iron_ore', 'grass_block'].map(n => registry.blocksByName[n].id)
  const c = bot.entity.position.floored()
  const dist = l => l.map(p => p.distanceTo(c))
  // Exact, la ou mineflayer s arrete a la premiere couche de sections pleine.
  assert.deepStrictEqual(dist(bot.findBlocks({ matching: ids, maxDistance: 20, count: 10 })), exhaustif(bot, ids, null, 20, 10))
  assert.strictEqual(bot.findBlock({ matching: registry.blocksByName.iron_ore.id, maxDistance: 32 }).name, 'iron_ore')
  // Four absent : mineflayer construisait un Block par case de chaque section
  // d air du rayon (piege 18) ; branche, aucun.
  let construits = 0
  const blockAt = bot.blockAt
  bot.blockAt = (...a) => { construits++; return blockAt(...a) }
  assert.strictEqual(bot.findBlock({ matching: registry.blocksByName.furnace.id, maxDistance: 24 }), null)
  assert.strictEqual(construits, 0)
  // Une recherche a fonction garde l original.
  assert.ok(bot.findBlocks({ matching: b => b?.name === 'iron_ore', maxDistance: 8, count: 1 }).length <= 1)
})
