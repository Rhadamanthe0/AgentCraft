'use strict'

// Real pathfinder 2.4.5 and prismarine-physics, simulated block world; no server.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const Move = require('mineflayer-pathfinder/lib/move')
const { Physics, PlayerState } = require('prismarine-physics')
const registry = require('prismarine-registry')('26.1')
const Block = require('prismarine-block')(registry)
const { createNavigator, clearSegment, itemInPickupRange } = require('../bot/navigation')

function fixture ({ height = 2, landing = 'stone', unknown = false, mobile = true, tree = false, landingPatch = null, pickupEdge = false, encoche = false } = {}) {
  const bot = new EventEmitter()
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  const inputs = []
  const positions = []
  const world = { getBlock: pos => {
    const p = pos.floored()
    if (pickupEdge ? p.x < 40 || p.x > 49 || p.z < -111 || p.z > -100 : Math.abs(p.x) > 8 || Math.abs(p.z) > 8) return null
    if (unknown && (p.x !== 0 || p.z !== 0) && p.y < 67) return null
    const nearTree = Math.hypot(p.x, p.z - 6) <= 3
    if (landingPatch === 'unknown' && nearTree && p.y <= 68) return null
    let name = 'air'
    if (p.y <= 64) name = p.y === 64 ? landing : 'stone'
    if (p.x === 0 && p.z === 0 && p.y >= 65 && p.y < 65 + height) name = 'dirt'
    if (tree && p.x === 0 && p.z === 6 && p.y >= 69 && p.y <= 73) name = 'oak_log'
    if (nearTree && landingPatch === 'water' && p.y === 64) name = 'water'
    if (nearTree && landingPatch === 'wall' && p.y >= 65 && p.y <= 67) name = 'stone'
    if (pickupEdge) {
      name = p.y <= 63 ? 'stone' : 'air'
      if (p.x === 43 && p.z === -107 && p.y >= 64 && p.y <= 65) name = 'stone'
      if (p.x === 45 && p.z === -106 && p.y === 64) name = 'grass_block'
      // Paroi de deux blocs a x = 47, encoche a hauteur de tete (minerai casse
      // de cote) ou l objet repose a +1 au-dessus des pieds.
      if (encoche && p.x === 47 && p.y >= 64 && p.y <= 65 && !(p.y === 65 && p.z === -105)) name = 'stone'
    }
    const definition = registry.blocksByName[name]
    // A bottom slab makes the geometric fall 2.5 rather than two blocks.
    let state = definition.defaultState
    if (name === 'stone_slab') {
      for (let s = definition.minStateId; s <= definition.maxStateId; s++) {
        const candidate = Block.fromStateId(s, 0)
        if (candidate.getProperties().type === 'bottom' && !candidate.getProperties().waterlogged) { state = s; break }
      }
    }
    const block = Block.fromStateId(state, 0)
    block.position = p
    return block
  } }
  Object.assign(bot, { version: '26.1', registry, game: { minY: -64 }, entities: {},
    entity: { position: pickupEdge ? new Vec3(43.5, 66, -106.7) : new Vec3(0.5, 65 + height, 0.5), velocity: new Vec3(0, 0, 0),
      yaw: 0, pitch: 0, onGround: true, effects: {}, attributes: {}, height: 1.8, width: 0.6 },
    inventory: { items: () => [], slots: [] }, controlState: controls,
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    blockAt: world.getBlock,
    clearControlStates: () => { for (const key of Object.keys(controls)) controls[key] = false },
    setControlState: (key, enabled) => { controls[key] = enabled; inputs.push([key, enabled]) },
    look: async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch },
    dig: async () => { throw new Error('no dig allowed') },
    placeBlock: async () => { throw new Error('no placement allowed') }
  })
  bot.physics = Physics(registry, world)
  pathfinder(bot)
  const traces = []
  const movementsSeen = []
  const realGetPath = bot.pathfinder.getPathFromTo
  bot.pathfinder.getPathFromTo = function * (movements, start, goal, options) {
    movementsSeen.push(movements)
    for (const step of realGetPath(movements, start, goal, options)) {
      traces.push({ status: step.result.status, visited: step.result.visitedNodes,
        path: step.result.path.map(p => ({ x: p.x, y: p.y, z: p.z })), maxDropDown: movements.maxDropDown })
      yield step
    }
  }
  let timer
  function startPhysics () {
    timer = setInterval(() => {
      if (mobile) bot.physics.simulatePlayer(new PlayerState(bot, controls), world).apply(bot)
      positions.push({ x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z, onGround: bot.entity.onGround })
      bot.emit('physicsTick')
    }, 50)
  }
  return { bot, controls, inputs, positions, traces, movementsSeen, startPhysics, close: () => clearInterval(timer) }
}

