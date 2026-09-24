'use strict'

// Reutilise le template silencieux et son arret borne. Copier le template a
// /tmp/probe-bot.js, ce scenario a /tmp/h1.js, navigation a /tmp/navigation.js.
const { bot, stop } = require('./probe-bot')
const { pathfinder } = require('mineflayer-pathfinder')
const { createNavigator } = require('./navigation')
const { Vec3 } = require('vec3')
bot.loadPlugin(pathfinder)
bot.once('spawn', () => {
  // Laisser le temps au RCON de positionner uniquement le harness.
  setTimeout(async () => {
    const before = bot.entity.position.clone()
    for (let x = 180; x <= 182; x++) for (let z = -100; z <= -98; z++) {
      console.log(JSON.stringify({ x, z, blocks: [64, 65, 66, 67].map(y => {
        const b = bot.blockAt(new Vec3(x, y, z))
        return { y, name: b?.name, shapes: b?.shapes }
      }) }))
    }
    const destination = new Vec3(184.5, 65, -102.5)
    bot.players.NavigationTarget = { entity: { position: destination } }
    const nav = createNavigator(() => bot, { trace: value => console.log(JSON.stringify(value)) })
    let maxY = before.y
    const trace = setInterval(() => {
      maxY = Math.max(maxY, bot.entity.position.y)
      console.log(JSON.stringify({ position: bot.entity.position, onGround: bot.entity.onGround, controls: bot.controlState }))
    }, 1000)
    try {
      const result = await nav.toPlayer('NavigationTarget')
      console.log(JSON.stringify({ before, destination, result, after: bot.entity.position, maxY }))
      stop(result.reached ? 0 : 1, result.code)
    } catch (err) {
      console.error(err)
      stop(1, err.message)
    } finally {
      clearInterval(trace)
      nav.cancel()
    }
  }, 15000)
})
