'use strict'

// Reuse the project's silent, non-op probe lifecycle.
const { bot, stop } = require('../tmp/probe-bot')
const { pathfinder } = require('mineflayer-pathfinder')
const { createNavigator } = require('../bot/navigation')
const http = require('node:http')
bot.loadPlugin(pathfinder)
const nav = createNavigator(() => bot)
let ready = false
let busy = false
bot.once('spawn', async () => {
  await bot.waitForChunksToLoad()
  ready = true
})
const state = () => ({ ready, position: bot.entity?.position, onGround: bot.entity?.onGround,
  controls: Object.keys(bot.controlState).filter(k => bot.controlState[k]) })
const server = http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json')
  try {
    if (req.url === '/state') return res.end(JSON.stringify(state()))
    if (req.url !== '/navigate' || req.method !== 'POST') {
      res.statusCode = 404
      return res.end('{}')
    }
    if (!ready || busy) throw new Error('Harness not ready or busy')
    busy = true
    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > 4096) throw new Error('Request too large')
    }
    const { target, abortAfterMs } = JSON.parse(raw)
    const controller = new AbortController()
    let abortedAt = null
    const timer = abortAfterMs == null ? null : setTimeout(() => {
      abortedAt = Date.now()
      controller.abort()
    }, abortAfterMs)
    const before = state()
    const started = Date.now()
    try {
      const result = await nav.toPosition(target, { radius: 0.8, timeoutMs: 15000, signal: controller.signal })
      const ended = Date.now()
      await new Promise(resolve => setTimeout(resolve, 300))
      const after = state()
      res.end(JSON.stringify({ result, before, after, elapsedMs: ended - started,
        finalDistanceXZ: Math.hypot(after.position.x - target.x, after.position.z - target.z),
        finalDeltaY: Math.abs(after.position.y - target.y),
        abortLatencyMs: abortedAt == null ? null : ended - abortedAt, trace: nav.trace() }))
    } finally { clearTimeout(timer); nav.cancel() }
  } catch (error) {
    res.statusCode = 500
    res.end(JSON.stringify({ error: error.message }))
  } finally { busy = false }
})
server.listen(3101, '127.0.0.1')
bot.once('end', () => { ready = false; server.close(); stop(1, 'disconnected') })
