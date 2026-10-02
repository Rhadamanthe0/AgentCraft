'use strict'

// Moteur d acces unique (option `place` du navigateur, interrupteur
// acces_unifie) : vrai A* 2.4.5 et vraie physique, monde simule modifiable.
// Le calcul choisit lui-meme de monter en tour sous une buche trop haute, et
// l execution pose chaque bloc sous les pieds (pose.js), verifie par le monde.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { pathfinder } = require('mineflayer-pathfinder')
const { Physics, PlayerState } = require('prismarine-physics')
const registry = require('prismarine-registry')('26.1')
const Block = require('prismarine-block')(registry)
const { createNavigator, posePorteAppui } = require('../bot/navigation')

function fixture ({ log = new Vec3(0, 70, 0), dirt = 8, start = new Vec3(0.5, 65, 0.5), extra = {} } = {}) {
  const cells = new Map(Object.entries(extra))
  cells.set(`${log.x},${log.y},${log.z}`, 'oak_log')
  const nameAt = p => {
    const k = `${p.x},${p.y},${p.z}`
    if (cells.has(k)) return cells.get(k)
    return p.y <= 64 ? 'stone' : 'air'
  }
  const world = { getBlock: pos => {
    const p = pos.floored()
    if (Math.abs(p.x) > 10 || Math.abs(p.z) > 10) return null
    const block = Block.fromStateId(registry.blocksByName[nameAt(p)].defaultState, 0)
    block.position = p
    return block
  } }
  const bot = new EventEmitter()
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  const stock = [{ name: 'dirt', type: registry.itemsByName.dirt.id, count: dirt }]
  const placed = []
  Object.assign(bot, { version: '26.1', registry, game: { minY: -64 }, entities: {},
    entity: { position: start.clone(), velocity: new Vec3(0, 0, 0),
      yaw: 0, pitch: 0, onGround: true, effects: {}, attributes: {}, height: 1.8, width: 0.6 },
    inventory: { items: () => stock.filter(i => i.count > 0), slots: [] }, controlState: controls,
    heldItem: null, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    blockAt: world.getBlock,
    clearControlStates: () => { for (const key of Object.keys(controls)) controls[key] = false },
    setControlState: (key, enabled) => { controls[key] = enabled },
    look: async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch },
    lookAt: async () => {},
    equip: async item => { bot.heldItem = item },
    dig: async () => { throw new Error('no dig allowed') },
    // Comme le serveur : refus si la case est pleine ou recouvre le corps.
    placeBlock: async (ref, face) => {
      const cell = ref.position.plus(face)
      const p = bot.entity.position
      const corps = cell.x + 1 > p.x - 0.3 && cell.x < p.x + 0.3 && cell.z + 1 > p.z - 0.3 && cell.z < p.z + 0.3 &&
        cell.y + 1 > p.y && cell.y < p.y + 1.8
      if (nameAt(cell) !== 'air' || corps || !(bot.heldItem?.count > 0)) throw new Error('the block is still air')
      cells.set(`${cell.x},${cell.y},${cell.z}`, bot.heldItem.name)
      bot.heldItem.count--
      placed.push(cell)
    }
  })
  bot.physics = Physics(registry, world)
  pathfinder(bot)
  const timer = setInterval(() => {
    bot.physics.simulatePlayer(new PlayerState(bot, controls), world).apply(bot)
    bot.emit('physicsTick')
  }, 50)
  return { bot, placed, stock, cells, close: () => clearInterval(timer) }
}

const place = (f, extra = {}) => ({ items: [registry.itemsByName.dirt.id], max: 6, ...extra })

test('posePorteAppui : un pas de tour pose le sol du noeud d arrivee', () => {
  assert.equal(posePorteAppui({ x: 0, y: 66, z: 0, toPlace: [{ x: 0, y: 64, z: 0, dx: 0, dy: 1, dz: 0, jump: true }] }), true)
  assert.equal(posePorteAppui({ x: 1, y: 65, z: 0, toPlace: [{ x: 0, y: 64, z: 0, dx: 1, dy: 0, dz: 0 }] }), true)
  assert.equal(posePorteAppui({ x: 1, y: 65, z: 0, toPlace: [] }), false)
})