function pathWithLimit (f, maxDropDown) {
  const movements = new Movements(f.bot)
  movements.getMoveDiagonal = () => {}
  movements.canDig = false
  movements.allow1by1towers = false
  movements.allowParkour = false
  movements.maxDropDown = maxDropDown
  for (const name of ['water', 'lava', 'bubble_column']) movements.blocksToAvoid.add(registry.blocksByName[name].id)
  const node = new Move(0, f.bot.entity.position.y, 0, 0, 0)
  const neighbors = movements.getNeighbors(node)
  let result
  for (const step of f.bot.pathfinder.getPathFromTo(movements, f.bot.entity.position,
    new goals.GoalBlock(4, 65, 0), { optimizePath: false, timeout: 500, tickTimeout: 20 })) result = step.result
  return { neighbors, result }
}

test('vrai A* : limite2 sans voisins sur pilier2, limite3 trouve une descente2', () => {
  assert.equal(require('mineflayer-pathfinder/package.json').version, '2.4.5')
  const f = fixture()
  const old = pathWithLimit(f, 2)
  assert.equal(old.neighbors.length, 0)
  assert.equal(old.result.status, 'noPath')
  assert.equal(old.result.visitedNodes, 1)
  const next = pathWithLimit(f, 3)
  assert.equal(next.neighbors.length, 4)
  assert.ok(next.neighbors.every(node => node.y === 65 && node.toBreak.length === 0 && node.toPlace.length === 0))
  assert.equal(next.result.status, 'success')
  assert.deepEqual(next.result.path.map(p => [p.x, p.y, p.z]), [[1, 65, 0], [2, 65, 0], [3, 65, 0], [4, 65, 0]])
})

test('navigateur reel et physique : sort du pilier2 sans saut, atterrit puis atteint le sol cible', async t => {
  const f = fixture()
  t.after(f.close)
  f.startPhysics()
  const nav = createNavigator(() => f.bot, { timeoutMs: 7000 })
  const result = await nav.toPosition(new Vec3(4.5, 65, 0.5), { radius: 0.4 })
  assert.equal(result.code, 'arrived', JSON.stringify({ result, traces: f.traces, position: f.bot.entity.position }))
  assert.equal(f.bot.entity.onGround, true)
  assert.equal(f.bot.entity.position.y, 65)
  assert.ok(f.positions.some(p => !p.onGround && p.y < 67 && p.y > 65), 'actual gravity-driven fall')
  assert.ok(f.positions.every(p => p.y >= 65 && p.y <= 67), 'fall height never exceeds two blocks')
  assert.equal(f.inputs.some(([key, enabled]) => key === 'jump' && enabled), false)
  assert.equal(Object.values(f.controls).some(Boolean), false)
  assert.ok(f.traces[0].path.length > 0)
})

test('descente refusee : trois blocs, dalle a2.5, eau, lave ou sol inconnu', async () => {
  for (const options of [{ height: 3 }, { landing: 'stone_slab' }, { landing: 'water' }, { landing: 'lava' }, { unknown: true }]) {
    const f = fixture(options)
    const result = await createNavigator(() => f.bot).toPosition(new Vec3(4.5, 65, 0.5), { radius: 0.4 })
    assert.equal(result.code, 'no_path', JSON.stringify({ options, result, traces: f.traces }))
    assert.equal(f.traces[0].visited, 1)
    assert.equal(f.inputs.some(([, enabled]) => enabled), false)
  }
})

test('annulation pendant descente : controles relaches, aucune arrivee fabriquee', async t => {
  const f = fixture()
  t.after(f.close)
  f.startPhysics()
  const abort = new AbortController()
  const cancelWhileFalling = () => {
    if (!f.bot.entity.onGround && f.bot.entity.position.y < 67) abort.abort()
  }
  f.bot.on('physicsTick', cancelWhileFalling)
  const result = await createNavigator(() => f.bot, { timeoutMs: 7000 }).toPosition(new Vec3(4.5, 65, 0.5), { signal: abort.signal, radius: 0.4 })
  assert.equal(abort.signal.aborted, true)
  assert.equal(result.code, 'cancelled')
  assert.equal(result.reached, false)
  assert.equal(Object.values(f.controls).some(Boolean), false)
  assert.equal(f.inputs.some(([key, enabled]) => key === 'jump' && enabled), false)
})

