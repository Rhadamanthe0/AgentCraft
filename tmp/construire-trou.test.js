'use strict'

// construire depuis le fond d un trou de deux blocs (pierre recoltee sous un
// sol mis a nu) : les postes de tir se rallient a pied et etaient injoignables
// jusqu a la fin (skill/stone-hut-batir, banc ec97eb4). Serveur simule : vrai
// A*, vraie physique, vraie mission scriptee.

const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { createSimServer } = require('./sim-server')
const craft = require('../bot/craft')
craft.targetCriteria = craft.targetCriteria ?? (() => ({}))
const { createMissionRunner } = require('../bot/mission')

test('construire sort d un trou de deux blocs avant de rallier ses postes', { timeout: 120000 }, async () => {
  const sim = createSimServer({
    start: new Vec3(20.5, 200, 20.5),
    borne: { x0: 0, x1: 40, z0: 0, z1: 40 },
    inventory: [{ name: 'cobblestone', count: 40 }, { name: 'wooden_pickaxe', count: 1 }]
  })
  const log = console.log
  console.log = () => {}
  try {
    const r = createMissionRunner(sim.host)
    const started = await r.start('Construis-moi une maison en pierre de 3 par 3 par 3', 'joueur', {
      brief: { type: 'construction', matiere: 'pierre' },
      script: [{ action: 'choisir_terrain' }, { action: 'attendre', duree: 4 }, { action: 'construire', quantite: 24 }]
    })
    assert.ok(started.ok, started.error)
    const debut = Date.now()
    let creuse = false
    while (r.isRunning() && Date.now() - debut < 100000) {
      await new Promise(resolve => setTimeout(resolve, 100))
      const s = r.status()
      if (creuse || !s.chantier?.emplacement || s.etapes < 1) continue
      // Pendant `attendre` : trou de 2x1, deux blocs de profondeur, parois de
      // pierre, a huit blocs du chantier ; le bot au fond.
      creuse = true
      const [x0, , z0] = String(s.chantier.emplacement).split(' ').map(Number)
      const px = x0 - 8
      for (let x = px - 2; x <= px + 3; x++) {
        for (let z = z0 - 2; z <= z0 + 2; z++) {
          const vide = z === z0 && (x === px || x === px + 1)
          for (const y of [198, 199]) sim.setBlock(new Vec3(x, y, z), vide ? 'air' : 'stone')
        }
      }
      sim.bot.entity.position = new Vec3(px + 0.5, 198, z0 + 0.5)
      sim.bot.entity.velocity = new Vec3(0, 0, 0)
    }
    const fin = r.status()
    assert.ok(creuse)
    assert.equal(fin.chantier.blocs_poses, 24, `${fin.etat} : ${fin.raison}`)
  } finally {
    console.log = log
    sim.close()
  }
})
