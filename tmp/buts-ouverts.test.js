'use strict'

// Matieres ouvertes au registre (A/B `buts_ouverts`) : une demande hors du
// catalogue de matieres (citrouilles, spawner) se joue avec les actions
// existantes, la matiere decrite par le registre du jeu (objets lachees,
// bloc qui ne se recolte pas). Et une capacite absente se refuse tout de
// suite. Serveur simule : vrai A*, vraie physique, vraie mission scriptee.

const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { createSimServer } = require('./sim-server')
const craft = require('../bot/craft')
craft.targetCriteria = craft.targetCriteria ?? (() => ({}))
const { createMissionRunner } = require('../bot/mission')
const skills = require('../bot/skills')

async function jouer (ouvert, { blocks, objectif, brief, script, inventaire = [] }) {
  const sim = createSimServer({ blocks, start: new Vec3(10.5, 200, 10.5), borne: { x0: 0, x1: 40, z0: 0, z1: 40 }, inventory: inventaire })
  const log = console.log
  const lignes = []
  console.log = (...a) => { lignes.push(a.join(' ')) }
  try {
    const r = createMissionRunner(sim.host)
    r.setFeatures({ reset: true, buts_ouverts: ouvert })
    const started = await r.start(objectif, 'joueur', { brief, script })
    const debut = Date.now()
    while (started.ok && r.isRunning() && Date.now() - debut < 60000) await new Promise(resolve => setTimeout(resolve, 100))
    return { started, status: r.status(), inventaire: sim.inventory(), lignes }
  } finally {
    console.log = log
    sim.close()
  }
}

test('registre : un bloc hors catalogue se decrit par ses objets lachees', () => {
  const registry = require('minecraft-data')('26.1')
  const citrouille = skills.resourceSpec(skills.ressourceLibre('pumpkin', registry), registry)
  assert.ok(citrouille.items.test('pumpkin'))
  assert.equal(citrouille.build, 'pumpkin')
  const spawner = skills.resourceSpec(skills.ressourceLibre('minecraft:spawner', registry), registry)
  assert.equal(spawner.items, null, 'un spawner ne lache rien')
  assert.equal(skills.ressourceLibre('pas_un_bloc', registry), null)
  assert.equal(skills.ressourceLibre('air', registry), null)
  assert.equal(skills.resourceSpec('bois', registry), skills.RESOURCES.bois, 'catalogue inchange')
})

test('buts_ouverts : « ramene-moi 3 citrouilles » se recolte et se compte', { timeout: 150000 }, async () => {
  const blocks = {}
  for (const [x, z] of [[16, 12], [18, 9], [15, 17], [20, 14]]) blocks[`${x},200,${z}`] = 'pumpkin'
  const partie = {
    blocks,
    objectif: 'Ramene-moi 3 citrouilles',
    brief: { type: 'recolte', matiere: 'aucune', bloc: 'pumpkin' },
    script: [{ action: 'recolter', quantite: 3 }, { action: 'recolter', quantite: 3 }]
  }
  const sans = await jouer(false, partie)
  assert.notEqual(sans.status.etat, 'done', 'sans mode ouvert, aucune matiere')
  const avec = await jouer(true, partie)
  const tenues = avec.inventaire.filter(i => i.name === 'pumpkin').reduce((n, i) => n + i.count, 0)
  assert.ok(tenues >= 3, `${tenues} citrouille(s) : ${avec.lignes.filter(l => /\[mission\]/.test(l)).slice(-8).join(' | ')}`)
  assert.equal(avec.status.etat, 'done', avec.status.raison)
  assert.equal(avec.status.matiere, 'libre:pumpkin')
})

test('buts_ouverts : un bloc qui ne lache rien se rejoint (deplacement mesure)', { timeout: 150000 }, async () => {
  const avec = await jouer(true, {
    blocks: { '24,200,18': 'spawner' },
    objectif: 'Trouve un spawner',
    brief: { type: 'recolte', matiere: 'aucune', bloc: 'spawner' },
    script: [{ action: 'avancer' }]
  })
  assert.equal(avec.status.type, 'deplacement')
  assert.equal(avec.status.etat, 'done', `${avec.status.raison} : ${avec.lignes.filter(l => /\[mission\]/.test(l)).slice(-6).join(' | ')}`)
})

test('buts_ouverts : une capacite absente est refusee tout de suite, en le disant', async () => {
  const r = await jouer(true, {
    blocks: {},
    objectif: 'Fais-moi une ferme a oeufs automatique avec des entonnoirs',
    brief: { type: 'construction', matiere: 'aucune', hors_capacites: 'mecanisme' },
    script: [{ action: 'attendre', duree: 1 }]
  })
  assert.equal(r.started.ok, false)
  assert.match(r.started.error, /je ne sais pas encore faire de la redstone/)
  const sans = await jouer(false, {
    blocks: {},
    objectif: 'Fais-moi une ferme a oeufs automatique avec des entonnoirs',
    brief: { type: 'construction', matiere: 'aucune', hors_capacites: 'mecanisme' },
    script: [{ action: 'attendre', duree: 1 }]
  })
  assert.equal(sans.started.ok, true, 'sans le mode, la mission part comme avant')
})

test('buts_ouverts : un bloc absent du registre est renvoye une fois au modele, avec le nom refuse', async () => {
  const llm = require('../bot/llm')
  const saved = { call: llm.call, url: process.env.PLANNER_BASE_URL, model: process.env.PLANNER_MODEL, sid: process.env.PLANNER_SESSION_ID }
  Object.assign(process.env, { PLANNER_BASE_URL: 'https://exemple.invalid/v1', PLANNER_MODEL: 'm', PLANNER_SESSION_ID: 's' })
  delete require.cache[require.resolve('../bot/planner')]
  const planner = require('../bot/planner')
  const registry = require('minecraft-data')('26.1')
  const blocConnu = nom => !!skills.ressourceLibre(nom, registry)
  const entrees = []
  const reponses = ['{"type":"deplacement","matiere":"aucune","bloc":"table_d_enchantement"}', '{"type":"deplacement","matiere":"aucune","bloc":"enchanting_table"}']
  llm.call = async (system, user) => { entrees.push(JSON.parse(user)); return { content: reponses[entrees.length - 1], ms: 1 } }
  try {
    const brief = await planner.readBrief('Va jusqu a la table d enchantement', { ouvert: true, blocConnu })
    assert.equal(brief.blocRegistre, 'enchanting_table')
    assert.equal(entrees.length, 2)
    assert.equal(entrees[1].bloc_refuse, 'table_d_enchantement')
    // Un nom connu d emblee ne coute aucun appel de plus ; un second refus donne null.
    entrees.length = 0
    reponses.splice(0, 2, '{"type":"recolte","matiere":"aucune","bloc":"obsidian"}')
    assert.equal((await planner.readBrief('Ramene de l obsidienne', { ouvert: true, blocConnu })).blocRegistre, 'obsidian')
    assert.equal(entrees.length, 1)
    entrees.length = 0
    reponses.splice(0, 2, '{"bloc":"truc"}', '{"bloc":"machin"}')
    assert.equal((await planner.readBrief('Trouve un truc', { ouvert: true, blocConnu })).blocRegistre, null)
    assert.equal(entrees.length, 2)
  } finally {
    llm.call = saved.call
    for (const [k, v] of [['PLANNER_BASE_URL', saved.url], ['PLANNER_MODEL', saved.model], ['PLANNER_SESSION_ID', saved.sid]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
})
