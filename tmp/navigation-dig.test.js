'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')

// Mode creuser du navigateur partage (interrupteur nav_creuse) : le calcul
// donne un pas qui traverse un bloc (toBreak), l execution le casse puis
// avance. Terrain et mouvement simules, code du navigateur reel.
function fixture ({ wall = true } = {}) {
  class V {
    constructor (x, y, z) { Object.assign(this, { x, y, z }) }
    clone () { return new V(this.x, this.y, this.z) }
    distanceTo (p) { return Math.hypot(this.x - p.x, this.y - p.y, this.z - p.z) }
  }
  class Movements {
    constructor () { this.blocksToAvoid = new Set(); this.blocksCantBreak = new Set() }
    getBlock () { return { name: 'air', safe: false, physical: true } }
  }
  class GoalNear { constructor (x, y, z) { Object.assign(this, { x, y, z }) } }
  const scope = { module: { exports: {} }, setTimeout, Date,
    require: name => name === './motion-trace' ? require('../bot/motion-trace') : ({ Movements, goals: { GoalNear } }) }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../bot/navigation.js'), 'utf8'), scope)
  const solid = new Set(wall ? ['2,0,0', '2,1,0'] : [])
  let yaw = 0
  const state = { plans: 0, movements: null }
  const bot = {
    entity: { position: new V(0.5, 0, 0.5), onGround: true },
    registry: { blocksByName: {} },
    blockAt: p => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      return solid.has(k)
        ? { name: 'dirt', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], position: new V(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
        : { name: 'air', boundingBox: 'empty', shapes: [] }
    },
    players: {},
    clearControlStates: () => {},
    setControlState: (k, v) => {
      if (k !== 'forward' || !v) return
      const nx = bot.entity.position.x - Math.sin(yaw) * 0.25
      const nz = bot.entity.position.z - Math.cos(yaw) * 0.25
      if (!solid.has(`${Math.floor(nx)},0,${Math.floor(nz)}`)) {
        bot.entity.position.x = nx
        bot.entity.position.z = nz
      }
    },
    look: async value => { yaw = value },
    pathfinder: {
      setGoal: () => {},
      getPathFromTo: function * (movements) {
        state.plans++
        state.movements = movements
        const traverse = [new V(2, 0, 0), new V(2, 1, 0)].filter(c => solid.has(`${c.x},${c.y},${c.z}`))
        yield { result: { status: 'success', path: [
          Object.assign(new V(1, 0, 0), { toBreak: [], toPlace: [] }),
          Object.assign(new V(2, 0, 0), { toBreak: traverse, toPlace: [] }),
          Object.assign(new V(3, 0, 0), { toBreak: [], toPlace: [] })
        ] } }
      }
    }
  }
  return { bot, solid, state, createNavigator: scope.module.exports.createNavigator }
}

test('mode creuser : le bloc du pas est casse puis le bot avance jusqu au but', async () => {
  const f = fixture()
  const casses = []
  const nav = f.createNavigator(() => f.bot, { timeoutMs: 3000 })
  const r = await nav.toPosition({ x: 3.5, y: 0, z: 0.5 }, { radius: 0.5, dig: {
    cantBreak: [7],
    canBreak: () => true,
    digBlock: async b => { casses.push(`${b.position.x},${b.position.y},${b.position.z}`); f.solid.delete(`${b.position.x},${b.position.y},${b.position.z}`); return true }
  } })
  assert.equal(r.code, 'arrived', JSON.stringify(r))
  assert.deepEqual(casses, ['2,0,0', '2,1,0'])
  assert.equal(f.state.movements.canDig, true)
  assert.ok(f.state.movements.blocksCantBreak.has(7))
})

test('mode creuser : casse refusee, la case est exclue et jamais cassee', async () => {
  const f = fixture()
  let essais = 0
  const nav = f.createNavigator(() => f.bot, { timeoutMs: 600 })
  const r = await nav.toPosition({ x: 3.5, y: 0, z: 0.5 }, { radius: 0.5, dig: {
    canBreak: () => false,
    digBlock: async () => { essais++; return true }
  } })
  assert.equal(r.reached, false)
  assert.notEqual(r.code, 'unsupported_move')
  assert.equal(essais, 0)
  assert.ok(f.state.plans >= 2, 'replanifie apres le refus')
})

test('sans mode creuser : un pas a casser reste un mouvement non supporte', async () => {
  const f = fixture()
  const r = await f.createNavigator(() => f.bot, { timeoutMs: 1000 }).toPosition({ x: 3.5, y: 0, z: 0.5 }, { radius: 0.5 })
  assert.equal(r.code, 'unsupported_move')
  assert.equal(f.state.movements.canDig, false)
})
