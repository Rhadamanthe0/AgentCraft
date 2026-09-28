'use strict'

process.env.MISSION_TICK_MS = '1'
process.env.MISSION_QUEUE_TICK_MS = '1'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const planner = require('../bot/planner')
const { createMissionRunner } = require('../bot/mission')
planner.isEnabled = () => true

// La porte lue par le modele n est gardee que si le joueur en parle
// (build/arch 295e295 : « arche en pierre » lue « porte oui »).
function runner () {
  planner.readBrief = async () => ({ kind: 'construction', kindConfidence: 1, resource: 'pierre', resourceConfidence: 1,
    landmark: 'ici', door: true, doorProbability: 0.9 })
  planner.plan = async () => ({ ms: 0, seconds: 1, rejected: [], done: 0, finished: false,
    steps: [{ action: 'terminer', scale: 0, scaleLevel: null, choices: {} }] })
  const bot = { entity: { position: new Vec3(0.5, 65, 0.5), yaw: 0, pitch: 0, onGround: true },
    registry: { blocksByName: {}, itemsByName: {} }, inventory: { items: () => [] }, players: {}, entities: {},
    findBlocks: () => [], findBlock: () => null, blockAt: position => ({ name: 'air', position, shapes: [] }),
    clearControlStates () {}, look: async () => {}, lookAt: async () => {}, setControlState () {} }
  const logs = []
  const r = createMissionRunner({ getBot: () => bot, isReady: () => true, inLiquid: () => false,
    stopPathfinding () {}, chat () {} })
  return { r, logs }
}

async function porteLue (texte) {
  const { r } = runner()
  const lignes = []
  const log = console.log
  console.log = (...a) => { lignes.push(a.join(' ')); log(...a) }
  try {
    await r.start(texte, 'test')
  } finally { console.log = log }
  r.stop?.()
  return lignes.find(l => l.includes(`"${texte}"`)) ?? ''
}

test('porte lue par le modele mais absente du texte : non demandee', async () => {
  assert.match(await porteLue('Construis une arche en pierre de 5 blocs de large et 4 de haut'), /porte non \(non demandee\)/)
})

test('porte citee par le joueur : gardee', async () => {
  assert.match(await porteLue('Construis une maison en terre de 3 par 3 par 3 avec une porte'), /porte oui/)
})
