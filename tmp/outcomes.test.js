'use strict'

process.env.MISSION_TICK_MS = '1'
process.env.MISSION_QUEUE_TICK_MS = '1'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { Vec3 } = require('vec3')
const skills = require('../bot/skills')
const outcomes = require('../bot/outcomes')
const planner = require('../bot/planner')
const craft = require('../bot/craft')
const { createMissionRunner } = require('../bot/mission')

const source = fs.readFileSync(path.join(__dirname, '..', 'bot', 'mission.js'), 'utf8')

// Chaque code d echec ecrit dans mission.js est connu du registre : un echec
// nouveau sans remede declare casse ce test, pas le banc.
test('chaque code litteral de mission.js a une entree de remedes', () => {
  const codes = new Set([...source.matchAll(/code: '([a-z_]+)'/g)].map(m => m[1]))
  assert.ok(codes.size > 10)
  const manquants = [...codes].filter(code => !Object.prototype.hasOwnProperty.call(outcomes.REMEDES, code))
  assert.deepEqual(manquants, [])
})

test('chaque remede nomme une action du catalogue', () => {
  const actions = new Set(Object.keys(skills.ACTIONS))
  for (const [code, remedes] of Object.entries(outcomes.REMEDES)) {
    for (const nom of remedes) assert.ok(actions.has(nom), `${code} -> ${nom}`)
  }
  for (const [action, remedes] of Object.entries(outcomes.REMEDES_PAR_ACTION)) {
    assert.ok(actions.has(action), action)
    for (const nom of remedes) assert.ok(actions.has(nom), `${action} -> ${nom}`)
  }
  for (const nom of outcomes.SANS_GARDE) assert.ok(actions.has(nom), nom)
})

test('un echec sans code recoit le code generique et les remedes de son action', () => {
  const r = outcomes.normaliser('avancer', { resultat: 'bloque', echec: true }, skills.ACTIONS)
  assert.equal(r.code, 'avancer_echec')
  assert.deepEqual(r.remedes, outcomes.REMEDES_PAR_ACTION.avancer)
  const ok = outcomes.normaliser('avancer', { resultat: 'avance de 3' }, skills.ACTIONS)
  assert.equal(ok.code, undefined)
  assert.equal(ok.remedes, undefined)
  const haute = outcomes.normaliser('avancer', { resultat: 'x', echec: true, code: 'cible_haute' }, skills.ACTIONS)
  assert.deepEqual(haute.remedes, ['piler', 'casser'])
})

test('garde : troisieme echec identique refuse, succes ou changement le libere', () => {
  const g = outcomes.createLoopGuard()
  const cell = new Vec3(1, 65, 2)
  const sig = outcomes.signature('casser', { duree: 4 }, cell, 3)
  const echec = { resultat: 'aucun bloc', echec: true, code: 'casser_echec', remedes: ['avancer'] }
  assert.equal(g.refuse(sig), null)
  g.note(sig, echec)
  assert.equal(g.refuse(sig), null)
  g.note(sig, echec)
  assert.equal(g.refuse(sig).resultat, 'aucun bloc')
  // Autre case, autres parametres ou autre inventaire : rejouable.
  assert.equal(g.refuse(outcomes.signature('casser', { duree: 4 }, cell.offset(1, 0, 0), 3)), null)
  assert.equal(g.refuse(outcomes.signature('casser', { duree: 6 }, cell, 3)), null)
  assert.equal(g.refuse(outcomes.signature('casser', { duree: 4 }, cell, 4)), null)
  g.note(sig, { resultat: 'casse 1' })
  g.note(sig, echec)
  assert.equal(g.refuse(sig), null, 'un succes entre deux echecs libere')
  // Actions qui dependent d un autre joueur : jamais gardees.
  assert.equal(outcomes.signature('rejoindre_demandeur', {}, cell, 3), null)
})

test('mission : la meme etape en echec n est jouee que deux fois, la troisieme est refusee avec ses remedes', async () => {
  planner.isEnabled = () => true
  craft.targetCriteria = () => ({})
  planner.readBrief = async () => ({ kind: 'recolte', kindConfidence: 1, resource: 'bois', resourceConfidence: 1,
    landmark: 'ici', door: false, doorProbability: 0 })
  let plans = 0
  planner.plan = async () => ({ ms: 0, seconds: 1, rejected: [], done: 0, finished: false,
    steps: [{ action: plans++ < 3 ? 'fabriquer' : 'terminer', scale: 0, scaleLevel: null, choices: { objet: 'truc' } }] })
  const bot = { entity: { position: new Vec3(0.5, 65, 0.5), yaw: 0, pitch: 0, onGround: true },
    registry: { blocksByName: { oak_log: { id: 1 } }, itemsByName: {} }, inventory: { items: () => [] },
    players: {}, entities: {}, findBlocks: () => [], findBlock: () => null,
    blockAt: position => ({ name: 'air', position, boundingBox: 'empty', shapes: [] }),
    clearControlStates () {}, setControlState () {}, look: async () => {} }
  const r = createMissionRunner({ getBot: () => bot, isReady: () => true, inLiquid: () => false,
    stopPathfinding () {}, chat () {}, navigateToPosition: async () => ({ reached: false, code: 'no_path' }) })
  await r.start('coupe du bois', 'human')
  for (let i = 0; i < 400 && r.isRunning(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  r.stop('test')
  const casses = r.status().historique.filter(h => h.action === 'fabriquer')
  assert.equal(casses.length, 3)
  assert.equal(casses[0].echec, true)
  assert.equal(casses[0].resultat, casses[1].resultat)
  assert.equal(casses[2].code, 'repetition')
  assert.match(casses[2].resultat, /repetition refusee : fabriquer a deja rendu deux fois/)
  assert.ok(Array.isArray(casses[0].remedes) && casses[0].remedes.length > 0)
  assert.ok(!casses[2].remedes?.includes('fabriquer'))
})
