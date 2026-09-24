'use strict'
// Serveur de test LOCAL au conteneur, jamais une commande admin du bot.
// Copie : bot/ -> /tmp/arena-app ; probe-bot.js et ce fichier dans /tmp/.
const { bot, stop } = require('./probe-bot')
const { pathfinder } = require('mineflayer-pathfinder')
const appRoot = process.env.ARENA_APP || './arena-app'
const { createNavigator } = require(`${appRoot}/navigation`)
const { createMissionRunner } = require(`${appRoot}/mission`)
const { createConversation } = require(`${appRoot}/conversation`)
const planner = require(`${appRoot}/planner`)
const http = require('node:http')
bot.loadPlugin(pathfinder)
const nav = createNavigator(() => bot, { trace: value => console.log(JSON.stringify(value)) })
const messages = []
const runner = createMissionRunner({ getBot: () => bot, isReady: () => Boolean(bot.entity),
  stopPathfinding: () => { nav.cancel(); bot.pathfinder.setGoal(null) }, inLiquid: () => bot.entity.isInWater,
  chat: text => messages.push(text), recentChat: () => [],
  navigateToPlayer: (name, opts) => nav.toPlayer(name, opts),
  navigateToPosition: (pos, opts) => nav.toPosition(pos, opts) })
const talk = createConversation({ status: runner.status, interpret: planner.interpretMessage,
  cancelPendingStart: runner.cancelPendingStart, start: runner.start, revise: runner.revise,
  context: runner.addContext, say: text => messages.push(text), stop: () => runner.stop(),
  observation: () => ({ position: bot.entity.position, navigation: nav.status() }) })
const server = http.createServer(async (req, res) => {
  try {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    let result
    if (req.url === '/mission' && req.method === 'POST') result = await runner.start(body.objective, 'TestProbe2')
    else if (req.url === '/instruction' && req.method === 'POST') result = await talk.receive('TestProbe2', body.message)
    else if (req.url === '/stop') { talk.cancel(); result = runner.stop() }
    else if (req.url === '/trace') result = nav.trace()
    else if (req.url === '/traces') result = nav.traces()
    else result = { mission: runner.status(), position: bot.entity?.position, navigation: nav.status(), messages,
      controls: ['forward', 'back', 'left', 'right', 'jump', 'sprint'].filter(k => bot.getControlState(k)) }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(result))
  } catch (err) { res.statusCode = 500; res.end(JSON.stringify({ error: err.message })) }
})
bot.once('spawn', () => server.listen(3101, '127.0.0.1', () => console.log('[arena] ready')))
bot.once('end', () => { runner.stop(); server.close(); stop(0, 'arena end') })
