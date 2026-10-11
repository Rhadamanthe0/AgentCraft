'use strict'

// Joue un niveau skill/* hors ligne : meme arene et meme script qu au banc
// (tmp/skill-levels.json, exporte par `python3 ci/trees.py --export-skills`),
// vraie mission scriptee (mission.js, script-brain.js), vrai A* et vraie
// physique sur un serveur simule (tmp/sim-server.js). Controles repris de la
// famille du niveau (ci/trees.py) ; seuls ceux que la simulation sait mesurer.
//
//   NODE_PATH=$PWD/bot/node_modules node tmp/skill-sim.js skill/tree-pillar
//   ... node tmp/skill-sim.js skill/tree-pillar~avec-acces_unifie --json
//   ... node tmp/skill-sim.js --liste
//
// Une variante allume ses interrupteurs (FEATURE_<MODE>) avant de charger la
// mission. Hors champ (fabrication, four) : le niveau le dit et reste au banc.

const fs = require('node:fs')
const path = require('node:path')
const { Vec3 } = require('vec3')

const FIXTURES = JSON.parse(fs.readFileSync(path.join(__dirname, 'skill-levels.json'), 'utf8'))
// Fabrication et four : fenetres non simulees.
const HORS_CHAMP = /batir/

function trouver (nom) {
  for (const level of FIXTURES.levels) {
    if (level.name === nom) return { level, features: level.features ?? {} }
    const v = (level.variants ?? []).find(x => x.name === nom)
    if (v) return { level, features: { ...(level.features ?? {}), ...v.features } }
  }
  return null
}

function arene (level) {
  const blocks = new Map()
  const nom = b => String(b).replace(/^minecraft:/, '').replace(/\[.*$/, '')
  const remplir = (x1, y1, z1, x2, y2, z2, name) => {
    for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
      for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
        for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) blocks.set(`${x},${y},${z}`, nom(name))
      }
    }
  }
  for (const t of level.terrain ?? []) remplir(...t)
  for (const b of level.leaves ?? []) remplir(...b, level.leavesBlock)
  for (const [[x, y, z], block] of level.logs ?? []) blocks.set(`${x},${y},${z}`, nom(block))
  return blocks
}

