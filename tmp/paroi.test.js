'use strict'
// Jamais au contact exact d une paroi (bot/paroi.js, piege 20) : le serveur
// refuse un pas qui met la boite du bot pile contre la face d un bloc.
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { brancherParoi, ecartAxe } = require('../bot/paroi')

// Coin de haie de skill/hedge-pit : feuilles en (25, 205..206, 26), sol plein.
function fauxBot (pleins) {
  const bot = new EventEmitter()
  bot.blockAt = p => ({ boundingBox: p.y < 205 || pleins.has(`${p.x},${p.y},${p.z}`) ? 'block' : 'empty' })
  return bot
}
const HAIE = new Set(['25,205,26', '25,206,26'])

test('contact exact avec la face d une feuille : ecarte d un millimetre', () => {
  const bot = fauxBot(HAIE)
  assert.strictEqual(ecartAxe(bot, new Vec3(25.79, 205, 25.7), 'z'), -0.001)
  assert.strictEqual(ecartAxe(bot, new Vec3(25.79, 205, 25.7), 'x'), 0)
})

test('face basse et autre axe', () => {
  const bot = fauxBot(new Set(['24,205,10']))
  assert.strictEqual(ecartAxe(bot, new Vec3(25.3, 205, 10.5), 'x'), 0.001)
})

test('pas de bloc derriere la face, ou boite qui ne touche pas : rien', () => {
  const bot = fauxBot(HAIE)
  assert.strictEqual(ecartAxe(bot, new Vec3(26.4, 205, 25.7), 'z'), 0)
  assert.strictEqual(ecartAxe(bot, new Vec3(25.79, 205, 25.69), 'z'), 0)
})

test('plugin : le pas de physique laisse un millimetre avant l envoi', () => {
  const bot = fauxBot(HAIE)
  bot.entity = { position: new Vec3(25.79, 205, 25.7), isCollidedHorizontally: true }
  brancherParoi(bot)
  bot.emit('physicsTick')
  assert.ok(Math.abs(bot.entity.position.z - 25.699) < 1e-9)
  assert.strictEqual(bot.paroi.ecartes, 1)
})
