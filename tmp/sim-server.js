'use strict'

// Serveur simule pour jouer une mission scriptee (banc de competences) hors
// ligne, en quelques secondes a quelques dizaines de secondes, sans Paper ni
// modele. Ce qui est reel : mineflayer-pathfinder 2.4.5 (A*), prismarine-
// physics (gravite, sauts, collisions), le runner de mission et ses actions,
// le navigateur partage. Ce qui est simule, au plus pres du serveur :
//   - casse : le bloc disparait ; ses objets (drops du registre, seulement avec
//     l outil exige) tombent en entite `item` (entitySpawn), chutent jusqu au
//     sol et sont ramasses au contact de la boite du joueur elargie d un bloc
//     (playerCollect puis entityGone) ;
//   - trajet qui creuse (host.digToward) : le navigateur en mode creuser, la
//     ou le banc passe par le pathfinder ;
//   - pose : refusee si la case est pleine, recouvre le corps du bot, ou sans
//     objet en main (« the block is still air », piege 5) ;
//   - inventaire : objets par id du registre 26.1.
// Hors champ : fabrication (fenetres), four, liquides, autres joueurs. Un
// niveau qui en a besoin reste au banc.

const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { pathfinder } = require('mineflayer-pathfinder')
const { Physics, PlayerState } = require('prismarine-physics')
const registry = require('prismarine-registry')('26.1')
const Block = require('prismarine-block')(registry)
const { createNavigator } = require('../bot/navigation')

