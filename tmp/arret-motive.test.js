'use strict'

// Arret motive (proprietaire, 2026-10-20, reste de la replanification sur
// evenement inspiree d Astra) : `terminer {raison}` arrete le bot bloque et dit
// pourquoi, sur une impasse mesuree seulement ; sinon l arret est refuse.

const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const planner = require('../bot/planner')
const craft = require('../bot/craft')
const { createMissionRunner } = require('../bot/mission')

const orig = { isEnabled: planner.isEnabled, readBrief: planner.readBrief, plan: planner.plan, targetCriteria: craft.targetCriteria }
test.afterEach(() => Object.assign(planner, { isEnabled: orig.isEnabled, readBrief: orig.readBrief, plan: orig.plan }))

const etape = (action, choices = {}) => ({ action, scale: 0, scaleLevel: null, choices })

// Plans servis dans l ordre ; le dernier se repete.
function servir (plans) {
  let n = 0
  planner.isEnabled = () => true
  planner.plan = async () => ({ ms: 0, seconds: 1, rejected: [], done: 0, finished: false, steps: plans[Math.min(n++, plans.length - 1)].map(s => ({ ...s })) })
  return () => n
}

async function jouerFactice (features, plans) {
  craft.targetCriteria = () => ({})
  planner.readBrief = async () => ({ kind: 'recolte', kindConfidence: 1, resource: 'bois', resourceConfidence: 1,
    landmark: 'ici', door: false, doorProbability: 0 })
  const appels = servir(plans)
  const bot = { entity: { position: new Vec3(0.5, 65, 0.5), yaw: 0, pitch: 0, onGround: true }, health: 20,
    registry: { blocksByName: { oak_log: { id: 1 } }, itemsByName: {} }, inventory: { items: () => [] },
    players: {}, entities: {}, findBlocks: () => [], findBlock: () => null,
    blockAt: position => ({ name: 'air', position, boundingBox: 'empty', shapes: [] }),
    clearControlStates () {}, setControlState () {}, look: async () => {} }
  const r = createMissionRunner({ getBot: () => bot, isReady: () => true, inLiquid: () => false,
    stopPathfinding () {}, chat () {}, navigateToPosition: async () => ({ reached: false, code: 'no_path' }) })
  r.setFeatures({ reset: true, ...features })
  await r.start('coupe du bois', 'human')
  for (let i = 0; i < 600 && r.isRunning(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  r.stop('test')
  const status = r.status()
  r.setFeatures({ reset: true })
  craft.targetCriteria = orig.targetCriteria
  return { status, appels: appels(), historique: status.historique }
}

test('arret motive : terminer {raison} arrete le bot bloque sur une impasse mesuree, refuse sinon', async () => {
  // Aucune impasse : refuse (note reinjectee), la mission continue.
  const libre = await jouerFactice({},
    [[etape('terminer', { raison: 'je ne trouve pas de bois' })], [etape('attendre', { duree: 0.2 })], [etape('terminer', { raison: 'toujours rien' })]])
  assert.ok(libre.appels >= 3, 'le premier arret motive est refuse')
  // Apres un echec : accepte, la raison est dite.
  const bloque = await jouerFactice({},
    [[etape('fabriquer', { objet: 'truc' })], [etape('terminer', { raison: 'aucune recette pour truc' })]])
  assert.equal(bloque.status.etat, 'failed')
  assert.equal(bloque.status.raison, 'bloque : aucune recette pour truc')
})
