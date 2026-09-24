'use strict'

// Journal borne des ticks REELS de physique (~50 ms). Aucun timer artificiel
// a 10 ms qui enregistrerait cinq fois la meme simulation. Pas d IO dans le tick.
function createMotionTrace (bot, { limit = 2400, label = null } = {}) {
  const started = Date.now()
  const buffer = new Array(limit)
  let count = 0
  let point = null
  let ended = null
  let outcome = null
  const events = []
  const rounded = n => Number.isFinite(n) ? Number(n.toFixed(4)) : null
  const vector = p => p ? [rounded(p.x), rounded(p.y), rounded(p.z)] : null
  function sample () {
    const e = bot.entity
    if (!e) return
    buffer[count % limit] = { t: Date.now() - started, position: vector(e.position),
      yaw: rounded(e.yaw), pitch: rounded(e.pitch), velocity: vector(e.velocity),
      onGround: Boolean(e.onGround), point,
      controls: ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].filter(k => bot.getControlState?.(k)) }
    count++
  }
  function event (value) {
    events.push({ t: Date.now() - started, ...value })
    if (events.length > 64) events.shift()
  }
  function stop (result) {
    if (ended !== null) return
    bot.removeListener?.('physicsTick', sample)
    sample()
    ended = Date.now()
    outcome = result
    event({ event: 'finished', result })
  }
  bot.on?.('physicsTick', sample)
  sample()
  return { event, stop, target: p => { point = vector(p) },
    snapshot: () => ({ label, startedAt: new Date(started).toISOString(), endedAt: ended && new Date(ended).toISOString(),
      cadence: 'physicsTick (~50 ms)', totalSamples: count, droppedSamples: Math.max(0, count - limit), outcome,
      events: events.slice(), samples: Array.from({ length: Math.min(count, limit) }, (_, i) => buffer[(Math.max(0, count - limit) + i) % limit]) }) }
}

module.exports = { createMotionTrace }