async function jouer (nomNiveau, { capMs = 240000 } = {}) {
  const found = trouver(nomNiveau)
  if (!found) throw new Error(`niveau inconnu : ${nomNiveau}`)
  const { level, features } = found
  if (HORS_CHAMP.test(level.name)) return { test: nomNiveau, horsChamp: true, success: null, raison: 'fabrication non simulee : banc seulement' }
  for (const [mode, on] of Object.entries(features)) process.env[`FEATURE_${mode.toUpperCase()}`] = on ? '1' : '0'
  // Trajet qui creuse comme au banc : le pathfinder, sauf avec nav_creuse.
  process.env.SIM_CREUSE ??= features.nav_creuse ? 'navigateur' : 'pathfinder'
  const { createSimServer } = require('./sim-server')
  const craft = require('../bot/craft')
  craft.targetCriteria = craft.targetCriteria ?? (() => ({}))
  const { createMissionRunner } = require('../bot/mission')
  const blocks = arene(level)
  const logsAvant = [...blocks.values()].filter(n => /_log$/.test(n)).length
  const feuillesAvant = [...blocks.values()].filter(n => /_leaves$/.test(n)).length
  const s = level.start
  const sim = createSimServer({ blocks, start: new Vec3(s[0], s[1], s[2]),
    borne: { x0: 0, x1: FIXTURES.size, z0: 0, z1: FIXTURES.size },
    inventory: (level.give ?? []).map(([name, count]) => ({ name, count })) })
  const logs = []
  const log = console.log
  console.log = (...a) => logs.push(a.join(' '))
  const debut = Date.now()
  let pic = s[1]
  let bas = s[1]
  let fin = null
  try {
    const r = createMissionRunner(sim.host)
    const started = await r.start(level.instruction, FIXTURES.requester, { script: level.skill.script, brief: level.skill.brief })
    if (!started.ok) throw new Error(`mission refusee : ${started.error}`)
    while (r.isRunning() && Date.now() - debut < capMs) {
      await new Promise(resolve => setTimeout(resolve, 100))
      if (sim.bot.entity.onGround) {
        pic = Math.max(pic, sim.bot.entity.position.y)
        bas = Math.min(bas, sim.bot.entity.position.y)
      }
    }
    if (r.isRunning()) r.stop('plafond hors ligne')
    fin = r.status()
  } finally {
    console.log = log
    sim.close()
  }
  const inv = sim.inventory()
  const tenu = re => inv.filter(i => re.test(i.name)).reduce((n, i) => n + i.count, 0)
  const rules = level.rules ?? {}
  const checks = { mission_terminee: fin?.etat === 'done' }
  if (!level.kind) {
    const logsApres = sim.count(n => /_log$/.test(n))
    checks.toutes_les_buches_coupees = logsApres === 0
    checks.tout_le_bois_ramasse = tenu(/_log$/) + Math.floor(tenu(/_planks$/) / 4) >= logsAvant
    if ('leaves_broken_max' in rules) checks.feuilles_intactes = feuillesAvant - sim.count(n => /_leaves$/.test(n)) <= rules.leaves_broken_max
    if ('dirt_placed_max' in rules) checks.aucun_bloc_pose = countPlaced(sim, /^dirt$/, 200) <= rules.dirt_placed_max
    if ('standing_y_max' in rules) checks.hauteur_max_respectee = pic <= rules.standing_y_max
    if ('standing_y_min' in rules) checks.a_monte_assez = pic >= rules.standing_y_min
  } else if (level.kind === 'gather') {
    const items = new RegExp(`^(${level.items.join('|')})$`)
    checks.quantite_en_inventaire = tenu(items) >= level.target
    checks.pas_de_puits = bas >= 198.9
  } else if (level.kind === 'build') {
    const re = new RegExp(level.blocks.map(b => b.replace('minecraft:', '').replace('#', '.*')).map(b => `^${b}$`).join('|'))
    checks.blocs_poses = countPlaced(sim, re, 200) >= level.target
    if (level.door) checks.porte_posee = countPlaced(sim, /_door$/, 200) > 0
  }
  return {
    test: nomNiveau, success: Object.values(checks).every(Boolean), checks,
    elapsedS: Math.round((Date.now() - debut) / 100) / 10,
    mission: { etat: fin?.etat, raison: fin?.raison, etapes: fin?.etapes },
    historique: fin?.historique ?? [], inventaire: inv,
    journal: { casses: sim.journal.digs.length, poses: sim.journal.places.length, ramasses: sim.journal.collects.length },
    logs: logs.filter(l => /\[mission\]/.test(l)).slice(-40)
  }
}

function countPlaced (sim, re, minY) {
  let n = 0
  for (let x = 0; x <= FIXTURES.size; x++) {
    for (let z = 0; z <= FIXTURES.size; z++) {
      for (let y = minY; y <= FIXTURES.topY; y++) if (re.test(sim.nameAt(x, y, z))) n++
    }
  }
  return n
}

if (require.main === module) {
  const args = process.argv.slice(2)
  if (args.includes('--liste')) {
    for (const l of FIXTURES.levels) console.log([l.name, ...(l.variants ?? []).map(v => v.name)].join('\n'))
    process.exit(0)
  }
  const nomNiveau = args.find(a => !a.startsWith('--'))
  if (!nomNiveau) {
    console.error('usage : node tmp/skill-sim.js <niveau skill/*> [--json] | --liste')
    process.exit(2)
  }
  jouer(nomNiveau).then(r => {
    if (args.includes('--json')) console.log(JSON.stringify(r))
    else {
      console.log(r.logs?.join('\n') ?? '')
      console.log(`${r.success === null ? 'HORS CHAMP' : r.success ? 'PASS' : 'FAIL'} ${r.test} (${r.elapsedS ?? '-'} s)` +
        ` ${JSON.stringify(r.checks ?? r.raison)} ; mission ${r.mission?.etat ?? '-'} : ${r.mission?.raison ?? ''}`)
    }
    process.exit(r.success === false ? 1 : 0)
  }, err => {
    console.error(err.stack)
    process.exit(3)
  })
}

module.exports = { jouer, trouver, arene }