test('vrai A* et physique : buche a +5 au-dessus, tour de terre posee sous les pieds jusqu a portee', async t => {
  const f = fixture()
  t.after(f.close)
  const poses = []
  const nav = createNavigator(() => f.bot, { timeoutMs: 15000 })
  const r = await nav.toPosition(new Vec3(0.5, 70.5, 0.5), { interaction: true,
    place: place(f, { onPlaced: (cell, info) => poses.push({ ...cell, ...info }) }) })
  assert.equal(r.code, 'arrived', JSON.stringify({ r, pos: f.bot.entity.position, trace: nav.trace()?.events?.slice(-8) }))
  assert.ok(f.placed.length >= 1 && f.placed.length <= 6, `tour de ${f.placed.length}`)
  assert.ok(poses.every(p => p.tour), 'chaque pose est un niveau de tour')
  // Une colonne : toutes les poses dans la meme case x,z, en montant.
  assert.equal(new Set(f.placed.map(c => `${c.x},${c.z}`)).size, 1)
  assert.equal(f.stock[0].count, 8 - f.placed.length)
  assert.ok(f.bot.entity.position.y >= 65 + f.placed.length - 0.01)
})

test('sans echafaudage en poche : aucune tour planifiee, la buche reste hors de portee', async t => {
  const f = fixture({ dirt: 0 })
  t.after(f.close)
  const nav = createNavigator(() => f.bot, { timeoutMs: 4000 })
  const r = await nav.toPosition(new Vec3(0.5, 70.5, 0.5), { interaction: true, place: place(f) })
  assert.equal(r.reached, false)
  assert.equal(f.placed.length, 0)
})

test('borne max : pas plus de blocs que permis, meme avec du stock', async t => {
  const f = fixture({ log: new Vec3(0, 73, 0) })
  t.after(f.close)
  const nav = createNavigator(() => f.bot, { timeoutMs: 6000 })
  const r = await nav.toPosition(new Vec3(0.5, 73.5, 0.5), { interaction: true, place: place(f, { max: 2 }) })
  assert.equal(r.reached, false)
  assert.ok(f.placed.length <= 2)
})

test('sans option place : le navigateur ne pose jamais rien', async t => {
  const f = fixture()
  t.after(f.close)
  const nav = createNavigator(() => f.bot, { timeoutMs: 3000 })
  const r = await nav.toPosition(new Vec3(0.5, 70.5, 0.5), { interaction: true })
  assert.equal(r.reached, false)
  assert.equal(f.placed.length, 0)
})

test('buche decalee de deux blocs a +6 : le calcul choisit un poste et une tour, jamais plus de six blocs', async t => {
  const f = fixture({ log: new Vec3(2, 71, 0) })
  t.after(f.close)
  const nav = createNavigator(() => f.bot, { timeoutMs: 15000 })
  const r = await nav.toPosition(new Vec3(2.5, 71.5, 0.5), { interaction: true, place: place(f) })
  assert.equal(r.code, 'arrived', JSON.stringify({ r, pos: f.bot.entity.position, placed: f.placed }))
  assert.ok(f.placed.length >= 2 && f.placed.length <= 6, `tour de ${f.placed.length}`)
})

test('tranchee de trois de large entre le bot et la cible : sol pose en pont, puis cible atteinte', async t => {
  // Sol de pierre partout sauf une tranchee x = 2..4 profonde de 6.
  const extra = {}
  for (let x = 2; x <= 4; x++) for (let z = -10; z <= 10; z++) for (let y = 58; y <= 64; y++) extra[`${x},${y},${z}`] = 'air'
  const f = fixture({ log: new Vec3(8, 65, 0), extra })
  t.after(f.close)
  const poses = []
  const nav = createNavigator(() => f.bot, { timeoutMs: 20000 })
  const r = await nav.toPosition(new Vec3(8.5, 65.5, 0.5), { interaction: true,
    place: place(f, { onPlaced: (cell, info) => poses.push({ ...cell, ...info }) }) })
  assert.equal(r.code, 'arrived', JSON.stringify({ r, pos: f.bot.entity.position, placed: f.placed }))
  assert.ok(f.placed.length >= 1 && f.placed.every(c => c.y === 64), JSON.stringify(f.placed))
  assert.ok(poses.every(p => !p.tour), 'un pont n est pas une tour')
  assert.ok(f.bot.entity.position.y >= 64.99, 'jamais tombe dans la tranchee')
})
