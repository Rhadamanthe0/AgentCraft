'use strict'

// Reparations par le code (A/B `reparer`) : un tronc trop haut pres d un
// chantier deja place. recolter ne monte pas de lui-meme tant qu un chantier
// existe et rend `cible_haute` ; le modele devait alors planifier piler puis
// casser (un aller-retour par tronc). Avec `reparer`, le code joue ces remedes
// et rejoue recolter. Serveur simule : vrai A*, vraie physique, vraie mission
// scriptee (une seule recolte, aucun piler dans le script).

const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { createSimServer } = require('./sim-server')
const craft = require('../bot/craft')
craft.targetCriteria = craft.targetCriteria ?? (() => ({}))
const { createMissionRunner } = require('../bot/mission')

async function jouer (reparer, { tronc = 7, inventaire = [{ name: 'dirt', count: 12 }], script = [{ action: 'choisir_terrain' }, { action: 'recolter', quantite: 7 }] } = {}) {
  const blocks = {}
  // Tronc au pied du bot : au-dela de 3, le haut est hors de portee du sol.
  for (let y = 200; y < 200 + tronc; y++) blocks[`23,${y},20`] = 'oak_log'
  const sim = createSimServer({
    blocks,
    start: new Vec3(20.5, 200, 20.5),
    borne: { x0: 0, x1: 40, z0: 0, z1: 40 },
    inventory: inventaire
  })
  const log = console.log
  const lignes = []
  console.log = (...a) => { lignes.push(a.join(' ')) }
  try {
    const r = createMissionRunner(sim.host)
    r.setFeatures({ reset: true, reparer })
    const started = await r.start('Construis-moi une cabane en bois de 3 par 3 par 3', 'joueur', {
      brief: { type: 'construction', matiere: 'bois' },
      script
    })
    assert.ok(started.ok, started.error)
    const debut = Date.now()
    while (r.isRunning() && Date.now() - debut < 100000) await new Promise(resolve => setTimeout(resolve, 100))
    const debout = [...Array(tronc).keys()].filter(i => sim.nameAt(23, 200 + i, 20) === 'oak_log').length
    return { debout, status: r.status(), lignes }
  } finally {
    r0(sim)
    console.log = log
  }
}
function r0 (sim) { sim.close() }

module.exports = { jouer }
if (!process.env.DBG) test('reparer : tronc haut pres d un chantier, piler et casser joues par le code', { timeout: 150000 }, async () => {
  const sans = await jouer(false)
  assert.ok(sans.debout > 0, 'sans reparer, le script seul laisse le haut du tronc')
  const avec = await jouer(true)
  assert.equal(avec.debout, 0, `avec reparer, tronc fini : ${avec.lignes.filter(l => /\[mission\] (\d+\.|reparation)/.test(l)).join(' | ')}`)
  assert.ok(avec.status.reparations?.n >= 1, 'reparation comptee')
  assert.ok(avec.status.reparations.codes.cible_haute >= 1)
})

if (!process.env.DBG) test('reparer : construire refuse sur un arbre commence, le code le finit puis construit', { timeout: 150000 }, async () => {
  const opts = {
    tronc: 6,
    inventaire: [{ name: 'oak_planks', count: 30 }],
    script: [{ action: 'choisir_terrain' }, { action: 'casser', duree: 1 }, { action: 'construire', quantite: 8 }]
  }
  const sans = await jouer(false, opts)
  assert.ok(sans.debout > 0 && (sans.status.chantier?.blocs_poses ?? 0) === 0, 'sans reparer, construire refuse et rien n est pose')
  const avec = await jouer(true, opts)
  assert.equal(avec.debout, 0, 'arbre fini')
  assert.ok(avec.status.chantier.blocs_poses >= 8, `${avec.lignes.filter(l => /\[mission\] (\d+\.|reparation)/.test(l)).join(' | ')}`)
  assert.equal(avec.status.reparations?.codes?.arbre_inacheve, 1)
})
