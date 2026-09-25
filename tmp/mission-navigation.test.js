'use strict'

process.env.MISSION_TICK_MS = '1'
process.env.MISSION_QUEUE_TICK_MS = '1'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const planner = require('../bot/planner')
const craft = require('../bot/craft')
const { createMissionRunner } = require('../bot/mission')
planner.isEnabled = () => true
const brief = { kind: 'geste', kindConfidence: 1, resource: 'aucune', resourceConfidence: 1,
  landmark: 'ici', door: false, doorProbability: 0 }
craft.targetCriteria = () => ({})

function runner (plans, reached) {
  planner.readBrief = async () => brief
  let calls = 0
  planner.plan = async () => {
    const action = plans[Math.min(calls++, plans.length - 1)]
    return { ms: 0, seconds: 1, rejected: [], done: action === 'fini' ? 1 : 0, finished: action === 'fini',
      steps: [{ action, scale: 0, scaleLevel: null, choices: { texte: 'test' } }] }
  }
  const bot = { entity: { position: new Vec3(0, 65, 0), yaw: 0, pitch: 0 },
    registry: { blocksByName: {}, itemsByName: {} }, inventory: { items: () => [] }, players: {}, entities: {},
    findBlocks: () => [], findBlock: () => null,
    clearControlStates: () => {}, blockAt: () => null }
  let joins = 0
  const messages = []
  const r = createMissionRunner({ getBot: () => bot, isReady: () => true,
    inLiquid: () => false, stopPathfinding: () => {}, chat: text => messages.push(text),
    navigateToPlayer: async () => { joins++; return { reached, code: reached ? 'arrived' : 'stuck', remaining: reached ? 1 : 10 } },
    navigateToPosition: async () => ({ reached, code: reached ? 'arrived' : 'stuck', remaining: 0.5 }) })
  return { r, bot, messages, get joins () { return joins } }
}
async function finished (r) {
  for (let i = 0; i < 300 && r.isRunning(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(r.isRunning(), false)
  return r.status()
}

function highTargetFixture ({ stock = 2, low = false, high = true, kind = 'recolte', navigationResult = null } = {}) {
  planner.readBrief = async () => ({ ...brief, kind, resource: 'bois' })
  let plans = 0
  planner.plan = async () => ({ ms: 0, seconds: 1, rejected: [], done: 0, finished: false,
    steps: [{ action: plans++ === 0 ? 'avancer' : 'terminer', scale: 0, scaleLevel: null, choices: { distance: 1 } }] })
  const positions = [...(high ? [new Vec3(0, 70, 0)] : []), ...(low ? [new Vec3(3, 65, 0)] : [])]
  const controls = []
  const navigation = []
  let looks = 0
  const bot = { entity: { position: new Vec3(0.5, 65, 0.5), yaw: 0, pitch: 0, onGround: true },
    registry: { blocksByName: { oak_log: { id: 1 } }, itemsByName: {} },
    inventory: { items: () => stock ? [{ name: 'dirt', count: stock }] : [] }, players: {}, entities: {},
    findBlocks: ({ matching }) => matching.includes(1) ? positions : [], findBlock: () => null,
    blockAt: position => positions.some(p => p.equals(position))
      ? { name: 'oak_log', position, shapes: [[0, 0, 0, 1, 1, 1]] }
      : { name: 'air', position, shapes: [] },
    clearControlStates () {},
    look: async () => { looks++ },
    setControlState: (control, enabled) => {
      controls.push({ control, enabled })
      if (control === 'forward' && enabled) bot.entity.position.z -= 1
    },
    dig: async () => { throw new Error('no automatic digging') },
    placeBlock: async () => { throw new Error('no automatic piling') }
  }
  const r = createMissionRunner({ getBot: () => bot, isReady: () => true, inLiquid: () => false,
    stopPathfinding () {}, chat () {}, navigateToPosition: async (position, options) => {
      navigation.push({ position, options })
      return navigationResult ?? { reached: true, code: 'arrived', travelled: 1 }
    } })
  return { r, bot, controls, navigation, get looks () { return looks } }
}

test('etat secondaire mesure la cible effective de casser, permission distincte de disponibilite', async () => {
  for (const variant of ['available', 'absent', 'support', 'deep', 'far', 'enough_stock', 'wood_first']) {
    const f = highTargetFixture({ stock: variant === 'enough_stock' ? 6 : 2, low: variant === 'wood_first' })
    const dirt = variant === 'support' ? new Vec3(0, 64, 0)
      : variant === 'deep' ? new Vec3(2, 63, 0)
        : variant === 'far' ? new Vec3(8, 65, 0) : new Vec3(2, 65, 0)
    f.bot.registry.blocksByName.dirt = { id: 2 }
    const originalFind = f.bot.findBlocks
    const originalAt = f.bot.blockAt
    f.bot.findBlocks = options => options.matching.includes(2)
      ? variant === 'absent' ? [] : [dirt] : originalFind(options)
    f.bot.blockAt = position => position.equals(dirt)
      ? { name: 'dirt', position, shapes: [[0, 0, 0, 1, 1, 1]] } : originalAt(position)
    const states = []
    const checked = []
    const originalHarvestCheck = craft.harvestCheck
    craft.harvestCheck = (_bot, block) => {
      checked.push(block)
      return { ok: false, need: 'test', reason: 'stop before physical dig' }
    }
    planner.plan = async state => {
      states.push(state)
      return { ms: 0, seconds: 1, rejected: [], done: 0, finished: false,
        steps: [{ action: states.length === 1 ? 'casser' : 'terminer', scale: 0, scaleLevel: null, choices: {} }] }
    }
    try {
      await f.r.start('ramasse du bois', 'human')
      await finished(f.r)
    } finally { craft.harvestCheck = originalHarvestCheck }
    const env = states[0].environnement
    assert.equal(env.dirt_secondaire_admise, variant !== 'enough_stock')
    if (variant === 'available') {
      assert.deepEqual(env.dirt_secondaire_cible, {
        nom: 'dirt', position: { x: 2, y: 65, z: 0 }, distance: 2.06, a_portee: true
      })
      assert.equal(checked[0].name, 'dirt')
      assert.deepEqual(checked[0].position, dirt)
    } else assert.equal(env.dirt_secondaire_cible, null, variant)
    if (variant === 'wood_first') assert.equal(checked[0].name, 'oak_log')
  }
})

test('cible seulement en hauteur : avancer refuse sans controle ni navigation, stock mesure', async () => {
  for (const stock of [2, 0]) {
    const f = highTargetFixture({ stock })
    await f.r.start('ramasse du bois', 'human')
    const state = await finished(f.r)
    const step = state.historique.find(entry => entry.action === 'avancer')
    assert.equal(step.code, 'cible_haute')
    assert.equal(step.echec, true)
    assert.match(step.resultat, /\+5/)
    assert.match(step.resultat, new RegExp(`${stock} dirt`))
    assert.match(step.resultat, stock ? /piler.*si.*(?:appui|espace)/ : /stock court/)
    assert.deepEqual(f.controls, [])
    assert.deepEqual(f.navigation, [])
    assert.equal(f.looks, 0)
    assert.deepEqual(f.bot.entity.position, new Vec3(0.5, 65, 0.5))
  }
})

test('cible basse prioritaire sur cible haute : approche normale preservee', async () => {
  const f = highTargetFixture({ low: true })
  await f.r.start('ramasse du bois', 'human')
  const state = await finished(f.r)
  assert.equal(state.historique[0].code, 'arrived')
  assert.equal(f.navigation.length, 1)
  assert.deepEqual(f.navigation[0].position, new Vec3(3.5, 65.5, 0.5))
  assert.deepEqual(f.controls, [])
})

test('poste rapproche mais cible trop haute : besoin mesure remonte, jamais succes ni pilier automatique', async () => {
  const f = highTargetFixture({ low: true, navigationResult: {
    reached: false, code: 'needs_height', horizontalDistance: 1.8, verticalGap: 4.5,
    position: { x: 3.5, y: 60, z: 0.5 }, remaining: 4.85, travelled: 4
  } })
  await f.r.start('ramasse du bois', 'human')
  const state = await finished(f.r)
  const step = state.historique[0]
  assert.equal(f.navigation[0].options.allowHighApproach, true)
  assert.equal(f.navigation[0].options.interaction, true)
  assert.equal(step.code, 'needs_height')
  assert.equal(step.echec, true)
  assert.match(step.resultat, /1.8.*\+4.5.*hors portee/)
  assert.equal(state.etat, 'failed')
  assert.equal(state.blocs_casses, 0)
  assert.deepEqual(f.controls, [])
})

test('geste explicite et exploration sans cible haute gardent leur deplacement libre', async () => {
  for (const options of [{ kind: 'geste' }, { high: false }]) {
    const f = highTargetFixture(options)
    await f.r.start(options.kind ? 'avance un bloc' : 'ramasse du bois', 'human')
    const state = await finished(f.r)
    const step = state.historique.find(entry => entry.action === 'avancer')
    assert.equal(step.echec, false)
    assert.ok(f.controls.some(c => c.control === 'forward' && c.enabled))
    assert.deepEqual(f.navigation, [])
    assert.deepEqual(f.bot.entity.position, new Vec3(0.5, 65, -0.5))
  }
})

test('ramasser objet procheXZ mais autre etage navigue en modepickup ; gain inventaire seul prouve collecte', async () => {
  for (const gained of [0, 1]) {
    planner.readBrief = async () => ({ ...brief, kind: 'recolte', resource: 'bois' })
    let plans = 0
    const states = []
    planner.plan = async state => {
      states.push(state)
      return { ms: 0, seconds: 1, rejected: [], done: 0, finished: false,
        steps: [{ action: plans++ === 0 ? 'ramasser' : 'terminer', scale: 0, scaleLevel: null, choices: { quantite: 1 } }] }
    }
    let stock = 0
    const target = new Vec3(1.5, 63, 0.5)
    const bot = { entity: { position: new Vec3(0.5, 65, 0.5), yaw: 0, pitch: 0, onGround: true },
      registry: { blocksByName: {}, itemsByName: {} },
      inventory: { items: () => stock ? [{ name: 'oak_log', count: stock }] : [] }, players: {},
      entities: { item: { name: 'item', position: target } }, findBlocks: () => [], findBlock: () => null,
      blockAt: p => p.y === 62 || (p.x === 0 && p.y === 64)
        ? { name: 'stone', position: p, shapes: [[0, 0, 0, 1, 1, 1]] }
        : { name: 'air', position: p, shapes: [] }, clearControlStates () {} }
    const navigation = []
    const r = createMissionRunner({ getBot: () => bot, isReady: () => true, inLiquid: () => false,
      stopPathfinding () {}, chat () {}, navigateToPosition: async (position, options) => {
        navigation.push(options)
        bot.entity.position = position.clone()
        stock = gained
        return { reached: true, code: 'arrived' }
      } })
    await r.start('ramasse un bloc de bois', 'human')
    const state = await finished(r)
    assert.equal(states[0].environnement.navigation_objet.a_portee, false)
    assert.equal(navigation.length, 1)
    assert.equal(navigation[0].pickup, true)
    assert.equal(navigation[0].radius, 1.6)
    const step = state.historique.find(entry => entry.action === 'ramasser')
    assert.equal(step.echec, gained === 0)
    assert.match(step.resultat, new RegExp(`\\+${gained} dans l inventaire`))
    assert.equal(state.objets_recoltes, gained)
  }
})

test('approche ressource : delegation du trajet, budget et signal, sans gestes du modele', async () => {
  planner.readBrief = async () => ({ ...brief, kind: 'recolte', resource: 'sable' })
  let plans = 0
  planner.plan = async () => ({ ms: 0, seconds: 1, rejected: [], done: 0, finished: false,
    steps: [{ action: plans++ === 0 ? 'avancer' : 'terminer', scale: 0, scaleLevel: null, choices: { distance: 12 } }] })
  const target = new Vec3(8, 65, 0)
  const bot = { entity: { position: new Vec3(0.5, 65, 0.5), yaw: 0, pitch: 0, onGround: true },
    registry: { blocksByName: { sand: { id: 1 } }, itemsByName: {} },
    inventory: { items: () => [] }, players: {}, entities: {},
    findBlocks: ({ matching }) => matching.includes(1) ? [target] : [], findBlock: () => null,
    blockAt: p => p.equals(target) ? { name: 'sand', position: target, shapes: [[0, 0, 0, 1, 1, 1]] }
      : { name: 'air', position: p, shapes: [] },
    clearControlStates: () => {}, setControlState: () => { throw new Error('pas de gestes directs pour une cible') } }
  const calls = []
  const r = createMissionRunner({ getBot: () => bot, isReady: () => true, inLiquid: () => false,
    stopPathfinding: () => {}, chat: () => {},
    navigateToPosition: async (position, options) => {
      calls.push({ position, options })
      return { reached: false, code: 'advanced', travelled: 12 }
    } })
  await r.start('ramasse du sable', 'human')
  const state = await finished(r)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].position, target.offset(0.5, 0.5, 0.5))
  assert.equal(calls[0].options.distanceBudget, 12)
  assert.equal(calls[0].options.interaction, true)
  assert.ok(calls[0].options.signal instanceof AbortSignal)
  // Avancer partiellement ne prouve ni collecte ni objectif termine.
  assert.equal(state.etat, 'failed')
})
test('navigation reussie : mission done', async () => {
  const f = runner(['rejoindre_demandeur'], true)
  await f.r.start('viens', 'human')
  assert.equal((await finished(f.r)).etat, 'done')
})
test('navigation echouee : trois essais puis failed, jamais done sans succes', async () => {
  const f = runner(['rejoindre_demandeur'], false)
  await f.r.start('viens', 'human')
  assert.equal((await finished(f.r)).etat, 'failed')
  assert.equal(f.joins, 3)
})
test('dire apres echec ne blanchit pas la mission', async () => {
  const f = runner(['rejoindre_demandeur', 'dire'], false)
  await f.r.start('viens', 'human')
  assert.equal((await finished(f.r)).etat, 'failed')
})
test('terminer apres echec ne blanchit pas la mission', async () => {
  const f = runner(['rejoindre_demandeur', 'terminer'], false)
  await f.r.start('viens', 'human')
  assert.equal((await finished(f.r)).etat, 'failed')
})
test('stop pendant readBrief empeche un demarrage tardif', async () => {
  const f = runner(['rejoindre_demandeur'], true)
  let release
  planner.readBrief = () => new Promise(resolve => { release = resolve })
  const starting = f.r.start('viens', 'human')
  f.r.stop()
  release(brief)
  assert.equal((await starting).ok, false)
  assert.equal(f.r.isRunning(), false)
  assert.equal(f.joins, 0)
})

