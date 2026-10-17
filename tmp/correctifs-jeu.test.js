'use strict'
// Correctifs des donnees du jeu et du pathfinder en 26.1 (bot/correctifs-jeu.js).
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { Movements, goals } = require('mineflayer-pathfinder')
const { createSimServer, registry } = require('./sim-server')
const Block = require('prismarine-block')(registry)
const { brancherCorrectifs, lianesGrimpables, cheminVideSansBut, gardeRetour } = require('../bot/correctifs-jeu')

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

const attendre = ms => new Promise(resolve => setTimeout(resolve, ms))
const creuser = bot => {
  const m = new Movements(bot)
  m.canDig = true; m.allow1by1towers = true; m.allowParkour = false; m.maxDropDown = 3
  return m
}

test('chemin vide : goto resout sans chemin, cheminVideSansBut le dit', async () => {
  // Boite de bedrock : aucun noeud meilleur que le depart.
  const blocks = {}
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) for (let y = 199; y <= 202; y++) {
    if (!(x === 0 && z === 0 && (y === 200 || y === 201))) blocks[`${x},${y},${z}`] = 'bedrock'
  }
  const sim = createSimServer({ blocks })
  const bot = sim.bot
  try {
    bot.pathfinder.setMovements(creuser(bot))
    let derniere = null
    bot.on('path_update', r => { derniere = r })
    const loin = new goals.GoalNear(10, 200, 0, 1)
    await bot.pathfinder.goto(loin) // le defaut : resout au lieu de rejeter
    assert.equal(derniere.status, 'noPath')
    assert.equal(derniere.path.length, 0)
    assert.equal(cheminVideSansBut(derniere, loin, bot.entity.position), true)
    // But deja atteint : chemin vide legitime.
    const ici = new goals.GoalNear(0, 200, 0, 1)
    await bot.pathfinder.goto(ici)
    assert.equal(cheminVideSansBut(derniere, ici, bot.entity.position), false)
  } finally {
    sim.close()
  }
})

// Marche posee au-dessus d un trou (sol en x <= 0, plateau d un bloc plus haut
// en x >= 2) ; trajet annule a la premiere pose : pendant qu elle attend la
// reponse du serveur (`enVol`, 200 ms ici) ou une fois le retour arme. Rend le
// deplacement du bot apres l annulation, sans but.
async function marcheAnnulee ({ garde, enVol = false }) {
  const sol = (x, y) => (x <= 0 && y <= 199 && y >= 189) || (x >= 2 && y <= 200 && y >= 189) ? 'stone' : 'air'
  const sim = createSimServer({ sol, inventory: [{ name: 'dirt', count: 16 }] })
  const bot = sim.bot
  try {
    const poser = bot.placeBlock
    bot.placeBlock = async (...args) => { await poser(...args); if (enVol) await attendre(200) }
    const m = new Movements(bot)
    m.canDig = false; m.allow1by1towers = false; m.allowParkour = false
    bot.pathfinder.setMovements(m)
    const retour = garde ? gardeRetour(bot) : null
    let annule = null
    bot.on('blockUpdate', (_vieux, neuf) => {
      if (annule || neuf?.name !== 'dirt') return
      bot.pathfinder.setGoal(null)
      annule = enVol && retour ? retour.neutraliser() : Promise.resolve(null)
    })
    bot.pathfinder.setGoal(new goals.GoalBlock(4, 201, 0))
    for (let i = 0; i < 300 && !annule; i++) await attendre(10)
    assert.ok(annule, 'aucune pose')
    let mene = await annule
    if (retour && mene === null) mene = await retour.neutraliser()
    const depuis = bot.entity.position.clone()
    let marche = 0
    const lire = () => { if (bot.getControlState('forward')) marche++ }
    bot.on('physicsTick', lire)
    await attendre(1500)
    bot.removeListener('physicsTick', lire)
    return { deplacement: depuis.distanceTo(bot.entity.position), marche, mene }
  } finally {
    sim.close()
  }
}

test('point de retour : un trajet annule a la pose ne fait plus marcher le bot', async () => {
  for (const enVol of [false, true]) {
    const sans = await marcheAnnulee({ garde: false, enVol })
    assert.ok(sans.deplacement > 0.5 && sans.marche > 0, JSON.stringify(sans))
  }
  // Pose en vol : son retour n est jamais arme.
  const vol = await marcheAnnulee({ garde: true, enVol: true })
  assert.ok(vol.mene === 0 && vol.deplacement < 0.1 && vol.marche === 0, JSON.stringify(vol))
  // Retour deja arme : neutraliser attend qu il ait fini (le bot glisse
  // encore sur son elan, sans commande), plus rien ensuite.
  const arme = await marcheAnnulee({ garde: true })
  assert.ok(arme.mene > 0 && arme.deplacement < 0.25 && arme.marche === 0, JSON.stringify(arme))
})

test('fullStop : le recentrage avant une casse ne met jamais le bot en collision', async () => {
  // Massif de pierre a traverser en creusant, departs hors du centre.
  const blocks = {}
  for (let x = 2; x <= 7; x++) for (let z = -2; z <= 6; z++) for (const y of [200, 201]) blocks[`${x},${y},${z}`] = 'stone'
  let recentrages = 0
  for (const start of [new Vec3(0.85, 200, 0.2), new Vec3(-3.3, 200, 3.7)]) {
    const sim = createSimServer({ blocks, start, inventory: [{ name: 'stone_pickaxe', count: 1 }] })
    const bot = sim.bot
    try {
      bot.pathfinder.setMovements(creuser(bot))
      // La physique s applique avant physicsTick : tout saut de position
      // pendant l evenement vient du pathfinder.
      let avant = null
      bot.prependListener('physicsTick', () => { avant = bot.entity.position.clone() })
      bot.on('physicsTick', () => {
        const p = bot.entity.position
        if (Math.hypot(p.x - avant.x, p.z - avant.z) < 1e-9) return
        recentrages++
        for (let x = Math.floor(p.x - 0.3); x <= Math.floor(p.x + 0.3 - 1e-9); x++) {
          for (let z = Math.floor(p.z - 0.3); z <= Math.floor(p.z + 0.3 - 1e-9); z++) {
            for (let y = Math.floor(p.y); y <= Math.floor(p.y + 1.8 - 1e-9); y++) assert.equal(sim.nameAt(x, y, z), 'air', `recentre en collision en ${p}`)
          }
        }
      })
      const delai = setTimeout(() => bot.pathfinder.setGoal(null), 30000)
      try { await bot.pathfinder.goto(new goals.GoalBlock(9, 200, 3)) } finally { clearTimeout(delai) }
    } finally {
      sim.close()
    }
  }
  assert.ok(recentrages > 0, 'aucun recentrage : le test ne mesure rien')
})
