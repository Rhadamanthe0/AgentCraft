'use strict'

// Lot 2 des actions generiques (A/B `objet_vers`, regle immuable du
// proprietaire, AGENTS.md) : la cible de recolter, casser, ramasser, avancer,
// explorer et piler est un parametre (`objet` ou `vers`) ; sans lui, la matiere
// de la mission. Serveur simule : vrai A*, vraie physique, mission scriptee.

const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { createSimServer } = require('./sim-server')
const craft = require('../bot/craft')
craft.targetCriteria = craft.targetCriteria ?? (() => ({}))
const { createMissionRunner } = require('../bot/mission')
const skills = require('../bot/skills')

// Un arbre de trois buches et du sable a quelques pas.
const MONDE = {
  '14,200,15': 'oak_log', '14,201,15': 'oak_log', '14,202,15': 'oak_log',
  '8,199,19': 'sand', '9,199,19': 'sand', '10,199,19': 'sand'
}

async function jouer ({ blocks = MONDE, brief = { type: 'recolte', matiere: 'bois' }, script, features = { objet_vers: true } }) {
  const sim = createSimServer({ blocks, start: new Vec3(8.5, 200, 15.5), borne: { x0: 0, x1: 30, z0: 0, z1: 30 } })
  const log = console.log
  const lignes = []
  console.log = (...a) => { lignes.push(a.join(' ')) }
  try {
    const r = createMissionRunner(sim.host)
    r.setFeatures({ reset: true, ...features })
    const started = await r.start('coupe moi un arbre', 'joueur', { brief, script })
    assert.ok(started.ok, started.error)
    const debut = Date.now()
    while (r.isRunning() && Date.now() - debut < 90000) await new Promise(resolve => setTimeout(resolve, 100))
    if (r.isRunning()) r.stop('fin du test')
    return { sim, lignes }
  } finally {
    console.log = log
    sim.close()
  }
}

const tenu = (sim, re) => sim.inventory().filter(i => re.test(i.name)).reduce((n, i) => n + i.count, 0)

test('objet_vers : parametres servis au modele seulement avec le mode', () => {
  const r = createMissionRunner({ getBot: () => null })
  r.setFeatures({ reset: true })
  assert.equal(skills.jsonParamsFor('recolter').objet, undefined)
  assert.equal(skills.jsonParamsFor('avancer').vers, undefined)
  r.setFeatures({ objet_vers: true })
  for (const [action, param] of [['casser', 'objet'], ['recolter', 'objet'], ['ramasser', 'objet'], ['avancer', 'vers'], ['explorer', 'vers'], ['piler', 'vers']]) {
    assert.ok(skills.jsonParamsFor(action)[param], `${action}.${param}`)
  }
  r.setFeatures({ reset: true })
})

test('objet_vers : recolter un objet nomme hors de la matiere de la mission, puis le bois par defaut', async () => {
  const { sim, lignes } = await jouer({
    script: [{ action: 'recolter', objet: 'sand', quantite: 2 }, { action: 'recolter', quantite: 3 }, { action: 'terminer' }]
  })
  assert.ok(tenu(sim, /^sand$/) >= 2, lignes.filter(l => /\[mission\]/.test(l)).slice(-8).join('\n'))
  assert.equal(sim.count(n => n === 'oak_log'), 0, 'le bois de la mission reste la cible sans parametre')
})

test('objet_vers : nom inconnu refuse avec son code, arbre commence prioritaire', async () => {
  const { lignes } = await jouer({
    script: [
      { action: 'recolter', objet: 'licorne' },
      { action: 'avancer', vers: 'oak_log', distance: 10 },
      { action: 'casser', objet: 'oak_log', duree: 1 },
      { action: 'recolter', objet: 'sand', quantite: 1 },
      { action: 'terminer' }
    ]
  })
  assert.ok(lignes.some(l => /objet inconnu : « licorne »/.test(l)), lignes.slice(-10).join('\n'))
  assert.ok(lignes.some(l => /avancer \(vers=oak_log.*oak_log rejoint a portee/.test(l)), lignes.slice(-10).join('\n'))
  assert.ok(lignes.some(l => /recolter sand .*arbre commence : \d buche\(s\) encore debout/.test(l)), lignes.slice(-10).join('\n'))
})

test('objet_vers : sans le mode, le parametre est ignore (matiere de la mission)', async () => {
  const { sim } = await jouer({
    features: {},
    script: [{ action: 'recolter', objet: 'sand', quantite: 3 }, { action: 'terminer' }]
  })
  assert.equal(tenu(sim, /^sand$/), 0)
})
