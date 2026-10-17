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

function highTargetFixture ({ stock = 2, low = false, high = true, kind = 'recolte', navigationResult = null, feetY = 65 } = {}) {
  planner.readBrief = async () => ({ ...brief, kind, resource: 'bois' })
  let plans = 0
  planner.plan = async () => ({ ms: 0, seconds: 1, rejected: [], done: 0, finished: false,
    steps: [{ action: plans++ === 0 ? 'avancer' : 'terminer', scale: 0, scaleLevel: null, choices: { distance: 1 } }] })
  const positions = [...(high ? [new Vec3(0, 70, 0)] : []), ...(low ? [new Vec3(3, 65, 0)] : [])]
  const controls = []
  const navigation = []
  let looks = 0
  const bot = { entity: { position: new Vec3(0.5, feetY, 0.5), yaw: 0, pitch: 0, onGround: true },
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

// Stock en poche : le pilier mesure (denivele - portee) est tente d abord ; ici
// sans appui simule il echoue, et l echec garde le constat chiffre.
test('cible seulement en hauteur : pilier tente avec stock, sinon refus sans controle ni navigation', async () => {
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
    if (stock === 0) {
      assert.deepEqual(f.controls, [])
      assert.equal(f.looks, 0)
    } else {
      assert.ok(f.controls.every(c => c.control === 'jump'))
    }
    assert.deepEqual(f.navigation, [])
    assert.deepEqual(f.bot.entity.position, new Vec3(0.5, 65, 0.5))
  }
})

// Stock vide mais terre a cote : piler va chercher la terre lui-meme au lieu
// d un refus « stock court » qui coutait un tour de planificateur (trees/bent
// 7b01683, trees/tall 122bb4b).
test('cible seulement en hauteur, stock vide : piler va chercher la terre voisine', async () => {
  const f = highTargetFixture({ stock: 0 })
  const dirt = new Vec3(2, 65, 0)
  f.bot.registry.blocksByName.dirt = { id: 2 }
  const originalFind = f.bot.findBlocks
  const originalAt = f.bot.blockAt
  f.bot.findBlocks = options => options.matching.includes(2) ? [dirt] : originalFind(options)
  f.bot.blockAt = position => position.equals(dirt)
    ? { name: 'dirt', position, shapes: [[0, 0, 0, 1, 1, 1]] } : originalAt(position)
  const digs = []
  f.bot.lookAt = async () => {}
  f.bot.dig = async block => { digs.push(block.name); dug = true }
  let dug = false
  f.bot.inventory.items = () => dug ? [{ name: 'dirt', count: 1 }] : []
  await f.r.start('ramasse du bois', 'human')
  // A successful dig adds piler's pickup wait: poll longer than finished().
  for (let i = 0; i < 2000 && f.r.isRunning(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  const state = await finished(f.r)
  assert.ok(digs.includes('dirt'), `terre voisine visee par piler (${digs.join(', ') || 'aucun coup'})`)
  const step = state.historique.find(entry => entry.action === 'avancer')
  assert.equal(step.code, 'cible_haute', 'pose impossible, le constat chiffre reste')
  // Stock measured after the attempt, and piler's own failure kept.
  assert.match(step.resultat, /1 blocs d echafaudage \(1 dirt\)/)
  assert.match(step.resultat, /Pilier tente : /)
})

// Cible haute enfermee (aucune face visible) : ni pilier ni terre prise pour
// elle, meme regle de vue que findTargetBlock.
test('cible haute enfermee : aucun pilier automatique', async () => {
  const f = highTargetFixture({ stock: 2 })
  const log = new Vec3(0, 70, 0)
  const originalAt = f.bot.blockAt
  f.bot.blockAt = position => [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]
    .some(([x, y, z]) => position.equals(log.offset(x, y, z)))
    ? { name: 'stone', position, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : originalAt(position)
  let digs = 0
  f.bot.dig = async () => { digs++; throw new Error('no automatic digging') }
  await f.r.start('ramasse du bois', 'human')
  const state = await finished(f.r)
  const step = state.historique.find(entry => entry.action === 'avancer')
  assert.notEqual(step.code, 'cible_haute')
  assert.doesNotMatch(step.resultat, /cible haute|pilier/i)
  assert.equal(digs, 0)
})

// 32 correspondances enfouies plus proches (pierre sous le sol) ne remplissent
// pas le plafond de resultats : le filtre de vue s applique pendant la recherche.
test('cible haute exposee trouvee malgre 32 correspondances enfouies plus proches', async () => {
  const f = highTargetFixture({ stock: 2 })
  const buried = Array.from({ length: 32 }, (_, i) => new Vec3(i % 8 - 4, 60, Math.floor(i / 8) - 2))
  const isBuried = p => buried.some(b => b.equals(p))
  const nearBuried = p => p.y >= 59 && p.y <= 61 && Math.abs(p.x) <= 5 && Math.abs(p.z) <= 5
  const originalAt = f.bot.blockAt
  f.bot.blockAt = position => isBuried(position) ? { name: 'oak_log', position, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
    : nearBuried(position) ? { name: 'stone', position, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : originalAt(position)
  f.bot.findBlocks = ({ matching, useExtraInfo, count }) => {
    if (!matching.includes(1)) return []
    const all = [...buried, new Vec3(0, 70, 0)]
    return (typeof useExtraInfo === 'function' ? all.filter(p => useExtraInfo(f.bot.blockAt(p))) : all).slice(0, count)
  }
  await f.r.start('ramasse du bois', 'human')
  const state = await finished(f.r)
  const step = state.historique.find(entry => entry.action === 'avancer')
  assert.equal(step.code, 'cible_haute')
  assert.match(step.resultat, /\+5/)
})

// piler est reserve a recolte et construction (skills.js) : un deplacement ne
// creuse ni ne monte de lui-meme vers une cible haute.
test('deplacement avec cible haute : aucun pilier automatique', async () => {
  const f = highTargetFixture({ stock: 2, kind: 'deplacement' })
  let digs = 0
  f.bot.dig = async () => { digs++; throw new Error('no automatic digging') }
  await f.r.start('va a cote de cet arbre', 'human')
  const state = await finished(f.r)
  const step = state.historique.find(entry => entry.action === 'avancer')
  assert.doesNotMatch(step.resultat, /Pilier tente/)
  assert.equal(f.controls.some(c => c.control === 'jump'), false)
  assert.equal(digs, 0)
})

// Pieds en y fractionnaire (atterrissage tolere, appui sur une feuille) : la
// hauteur de pilier utile se mesure depuis l'ancrage floored. Depuis un y
// brut, le poste virtuel tombe une cellule trop haut, son sol sur l'air, et le
// constat claimait « aucune hauteur de pilier » pour une cible evidente
// (banc composite 755b262 : cabane bouclee 45 min sur ce message).
test('pieds y 65.15 : pilier automatique mesure depuis l ancrage', async t => {
  const f = highTargetFixture({ stock: 2, feetY: 65.15 })
  const originalFind = f.bot.findBlocks
  const originalAt = f.bot.blockAt
  f.bot.blockAt = position => position.equals(new Vec3(3, 69, 0))
    ? { name: 'oak_log', position, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
    : originalAt(position)
  f.bot.findBlocks = options => options.matching?.includes?.(1) ? [new Vec3(3, 69, 0)] : originalFind(options)
  await f.r.start('ramasse du bois', 'human')
  const state = await finished(f.r)
  const step = state.historique.find(entry => entry.action === 'avancer')
  assert.equal(step.code, 'cible_haute')
  assert.match(step.resultat, /\+4/)
  assert.match(step.resultat, /Pilier tente/)
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

// Avec de l echafaudage en poche, avancer tente le pilier mesure (ecart -
// portee) ; s il echoue (ici : aucun appui simule), l echec dit le besoin.
test('poste rapproche mais cible trop haute : pilier mesure tente, jamais un succes sans portee', async () => {
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
  assert.match(step.resultat, /pilier de 2/)
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
  // Budget = distance du modele, au moins 1,5 x la ligne droite + 2 (48 max) :
  // cible a 8,02 blocs => ceil(12,02) + 2 = 15 > 12 demandes.
  assert.equal(calls[0].options.distanceBudget, 15)
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
    assert.ok(f.messages.some(t => reached ? /Fini/.test(t) : /Échec/.test(t)))
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
  assert.match(result.raison, /0 (unite.*recoltee|en inventaire) sur 1 demande/)
  assert.ok(f.messages.some(t => /Échec/.test(t)))
  }
})

// Pierre sous l herbe a portee, rocher a hauteur plus loin : le bloc du sol
// sous les pieds n est jamais vise tant qu il reste de la matiere a hauteur
// (sinon le bot descend en escalier, composite/bucket, y 198 sur un sol en 199).
test('matiere a hauteur avant le sol sous les pieds, le tronc garde son ordre', async () => {
  for (const variant of ['pierre', 'pierre_seule', 'bois']) {
    const f = highTargetFixture({ high: false })
    const nom = variant === 'bois' ? 'oak_log' : 'stone'
    // Sol de pierre sous les pieds : 100 blocs plus proches que le rocher,
    // au-dela des plafonds de la recherche (64, puis 32 gardes).
    const sol = []
    for (let x = -5; x <= 5 && sol.length < 100; x++) {
      for (let z = -5; z <= 5 && sol.length < 100; z++) {
        if (Math.hypot(x, z) >= 2 && Math.hypot(x, z) < 5.9) sol.push(new Vec3(x, 64, z))
      }
    }
    const dessous = variant === 'bois' ? [new Vec3(2, 64, 0)] : sol
    const hauteur = new Vec3(6, 65, 0)
    const blocs = variant === 'pierre_seule' ? dessous : [...dessous, hauteur]
    planner.readBrief = async () => ({ ...brief, kind: 'recolte', resource: variant === 'bois' ? 'bois' : 'pierre' })
    f.bot.registry.blocksByName = { [nom]: { id: 1 } }
    f.bot.findBlocks = ({ matching }) => matching.includes(1) ? blocs : []
    f.bot.blockAt = position => blocs.some(p => p.equals(position))
      ? { name: nom, position, shapes: [[0, 0, 0, 1, 1, 1]] }
      : { name: 'air', position, shapes: [] }
    const checked = []
    const originalHarvestCheck = craft.harvestCheck
    craft.harvestCheck = (_bot, block) => {
      checked.push(block.position)
      return { ok: false, need: 'test', reason: 'stop before physical dig' }
    }
    let n = 0
    planner.plan = async () => ({ ms: 0, seconds: 1, rejected: [], done: 0, finished: false,
      steps: [{ action: n++ === 0 ? 'casser' : 'terminer', scale: 0, scaleLevel: null, choices: {} }] })
    try {
      await f.r.start(variant === 'bois' ? 'ramasse du bois' : 'ramasse de la pierre', 'human')
      await finished(f.r)
    } finally { craft.harvestCheck = originalHarvestCheck }
    const vise = checked[0] ?? f.navigation[0]?.position
    assert.ok(vise, variant)
    if (variant === 'pierre') assert.deepEqual([Math.floor(vise.x), Math.floor(vise.y)], [6, 65], variant)
    else assert.equal(Math.floor(vise.y), 64, variant)
  }
})

// Exclusions d une position (secteur, chantier, bornes) avant les plafonds de
// la recherche : 32 blocs plus proches hors du cone cachaient le seul bloc du
// cone (revue de #75, meme defaut qu une emprise de chantier pleine).
test('cone de regard : les blocs hors du cone ne remplissent pas la recherche', async () => {
  const blocs = []
  for (let y = 65; y <= 68; y++) for (let z = -7; z <= -1; z++) for (let x = z + 1; x <= -z - 1; x++) {
    if ((x + y + z) % 2 === 0) blocs.push(new Vec3(x, y, z))
  }
  blocs.push(new Vec3(8, 65, 0))
  planner.readBrief = async () => ({ kind: 'recolte', kindConfidence: 1, resource: 'pierre', resourceConfidence: 1, landmark: 'ici', door: false, doorProbability: 0 })
  let n = 0
  planner.plan = async () => ({ ms: 0, seconds: 1, rejected: [], done: 0, finished: false,
    steps: [{ action: n++ === 0 ? 'regarder_autour' : 'terminer', scale: 0, scaleLevel: null, choices: {} }] })
  const bot = { entity: { position: new Vec3(0.5, 65, 0.5), yaw: 0, pitch: 0, onGround: true },
    registry: { blocksByName: { stone: { id: 1 } }, blocks: { 1: { name: 'stone' } }, itemsByName: {} },
    inventory: { items: () => [] }, players: {}, entities: {},
    findBlocks: ({ matching, useExtraInfo, count, point }) => blocs
      .filter(p => [].concat(matching).includes(1) && (!useExtraInfo || useExtraInfo({ position: p })))
      .sort((a, b) => a.distanceTo(point) - b.distanceTo(point)).slice(0, count),
    findBlock: () => null,
    blockAt: position => blocs.some(p => p.equals(position))
      ? { name: 'stone', position, shapes: [[0, 0, 0, 1, 1, 1]] } : { name: 'air', position, shapes: [] },
    clearControlStates () {}, look: async () => {}, lookAt: async () => {}, setControlState () {} }
  const r = createMissionRunner({ getBot: () => bot, isReady: () => true, inLiquid: () => false, stopPathfinding () {}, chat () {} })
  const lignes = []
  const log = console.log
  console.log = (...a) => { lignes.push(a.join(' ')) }
  try {
    await r.start('ramasse de la pierre', 'test')
    for (let i = 0; i < 200 && r.status?.()?.active !== false && !lignes.some(l => l.includes('tour d horizon')); i++) await new Promise(res => setTimeout(res, 10))
  } finally { console.log = log; r.stop?.() }
  const l = lignes.find(x => x.includes('tour d horizon')) ?? ''
  assert.match(l, /est : stone/)
})
