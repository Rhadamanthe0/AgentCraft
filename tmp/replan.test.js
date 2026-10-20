'use strict'

// Replanification sur evenement (A/B `replan_probleme` et `replan_etape`,
// proprietaire 2026-10-20, idee d Astra) : un probleme rencontre (etape sans
// effet, blocage) interrompt le plan ; `terminer {raison}` arrete le bot
// bloque, sur une impasse mesuree seulement ; l etape du solveur franchie
// interrompt le plan avec `replan_etape`.

const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const planner = require('../bot/planner')
const craft = require('../bot/craft')
const { createMissionRunner } = require('../bot/mission')
const { createSimServer } = require('./sim-server')

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

test('replan_probleme : une etape sans effet interrompt le plan, sans le mode la file continue', async () => {
  const plan = [etape('casser', { duree: 1 }), etape('dire', { texte: 'un' }), etape('dire', { texte: 'deux' })]
  const sans = await jouerFactice({ replan_probleme: false }, [plan, [etape('terminer')]])
  assert.equal(sans.historique.filter(h => h.action === 'dire').length, 2, 'sans le mode, la file est jouee')
  assert.equal(sans.status.replans, null)
  const avec = await jouerFactice({ replan_probleme: true }, [plan, [etape('terminer')]])
  assert.equal(avec.historique[0].sans_effet, true)
  assert.equal(avec.historique.filter(h => h.action === 'dire').length, 0, 'avec le mode, la file est jetee')
  assert.equal(avec.status.replans.probleme, 1)
  assert.equal(avec.status.replans.etapesJetees, 2)
  assert.equal(avec.status.replans.causes['etape sans effet mesure'], 1)
})

test('replan_probleme : terminer {raison} arrete le bot bloque sur une impasse mesuree, refuse sinon', async () => {
  // Aucune impasse : refuse (note reinjectee), la mission continue.
  const libre = await jouerFactice({ replan_probleme: true },
    [[etape('terminer', { raison: 'je ne trouve pas de bois' })], [etape('attendre', { duree: 0.2 })], [etape('terminer', { raison: 'toujours rien' })]])
  assert.ok(libre.appels >= 3, 'le premier arret motive est refuse')
  // Apres un echec : accepte, la raison est dite.
  const bloque = await jouerFactice({ replan_probleme: true },
    [[etape('fabriquer', { objet: 'truc' })], [etape('terminer', { raison: 'aucune recette pour truc' })]])
  assert.equal(bloque.status.etat, 'failed')
  assert.equal(bloque.status.raison, 'bloque : aucune recette pour truc')
  // Sans le mode, la raison est ignoree : la fin garde la cause mesuree.
  const sans = await jouerFactice({ replan_probleme: false },
    [[etape('fabriquer', { objet: 'truc' })], [etape('terminer', { raison: 'aucune recette pour truc' })]])
  assert.doesNotMatch(String(sans.status.raison), /^bloque :/)
})

// Serveur simule : vraie recolte, vrai solveur (pioche en bois : bois, puis
// planches). La recolte du bois franchit l etape du solveur.
async function jouerEtape (replanEtape) {
  const blocks = {}
  for (let y = 200; y < 203; y++) blocks[`23,${y},20`] = 'oak_log'
  const sim = createSimServer({ blocks, start: new Vec3(20.5, 200, 20.5), borne: { x0: 0, x1: 40, z0: 0, z1: 40 } })
  planner.readBrief = async () => ({ kind: 'recolte', kindConfidence: 1, resource: 'bois', resourceConfidence: 1,
    landmark: 'ici', door: false, doorProbability: 0, fabrication: 'wooden_pickaxe', fabricationQuantite: 1 })
  servir([[etape('recolter', { quantite: 3 }), etape('dire', { texte: 'un' }), etape('dire', { texte: 'deux' })], [etape('terminer')]])
  const log = console.log
  console.log = () => {}
  let r
  try {
    r = createMissionRunner(sim.host)
    r.setFeatures({ reset: true, replan_etape: replanEtape })
    const started = await r.start('Fabrique-moi une pioche en bois', 'joueur')
    assert.ok(started.ok, started.error)
    const debut = Date.now()
    while (r.isRunning() && Date.now() - debut < 60000) await new Promise(resolve => setTimeout(resolve, 100))
    r.stop('test')
    return r.status()
  } finally {
    console.log = log
    r?.setFeatures({ reset: true })
    sim.close()
  }
}

test('replan_etape : l etape du solveur franchie (bois en poche) interrompt le plan', { timeout: 150000 }, async () => {
  const sans = await jouerEtape(false)
  assert.equal(sans.historique.filter(h => h.action === 'dire').length, 2, 'sans le mode, la file est jouee')
  const avec = await jouerEtape(true)
  assert.equal(avec.historique[0].action, 'recolter')
  assert.equal(avec.historique.filter(h => h.action === 'dire').length, 0, JSON.stringify(avec.historique))
  assert.equal(avec.replans.etape, 1)
})
