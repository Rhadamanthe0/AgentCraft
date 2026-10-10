'use strict'

// Poser un objet (A/B `poser`) : l objet et le lieu sont des parametres
// (regle immuable du proprietaire, AGENTS.md). Serveur simule : vrai A*,
// vraie physique, vraie mission scriptee. Une ligne de rails entre deux blocs
// nommes, une torche a cote d un bloc nomme, un minecart pose SUR un rail ;
// la fin est jugee par le code sur les poses verifiees (consigne.poses).

const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { createSimServer } = require('./sim-server')
const craft = require('../bot/craft')
craft.targetCriteria = craft.targetCriteria ?? (() => ({}))
const { createMissionRunner } = require('../bot/mission')
const poserMod = require('../bot/action-poser')

async function jouer ({ blocks, inventory, brief, script, features = { poser: true } }) {
  const sim = createSimServer({ blocks, start: new Vec3(8.5, 200, 15.5), borne: { x0: 0, x1: 30, z0: 0, z1: 30 }, inventory })
  const log = console.log
  const lignes = []
  console.log = (...a) => { lignes.push(a.join(' ')) }
  try {
    const r = createMissionRunner(sim.host)
    r.setFeatures({ reset: true, ...features })
    const started = await r.start('Fais-moi une ligne de minecart entre les deux blocs', 'joueur', { brief, script })
    assert.ok(started.ok, started.error)
    const debut = Date.now()
    while (r.isRunning() && Date.now() - debut < 90000) await new Promise(resolve => setTimeout(resolve, 100))
    return { sim, lignes, etat: r.status?.() }
  } finally {
    console.log = log
    sim.close()
  }
}

test('poser : cases d une ligne au sol, droite puis en L, sans case sous un mur', () => {
  const sim = createSimServer({ blocks: { '5,200,0': 'stone' } })
  try {
    const droite = poserMod.casesLigne(sim.bot, new Vec3(0, 200, 0), new Vec3(3, 200, 0))
    assert.deepEqual(droite.cases.map(c => [c.x, c.y, c.z]), [[0, 200, 0], [1, 200, 0], [2, 200, 0], [3, 200, 0]])
    const enL = poserMod.casesLigne(sim.bot, new Vec3(0, 200, 0), new Vec3(2, 200, 2))
    assert.deepEqual(enL.cases.map(c => [c.x, c.z]), [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]])
    // Un bloc dans la ligne : la case monte d un bloc sur lui (marche).
    const marche = poserMod.casesLigne(sim.bot, new Vec3(4, 200, 0), new Vec3(6, 200, 0))
    assert.deepEqual(marche.cases.map(c => [c.x, c.y]), [[4, 200], [5, 201], [6, 200]])
    assert.ok(poserMod.correspond('wall_torch', 'torch'))
    assert.ok(poserMod.correspond('redstone_wall_torch', 'redstone_torch'))
    assert.ok(!poserMod.correspond('rail', 'powered_rail'))
  } finally {
    sim.close()
  }
})

test('poser : ligne de rails entre deux blocs nommes, torche a cote, minecart sur un rail, fin mesuree', async () => {
  const { sim, lignes } = await jouer({
    blocks: { '10,199,15': 'red_wool', '20,199,15': 'blue_wool' },
    inventory: [{ name: 'rail', count: 16 }, { name: 'powered_rail', count: 2 }, { name: 'redstone_torch', count: 1 }, { name: 'minecart', count: 1 }],
    brief: { type: 'recolte', matiere: 'aucune', pose: [{ objet: 'rail' }, { objet: 'powered_rail', quantite: 2 }, { objet: 'minecart', quantite: 1 }] },
    script: [
      { action: 'poser', objet: 'powered_rail', quantite: 2, de: 'red_wool', vers: 'blue_wool' },
      { action: 'poser', objet: 'rail', de: 'red_wool', vers: 'blue_wool' },
      { action: 'poser', objet: 'redstone_torch', de: 'powered_rail' },
      { action: 'poser', objet: 'minecart', de: 'rail' },
      { action: 'terminer' }
    ]
  })
  const ligne = []
  for (let x = 10; x <= 20; x++) ligne.push(sim.nameAt(x, 200, 15))
  assert.deepEqual(ligne.slice(0, 2), ['powered_rail', 'powered_rail'], lignes.filter(l => /poser|mission/.test(l)).slice(-12).join('\n'))
  assert.ok(ligne.slice(2).every(n => n === 'rail'), ligne.join(','))
  assert.ok(sim.count(n => n === 'redstone_torch') === 1, 'torche posee a cote du rail accelerateur')
  assert.ok(Object.values(sim.bot.entities).some(e => e.name === 'minecart'), 'minecart pose sur un rail')
  assert.ok(lignes.some(l => /Objectif atteint/.test(l)), lignes.slice(-8).join('\n'))
})

test('poser : terminer avant tous les objets poses est refuse, chiffres a l appui', async () => {
  const { sim, lignes } = await jouer({
    blocks: { '10,199,15': 'red_wool', '20,199,15': 'blue_wool' },
    inventory: [{ name: 'rail', count: 16 }, { name: 'minecart', count: 1 }],
    brief: { type: 'recolte', matiere: 'aucune', pose: [{ objet: 'rail' }, { objet: 'minecart', quantite: 1 }] },
    script: [{ action: 'poser', objet: 'rail', de: 'red_wool', vers: 'blue_wool' }, { action: 'terminer' }]
  })
  assert.equal(sim.count(n => n === 'rail'), 11)
  assert.ok(lignes.some(l => /terminer refuse \(1\/\d\) : 0 minecart pose\(s\) sur 1/.test(l)), lignes.slice(-8).join('\n'))
  assert.ok(!lignes.some(l => /Objectif atteint/.test(l)))
})

test('poser : objet absent de l inventaire, echec dit avec son code', async () => {
  const { lignes } = await jouer({
    blocks: { '10,199,15': 'red_wool' },
    inventory: [],
    brief: { type: 'recolte', matiere: 'aucune' },
    script: [{ action: 'poser', objet: 'torch', de: 'red_wool' }, { action: 'terminer' }]
  })
  assert.ok(lignes.some(l => /aucun torch en inventaire/.test(l)), lignes.slice(-10).join('\n'))
})

test('obtenir : objet nomme deja en poche ou inconnu, dit sans rien jouer', async () => {
  const { lignes } = await jouer({
    blocks: {},
    inventory: [{ name: 'rail', count: 5 }],
    brief: { type: 'recolte', matiere: 'aucune' },
    features: { poser: true, sous_buts: true },
    script: [{ action: 'obtenir', objet: 'rail', quantite: 4 }, { action: 'obtenir', objet: 'licorne' }, { action: 'terminer' }]
  })
  assert.ok(lignes.some(l => /obtenir .*-> 5 rail deja en poche/.test(l)), lignes.slice(-10).join('\n'))
  assert.ok(lignes.some(l => /objet inconnu : « licorne »/.test(l)), lignes.slice(-10).join('\n'))
})