test('fini repete apres echec aboutit a failed, meme apres trois refus', async () => {
  const f = runner(['rejoindre_demandeur', 'fini'], false)
  await f.r.start('viens', 'human')
  assert.equal((await finished(f.r)).etat, 'failed')
})

test('parcours compose integre : quatre preuves, aucun micro-plan LLM', async () => {
  const f = runner([], true)
  planner.readBrief = async () => ({ ...brief, route: require('../bot/movement-task').validateRoute([{ type: 'aller_retour', repetitions: 2 }]) })
  planner.plan = async () => { throw new Error('un parcours ne doit pas demander un micro-plan') }
  await f.r.start('deux allers-retours', 'human')
  const result = await finished(f.r)
  assert.equal(result.etat, 'done')
  assert.equal(result.parcours.cursor, 4)
  assert.equal(f.joins, 2)
})

test('revision conserve les sous-objectifs prouves et le depart initial', async () => {
  const f = runner([], true)
  let calls = 0
  planner.readBrief = async () => ({ ...brief, route: [{ type: 'rejoindre' }, { type: 'attendre', secondes: calls++ ? 0.2 : 20 }, { type: 'retour' }] })
  await f.r.start('viens attends puis reviens', 'human')
  await new Promise(resolve => setTimeout(resolve, 10))
  const before = f.r.status()
  await f.r.revise('attends moins puis reviens', 'human')
  const result = await finished(f.r)
  assert.equal(result.id, before.id)
  assert.equal(result.revision, 1)
  assert.equal(result.etat, 'done')
  assert.deepEqual(result.parcours.origin, before.parcours.origin)
  assert.equal(f.joins, 1)
})
test('autorisation contextuelle et reservation conservee apres revision', async () => {
  const f = runner([], true)
  let calls = 0
  planner.readBrief = async () => ({ ...brief, route: [{ type: 'attendre', secondes: calls++ ? 0.2 : 20 }] })
  await f.r.start('attends', 'human')
  f.r.addContext('tu peux casser un bloc', 'human', { clearanceBlocks: 1 })
  const permission = f.r.status().parcours.clearance
  const digger = { canDigBlock: () => true, dig: async () => {}, blockAt: () => ({ name: 'air', shapes: [] }), stopDigging: () => {} }
  await require('../bot/tree-position').clearOne(digger, { name: 'oak_leaves', position: new Vec3(0, 1, 0) }, permission, new AbortController().signal)
  await f.r.revise('attends moins', 'human')
  const result = await finished(f.r)
  assert.deepEqual(result.autorisations.degagement, { limite: 1, consomme: 1 })
})
test('livraison mesuree : echec de don constate, jamais de succes fictif', async () => {
  // La capacite `donner` existe (delivery.js) : plus de refus global avant
  // execution. L echec se mesure a l execution (ici stock vide).
  const f = runner([], true)
  planner.readBrief = async () => ({ ...brief, kind: 'recolte', resource: 'sable', needsTransfer: true })
  planner.plan = async () => ({
    ms: 0, seconds: 1, rejected: [], done: 0, finished: false,
    steps: [{ action: 'donner', scale: 0, scaleLevel: null, choices: { objet: 'sand', quantite: 1, destinataire: 'human' } }]
  })
  const admitted = await f.r.start('casse un bloc de sable et donne-le moi', 'human')
  assert.equal(admitted.ok, true)
  const result = await finished(f.r)
  assert.equal(result.etat, 'failed')
  const don = result.historique.find((h) => h.action === 'donner')
  assert.ok(don, 'le don a ete tente et journalise')
  assert.equal(don.echec, true)
  assert.match(don.resultat, /insufficient_stock|don impossible/)
  assert.equal(f.joins, 0)
})
test('un parcours reussi et un echec produisent un resultat dans le chat', async () => {
  for (const reached of [true, false]) {
    const f = runner([], reached)
    planner.readBrief = async () => ({ ...brief, route: [{ type: 'rejoindre' }] })
    await f.r.start('viens', 'human')
    await finished(f.r)
    assert.ok(f.messages.some(t => reached ? /J ai termine/.test(t) : /pas pu terminer/.test(t)))
    assert.equal(f.r.status().activite.phase, reached ? 'done' : 'failed')
  }
})
test('terminer ne transforme plus un quota non atteint en succes', async () => {
  for (const quantity of ['1', 'un']) {
  const f = runner(['terminer'], true)
  planner.readBrief = async () => ({ ...brief, kind: 'recolte', resource: 'sable' })
  await f.r.start(`casse ${quantity} bloc de sable`, 'human')
  const result = await finished(f.r)
  assert.equal(result.etat, 'failed')
  assert.match(result.raison, /0 unite.*recoltee.*sur 1 demandee/)
  assert.ok(f.messages.some(t => /pas pu terminer/.test(t)))
  }
})
