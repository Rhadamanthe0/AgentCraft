'use strict'

// Cerveau scripte (banc de competences) : etapes servies dans l ordre, avec
// repetitions, validees comme celles du modele ; script epuise = fin dite ;
// aucun appel au planificateur distant.

const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const planner = require('../bot/planner')
const craft = require('../bot/craft')
const { createScriptBrain, lireScript } = require('../bot/script-brain')
const { createMissionRunner } = require('../bot/mission')

test('lireScript : refuse un script vide, une entree sans action, un repeter hors bornes', () => {
  assert.throws(() => lireScript([]), /script vide/)
  assert.throws(() => lireScript([{ quantite: 3 }]), /sans action/)
  assert.throws(() => lireScript([{ action: 'casser', repeter: 0 }]), /repeter/)
  assert.throws(() => lireScript([{ action: 'casser', repeter: 99 }]), /repeter/)
  assert.deepEqual(lireScript([{ action: 'casser', duree: 4, repeter: 2 }]), [{ etape: { action: 'casser', duree: 4 }, repeter: 2 }])
})

test('cerveau scripte : ordre, repetitions, parametres bornes, puis fin et refus', async () => {
  const c = createScriptBrain({ script: [{ action: 'recolter', quantite: 3, repeter: 2 }, { action: 'piler', hauteur: 2 }],
    brief: { type: 'recolte', matiere: 'bois' } })
  const brief = await c.readBrief()
  assert.equal(brief.kind, 'recolte')
  assert.equal(brief.resource, 'bois')
  const servies = []
  for (let i = 0; i < 3; i++) {
    const r = await c.plan({}, 'recolte', 'naturel')
    assert.equal(r.finished, false)
    assert.equal(r.steps.length, 1)
    servies.push([r.steps[0].action, r.steps[0].choices])
  }
  assert.deepEqual(servies.map(s => s[0]), ['recolter', 'recolter', 'piler'])
  assert.equal(servies[0][1].quantite, 3)
  assert.equal(servies[2][1].hauteur, 2)
  const fin = await c.plan({}, 'recolte', 'naturel')
  assert.equal(fin.finished, true)
  await assert.rejects(c.plan({}, 'recolte', 'naturel'), err => err.fin === true && /script epuise/.test(err.message))
})

test('cerveau scripte : une action hors du type de mission arrete la mission en le disant', async () => {
  const c = createScriptBrain({ script: [{ action: 'construire', quantite: 4 }], brief: { type: 'recolte', matiere: 'bois' } })
  await assert.rejects(c.plan({}, 'recolte', 'naturel'), err => err.fin === true && /rejetee : construire/.test(err.message))
})

test('mission scriptee : joue le script sans appeler le planificateur, puis se clot', async () => {
  planner.isEnabled = () => false
  let appels = 0
  planner.plan = async () => { appels++; throw new Error('planificateur appele') }
  planner.readBrief = async () => { appels++; throw new Error('brief appele') }
  craft.targetCriteria = () => ({})
  const bot = { entity: { position: new Vec3(0.5, 65, 0.5), yaw: 0, pitch: 0, onGround: true },
    registry: { blocksByName: { oak_log: { id: 1 } }, itemsByName: {} }, inventory: { items: () => [] },
    players: {}, entities: {}, findBlocks: () => [], findBlock: () => null,
    blockAt: position => ({ name: 'air', position, boundingBox: 'empty', shapes: [] }),
    clearControlStates () {}, setControlState () {}, look: async () => {} }
  const r = createMissionRunner({ getBot: () => bot, isReady: () => true, inLiquid: () => false,
    stopPathfinding () {}, chat () {}, navigateToPosition: async () => ({ reached: false, code: 'no_path' }) })
  const started = await r.start('ramasse 3 fleurs', 'banc', {
    script: [{ action: 'attendre', duree: 1 }, { action: 'regarder_autour' }],
    brief: { type: 'recolte', matiere: 'fleur' }
  })
  assert.equal(started.ok, true, started.error)
  for (let i = 0; i < 400 && r.isRunning(); i++) await new Promise(resolve => setTimeout(resolve, 25))
  const s = r.status()
  assert.equal(appels, 0)
  assert.deepEqual(s.historique.map(h => h.action), ['attendre', 'regarder_autour'])
  // Quantite explicite pas atteinte : l arret du script est refuse, puis la
  // mission echoue en le disant.
  assert.equal(r.isRunning(), false)
  assert.match(String(s.raison), /script epuise/)
})

test('mission scriptee : un script invalide est refuse avant tout demarrage', async () => {
  const bot = { entity: { position: new Vec3(0.5, 65, 0.5) } }
  const r = createMissionRunner({ getBot: () => bot, isReady: () => true, inLiquid: () => false, stopPathfinding () {}, chat () {} })
  const out = await r.start('coupe un arbre', 'banc', { script: [], brief: {} })
  assert.equal(out.ok, false)
  assert.match(out.error, /script refuse : script vide/)
})