test('tronc flottant : descente2 seule ne donne pas la portee, approche optionnelle au pied sans faux succes', async t => {
  const target = new Vec3(0.5, 69.5, 6.5)
  const f = fixture({ tree: true })
  t.after(f.close)
  const nav = createNavigator(() => f.bot, { timeoutMs: 7000 })
  const strict = await nav.toPosition(target, { interaction: true })
  assert.equal(strict.code, 'no_path', JSON.stringify(strict))
  assert.equal(f.inputs.some(([, enabled]) => enabled), false)
  f.startPhysics()
  const result = await nav.toPosition(target, { interaction: true, allowHighApproach: true })
  assert.equal(result.code, 'needs_height', JSON.stringify({ result, position: f.bot.entity.position, traces: f.traces }))
  assert.equal(result.reached, false)
  assert.equal(f.bot.entity.onGround, true)
  assert.equal(f.bot.entity.position.y, 65)
  assert.deepEqual(result.position, { x: f.bot.entity.position.x, y: 65, z: f.bot.entity.position.z })
  assert.ok(result.horizontalDistance <= 2)
  assert.equal(result.verticalGap, 4.5)
  assert.ok(result.remaining > 4)
  assert.equal(f.inputs.some(([key, enabled]) => key === 'jump' && enabled), false)
  assert.equal(Object.values(f.controls).some(Boolean), false)
})

test('approche haute : interaction reelle prioritaire, budget partage et annulation', async t => {
  const near = fixture({ tree: true })
  t.after(near.close)
  const reached = await createNavigator(() => near.bot).toPosition(new Vec3(0.5, 69.5, 2.5),
    { interaction: true, allowHighApproach: true })
  assert.equal(reached.code, 'arrived')
  assert.equal(reached.reached, true)
  assert.equal(near.traces.length, 0)
  for (const cancelled of [false, true]) {
    const f = fixture({ tree: true })
    t.after(f.close)
    f.startPhysics()
    const abort = new AbortController()
    if (cancelled) f.bot.on('physicsTick', () => {
      if (!f.bot.entity.onGround) abort.abort()
    })
    const result = await createNavigator(() => f.bot, { timeoutMs: 7000 }).toPosition(new Vec3(0.5, 69.5, 6.5),
      { interaction: true, allowHighApproach: true, distanceBudget: 1, signal: abort.signal })
    assert.equal(result.code, cancelled ? 'cancelled' : 'advanced', JSON.stringify(result))
    assert.equal(result.reached, false)
    assert.equal(Object.values(f.controls).some(Boolean), false)
  }
})

test('approche haute refuse un poste dont corps, appui ou chunks sont invalides', async () => {
  for (const landingPatch of ['wall', 'water', 'unknown']) {
    const f = fixture({ tree: true, landingPatch })
    const result = await createNavigator(() => f.bot).toPosition(new Vec3(0.5, 69.5, 6.5),
      { interaction: true, allowHighApproach: true })
    assert.equal(result.code, 'no_path', JSON.stringify({ landingPatch, result }))
    assert.equal(result.reached, false)
    assert.equal(f.inputs.some(([, enabled]) => enabled), false)
  }
})

test('tapis intermediaire : vrai voisin y67 mais pieds67.0625, chute vers65 refusee', async () => {
  const f = fixture({ landing: 'stone_slab' })
  await createNavigator(() => f.bot).toPosition(new Vec3(4.5, 65, 0.5))
  const movements = f.movementsSeen[0]
  f.bot.blockAt = pos => {
    const p = pos.floored()
    let name = p.y <= 64 ? 'stone' : 'air'
    if ((p.x === 0 || p.x === 1) && p.z === 0 && p.y >= 65 && p.y <= 66) name = 'stone'
    if (p.x === 1 && p.z === 0 && p.y === 67) name = 'white_carpet'
    const block = Block.fromStateId(registry.blocksByName[name].defaultState, 0)
    block.position = p
    return block
  }
  const neighbors = []
  movements.getMoveForward(new Move(0, 67, 0, 0, 0), { x: 1, z: 0 }, neighbors)
  assert.equal(neighbors.length, 1)
  assert.equal(neighbors[0].y, 67)
  assert.equal(movements.getBlock(neighbors[0], 0, 0, 0).height, 67.0625)
  assert.equal(movements.getLandingBlock(neighbors[0], { x: 1, z: 0 }), null)
})

