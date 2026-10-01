'use strict'

// Monde simule partage par les tests : une grille de blocs nommes, un faux bot
// Mineflayer qui lit, casse, pose, saute et retombe sur N IMPORTE QUELLE
// colonne sous sa hitbox. Chaque fichier de test reconstruisait son propre
// monde ; leurs limites (atterrissage seulement en colonne 0, sol absent)
// finissaient dans les assertions. Ici, une seule physique minimale :
//   - un bloc est plein sauf air / cave_air / void_air / liquide / plante ;
//   - sauter monte les pieds a la case au-dessus (+0.1) ;
//   - relacher le saut fait retomber jusqu au premier sol sous la hitbox.
// Il charge aussi un instantane pris par le bot a un blocage
// (perception.instantane), pour rejouer la perception sur le monde du banc.

const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const perception = require('../bot/perception')

const VIDE = /^(air|cave_air|void_air)$|water|lava|bubble_column|^(short_grass|tall_grass|fern|dandelion|poppy|torch)$/
const key = (x, y, z) => `${x},${y},${z}`

function createWorld (blocks = {}, { loaded = null } = {}) {
  const cells = new Map(blocks instanceof Map ? blocks : Object.entries(blocks))
  const world = {
    cells,
    get: (x, y, z) => cells.get(key(x, y, z)) ?? 'air',
    set (x, y, z, name) {
      if (!name || name === 'air') cells.delete(key(x, y, z))
      else cells.set(key(x, y, z), name)
      return world
    },
    fill (x0, y0, z0, x1, y1, z1, name) {
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
        for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
          for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) world.set(x, y, z, name)
        }
      }
      return world
    },
    blockAt (p) {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      if (loaded && !loaded(x, y, z)) return null
      const name = world.get(x, y, z)
      const plein = !VIDE.test(name)
      return { name, position: new Vec3(x, y, z), boundingBox: plein ? 'block' : 'empty', shapes: plein ? [[0, 0, 0, 1, 1, 1]] : [] }
    },
    solid: (x, y, z) => !VIDE.test(world.get(x, y, z))
  }
  return world
}

// Monde d un instantane : hors de la region, les cases sont inconnues (null),
// comme un chunk non charge.
function worldFromSnapshot (snap) {
  const monde = snap.monde ?? snap
  const noms = perception.lireInstantane(monde)
  const { origine, taille } = monde
  return createWorld(noms, {
    loaded: (x, y, z) => x >= origine.x && x < origine.x + taille.x && y >= origine.y &&
      y < origine.y + taille.y && z >= origine.z && z < origine.z + taille.z && noms.has(key(x, y, z))
  })
}

function createBot (world, { position = new Vec3(0.5, 65, 0.5), inventory = [], names = [] } = {}) {
  const stock = inventory.map(item => ({ ...item }))
  const registryNames = new Set([...names, ...[...world.cells.values()], 'dirt', 'oak_log', 'oak_planks', 'oak_leaves'])
  const blocksByName = {}
  let id = 1
  for (const name of registryNames) blocksByName[name] = { id: id++, name, boundingBox: VIDE.test(name) ? 'empty' : 'block' }
  const byId = Object.fromEntries(Object.values(blocksByName).map(b => [b.id, b.name]))
  const placements = []
  const digs = []
  const bot = new EventEmitter()
  const colonnes = () => perception.colonnesSousHitbox(bot.entity.position, Math.floor(bot.entity.position.y))
  const retomber = () => {
    const p = bot.entity.position
    let y = Math.floor(p.y)
    while (y > -64 && !colonnes().some(c => world.solid(c.x, y - 1, c.z))) y -= 1
    p.y = y
    bot.entity.onGround = true
  }
  Object.assign(bot, {
    entity: { id: 42, position: position.clone(), yaw: 0, pitch: 0, onGround: true, velocity: new Vec3(0, 0, 0) },
    registry: { blocksByName, itemsByName: {} },
    inventory: { items: () => stock.filter(item => item.count > 0) },
    players: {},
    entities: {},
    heldItem: null,
    placements,
    digs,
    blockAt: p => world.blockAt(p),
    findBlocks ({ matching, maxDistance = 32, count = 64, useExtraInfo, point }) {
      const ids = new Set([].concat(matching))
      const from = point ?? bot.entity.position
      const found = []
      for (const [k, name] of world.cells) {
        const bid = blocksByName[name]?.id
        if (!ids.has(bid)) continue
        const p = new Vec3(...k.split(',').map(Number))
        if (p.distanceTo(from) > maxDistance) continue
        if (typeof useExtraInfo === 'function' && !useExtraInfo(world.blockAt(p))) continue
        found.push(p)
      }
      return found.sort((a, b) => a.distanceTo(from) - b.distanceTo(from)).slice(0, count)
    },
    findBlock: () => null,
    clearControlStates () {},
    setControlState (control, value) {
      if (control !== 'jump') return
      if (value) {
        bot.entity.position.y = Math.floor(bot.entity.position.y) + 1.1
        bot.entity.onGround = false
      } else retomber()
    },
    look: async () => {},
    lookAt: async () => {},
    equip: async item => { bot.heldItem = stock.find(s => s.name === item.name) ?? item },
    dig: async block => {
      digs.push(block.name)
      world.set(block.position.x, block.position.y, block.position.z, 'air')
      const owned = stock.find(item => item.name === block.name)
      if (owned) owned.count++
      else stock.push({ name: block.name, count: 1 })
      retomber()
    },
    placeBlock: async support => {
      const name = bot.heldItem?.name
      if (!name || !(bot.heldItem.count > 0)) throw new Error('rien en main')
      world.set(support.position.x, support.position.y + 1, support.position.z, name)
      bot.heldItem.count--
      placements.push(name)
    }
  })
  bot.blockName = bid => byId[bid]
  return bot
}

module.exports = { createWorld, worldFromSnapshot, createBot, VIDE }
