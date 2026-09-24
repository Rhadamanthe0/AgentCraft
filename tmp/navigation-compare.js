'use strict'
const { bot, stop } = require('./probe-bot')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { createNavigator } = require(process.env.NAV_MODULE || '/app/navigation')
const http = require('node:http')
bot.loadPlugin(pathfinder)
const nav = createNavigator(() => bot)
let result = null
const events = []
bot.on('path_update', r => events.push({ status: r.status, length: r.path.length }))
const server = http.createServer(async (req, res) => {
  try {
    let raw = ''
    for await (const c of req) raw += c
    const b = raw ? JSON.parse(raw) : {}
    let out
    if (req.url === '/control') {
      nav.cancel(); bot.pathfinder.setGoal(null); bot.clearControlStates()
      if (b.yaw != null) await bot.look(b.yaw, 0, true)
      const before = bot.entity.position.clone()
      bot.setControlState('forward', true)
      await new Promise(r => setTimeout(r, b.ms || 4000))
      bot.clearControlStates()
      out = { before, after: bot.entity.position, moved: before.distanceTo(bot.entity.position) }
    } else if (req.url === '/native') {
      nav.cancel(); bot.pathfinder.setGoal(null); bot.clearControlStates()
      const m = new Movements(bot)
      m.canDig = false; m.allow1by1towers = false; m.allowParkour = false; m.allowSprinting = false; m.maxDropDown = 2
      for (const n of ['water', 'lava', 'bubble_column']) if (bot.registry.blocksByName[n]) m.blocksToAvoid.add(bot.registry.blocksByName[n].id)
      bot.pathfinder.setMovements(m)
      const before = bot.entity.position.clone()
      bot.pathfinder.setGoal(new goals.GoalNear(b.x, b.y, b.z, b.radius || 1))
      await new Promise(r => setTimeout(r, b.ms || 12000))
      bot.pathfinder.setGoal(null); bot.clearControlStates()
      out = { before, after: bot.entity.position, moved: before.distanceTo(bot.entity.position), events: events.splice(0) }
    } else if (req.url === '/navigate') {
      result = await nav.toPosition(b, b.options || {})
      out = { result, position: bot.entity.position, trace: nav.trace() }
    } else if (req.url === '/blocks') {
      out = []
      for (let x = b.x - b.r; x <= b.x + b.r; x++) for (let z = b.z - b.r; z <= b.z + b.r; z++) {
        for (let y = b.y - 5; y <= b.y + 5; y++) {
          const block = bot.blockAt(new Vec3(x, y, z))
          if (block && block.name !== 'air') out.push({ x,y,z,name: block.name, shapes: block.shapes })
        }
      }
    } else if (req.url === '/stop') { nav.cancel(); bot.pathfinder.setGoal(null); bot.clearControlStates(); out = { ok: true } }
    else out = { position: bot.entity?.position, onGround: bot.entity?.onGround, result, nav: nav.status(), controls: bot.controlState }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(out))
  } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })) }
})
bot.once('spawn', () => server.listen(3102, '127.0.0.1', () => console.log('[compare] ready')))
bot.once('end', () => { nav.cancel(); server.close(); stop(0, 'end') })
