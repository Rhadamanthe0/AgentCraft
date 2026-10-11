'use strict'
// But « bloc en vue » du trajet qui creuse (bot/but-bloc.js) sur le vrai A* de
// mineflayer-pathfinder 2.4.5 et un vrai monde 26.1 : arbre de trois buches au
// fond d un trou de cinq, coiffe de feuilles, bot sur le bord. Avec
// GoalLookAtBlock, la buche du haut (deux blocs au-dessus des pieds possibles)
// n etait a portee d aucun poste : A* jusqu au delai, « no_path » au banc
// (terrain/far-hedge-pit, 2026-10-11).
const test = require('node:test')
const assert = require('node:assert')
const EventEmitter = require('events')
const Vec3 = require('vec3').Vec3
const registry = require('prismarine-registry')('26.1')
const Chunk = require('prismarine-chunk')(registry)
const World = require('prismarine-world')(registry)
const { Movements, goals } = require('mineflayer-pathfinder')
const AStar = require('mineflayer-pathfinder/lib/astar')
const Move = require('mineflayer-pathfinder/lib/move')
const { GoalBlocEnVue } = require('../bot/but-bloc')
const perception = require('../bot/perception')

const MIN_Y = -64
const HEIGHT = 384

function monde () {
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot.registry = registry
  bot.version = '26.1'
  require('mineflayer/lib/plugins/blocks.js')(bot, { version: '26.1', hideErrors: true })
  bot.game = { minY: MIN_Y, height: HEIGHT, gameMode: 'survival' }
  bot.world = new World(null).sync
  bot.inventory = { items: () => [], slots: [] }
  bot.heldItem = null
  bot.pathfinder = { bestHarvestTool: () => null }
  const id = n => registry.blocksByName[n].defaultState
  for (let cx = -1; cx <= 2; cx++) {
    for (let cz = -1; cz <= 2; cz++) {
      const chunk = new Chunk({ minY: MIN_Y, worldHeight: HEIGHT })
      for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++) {
          for (let y = 50; y < 64; y++) chunk.setBlockStateId(new Vec3(x, y, z), id('stone'))
          for (let y = 64; y < 68; y++) chunk.setBlockStateId(new Vec3(x, y, z), id('dirt'))
          chunk.setBlockStateId(new Vec3(x, 68, z), id('grass_block'))
        }
      }
      bot.world.setColumn(cx, cz, chunk)
    }
  }
  const remplir = (x1, y1, z1, x2, y2, z2, n) => {
    for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) for (let z = z1; z <= z2; z++) bot.world.setBlockStateId(new Vec3(x, y, z), id(n))
  }
  // Trou de 5 (sol du trou : pieds a 64), tronc au centre, couronne qui le coiffe.
  remplir(13, 64, 13, 19, 68, 19, 'air')
  remplir(14, 67, 14, 18, 68, 18, 'oak_leaves')
  remplir(16, 64, 16, 16, 66, 16, 'oak_log')
  bot.entity = { position: new Vec3(22.5, 69, 22.5), velocity: new Vec3(0, 0, 0), onGround: true, height: 1.8, width: 0.6 }
  const m = new Movements(bot)
  m.canDig = true
  m.allow1by1towers = true
  m.allowParkour = false
  m.maxDropDown = 3
  return { bot, m }
}

function chercher (bot, m, goal, delai) {
  const p = bot.entity.position.floored()
  const a = new AStar(new Move(p.x, p.y, p.z, 0, 0), m, goal, delai, 40, -1)
  let r
  do { r = a.compute() } while (r.status === 'partial')
  return r
}

test('buche du haut au fond d un trou : un poste a portee des yeux est trouve', () => {
  const { bot, m } = monde()
  const haut = new Vec3(16, 66, 16)
  const r = chercher(bot, m, new GoalBlocEnVue(haut, bot.world, { reach: 3.5 }), 5000)
  assert.strictEqual(r.status, 'success')
  const fin = r.path.at(-1)
  const yeux = new Vec3(fin.x + 0.5, fin.y + 1.62, fin.z + 0.5)
  assert.ok(yeux.distanceTo(haut.offset(0.5, 0.5, 0.5)) <= perception.REACH, `poste ${fin} hors de portee des actions`)
})

test('GoalLookAtBlock du pathfinder ne trouve aucun poste pour cette buche (raison du but maison)', () => {
  const { bot, m } = monde()
  const r = chercher(bot, m, new goals.GoalLookAtBlock(new Vec3(16, 66, 16), bot.world, { reach: 3.5 }), 1500)
  assert.notStrictEqual(r.status, 'success')
})

test('hors de portee des yeux : pas un but atteint ; a cote du tronc : atteint', () => {
  const { bot } = monde()
  const goal = new GoalBlocEnVue(new Vec3(16, 64, 16), bot.world, { reach: 3.5 })
  assert.strictEqual(goal.isEnd(new Move(22, 69, 22, 0, 0)), false) // trop loin
  assert.strictEqual(goal.isEnd(new Move(18, 64, 16, 0, 0)), true)
})
