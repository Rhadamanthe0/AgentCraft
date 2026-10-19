'use strict'

// Chantier pose a cote d un arbre commence : la marge de son emprise (un bloc
// autour des murs) couvre le tronc coupe par le bas, et sa derniere buche,
// hors de portee du sol, etait ecartee des cibles comme un bloc du chantier.
// arbre fini en faisait pourtant la seule cible bois : recolter rendait « hors
// de portee d ici », piler puis casser ne la voyaient pas (composite/stone-
// hut-from-scratch~aleatoire, e067385 : 45 min, 193 plans). Serveur simule :
// vrai A*, vraie physique, vraie mission scriptee.

const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { createSimServer } = require('./sim-server')
const build = require('../bot/build')
const craft = require('../bot/craft')
craft.targetCriteria = craft.targetCriteria ?? (() => ({}))
const { createMissionRunner } = require('../bot/mission')

test('arbre commence dans la marge du chantier : piler puis casser finissent l arbre', { timeout: 120000 }, async () => {
  const tronc = 5
  const blocks = {}
  for (let y = 200; y < 200 + tronc; y++) blocks[`22,${y},20`] = 'oak_log'
  const sim = createSimServer({
    blocks,
    start: new Vec3(20.5, 200, 20.5),
    borne: { x0: 0, x1: 40, z0: 0, z1: 40 },
    inventory: [{ name: 'dirt', count: 12 }, { name: 'oak_planks', count: 30 }]
  })
  // Le terrain choisi colle au tronc coupe : sa marge le couvre.
  const findSite = build.findSite
  build.findSite = async () => ({ origin: new Vec3(23, 200, 19), distance: 3 })
  const log = console.log
  const lignes = []
  console.log = (...a) => { lignes.push(a.join(' ')) }
  try {
    const r = createMissionRunner(sim.host)
    r.setFeatures({ reset: true })
    const started = await r.start('Construis-moi une cabane en bois de 3 par 3 par 3', 'joueur', {
      brief: { type: 'construction', matiere: 'bois' },
      script: [
        { action: 'casser', duree: 6 },
        { action: 'choisir_terrain' },
        { action: 'piler', hauteur: 1 },
        { action: 'casser', duree: 6 }
      ]
    })
    assert.ok(started.ok, started.error)
    const debut = Date.now()
    while (r.isRunning() && Date.now() - debut < 90000) await new Promise(resolve => setTimeout(resolve, 100))
    const etapes = lignes.filter(l => /\[mission\] \d+\./.test(l)).join(' | ')
    assert.match(etapes, /chantier place en 23 200 19/, etapes)
    const debout = [...Array(tronc).keys()].filter(i => sim.nameAt(22, 200 + i, 20) === 'oak_log').length
    assert.equal(debout, 0, `derniere buche coupee depuis le pilier : ${etapes}`)
  } finally {
    build.findSite = findSite
    console.log = log
    sim.close()
  }
})
