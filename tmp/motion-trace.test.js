'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createMotionTrace } = require('../bot/motion-trace')
test('trace bornee, chronologique, controles et listener libere', () => {
  const bot = new EventEmitter()
  bot.entity = { position: { x: 0, y: 65, z: 0 }, yaw: 1, pitch: 0, onGround: true }
  bot.getControlState = key => key === 'forward'
  const t = createMotionTrace(bot, { limit: 3 })
  for (let i = 1; i <= 5; i++) { bot.entity.position.x = i; bot.emit('physicsTick') }
  t.stop('arrived')
  assert.equal(bot.listenerCount('physicsTick'), 0)
  const s = t.snapshot()
  assert.equal(s.samples.length, 3)
  assert.equal(s.totalSamples, 7)
  assert.equal(s.droppedSamples, 4)
  assert.deepEqual(s.samples.map(v => v.position[0]), [4, 5, 5])
  assert.deepEqual(s.samples[0].controls, ['forward'])
  assert.equal(s.outcome, 'arrived')
})
