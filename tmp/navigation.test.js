'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')

// Simule le terrain et le mouvement, pas le code du navigateur. Aucun reseau.
function fixture ({ mobile = true, target = [4, 0, 0], pathStatus = 'success', emptyPath = false } = {}) {
  class V {
    constructor (x, y, z) { Object.assign(this, { x, y, z }) }
    clone () { return new V(this.x, this.y, this.z) }
    distanceTo (p) { return Math.hypot(this.x - p.x, this.y - p.y, this.z - p.z) }
  }
  class Movements {
    constructor () { this.blocksToAvoid = new Set() }
    // Bloc vu par le calcul : Movements.next (nom), plein et non traversable.
    getBlock () { return { name: Movements.next ?? 'air', safe: false, physical: true } }
  }
  class GoalNear { constructor (x, y, z) { Object.assign(this, { x, y, z }) } }
  const scope = { module: { exports: {} }, setTimeout, Date,
    require: name => name === './motion-trace' ? require('../bot/motion-trace') : ({ Movements, goals: { GoalNear } }) }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../bot/navigation.js'), 'utf8'), scope)
  const controls = {}
  let yaw = 0
  let plans = 0
  const bot = {
    entity: { position: new V(0, 0, 0), onGround: true },
    registry: { blocksByName: {} },
    blockAt: () => ({ name: 'air', shapes: [] }),
    players: { human: { entity: { position: new V(...target) } } },
    clearControlStates: () => { for (const k of Object.keys(controls)) controls[k] = false },
    setControlState: (k, v) => {
      controls[k] = v
      if (mobile && k === 'forward' && v) {
        bot.entity.position.x -= Math.sin(yaw) * 0.25
        bot.entity.position.z -= Math.cos(yaw) * 0.25
      }
    },
    look: async value => { yaw = value },
    pathfinder: {
      setGoal: () => {},
      getPathFromTo: function * (movements, start, goal) {
        plans++
        yield { result: { status: pathStatus, path: pathStatus === 'success' && !emptyPath ? [new V(goal.x, goal.y, goal.z)] : [] } }
      }
    }
  }
  return { bot, controls, Movements, get plans () { return plans }, ...scope.module.exports }
}

test('arrivee reelle, sans succes a un autre etage', () => {
  const f = fixture()
  assert.equal(f.arrived({ x: 0, y: 0, z: 0 }, { x: 0, y: 3, z: 0 }), false)
  assert.equal(f.arrived({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }), true)
})
test('chemin calcule puis arrivee mesuree et touches relachees', async () => {
  const f = fixture()
  const nav = f.createNavigator(() => f.bot)
  const r = await nav.toPlayer('human')
  assert.equal(r.code, 'arrived')
  assert.equal(r.reached, true)
  assert.equal(f.plans, 1)
  assert.equal(Object.values(f.controls).some(Boolean), false)
})
test('path success sans deplacement ne vaut pas arrivee', async () => {
  const f = fixture({ mobile: false })
  const r = await f.createNavigator(() => f.bot, { timeoutMs: 100 }).toPlayer('human')
  assert.equal(r.code, 'timeout')
  assert.equal(r.reached, false)
})
test('absence de chemin et joueur perdu ont des codes distincts', async () => {
  const f = fixture({ pathStatus: 'noPath' })
  const nav = f.createNavigator(() => f.bot, { targetLostMs: 0 })
  assert.equal((await nav.toPlayer('human')).code, 'no_path')
  delete f.bot.players.human.entity
  assert.equal((await nav.toPlayer('human')).code, 'target_lost')
})
test('annulation pendant la marche relache toutes les touches', async () => {
  const f = fixture({ mobile: false })
  const nav = f.createNavigator(() => f.bot)
  const abort = new AbortController()
  const pending = nav.toPlayer('human', { signal: abort.signal })
  setTimeout(() => abort.abort(), 30)
  assert.equal((await pending).code, 'cancelled')
  assert.equal(nav.isActive(), false)
  assert.equal(Object.values(f.controls).some(Boolean), false)
})
test('cible mobile : recalcule le chemin', async () => {
  const f = fixture({ mobile: false })
  const nav = f.createNavigator(() => f.bot, { timeoutMs: 200 })
  setTimeout(() => { f.bot.players.human.entity.position.z += 3 }, 30)
  await nav.toPlayer('human')
  assert.ok(f.plans >= 2)
})

