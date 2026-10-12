'use strict'
// Casse confirmee par le serveur (bot/casse.js, piege 19) : mineflayer met le
// bloc a l air cote client des la fin de casse ; sans confirmation du serveur
// le bloc est remis et la casse echoue.
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { brancherCasse } = require('../bot/casse')

const FEUILLES = 250

// Faux bot : `interne` joue la fonction de blocks.js (paquets du serveur),
// `bot._updateBlockState` la meme fonction exposee, appelee par le dig de
// mineflayer pour sa prediction.
function fauxBot ({ serveur }) {
  const bot = new EventEmitter()
  const monde = new Map([['5,205,5', FEUILLES]])
  const interne = (pos, etat) => {
    const k = `${pos.x},${pos.y},${pos.z}`
    const ancien = { stateId: monde.get(k) ?? 0 }
    monde.set(k, etat)
    const neuf = { position: pos, stateId: etat, type: etat === 0 ? 0 : 1 }
    bot.emit('blockUpdate', ancien, neuf)
    bot.emit(`blockUpdate:${pos}`, ancien, neuf)
  }
  bot._updateBlockState = interne
  bot.blockAt = pos => ({ position: pos, name: 'oak_leaves', stateId: monde.get(`${pos.x},${pos.y},${pos.z}`) ?? 0 })
  bot.entity = { position: new Vec3(3.5, 205, 5.5), eyeHeight: 1.62, onGround: true }
  bot.dig = async function (block) {
    if (serveur === 'avant') interne(block.position, 0)
    if (serveur === 'apres') setTimeout(() => interne(block.position, 0), 20)
    if (serveur === 'renvoie') setTimeout(() => interne(block.position, FEUILLES), 20)
    // Prediction de mineflayer 4.39 (digging.js, finishDigging).
    bot._updateBlockState(block.position, 0)
  }
  return { bot, etat: () => monde.get('5,205,5') }
}

const bloc = bot => bot.blockAt(new Vec3(5, 205, 5))

test('casse confirmee par le serveur apres la prediction : faite', async () => {
  const { bot, etat } = fauxBot({ serveur: 'apres' })
  brancherCasse(bot, { attenteMs: 500 })
  await bot.dig(bloc(bot))
  assert.strictEqual(etat(), 0)
  assert.deepStrictEqual(bot.casse, { confirmees: 1, refusees: 0 })
})

test('casse confirmee avant la fin (casse instantanee) : faite sans attendre', async () => {
  const { bot, etat } = fauxBot({ serveur: 'avant' })
  brancherCasse(bot, { attenteMs: 5000 })
  const t0 = Date.now()
  await bot.dig(bloc(bot))
  assert.ok(Date.now() - t0 < 1000)
  assert.strictEqual(etat(), 0)
  assert.strictEqual(bot.casse.confirmees, 1)
})

test('serveur muet : bloc remis cote client et casse en echec', async () => {
  const { bot, etat } = fauxBot({ serveur: 'muet' })
  brancherCasse(bot, { attenteMs: 100 })
  await assert.rejects(bot.dig(bloc(bot)), /casse refusee par le serveur/)
  assert.strictEqual(etat(), FEUILLES)
  assert.deepStrictEqual(bot.casse, { confirmees: 0, refusees: 1 })
})

test('la fonction de prediction est rendue apres la casse', async () => {
  const { bot } = fauxBot({ serveur: 'muet' })
  const avant = bot._updateBlockState
  brancherCasse(bot, { attenteMs: 50 })
  await bot.dig(bloc(bot)).catch(() => {})
  assert.strictEqual(bot._updateBlockState, avant)
  assert.strictEqual(bot.listenerCount('blockUpdate:(5, 205, 5)'), 0)
})

test('serveur qui renvoie le bloc : casse en echec, bloc du serveur garde', async () => {
  const { bot, etat } = fauxBot({ serveur: 'renvoie' })
  brancherCasse(bot, { attenteMs: 500 })
  await assert.rejects(bot.dig(bloc(bot)), /casse refusee par le serveur/)
  assert.strictEqual(etat(), FEUILLES)
  assert.deepStrictEqual(bot.casse, { confirmees: 0, refusees: 1 })
})