test('objet contre paroi : vrai A* et physique atteignent un poste proche sans viser le volume du corps au point objet', async t => {
  const f = fixture({ pickupEdge: true })
  t.after(f.close)
  const target = new Vec3(45.8077, 64, -104.7511)
  const post = new Vec3(45.5, 64, -104.5)
  assert.equal(clearSegment(f.bot, post, target), false)
  assert.equal(itemInPickupRange(f.bot, post, target), true)
  const nav = createNavigator(() => f.bot, { timeoutMs: 7000 })
  const strict = await nav.toPosition(target, { radius: 1.6 })
  assert.equal(strict.code, 'no_path', JSON.stringify(strict))
  assert.equal(f.inputs.some(([, enabled]) => enabled), false)
  f.startPhysics()
  const result = await nav.toPosition(target, { radius: 1.6, pickup: true })
  assert.equal(result.code, 'arrived', JSON.stringify({ result, position: f.bot.entity.position }))
  assert.equal(f.bot.entity.onGround, true)
  assert.equal(f.bot.entity.position.y, 64)
  assert.ok(Math.hypot(f.bot.entity.position.x - target.x, f.bot.entity.position.z - target.z) <= 1.6)
  assert.equal(Object.values(f.controls).some(Boolean), false)
})

test('objet dans une encoche a hauteur de tete : vrai A* et physique rejoignent un poste au pied de la paroi', async t => {
  const f = fixture({ pickupEdge: true, encoche: true })
  t.after(f.close)
  f.bot.entity.position = new Vec3(43.5, 64, -104.5)
  const item = new Vec3(47.5, 65, -104.5)
  f.startPhysics()
  const result = await createNavigator(() => f.bot, { timeoutMs: 7000 }).toPosition(item, { radius: 1.6, pickup: true })
  assert.equal(result.code, 'arrived', JSON.stringify({ result, position: f.bot.entity.position }))
  const p = f.bot.entity.position
  assert.equal(p.y, 64)
  assert.ok(p.x < 47 && Math.hypot(p.x - item.x, p.z - item.z) <= 1.6, JSON.stringify(p))
})

test('poste pickup : autre etage, absence appui, eau et chunks inconnus refuses', () => {
  const f = fixture()
  const post = new Vec3(3.5, 65, 0.5)
  assert.equal(itemInPickupRange(f.bot, post, new Vec3(3.7, 65, 0.5)), true)
  assert.equal(itemInPickupRange(f.bot, post, new Vec3(3.7, 63, 0.5)), false)
  // Boite de ramassage du jeu : un objet a +1 ou +2 est pris, pas a +2,4.
  assert.equal(itemInPickupRange(f.bot, post, new Vec3(3.7, 66, 0.5)), true)
  assert.equal(itemInPickupRange(f.bot, post, new Vec3(3.7, 67, 0.5)), true)
  assert.equal(itemInPickupRange(f.bot, post, new Vec3(3.7, 67.4, 0.5)), false)
  assert.equal(itemInPickupRange(f.bot, post, new Vec3(3.7, 64.2, 0.5)), false)
  const original = f.bot.blockAt
  for (const name of ['water', 'air', null]) {
    f.bot.blockAt = position => {
      if (position.y !== 64) return original(position)
      if (name === null) return null
      const block = Block.fromStateId(registry.blocksByName[name].defaultState, 0)
      block.position = position.floored()
      return block
    }
    assert.equal(itemInPickupRange(f.bot, post, new Vec3(3.7, 65, 0.5)), false)
  }
})

test('pickup chemin vide : recadrage vers centre valide, pas vers coordonnees objet', async t => {
  const f = fixture({ pickupEdge: true })
  t.after(f.close)
  f.bot.entity.position = new Vec3(44.02, 64, -105.02)
  f.startPhysics()
  const result = await createNavigator(() => f.bot, { timeoutMs: 3000 }).toPosition(new Vec3(45.8077, 64, -104.7511),
    { radius: 1.6, pickup: true })
  assert.equal(result.code, 'arrived', JSON.stringify(result))
  assert.deepEqual(f.traces[0].path, [])
  assert.ok(f.bot.entity.position.z < -105.02, 'movement toward the safe cell center, away from item z')
})

test('annulation du trajet pickup relache les controles sans succes', async t => {
  const f = fixture({ pickupEdge: true })
  t.after(f.close)
  f.startPhysics()
  const abort = new AbortController()
  f.bot.on('physicsTick', () => { if (!f.bot.entity.onGround) abort.abort() })
  const result = await createNavigator(() => f.bot, { timeoutMs: 3000 }).toPosition(new Vec3(45.8077, 64, -104.7511),
    { radius: 1.6, pickup: true, signal: abort.signal })
  assert.equal(abort.signal.aborted, true)
  assert.equal(result.code, 'cancelled')
  assert.equal(result.reached, false)
  assert.equal(Object.values(f.controls).some(Boolean), false)
})
