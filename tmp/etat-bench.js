'use strict'
// Banc de duree de l etat de mission (buildState) sur un monde reel par
// sections (prismarine-world 26.1, findBlocks de mineflayer) : sous-sol de
// pierre et minerais, terre, herbe, arbres, sable. Le serveur simule fournit la
// physique et l hote ; le monde reel remplace sa recherche de blocs pour que
// les couts soient ceux du banc (piege 17, [lent] dans containers.log).
//
//   NODE_PATH=$PWD/bot/node_modules node --cpu-prof --cpu-prof-dir=<dir> tmp/etat-bench.js [scenario]
//
// Imprime, par scenario, le nombre d etats construits et leur duree mediane.
process.env.MISSION_ETAT_LENT_MS = '0'
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { createSimServer, registry } = require('./sim-server')
const Chunk = require('prismarine-chunk')(registry)
const World = require('prismarine-world')(registry)
const craft = require('../bot/craft')
craft.targetCriteria = craft.targetCriteria ?? (() => ({}))
const { createMissionRunner } = require('../bot/mission')

const MIN_Y = -64
const HEIGHT = 384
const R = 5 // chunks autour de l origine

// Terrain naturel deterministe.
function hash (x, y, z) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0
  h = (h ^ (h >>> 13)) * 1274126177 | 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
const ARBRES = []
for (let i = 0; i < 40; i++) {
  const x = Math.floor(hash(i, 1, 7) * 150) - 75
  const z = Math.floor(hash(i, 2, 9) * 150) - 75
  if (Math.abs(x) < 6 && Math.abs(z) < 6) continue
  ARBRES.push({ x, z, h: 4 + Math.floor(hash(i, 3, 3) * 3) })
}
const cellules = new Map()
for (const a of ARBRES) {
  for (let dy = 0; dy < a.h; dy++) cellules.set(`${a.x},${200 + dy},${a.z}`, 'oak_log')
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      for (let dy = a.h - 2; dy <= a.h; dy++) {
        const k = `${a.x + dx},${200 + dy},${a.z + dz}`
        if (!cellules.has(k)) cellules.set(k, 'oak_leaves')
      }
    }
  }
}
function sol (x, y, z) {
  if (y === 199) return (x > 20 && x < 30 && z > -10 && z < 0) ? 'sand' : 'grass_block'
  if (y >= 196 && y < 199) return 'dirt'
  if (y >= 140 && y < 196) {
    const r = hash(x, y, z)
    if (r < 0.01) return 'coal_ore'
    if (r < 0.016) return 'iron_ore'
    if (y < 160 && r < 0.018) return 'gold_ore'
    if (y < 150 && r < 0.02) return 'redstone_ore'
    return 'stone'
  }
  return 'air'
}

function remplir (world) {
  for (let cx = -R; cx <= R; cx++) {
    for (let cz = -R; cz <= R; cz++) {
      const chunk = new Chunk({ minY: MIN_Y, worldHeight: HEIGHT })
      const p = new Vec3(0, 0, 0)
      for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++) {
          for (let y = 140; y < 210; y++) {
            const wx = cx * 16 + x; const wz = cz * 16 + z
            const n = cellules.get(`${wx},${y},${wz}`) ?? sol(wx, y, wz)
            if (n === 'air') continue
            p.x = x; p.y = y; p.z = z
            chunk.setBlockStateId(p, registry.blocksByName[n].defaultState)
          }
        }
      }
      world.setColumn(cx, cz, chunk)
    }
  }
}

const SCENARIOS = {
  bois: { objectif: 'coupe moi un arbre', brief: { type: 'recolte', matiere: 'bois' } },
  pierre: { objectif: 'ramene moi de la pierre', brief: { type: 'recolte', matiere: 'pierre' } },
  cabane: { objectif: 'Construis-moi une cabane en bois de 4 par 4 par 4 avec une porte', brief: { type: 'construction', matiere: 'bois', porte: true } },
  pioche_fer: { objectif: 'fabrique moi une pioche en fer', brief: { type: 'recolte', matiere: 'fer', fabrication: 'iron_pickaxe' } }
}

async function jouer (nom) {
  const sc = SCENARIOS[nom]
  const sim = createSimServer({ blocks: cellules, sol, start: new Vec3(0.5, 200, 0.5) })
  // Monde reel par sections, comme au banc.
  const fauxClient = new EventEmitter()
  const support = new EventEmitter()
  support._client = fauxClient
  support.registry = registry
  support.version = '26.1'
  require('mineflayer/lib/plugins/blocks.js')(support, { version: '26.1', hideErrors: true })
  support.game = { minY: MIN_Y, height: HEIGHT }
  support.world = new World(null).sync
  remplir(support.world)
  sim.bot.world = support.world
  sim.bot.game.height = HEIGHT
  support.entity = sim.bot.entity
  if (!process.env.SANS_BRANCHE) require('../bot/perception').brancherRecherche(support)
  sim.bot.findBlocks = opts => support.findBlocks(opts)
  sim.bot.findBlock = opts => support.findBlock(opts)
  const durees = []
  const log = console.log
  console.log = (...a) => {
    const m = /\[lent\] etat de mission construit en (\d+) ms/.exec(a.join(' '))
    if (m) durees.push(Number(m[1]))
  }
  try {
    const r = createMissionRunner(sim.host)
    r.setFeatures({ reset: true })
    const script = [{ action: 'attendre', duree: 1, repeter: 6 }, { action: 'terminer' }]
    const t0 = Date.now()
    const started = await r.start(sc.objectif, 'joueur', { brief: sc.brief, script })
    if (!started.ok) throw new Error(started.error)
    while (r.isRunning() && Date.now() - t0 < 60000) await new Promise(resolve => setTimeout(resolve, 50))
    if (r.isRunning()) r.stop('fin du banc')
    return { durees }
  } finally {
    console.log = log
    sim.close()
  }
}

async function main () {
  const noms = process.argv[2] ? [process.argv[2]] : Object.keys(SCENARIOS)
  for (const nom of noms) {
    const { durees } = await jouer(nom)
    durees.sort((a, b) => a - b)
    console.log(`${nom} : ${durees.length} etats, mediane ${durees[durees.length >> 1] ?? '-'} ms, max ${durees.at(-1) ?? '-'} ms`)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