const key = (x, y, z) => `${x},${y},${z}`
const nom = brut => String(brut).replace(/^minecraft:/, '').replace(/\[.*$/, '')

// blocks : Map ou objet 'x,y,z' -> nom ; sol : fonction (x, y, z) -> nom pour
// les cases non listees (defaut : herbe en 199, pierre dessous, air dessus) ;
// borne : { x0, x1, z0, z1 } au-dela de laquelle tout est barriere.
function createSimServer ({ blocks = {}, sol = null, borne = null, start = new Vec3(0.5, 200, 0.5),
  inventory = [], tickMs = 50 } = {}) {
  const cells = new Map(blocks instanceof Map ? blocks : Object.entries(blocks))
  const fond = sol ?? ((x, y) => y === 199 ? 'grass_block' : y < 199 && y >= 189 ? 'stone' : 'air')
  const nameAt = (x, y, z) => {
    if (borne && (x < borne.x0 || x > borne.x1 || z < borne.z0 || z > borne.z1)) return 'barrier'
    const k = key(x, y, z)
    return cells.has(k) ? cells.get(k) : fond(x, y, z)
  }
  const blockAt = pos => {
    const p = pos.floored()
    const def = registry.blocksByName[nameAt(p.x, p.y, p.z)] ?? registry.blocksByName.stone
    const block = Block.fromStateId(def.defaultState, 0)
    block.position = p
    return block
  }
  const setBlock = (p, name) => { cells.set(key(p.x, p.y, p.z), name ?? 'air') }
  const world = { getBlock: blockAt }

  const bot = new EventEmitter()
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  const stock = []
  const ajouter = (name, count = 1) => {
    const item = registry.itemsByName[name]
    if (!item) return
    const owned = stock.find(i => i.name === name && i.count < (item.stackSize ?? 64))
    if (owned) owned.count += count
    else stock.push({ name, type: item.id, count, stackSize: item.stackSize ?? 64, displayName: item.displayName })
  }
  for (const { name, count } of inventory) ajouter(name, count)
  let nextId = 1000
  const journal = { digs: [], places: [], collects: [] }

  Object.assign(bot, {
    version: '26.1', registry, game: { minY: -64, gameMode: 'survival' }, entities: {}, players: {},
    username: 'SimBot', health: 20, food: 20,
    entity: { id: 1, type: 'player', name: 'player', username: 'SimBot', position: start.clone(), velocity: new Vec3(0, 0, 0),
      yaw: 0, pitch: 0, onGround: true, effects: {}, attributes: {}, height: 1.8, width: 0.6 },
    inventory: { items: () => stock.filter(i => i.count > 0), slots: [], emit () {} },
    controlState: controls, heldItem: null, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    blockAt: p => blockAt(p),
    clearControlStates: () => { for (const k of Object.keys(controls)) controls[k] = false },
    setControlState: (k, v) => { controls[k] = v },
    getControlState: k => controls[k],
    look: async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch },
    // Comme mineflayer : le regard suit le point vise (le pathfinder recule
    // vers un rebord en se retournant, moveToEdge ; sans cela il reculait a
    // l aveugle).
    lookAt: async point => {
      const d = point.minus(bot.entity.position.offset(0, 1.62, 0))
      bot.entity.yaw = Math.atan2(-d.x, -d.z)
      bot.entity.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z))
    },
    chat () {},
    equip: async item => {
      const owned = stock.find(i => i.name === item?.name && i.count > 0)
      if (!owned) throw new Error(`objet absent : ${item?.name}`)
      bot.heldItem = owned
    },
    unequip: async () => { bot.heldItem = null },
    // Objet-entite tenu (minecart, bateau...) utilise sur un bloc : l entite
    // apparait dessus, l objet est consomme, comme au serveur.
    activateBlock: async block => {
      const tenu = bot.heldItem && bot.heldItem.count > 0 ? bot.heldItem : null
      if (!tenu || registry.blocksByName[tenu.name] || !registry.entitiesByName?.[tenu.name]) return
      const entity = { id: nextId++, uuid: `sim-${nextId}`, name: tenu.name, type: 'other',
        position: block.position.offset(0.5, 0.1, 0.5), velocity: new Vec3(0, 0, 0) }
      bot.entities[entity.id] = entity
      tenu.count -= 1
      if (tenu.count <= 0) bot.heldItem = null
      journal.places.push(tenu.name)
      bot.emit('entitySpawn', entity)
    },
    canDigBlock: block => Boolean(block && block.diggable !== false),
    digTime: () => 50,
    stopDigging () {},
    dig: async block => {
      const b = blockAt(block.position)
      if (b.name === 'air') throw new Error('rien a casser')
      setBlock(b.position, 'air')
      journal.digs.push(b.name)
      const outil = b.harvestTools ? Object.keys(b.harvestTools).map(Number) : null
      const bonOutil = !outil || (bot.heldItem && outil.includes(bot.heldItem.type))
      const drops = bonOutil ? (b.drops ?? []).map(d => typeof d === 'number' ? d : d?.drop?.id ?? d?.id).filter(Number.isInteger) : []
      for (const id of drops.slice(0, 1)) {
        const name = registry.items[id]?.name
        if (!name) continue
        const entity = { id: nextId++, uuid: `sim-${nextId}`, name: 'item', type: 'object',
          position: b.position.offset(0.5, 0.25, 0.5), velocity: new Vec3(0, 0, 0),
          getDroppedItem: () => ({ name, count: 1, type: id }) }
        bot.entities[entity.id] = entity
        bot.emit('entitySpawn', entity)
        bot.emit('itemDrop', entity)
      }
      bot.emit('blockUpdate', b, blockAt(b.position))
    },
    placeBlock: async (ref, face) => {
      const cell = ref.position.plus(face)
      const p = bot.entity.position
      const corps = cell.x + 1 > p.x - 0.3 && cell.x < p.x + 0.3 && cell.z + 1 > p.z - 0.3 && cell.z < p.z + 0.3 &&
        cell.y + 1 > p.y && cell.y < p.y + 1.8
      const plein = blockAt(cell).boundingBox === 'block'
      const tenu = bot.heldItem && bot.heldItem.count > 0 ? bot.heldItem : null
      if (plein || corps || !tenu || !registry.blocksByName[tenu.name]) throw new Error('the block is still air')
      setBlock(cell, tenu.name)
      tenu.count -= 1
      if (tenu.count <= 0) bot.heldItem = null
      journal.places.push(tenu.name)
      bot.emit('blockUpdate', null, blockAt(cell))
    },
    findBlocks ({ matching, maxDistance = 32, count = 64, point, useExtraInfo }) {
      const test = typeof matching === 'function' ? matching
        : (ids => b => ids.has(b.type))(new Set([].concat(matching)))
      const from = (point ?? bot.entity.position).floored()
      const found = []
      const r = Math.min(32, Math.ceil(maxDistance))
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          for (let dy = -r; dy <= r; dy++) {
            const p = from.offset(dx, dy, dz)
            if (p.distanceTo(from) > maxDistance) continue
            const n = nameAt(p.x, p.y, p.z)
            if (n === 'air') continue
            const b = blockAt(p)
            if (!test(b)) continue
            if (typeof useExtraInfo === 'function' && !useExtraInfo(b)) continue
            found.push(p)
          }
        }
      }
      return found.sort((a, b) => a.distanceTo(from) - b.distanceTo(from)).slice(0, count)
    },
    findBlock (opts) {
      const p = bot.findBlocks({ ...opts, count: 1 })[0]
      return p ? blockAt(p) : null
    },
    recipesFor: () => [],
    recipesAll: () => []
  })
  bot.physics = Physics(registry, world)
  pathfinder(bot)

  // Objets au sol : chute jusqu au premier bloc plein, ramassage a portee.
  function objets () {
    for (const entity of Object.values(bot.entities)) {
      if (entity.name !== 'item') continue
      const dessous = blockAt(entity.position.offset(0, -0.3, 0))
      if (dessous.boundingBox !== 'block') entity.position.y -= 0.35
      // Comme le serveur : boite du joueur (0,6 x 1,8) elargie de 1 bloc en X/Z
      // et 0,5 en Y, contre celle de l objet (0,25 de cote).
      const p = bot.entity.position
      const e = entity.position
      if (Math.abs(e.x - p.x) <= 0.3 + 1 + 0.125 && Math.abs(e.z - p.z) <= 0.3 + 1 + 0.125 &&
        e.y + 0.25 >= p.y - 0.5 && e.y <= p.y + 1.8 + 0.5) {
        const item = entity.getDroppedItem()
        ajouter(item.name, item.count)
        journal.collects.push(item.name)
        bot.emit('playerCollect', bot.entity, entity)
        delete bot.entities[entity.id]
        bot.emit('entityGone', entity)
      }
    }
  }
  const timer = setInterval(() => {
    bot.physics.simulatePlayer(new PlayerState(bot, controls), world).apply(bot)
    objets()
    bot.emit('physicsTick')
  }, tickMs)

  const navigator = createNavigator(() => bot, { timeoutMs: 30000 })
  const host = {
    getBot: () => bot,
    isReady: () => true,
    inLiquid: () => /water|lava/.test(blockAt(bot.entity.position).name),
    stopPathfinding: () => navigator.cancel(),
    setNavigation () {},
    chat () {},
    navigateToPosition: (position, options = {}) => {
      const opts = { ...options }
      delete opts.__owner
      return navigator.toPosition(position, opts)
    },
    navigateToPlayer: async () => ({ reached: false, code: 'no_player' }),
    // Trajet qui creuse : par defaut le navigateur en mode creuser (A/B
    // nav_creuse, digTowardNavigateur), pas de bloc construit si protectBuilt ;
    // SIM_CREUSE=pathfinder : le pathfinder comme au banc (index.digToward,
    // nav_creuse eteint), choisi par tmp/skill-sim.js.
    digToward: async (position, { range, protectBuilt, block } = {}) => {
      if (process.env.SIM_CREUSE === 'pathfinder') return digTowardPathfinder(position, { range, block })
      const BUILT = /(_planks|_door|glass|chest|crafting_table|furnace|_stairs|_slab|_log|_wood)/
      const startPos = bot.entity.position.clone()
      const target = block ? new Vec3(block.x + 0.5, block.y + 0.5, block.z + 0.5) : position
      const r = await navigator.toPosition(target, { radius: range, interaction: Boolean(block), dig: {
        canBreak: b => !(protectBuilt && BUILT.test(b.name)) && b.diggable !== false && Number.isFinite(b.hardness) && b.hardness >= 0,
        digBlock: async b => { try { await bot.dig(b) } catch (_) { return false } return blockAt(b.position).boundingBox !== 'block' }
      } })
      return { reached: Boolean(r.reached), code: r.reached ? 'dug' : r.code,
        travelled: Number(startPos.distanceTo(bot.entity.position).toFixed(2)), distance: bot.entity.position.distanceTo(position) }
    },
    recentChat: () => []
  }
  // Trajet qui creuse du banc (index.digToward) : vrai pathfinder 2.4.5,
  // memes Movements que safeDigMovements, but « bloc en vue ».
  async function digTowardPathfinder (position, { range = 3, block } = {}) {
    const { Movements, goals } = require('mineflayer-pathfinder')
    const { GoalBlocEnVue } = require('../bot/but-bloc')
    const m = new Movements(bot)
    m.canDig = true; m.allow1by1towers = true; m.allowParkour = false; m.maxDropDown = 3
    bot.pathfinder.setMovements(m)
    const startPos = bot.entity.position.clone()
    // Monde par sections (raycast du but) recopie du serveur simule autour du
    // trajet, tenu a jour par blockUpdate.
    const Chunk = require('prismarine-chunk')(registry)
    const World = require('prismarine-world')(registry)
    const monde = new World(null).sync
    const a = bot.entity.position; const b = block ?? position
    for (let cx = Math.floor(Math.min(a.x, b.x) / 16) - 1; cx <= Math.floor(Math.max(a.x, b.x) / 16) + 1; cx++) {
      for (let cz = Math.floor(Math.min(a.z, b.z) / 16) - 1; cz <= Math.floor(Math.max(a.z, b.z) / 16) + 1; cz++) {
        const ch = new Chunk({ minY: -64, worldHeight: 384 })
        for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 185; y < 225; y++) {
          const n = nameAt(cx * 16 + x, y, cz * 16 + z)
          if (n !== 'air') ch.setBlockStateId(new Vec3(x, y, z), registry.blocksByName[n].defaultState)
        }
        monde.setColumn(cx, cz, ch)
      }
    }
    const onBloc = (_old, neuf) => { if (neuf?.position) monde.setBlockStateId(neuf.position, registry.blocksByName[neuf.name]?.defaultState ?? 0) }
    bot.on('blockUpdate', onBloc)
    const goal = block ? new GoalBlocEnVue(block, monde, { reach: 3.5 }) : new goals.GoalNear(position.x, position.y, position.z, range)
    const log = []
    const onUpdate = r => log.push(`${r.status}:${r.visitedNodes}n/${r.path.length}p ${r.path.slice(0, 3).map(n => `${n.x},${n.y},${n.z}${n.toBreak.length ? ' b' + n.toBreak.length : ''}${n.toPlace.length ? ' p' + n.toPlace.length : ''}`).join(' > ')}`)
    const onReset = r => log.push(`reset:${r} ${bot.entity.position.toString()}`)
    bot.on('path_update', onUpdate); bot.on('path_reset', onReset)
    let stuck = 0
    const onStuck = r => { if (r === 'stuck' && ++stuck >= 3) bot.pathfinder.setGoal(null) }
    bot.on('path_reset', onStuck)
    const timer = setTimeout(() => bot.pathfinder.setGoal(null), 45000)
    try {
      await bot.pathfinder.goto(goal)
      return { reached: stuck < 3, code: stuck < 3 ? 'dug' : 'stuck', travelled: Number(startPos.distanceTo(bot.entity.position).toFixed(2)), distance: bot.entity.position.distanceTo(position) }
    } catch (e) {
      console.log(`[creuse] ${e.message} ; ${log.slice(-8).join(' | ')}`)
      return { reached: false, code: stuck >= 3 ? 'stuck' : 'no_path', travelled: Number(startPos.distanceTo(bot.entity.position).toFixed(2)) }
    } finally {
      clearTimeout(timer)
      bot.removeListener('path_update', onUpdate); bot.removeListener('path_reset', onReset); bot.removeListener('path_reset', onStuck)
      bot.removeListener('blockUpdate', onBloc)
      bot.clearControlStates()
    }
  }
  return {
    bot, host, navigator, journal,
    nameAt, setBlock,
    count: test => [...cells.entries()].filter(([, n]) => test(n)).length,
    inventory: () => stock.filter(i => i.count > 0).map(i => ({ name: i.name, count: i.count })),
    close: () => { clearInterval(timer); navigator.cancel() }
  }
}

module.exports = { createSimServer, registry, nom }