test('un mur entre le joueur et le bot interdit une arrivee par le rayon seul', async () => {
  const f = fixture({ mobile: false, target: [1.8, 0, 0], pathStatus: 'noPath' })
  f.bot.blockAt = p => p.x === 1 ? { name: 'stone', shapes: [[0, 0, 0, 1, 1, 1]] } : { name: 'air', shapes: [] }
  assert.equal((await f.createNavigator(() => f.bot).toPlayer('human')).reached, false)
})
test('retour a une position fixe et suivi borne', async () => {
  const f = fixture({ target: [0, 0, 0] })
  const nav = f.createNavigator(() => f.bot)
  assert.equal((await nav.toPosition({ x: 0, y: 0, z: 0 }, { radius: 0.6 })).reached, true)
  assert.equal((await nav.toPlayer('human', { follow: true, durationMs: 100 })).code, 'followed')
})
test('chemin vide au bord de la case : ajustement physique avant succes', async () => {
  const f = fixture({ emptyPath: true, target: [2.1, 0, 0] })
  assert.equal((await f.createNavigator(() => f.bot).toPlayer('human')).reached, true)
  assert.ok(f.bot.entity.position.x > 0)
})
test('depart au bord des feuilles : trajet reel sans couper le coin', async () => {
  const f = fixture({ target: [184.5, 65, -102.5] })
  Object.assign(f.bot.entity.position, { x: 180.4066, y: 65, z: -99.2592 })
  f.bot.blockAt = p => p.y === 64 || (p.x === 181 && p.z === -99 && p.y >= 66)
    ? { name: 'stone', shapes: [[0, 0, 0, 1, 1, 1]] } : { name: 'air', shapes: [] }
  const set = f.bot.setControlState
  f.bot.setControlState = (k, value) => {
    const before = f.bot.entity.position.clone()
    set(k, value)
    if (!f.clearSegment(f.bot, before, f.bot.entity.position)) Object.assign(f.bot.entity.position, before)
  }
  f.bot.pathfinder.getPathFromTo = function * (movements, start, goal, opts) {
    // Sans cela, les resultats PARTIAL du plugin mutent ses propres noeuds A*.
    assert.equal(opts.optimizePath, false)
    const path = [{ x: 181, y: 65, z: -100 }, { x: 182, y: 65, z: -100 },
      { x: 183, y: 65, z: -100 }, { x: 183, y: 65, z: -101 }, { x: 183, y: 65, z: -102 }]
    const original = JSON.stringify(path)
    yield { result: { status: 'partial', path } }
    assert.equal(JSON.stringify(path), original)
    yield { result: { status: 'success', path } }
  }
  const nav = f.createNavigator(() => f.bot, { timeoutMs: 3000 })
  const result = await nav.toPlayer('human')
  assert.equal(result.reached, true, JSON.stringify({ result, position: f.bot.entity.position, events: nav.trace().events }))
})
test('immobilite a plat : recalcul, jamais de saut reflexe', async () => {
  const f = fixture({ mobile: false })
  const inputs = []
  const set = f.bot.setControlState
  f.bot.setControlState = (key, value) => { inputs.push([key, value]); set(key, value) }
  await f.createNavigator(() => f.bot, { timeoutMs: 2200 }).toPlayer('human')
  assert.ok(f.plans >= 2)
  assert.equal(inputs.some(([key, value]) => key === 'jump' && value), false)
})
test('saut de marche : impulsion unique relachee avant de reprendre la marche', async () => {
  const f = fixture({ target: [2.5, 1, 0.5] })
  const inputs = []
  const set = f.bot.setControlState
  f.bot.setControlState = (key, value) => {
    inputs.push([key, value])
    set(key, value)
    if (key === 'jump' && value) f.bot.entity.position.y = 1
  }
  const result = await f.createNavigator(() => f.bot, { timeoutMs: 2000 }).toPlayer('human')
  assert.equal(result.reached, true)
  const jump = inputs.findIndex(([key, value]) => key === 'jump' && value)
  assert.ok(jump >= 0)
  assert.deepEqual(inputs[jump + 1], ['jump', false])
  assert.equal(inputs.filter(([key, value]) => key === 'jump' && value).length, 1)
})
test('chemin deja libre : pas de demi-tour pour recentrer puis repartir', async () => {
  for (const ledge of [false, true]) {
  const f = fixture({ target: [186.5, 67, -108.5] })
  Object.assign(f.bot.entity.position, { x: 186.5154, y: 67, z: -104.7771 })
  f.bot.blockAt = p => p.y === 66 && (!ledge || p.z <= -106) ? { name: 'stone', shapes: [[0, 0, 0, 1, 1, 1]] } : { name: 'air', shapes: [] }
  f.bot.pathfinder.getPathFromTo = function * () {
    yield { result: { status: 'success', path: [{ x: 186, y: 67, z: -106 }, { x: 186, y: 67, z: -107 }] } }
  }
  const angles = []
  const look = f.bot.look
  f.bot.look = async yaw => { angles.push(yaw); await look(yaw) }
  assert.equal((await f.createNavigator(() => f.bot).toPlayer('human')).reached, true)
  assert.ok(angles.every(yaw => Math.abs(yaw) < Math.PI / 2))
  }
})

