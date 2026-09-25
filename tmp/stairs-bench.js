'use strict'
// Banc local : temps pour monter un escalier de 3 marches (vrai A*, vraie physique).
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { pathfinder } = require('mineflayer-pathfinder')
const { Physics, PlayerState } = require('prismarine-physics')
const registry = require('prismarine-registry')('26.1')
const Block = require('prismarine-block')(registry)
const { createNavigator } = require('../bot/navigation')

function world (x, y, z) {
  if (Math.abs(z) > 6 || x < -4 || x > 20) return 'air'
  if (y <= 64) return 'stone'
  const top = x >= 6 ? 67 : x >= 3 ? 64 + (x - 2) : 64
  return y <= top ? 'dirt' : 'air'
}
async function run () {
  const bot = new EventEmitter()
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  const w = { getBlock: pos => { const p = pos.floored(); const b = Block.fromStateId(registry.blocksByName[world(p.x, p.y, p.z)].defaultState, 0); b.position = p; return b } }
  Object.assign(bot, { version: '26.1', registry, game: { minY: -64 }, entities: {},
    entity: { position: new Vec3(0.5, 65, 0.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true, effects: {}, attributes: {}, height: 1.8, width: 0.6 },
    inventory: { items: () => [], slots: [] }, controlState: controls, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    blockAt: w.getBlock,
    clearControlStates: () => { for (const k of Object.keys(controls)) controls[k] = false },
    setControlState: (k, v) => { controls[k] = v },
    look: async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch } })
  bot.physics = Physics(registry, w)
  pathfinder(bot)
  const timer = setInterval(() => { bot.physics.simulatePlayer(new PlayerState(bot, controls), w).apply(bot); bot.emit('physicsTick') }, 50)
  const nav = createNavigator(() => bot, { timeoutMs: 15000 })
  const t0 = Date.now()
  const r = await nav.toPosition(new Vec3(12.5, 68, 0.5), { radius: 0.5 })
  clearInterval(timer)
  console.log(r.code, ((Date.now() - t0) / 1000).toFixed(2) + ' s', bot.entity.position.toString())
}
run().then(run).then(run)
