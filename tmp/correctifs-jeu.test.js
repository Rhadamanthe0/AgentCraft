'use strict'
// Correctifs des donnees du jeu et du pathfinder en 26.1 (bot/correctifs-jeu.js).
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { Movements, goals } = require('mineflayer-pathfinder')
const { createSimServer, registry } = require('./sim-server')
const Block = require('prismarine-block')(registry)
const { brancherCorrectifs, lianesGrimpables } = require('../bot/correctifs-jeu')

const duree = (bloc, outil) => Block.fromStateId(registry.blocksByName[bloc].defaultState, 0)
  .digTime(outil ? registry.itemsByName[outil].id : null, false, false, false)

test('minerais : la pioche compte, comme au serveur', () => {
  // Donnees brutes : toute pioche en pierre ou en fer comptee comme la main.
  const avant = duree('iron_ore', 'stone_pickaxe')
  brancherCorrectifs({ registry })
  brancherCorrectifs({ registry })
  assert.ok(avant > duree('iron_ore', 'stone_pickaxe'), `avant ${avant} ms`)
  // Temps du jeu : durete x 1,5 / vitesse de l outil, arrondi au tick superieur.
  assert.equal(duree('iron_ore', 'stone_pickaxe'), 1150)
  assert.equal(duree('diamond_ore', 'iron_pickaxe'), 750)
  assert.equal(duree('obsidian', 'diamond_pickaxe'), 9400)
  // Sans l outil exige, toujours lent (x 5), et rien d autre ne change.
  assert.equal(duree('iron_ore', 'wooden_pickaxe'), 7500)
  assert.equal(duree('stone', 'stone_pickaxe'), 600)
  assert.equal(duree('oak_log', 'stone_axe'), 750)
})

async function grimper (avecLianes) {
  const blocks = {}
  for (let z = -3; z <= 3; z++) for (let y = 200; y <= 203; y++) blocks[`3,${y},${z}`] = 'stone'
  for (let y = 200; y <= 203; y++) blocks[`2,${y},0`] = 'vine'
  const sim = createSimServer({ blocks, start: new Vec3(0.5, 200, 0.5), borne: { x0: -4, x1: 6, z0: -4, z1: 4 } })
  const bot = sim.bot
  try {
    await new Promise(resolve => setTimeout(resolve, 200))
    const m = new Movements(bot)
    m.canDig = false; m.allow1by1towers = false; m.allowParkour = false
    if (avecLianes) lianesGrimpables(m, registry)
    bot.pathfinder.setMovements(m)
    const delai = setTimeout(() => bot.pathfinder.setGoal(null), 20000)
    try {
      await bot.pathfinder.goto(new goals.GoalBlock(3, 204, 0))
      return { ok: true, y: bot.entity.position.y }
    } catch (e) {
      return { ok: false, erreur: e.message }
    } finally {
      clearTimeout(delai)
    }
  } finally {
    sim.close()
  }
}

test('mur de 4 blocs couvert de lianes : grimpe sans creuser ni poser', async () => {
  const sans = await grimper(false)
  assert.equal(sans.ok, false)
  const avec = await grimper(true)
  assert.ok(avec.ok, avec.erreur)
  assert.equal(Math.floor(avec.y), 204)
})
