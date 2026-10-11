'use strict'
// Rejoue le trajet qui creuse (vrai pathfinder 2.4.5, GoalBlocEnVue, memes
// Movements que safeDigMovements) sur un instantane de blocage, avec la
// physique du serveur simule. Ce qui passe ici et echoue au banc vient de
// l execution sur le vrai serveur (voir la ligne [creuse]).
//   NODE_PATH=$PWD/bot/node_modules node tmp/creuse-repro.js <instantane.json> [x,y,z depart] [x,y,z bloc]
const { Vec3 } = require('vec3')
const { createSimServer } = require('./sim-server')
const perception = require('../bot/perception')
const { Movements } = require('mineflayer-pathfinder')
const { GoalBlocEnVue } = require('../bot/but-bloc')
const snap = require(process.argv[2])
const cells = new Map()
for (const [k, n] of perception.lireInstantane(snap.monde)) cells.set(k, n)
const [sx, sy, sz] = (process.argv[3] ?? '511.3,205,12.3').split(',').map(Number)
const sim = createSimServer({ blocks: cells, start: new Vec3(sx, sy, sz),
  sol: (x, y) => y <= 203 && y >= 190 ? 'dirt' : y === 204 ? 'grass_block' : 'air' })
const bot = sim.bot
const { registry } = require('./sim-server')
const Chunk = require('prismarine-chunk')(registry)
const World = require('prismarine-world')(registry)
const monde = new World(null).sync
for (let cx = 30; cx <= 33; cx++) for (let cz = -1; cz <= 2; cz++) {
  const ch = new Chunk({ minY: -64, worldHeight: 384 })
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 190; y < 215; y++) {
    const n = sim.nameAt(cx * 16 + x, y, cz * 16 + z)
    if (n !== 'air') ch.setBlockStateId(new Vec3(x, y, z), registry.blocksByName[n].defaultState)
  }
  monde.setColumn(cx, cz, ch)
}
const m = new Movements(bot)
m.canDig = true; m.allow1by1towers = true; m.allowParkour = false; m.maxDropDown = 3
bot.pathfinder.setMovements(m)
bot.on('path_update', r => console.log('path_update', r.status, r.visitedNodes, r.path.map(p => `${p.x},${p.y},${p.z}`).join(' ')))
bot.on('path_reset', r => console.log('path_reset', r, bot.entity.position.toString(), 'onGround', bot.entity.onGround))
let t = 0
const iv = setInterval(() => { t++; if (t % 4 === 0) console.log('pos', bot.entity.position.toString(), 'g', bot.entity.onGround, JSON.stringify(bot.controlState)) }, 250)
bot.world = monde
const goal = new GoalBlocEnVue(new Vec3(...(process.argv[4] ?? '506,202,6').split(',').map(Number)), monde, { reach: 3.5 })
const fin = setTimeout(() => { console.log('TIMEOUT'); bot.pathfinder.setGoal(null) }, 20000)
bot.pathfinder.goto(goal).then(() => console.log('OK', bot.entity.position.toString()), e => console.log('ERR', e.message)).finally(() => { clearTimeout(fin); clearInterval(iv); sim.close(); process.exit(0) })