test('interaction : poste libre avec appui et ligne de vue, jamais le centre du bloc solide', () => {
  const f = fixture()
  const feet = { x: 0.5, y: 1, z: 0.5 }
  const target = { x: 3.5, y: 1.5, z: 0.5 }
  let wall = false
  let floor = true
  f.bot.blockAt = p => (floor && p.y === 0) || (p.x === 3 && p.y === 1) || (wall && p.x === 1 && p.y >= 1)
    ? { name: 'stone', shapes: [[0, 0, 0, 1, 1, 1]] } : { name: 'air', shapes: [] }
  assert.equal(f.blockInReach(f.bot, feet, target), true)
  assert.equal(f.blockInReach(f.bot, target, target), false)
  wall = true
  assert.equal(f.blockInReach(f.bot, feet, target), false)
  wall = false; floor = false
  assert.equal(f.blockInReach(f.bot, feet, target), false)
})

test('budget de trajet : progression partielle explicite, jamais arrivee inventee', async () => {
  const f = fixture({ target: [20, 0, 0] })
  const r = await f.createNavigator(() => f.bot).toPlayer('human', { distanceBudget: 1 })
  assert.equal(r.code, 'advanced')
  assert.equal(r.reached, false)
  assert.ok(r.travelled >= 1 && r.travelled <= 1.3)
  assert.equal(Object.values(f.controls).some(Boolean), false)
})

test('timeout par trajet ne laisse pas tourner la collecte indefiniment', async () => {
  const f = fixture({ mobile: false })
  const r = await f.createNavigator(() => f.bot).toPlayer('human', { timeoutMs: 60 })
  assert.equal(r.code, 'timeout')
  assert.equal(r.reached, false)
})

test('annulation puis nouveau trajet : aucune touche relachee par l ancienne execution', async () => {
  const f = fixture({ mobile: false })
  const nav = f.createNavigator(() => f.bot)
  const first = nav.toPlayer('human')
  const second = nav.toPosition({ x: 0, y: 0, z: 0 })
  assert.equal((await first).code, 'cancelled')
  assert.equal((await second).code, 'arrived')
  assert.equal(nav.status().code, 'arrived')
})

// Une porte en bois se traverse comme un joueur : le calcul la tient pour un
// passage, le bot l ouvre avant d y entrer (bot enferme dans sa cabane,
// composite/cabin-from-scratch 7d76b18). Une porte de fer reste un mur.
test('porte en bois : traversee par le calcul, porte de fer : mur', async () => {
  const f = fixture()
  const seen = {}
  f.bot.pathfinder.getPathFromTo = function * (movements, start, goal) {
    for (const name of ['oak_door', 'spruce_door', 'iron_door', 'stone']) {
      f.Movements.next = name
      const b = movements.getBlock({ x: 0, y: 0, z: 0 }, 0, 0, 0)
      seen[name] = b.safe && !b.physical
    }
    f.Movements.next = null
    yield { result: { status: 'success', path: [{ x: goal.x, y: goal.y, z: goal.z }] } }
  }
  await f.createNavigator(() => f.bot).toPlayer('human')
  assert.deepEqual(seen, { oak_door: true, spruce_door: true, iron_door: false, stone: false })
})

test('porte fermee sur le chemin : ouverte une fois avant d y entrer', async () => {
  const f = fixture({ target: [4.5, 0, 0.5] })
  Object.assign(f.bot.entity.position, { x: 0.5, y: 0, z: 0.5 })
  const door = { open: false }
  const activated = []
  f.bot.blockAt = p => {
    const position = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
    if (position.x === 2 && position.z === 0 && (position.y === 0 || position.y === 1)) {
      return { name: 'oak_door', position, shapes: door.open ? [] : [[0, 0, 0, 1, 1, 0.1875]], getProperties: () => ({ open: door.open }) }
    }
    return { name: 'air', position, shapes: [] }
  }
  f.bot.activateBlock = async block => { activated.push(block.position); door.open = true }
  f.bot.pathfinder.getPathFromTo = function * () {
    yield { result: { status: 'success', path: [{ x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }] } }
  }
  const nav = f.createNavigator(() => f.bot, { timeoutMs: 3000 })
  const result = await nav.toPlayer('human')
  assert.equal(result.reached, true, JSON.stringify(result))
  assert.deepEqual(activated, [{ x: 2, y: 0, z: 0 }])
  assert.ok(nav.trace().events.some(e => e.event === 'door_opened'))
})
