'use strict'

// Une matiere a plusieurs blocs (minerai) : le bot vise ceux que ses outils
// font lacher. Vu sur composite/powered-rail-line (06d881f) : pioche en
// pierre en main, or a 3 blocs, fer plus loin ; le bot cassait l or (« ne
// lache rien sans pioche en fer ») pendant 20 min. Serveur simule.

const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { createSimServer } = require('./sim-server')
const craft = require('../bot/craft')
craft.targetCriteria = craft.targetCriteria ?? (() => ({}))
const { createMissionRunner } = require('../bot/mission')

test('recolter du minerai : le fer que la pioche en pierre fait lacher, pas l or plus proche', async () => {
  const sim = createSimServer({
    blocks: { '11,200,8': 'gold_ore', '12,200,8': 'gold_ore', '17,200,8': 'iron_ore' },
    start: new Vec3(8.5, 200, 8.5),
    borne: { x0: 0, x1: 24, z0: 0, z1: 16 },
    inventory: [{ name: 'stone_pickaxe', count: 1 }]
  })
  const log = console.log
  const lignes = []
  console.log = (...a) => { lignes.push(a.join(' ')) }
  try {
    const r = createMissionRunner(sim.host)
    const started = await r.start('recolte du minerai', 'joueur', {
      brief: { type: 'recolte', matiere: 'minerai' },
      script: [{ action: 'recolter', quantite: 1 }, { action: 'terminer' }]
    })
    assert.ok(started.ok, started.error)
    const debut = Date.now()
    while (r.isRunning() && Date.now() - debut < 60000) await new Promise(resolve => setTimeout(resolve, 100))
  } finally {
    console.log = log
    sim.close()
  }
  assert.equal(sim.nameAt(17, 200, 8), 'air', lignes.filter(l => /recolter|mission\]/.test(l)).slice(-6).join('\n'))
  assert.equal(sim.nameAt(11, 200, 8), 'gold_ore')
  assert.equal(sim.nameAt(12, 200, 8), 'gold_ore')
})
