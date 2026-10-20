'use strict'

// Chantier en pierre pose, porte demandee mais ni posee ni en poche : la
// recolte suivante vise le bois de la porte, pas la pierre du brief
// (composite/big-stone-house, banc 39067397552 : 64/64 blocs, pierre recoltee
// 20 min, « il me manque du bois pour la porte »). Serveur simule : vrai A*,
// vraie physique, vraie mission scriptee.

const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { createSimServer } = require('./sim-server')
const craft = require('../bot/craft')
craft.targetCriteria = craft.targetCriteria ?? (() => ({}))
const { createMissionRunner } = require('../bot/mission')

test('chantier pose sans porte : la porte devient la cible, le bois passe avant la pierre', { timeout: 120000 }, async () => {
  const blocks = {}
  for (let y = 200; y <= 203; y++) blocks[`28,${y},20`] = 'oak_log'
  for (let x = 10; x <= 13; x++) blocks[`${x},199,12`] = 'stone'
  const sim = createSimServer({
    blocks,
    start: new Vec3(20.5, 200, 20.5),
    borne: { x0: 0, x1: 40, z0: 0, z1: 40 },
    inventory: [{ name: 'cobblestone', count: 40 }, { name: 'wooden_pickaxe', count: 1 }]
  })
  const log = console.log
  const lignes = []
  console.log = (...a) => { lignes.push(a.join(' ')) }
  try {
    const r = createMissionRunner(sim.host)
    const started = await r.start('Construis-moi une maison en pierre de 3 par 3 par 3 avec une porte', 'joueur', {
      brief: { type: 'construction', matiere: 'pierre', porte: true },
      script: [{ action: 'choisir_terrain' }, { action: 'construire', quantite: 40 }, { action: 'recolter', quantite: 1 }]
    })
    assert.ok(started.ok, started.error)
    const debut = Date.now()
    while (r.isRunning() && Date.now() - debut < 100000) await new Promise(resolve => setTimeout(resolve, 100))
  } finally {
    console.log = log
    sim.close()
  }
  const etapes = lignes.filter(l => /\[mission\] \d+\./.test(l))
  assert.ok(etapes.some(l => /construire .*-> \d+\/\d+ bloc\(s\) pose\(s\), (\d+)\/\1 au total/.test(l)), etapes.join('\n'))
  const recolte = etapes.find(l => /\] \d+\. recolter/.test(l)) ?? ''
  assert.match(recolte, /bois/, etapes.join('\n'))
  assert.ok(lignes.some(l => /solveur .*oak_door/.test(l)), lignes.filter(l => /solveur/.test(l)).join('\n'))
})
