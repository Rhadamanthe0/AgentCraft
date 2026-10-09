'use strict'

// Un modele muet par moments (bancs du 2026-10-07/08 : 67 a 122 plans sans
// reponse par banc complet, alors que les autres bots recoivent les leurs)
// ne doit pas tuer une mission en une minute : une serie de silences est
// toleree pendant MISSION_PLANNER_OUTAGE_MS ; un refus (403...) arrete
// toujours au troisieme echec.

process.env.MISSION_TICK_MS = '1'
process.env.MISSION_QUEUE_TICK_MS = '1'
process.env.MISSION_BRIEF_NOTICE_MS = '0'
process.env.MISSION_PLANNER_OUTAGE_MS = '90000'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const planner = require('../bot/planner')
const craft = require('../bot/craft')
const { createMissionRunner } = require('../bot/mission')
const brief = { kind: 'recolte', kindConfidence: 1, resource: 'bois', resourceConfidence: 1, landmark: 'ici', door: false, doorProbability: 0 }

function fixture (t, failure, callMs = 20000) {
  let now = 1000000
  t.mock.method(Date, 'now', () => now)
  t.mock.method(planner, 'isEnabled', () => true)
  t.mock.method(craft, 'targetCriteria', () => ({}))
  t.mock.method(planner, 'readBrief', async () => brief)
  let calls = 0
  // Chaque appel dure callMs (20 s : delai total du plan) puis echoue.
  t.mock.method(planner, 'plan', async () => { calls += 1; now += callMs; throw failure() })
  const bot = { entity: { position: new Vec3(0, 65, 0), yaw: 0, pitch: 0 },
    registry: { blocksByName: {}, itemsByName: {} }, inventory: { items: () => [] }, players: {}, entities: {},
    findBlocks: () => [], findBlock: () => null, blockAt: () => null, clearControlStates () {} }
  const runner = createMissionRunner({ getBot: () => bot, isReady: () => true,
    inLiquid: () => false, stopPathfinding () {}, chat () {}, navigateToPlayer: async () => {} })
  t.after(() => runner.stop('test cleanup'))
  return { runner, calls: () => calls }
}

async function ended (runner) {
  for (let i = 0; i < 400 && runner.isRunning(); i++) await new Promise(resolve => setTimeout(resolve, 2))
}

test('silences du modele : la mission tient au-dela de trois appels muets', async t => {
  const f = fixture(t, () => Object.assign(new Error('planificateur indisponible : pas de reponse en 9997 ms'), { passager: true }))
  await f.runner.start('coupe du bois', 'human')
  await ended(f.runner)
  assert.equal(f.runner.status().etat, 'failed')
  assert.match(f.runner.status().raison, /planificateur indisponible/)
  // Premier echec date a 20 s ; abandon quand la serie depasse 90 s : 6 appels.
  assert.equal(f.calls(), 6, `appels avant abandon : ${f.calls()}`)
})

test('reseau coupe (fetch failed) : panne passagere, toleree comme un silence', async t => {
  const f = fixture(t, () => Object.assign(new Error('planificateur indisponible : fetch failed'), { passager: true }), 10000)
  await f.runner.start('coupe du bois', 'human')
  await ended(f.runner)
  assert.equal(f.runner.status().etat, 'failed')
  assert.equal(f.calls(), 10, `appels avant abandon : ${f.calls()}`)
})

test('refus du gateway (403) : abandon au troisieme echec, sans attendre', async t => {
  const f = fixture(t, () => Object.assign(new Error('planificateur indisponible : HTTP 403 FreeTierError'), { passager: false }))
  await f.runner.start('coupe du bois', 'human')
  await ended(f.runner)
  assert.equal(f.runner.status().etat, 'failed')
  assert.equal(f.calls(), 3)
})

test('lecture de l objectif : un reseau coupe se rejoue, la mission demarre', async t => {
  const f = fixture(t, () => Object.assign(new Error('planificateur indisponible : pas de reponse'), { passager: true }))
  let lectures = 0
  planner.readBrief.mock.mockImplementation(async () => {
    lectures += 1
    if (lectures <= 2) throw Object.assign(new TypeError('fetch failed'), { code: 'LLM_NETWORK' })
    return brief
  })
  const out = await f.runner.start('coupe du bois', 'human')
  assert.equal(lectures, 3)
  assert.notEqual(out?.ok, false, `demarrage refuse : ${out?.error}`)
})
