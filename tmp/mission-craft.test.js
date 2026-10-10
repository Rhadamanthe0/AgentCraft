'use strict'

// Objectif fabrication generique (sans regex de phrase) : brief -> cible
// validee registre + quantite codee, fin par preuve mesuree.
// Tout le reseau est moque (readBrief/plan simules) sauf le primitif craft
// isole (2 buches -> 8 planches, non-regression live).
// Lancement : node --test tmp/mission-craft.test.js (voir tmp/craft.test.js
// pour la forme Docker).

process.env.MISSION_TICK_MS = '1'
process.env.MISSION_QUEUE_TICK_MS = '1'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')

const planner = require('../bot/planner')
const craft = require('../bot/craft')
const skills = require('../bot/skills')
const missionMod = require('../bot/mission')
const { createMissionRunner } = missionMod

planner.isEnabled = () => true

const origReadBrief = planner.readBrief
const origPlan = planner.plan
const origMake = craft.make
const origTargetCriteria = craft.targetCriteria

function restorePlanner () {
  planner.readBrief = origReadBrief
  planner.plan = origPlan
}

function restoreCraft () {
  craft.make = origMake
  craft.targetCriteria = origTargetCriteria
}

function fakeBot (stock = {}, extraItems = []) {
  const state = { ...stock }
  const itemsByName = {}
  for (const name of [...Object.keys(state), ...extraItems,
    'oak_log', 'oak_planks', 'stick', 'crafting_table',
    'wooden_axe', 'stone_axe', 'oak_door', 'torch', 'stone_pickaxe', 'stone_sword', 'cobblestone']) {
    itemsByName[name] = { id: name, name }
  }
  return {
    _stock: state,
    entity: { position: new Vec3(0, 65, 0), yaw: 0, pitch: 0, onGround: true, velocity: { y: 0 } },
    registry: { blocksByName: {}, itemsByName },
    inventory: {
      items: () => Object.entries(state)
        .filter(([, c]) => c > 0)
        .map(([name, count]) => ({ name, count }))
    },
    players: {},
    entities: {},
    findBlocks: () => [],
    findBlock: () => null,
    blockAt: () => null,
    blockAtCursor: () => null,
    clearControlStates: () => {},
    setControlState: () => {},
    look: async () => {},
    lookAt: async () => {}
  }
}

function realShapeBrief (overrides = {}) {
  return {
    kind: 'recolte',
    kindConfidence: 0.9,
    resource: 'bois',
    resourceConfidence: 0.9,
    resourceProbabilities: null,
    landmark: 'ici',
    landmarkConfidence: 0.9,
    door: false,
    doorProbability: 0,
    route: null,
    clearanceLimit: 0,
    needsTransfer: false,
    needsWeb: false,
    fabrication: null,
    fabricationQuantite: null,
    usage: null,
    ms: 1,
    ...overrides
  }
}

function planSteps (actions) {
  // actions : ['fabriquer:hache:1', 'terminer'] ou {finished:true,done:1}
  return actions.map(a => {
    if (a && typeof a === 'object' && a.finished) return a
    const [action, objet, quantite] = String(a).split(':')
    const choices = {}
    if (objet) choices.objet = objet
    if (quantite) choices.quantite = Number(quantite)
    if (action === 'dire') choices.texte = 'test'
    return {
      ms: 0,
      seconds: 1,
      rejected: [],
      done: 0,
      finished: false,
      steps: [{ action, scale: 0.5, scaleLevel: null, choices }]
    }
  })
}

async function runMission ({ brief, stock = {}, plans, makeStub = null }) {
  planner.readBrief = async () => brief
  const captured = []
  const queue = planSteps(plans)
  let calls = 0
  planner.plan = async (state) => {
    captured.push(JSON.parse(JSON.stringify({
      consigne: state.consigne,
      progression: state.progression,
      fabrications: state.fabrications_possibles ?? null
    })))
    const next = queue[Math.min(calls++, queue.length - 1)]
    if (next.finished) return { ...next, steps: [], rejected: [], ms: 0, seconds: 0, why: 'fini' }
    return next
  }
  if (makeStub) craft.make = makeStub
  const bot = fakeBot(stock)
  const messages = []
  const r = createMissionRunner({
    getBot: () => bot,
    isReady: () => true,
    inLiquid: () => false,
    stopPathfinding: () => {},
    chat: t => messages.push(t),
    recentChat: () => [],
    navigateToPlayer: async () => ({ reached: true, code: 'arrived', remaining: 0 }),
    navigateToPosition: async () => ({ reached: true, code: 'arrived', remaining: 0 })
  })
  const admitted = await r.start(brief._texte ?? 'fabrique une hache', 'human')
  assert.equal(admitted.ok, true)
  for (let i = 0; i < 400 && r.isRunning(); i++) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(r.isRunning(), false)
  return { status: r.status(), captured, messages, bot }
}

test('normalisation generique : alias FR + item direct, sans phrase hardcodee', () => {
  assert.equal(skills.normalizeFabricationTarget('hache'), 'hache')
  assert.equal(skills.normalizeFabricationTarget('HACHE'), 'hache')
  assert.equal(skills.normalizeFabricationTarget('minecraft:torch'), 'torch')
  assert.equal(skills.normalizeFabricationTarget('batons'), 'batons')
  assert.equal(skills.normalizeFabricationTarget('stick'), 'batons')
  assert.equal(skills.normalizeFabricationTarget('oak_planks'), 'planches')
  assert.equal(skills.normalizeFabricationTarget('  EtAbLi  '), 'etabli')
  assert.equal(missionMod.fabTargetName('minecraft:torch'), 'torch')
  assert.equal(missionMod.fabTargetName('stick'), 'batons')
  // Quantite codee, pas comptee par le modele : defaut 1, lecture du chiffre, bornes.
  assert.equal(missionMod.fabricationWanted('fabrique une hache', null), 1)
  assert.equal(missionMod.fabricationWanted('fabrique 3 haches', null), 3)
  assert.equal(missionMod.fabricationWanted('fabrique une hache', 2), 2)
  assert.equal(missionMod.fabricationWanted('fabrique une hache', 99), 16)
})

test('brief fabrication requalifie geste en recolte et persiste consigne', async () => {
  try {
    // 'fabrique une hache' classait geste 0.55 puis cloturait en un plan : le
    // brief porte desormais la cible, le code requalifie en recolte (journalise).
    const brief = realShapeBrief({
      kind: 'geste', kindConfidence: 0.55, resource: 'aucune',
      fabrication: 'hache', fabricationQuantite: 1, _texte: 'fabrique une hache'
    })
    const { status, captured } = await runMission({
      brief,
      stock: {},
      plans: ['terminer']
    })
    assert.equal(status.type, 'recolte')
    assert.equal(status.fabrication_cible, 'hache')
    assert.equal(status.fabrication_quantite, 1)
    assert.ok(captured.length >= 1)
    assert.equal(captured[0].consigne.fabrication_cible, 'hache')
    assert.equal(captured[0].consigne.fabrication_quantite, 1)
    assert.equal(captured[0].progression.fabrication_visee, 1)
  } finally {
    restorePlanner()
    restoreCraft()
  }
})

test('chaine buche -> hache : etabli compte, done mesure (pas quota16)', async () => {
  let makeCalls = []
  try {
    const brief = realShapeBrief({
      kind: 'recolte', resource: 'bois',
      fabrication: 'hache', fabricationQuantite: 1, _texte: 'fabrique une hache'
    })
    // Stock de depart : buches + planches, pas de hache ; l etabli est suivi
    // dans les comptes (stocks snapshot : buches/planches/batons/etablis).
    const botStock = { oak_log: 2, oak_planks: 0, stick: 0, crafting_table: 0, wooden_axe: 0 }
    const stub = async (bot, target, wanted) => {
      makeCalls.push({ target, wanted })
      const st = bot._stock
      if (target === 'planches') {
        assert.ok((st.oak_log ?? 0) >= 1, 'il faut des buches pour les planches')
        st.oak_log -= 1
        st.oak_planks = (st.oak_planks ?? 0) + 4
        return { item: 'oak_planks', produced: 4, wanted, usedTable: false }
      }
      if (target === 'hache') {
        st.wooden_axe = (st.wooden_axe ?? 0) + 1
        return { item: 'wooden_axe', produced: 1, wanted, usedTable: true }
      }
      throw Object.assign(new Error(`inattendu ${target}`), { code: 'unknown' })
    }
    const { status } = await runMission({
      brief,
      stock: botStock,
      plans: ['fabriquer:planches:4', 'fabriquer:hache:1', 'terminer'],
      makeStub: stub
    })
    assert.equal(status.etat, 'done')
    assert.equal(status.fabrication_cible, 'hache')
    assert.ok(status.fabrication_produits >= 1)
    assert.ok(makeCalls.some(c => c.target === 'planches'), 'la chaine passe par les planches')
    assert.ok(makeCalls.some(c => c.target === 'hache'), 'la hache est fabriquee')
    assert.doesNotMatch(status.raison ?? '', /16/)
  } finally {
    restorePlanner()
    restoreCraft()
  }
})

test('impossible missing : ni terminer ni fini ne peuvent done, pas de quota16', async () => {
  try {
    const brief = realShapeBrief({
      kind: 'recolte', resource: 'bois',
      fabrication: 'hache', fabricationQuantite: 1, _texte: 'fabrique une hache'
    })
    const missingStub = async () => {
      const err = new Error('ingredients manquants pour wooden_axe : oak_planks x3 (a recolter, rien d invente)')
      err.code = 'missing'
      err.missing = [{ name: 'oak_planks', count: 3 }]
      throw err
    }
    // Via `terminer` : la preuve manque => failed avec message fabrication.
    const t1 = await runMission({ brief, stock: {}, plans: ['fabriquer:hache:1', 'terminer'], makeStub: missingStub })
    assert.equal(t1.status.etat, 'failed')
    assert.match(t1.status.raison ?? '', /hache/)
    assert.doesNotMatch(t1.status.raison ?? '', /16 demandee/)
    const fab = t1.status.historique.find(h => h.action === 'fabriquer')
    assert.ok(fab && fab.echec, 'le manque est un echec mesure, pas un succes')
    restorePlanner()
    restoreCraft()
    // Via signal `fini` : meme refus, trois fois puis failed (jamais done).
    planner.readBrief = async () => brief
    const captured = []
    planner.plan = async (state) => {
      captured.push(state.progression)
      return { ms: 0, seconds: 0, rejected: [], done: 1, finished: true, steps: [], why: 'pretendu fini' }
    }
    const bot = fakeBot({})
    const r = createMissionRunner({
      getBot: () => bot,
      isReady: () => true,
      inLiquid: () => false,
      stopPathfinding: () => {},
      chat: () => {},
      recentChat: () => [],
      navigateToPlayer: async () => ({ reached: true, code: 'arrived', remaining: 0 }),
      navigateToPosition: async () => ({ reached: true, code: 'arrived', remaining: 0 })
    })
    const admitted = await r.start('fabrique une hache', 'human')
    assert.equal(admitted.ok, true)
    for (let i = 0; i < 400 && r.isRunning(); i++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    const st = r.status()
    assert.equal(st.etat, 'failed')
    assert.match(st.raison ?? '', /hache/)
    assert.doesNotMatch(st.raison ?? '', /16/)
  } finally {
    restorePlanner()
    restoreCraft()
  }
})

test('legacy recolte sans cible : quota et chemin inchanges', async () => {
  try {
    const brief = realShapeBrief({ kind: 'recolte', resource: 'sable', fabrication: null, _texte: 'casse 1 bloc de sable' })
    // Quantite explicite : `terminer` trop tot est refuse trois fois (reinjecte)
    // avant l echec, juge sur l inventaire.
    const { status } = await runMission({ brief, stock: {}, plans: ['terminer', 'terminer', 'terminer', 'terminer'] })
    assert.equal(status.type, 'recolte')
    assert.equal(status.fabrication_cible, null)
    assert.equal(status.etat, 'failed')
    assert.match(status.raison ?? '', /0 (unite.*|en inventaire )sur 1 demande/)
  } finally {
    restorePlanner()
    restoreCraft()
  }
})

test('primitif live 2 buches -> 8 planches : pas de regression', async () => {
  const recipes = [
    { result: { id: 'oak_planks', count: 4 }, ingredients: [{ id: 'oak_log', count: 1 }] }
  ]
  const state = { oak_log: 2 }
  const itemsByName = { oak_log: { id: 'oak_log', name: 'oak_log' }, oak_planks: { id: 'oak_planks', name: 'oak_planks' } }
  const needsOf = (r) => ({ oak_log: 1 })
  const bot = {
    version: '26.1',
    registry: { itemsByName, blocksByName: {}, recipes },
    inventory: { items: () => Object.entries(state).filter(([, c]) => c > 0).map(([name, count]) => ({ name, count })) },
    recipesFor: (id) => String(id) === 'oak_planks' && (state.oak_log ?? 0) >= 1
      ? [{ result: { count: 4 }, _fake: recipes[0] }]
      : [],
    craft: async (recipe) => {
      assert.ok((state.oak_log ?? 0) >= 1)
      state.oak_log -= 1
      state.oak_planks = (state.oak_planks ?? 0) + 4
    },
    entity: { position: { floored: () => ({ x: 0, y: 0, z: 0 }), distanceTo: () => 0 } },
    findBlock: () => null,
    blockAt: () => null,
    lookAt: async () => {}
  }
  const res = await craft.make(bot, 'planches', 8)
  assert.equal(res.item, 'oak_planks')
  assert.equal(res.produced, 8)
  assert.equal(res.wanted, 8)
  assert.equal(res.partial, false)
})

test('outil deja en poche redemande : etape suivante du plan, pas de refus', async () => {
  // Vu sur craft/iron-pickaxe (6ab854b) : pioche en pierre deja faite par une
  // etape reprise, redemandee, refusee « pas utile », plan jete.
  const makeCalls = []
  try {
    const brief = realShapeBrief({
      kind: 'recolte', resource: 'bois',
      fabrication: 'torch', fabricationQuantite: 4, _texte: 'fabrique 4 torches'
    })
    const stub = async (bot, target, wanted) => {
      makeCalls.push({ target, wanted })
      if (target !== 'torch') throw Object.assign(new Error(`inattendu ${target}`), { code: 'unknown' })
      bot._stock.torch = (bot._stock.torch ?? 0) + 4
      return { item: 'torch', produced: 4, wanted, usedTable: false }
    }
    const { status } = await runMission({
      brief,
      stock: { wooden_pickaxe: 1, stick: 1, coal: 1 },
      plans: ['fabriquer:wooden_pickaxe:1', 'terminer'],
      makeStub: stub
    })
    assert.ok(!makeCalls.some(c => /pickaxe|pioche/.test(c.target)), 'aucune pioche refaite')
    const fab = status.historique.find(h => h.action === 'fabriquer')
    assert.doesNotMatch(fab.resultat, /pas utile/)
    assert.match(fab.resultat, /^wooden_pickaxe deja dans l inventaire, etape suivante du plan faite a la place : /)
  } finally {
    restorePlanner()
    restoreCraft()
  }
})

// Plan du solveur impose (fabriquer la cible), sans recolte ni cuisson.
async function runWithPlan (plans, stock) {
  const acquirePlan = require('../bot/acquire-plan')
  const orig = acquirePlan.planAcquire
  acquirePlan.planAcquire = () => ({ ok: true, etapes: [{ op: 'fabriquer', objet: 'torch', quantite: 4 }], bloque: [] })
  const makeCalls = []
  try {
    const brief = realShapeBrief({
      kind: 'recolte', resource: 'bois',
      fabrication: 'torch', fabricationQuantite: 4, _texte: 'fabrique 4 torches'
    })
    const stub = async (bot, target, wanted) => {
      makeCalls.push(target)
      bot._stock.torch = (bot._stock.torch ?? 0) + 4
      return { item: 'torch', produced: 4, wanted, usedTable: false }
    }
    const { status } = await runMission({ brief, stock, plans, makeStub: stub })
    return { status, makeCalls }
  } finally {
    acquirePlan.planAcquire = orig
    restorePlanner()
    restoreCraft()
  }
}

test('recolte inutile (tout en poche) : l etape suivante du plan est faite', async () => {
  // Vu sur craft/iron-pickaxe (76553e7) : « rien a recolter : tout est en
  // poche, etape suivante du plan : fabriquer 1 iron_pickaxe », non faite.
  const { status, makeCalls } = await runWithPlan(['recolter:bois:3', 'terminer'], { stick: 1, coal: 1 })
  assert.deepEqual(makeCalls, ['torch'])
  const r = status.historique.find(h => h.action === 'recolter')
  assert.match(r.resultat, /^rien a recolter : tout est en poche, etape suivante du plan faite a la place : /)
  assert.ok(!r.echec)
})

test('cuisson deja faite : l etape suivante du plan au lieu de « rien a cuire »', async () => {
  // Vu sur craft/iron-pickaxe (76553e7) : lingots deja cuits, « cuire
  // iron_ingot » redemande deux fois, deux echecs.
  const { status, makeCalls } = await runWithPlan(['cuire:iron_ingot:3', 'terminer'], { iron_ingot: 3, stick: 1, coal: 1 })
  assert.deepEqual(makeCalls, ['torch'])
  const c = status.historique.find(h => h.action === 'cuire')
  assert.match(c.resultat, /^iron_ingot deja cuit\(s\), etape suivante du plan faite a la place : /)
  assert.ok(!c.echec)
})

test('cuisson : la quantite du solveur prime sur une demande plus petite', async () => {
  // Vu sur craft/iron-pickaxe (bff20b0) : solveur « cuire 3 iron_ingot »,
  // modele « cuire 1 » ; une buche (1,5 cuisson) brulee pour un lingot, plus
  // de combustible pour les deux autres, bois cherche loin, plafond atteint.
  const acquirePlan = require('../bot/acquire-plan')
  const orig = acquirePlan.planAcquire
  const origSmelt = craft.smelt
  acquirePlan.planAcquire = () => ({ ok: true, bloque: [], etapes: [
    { op: 'cuire', objet: 'iron_ingot', quantite: 3, depuis: 'raw_iron' },
    { op: 'fabriquer', objet: 'torch', quantite: 4 }] })
  const demandes = []
  craft.smelt = async (bot, objet, wanted) => {
    demandes.push(wanted)
    return { item: objet, produced: wanted, wanted, input: 'raw_iron', fuel: 'oak_log', fuelCount: 2, arret: null }
  }
  try {
    const brief = realShapeBrief({
      kind: 'recolte', resource: 'bois',
      fabrication: 'torch', fabricationQuantite: 4, _texte: 'fabrique 4 torches'
    })
    await runMission({ brief, stock: { raw_iron: 3, oak_log: 1, oak_planks: 1 }, plans: ['cuire:iron_ingot:1', 'terminer'],
      makeStub: async (bot, target, wanted) => ({ item: target, produced: 0, wanted }) })
    assert.deepEqual(demandes, [3])
  } finally {
    acquirePlan.planAcquire = orig
    craft.smelt = origSmelt
    restorePlanner()
    restoreCraft()
  }
})

test('toutes les recoltes attendent un outil a fabriquer : l etape suivante du plan est faite', async () => {
  // Vu sur craft/iron-pickaxe (7b01683) : bois recolte, reste pierre et fer,
  // pioche en bois pas encore fabriquee, « stone ne lache rien sans pioche ».
  const acquirePlan = require('../bot/acquire-plan')
  const orig = acquirePlan.planAcquire
  acquirePlan.planAcquire = () => ({
    ok: true,
    bloque: [],
    etapes: [
      { op: 'fabriquer', objet: 'wooden_pickaxe', quantite: 1, etabli: true },
      { op: 'recolter', objet: 'cobblestone', quantite: 3, bloc: 'stone', matiere: 'pierre', outil: 'wooden_pickaxe' },
      { op: 'fabriquer', objet: 'stone_pickaxe', quantite: 1, etabli: true }
    ]
  })
  const makeCalls = []
  try {
    const brief = realShapeBrief({
      kind: 'recolte', resource: 'pierre',
      fabrication: 'stone_pickaxe', fabricationQuantite: 1, _texte: 'fabrique une pioche en pierre'
    })
    const stub = async (bot, target, wanted) => {
      makeCalls.push(target)
      bot._stock[target] = (bot._stock[target] ?? 0) + 1
      return { item: target, produced: 1, wanted, usedTable: false }
    }
    const { status } = await runMission({ brief, stock: { wooden_pickaxe: 0, stone_pickaxe: 0 }, plans: ['recolter:pierre:3', 'terminer'], makeStub: stub })
    const r = status.historique.find(h => h.action === 'recolter')
    assert.deepEqual(makeCalls, ['wooden_pickaxe'])
    assert.match(r.resultat, /^stone exige wooden_pickaxe, encore a fabriquer, etape suivante du plan faite a la place : /)
    assert.ok(!r.echec, r.resultat)
  } finally {
    acquirePlan.planAcquire = orig
    restorePlanner()
    restoreCraft()
  }
})

test('recolte dont l outil reste a fabriquer : la recolte faisable est visee', async () => {
  // Vu sur craft/iron-pickaxe (e6e8328) : fer en vue, pioche en pierre encore
  // au plan, « iron_ore ne lache rien sans pioche » : la pierre etait faisable.
  const acquirePlan = require('../bot/acquire-plan')
  const orig = acquirePlan.planAcquire
  acquirePlan.planAcquire = () => ({
    ok: true,
    bloque: [],
    etapes: [
      { op: 'fabriquer', objet: 'stone_pickaxe', quantite: 1, etabli: true },
      { op: 'recolter', objet: 'raw_iron', quantite: 3, bloc: 'iron_ore', matiere: 'minerai', outil: 'stone_pickaxe' },
      { op: 'recolter', objet: 'cobblestone', quantite: 8, bloc: 'stone', matiere: 'pierre', outil: 'wooden_pickaxe' },
      { op: 'fabriquer', objet: 'iron_pickaxe', quantite: 1, etabli: true }
    ]
  })
  try {
    const brief = realShapeBrief({
      kind: 'recolte', resource: 'minerai',
      fabrication: 'iron_pickaxe', fabricationQuantite: 1, _texte: 'fabrique une pioche en fer'
    })
    const { status } = await runMission({ brief, stock: { wooden_pickaxe: 1, stone_pickaxe: 0, iron_pickaxe: 0 }, plans: ['recolter:pierre:3', 'terminer'] })
    const r = status.historique.find(h => h.action === 'recolter')
    assert.match(r.resultat, /objet\(s\) de pierre/)
  } finally {
    acquirePlan.planAcquire = orig
    restorePlanner()
    restoreCraft()
  }
})

test('plusieurs objets demandes : un a la fois, fin apres le dernier seulement', async () => {
  const makeCalls = []
  try {
    const brief = realShapeBrief({
      kind: 'recolte', resource: 'pierre',
      fabrication: 'stone_pickaxe', fabricationQuantite: 1,
      fabricationSuite: ['stone_axe', 'stone_sword', 'stone_axe'],
      _texte: 'fabrique-toi une pioche, une hache et une epee en pierre'
    })
    const stub = async (bot, target, wanted) => {
      makeCalls.push(target)
      bot._stock[target] = (bot._stock[target] ?? 0) + 1
      return { item: target, produced: 1, wanted, usedTable: true }
    }
    // Le modele dit terminer apres la pioche : refuse, la hache puis l epee
    // deviennent la cible tour a tour.
    const { status, captured } = await runMission({
      brief,
      stock: { cobblestone: 9, stick: 6, stone_pickaxe: 0, stone_axe: 0, stone_sword: 0 },
      plans: ['fabriquer:stone_pickaxe:1', 'terminer', 'fabriquer:stone_axe:1', 'fabriquer:stone_sword:1', 'terminer'],
      makeStub: stub
    })
    assert.equal(status.etat, 'done', status.raison)
    assert.deepEqual(makeCalls, ['stone_pickaxe', 'stone_axe', 'stone_sword'])
    assert.deepEqual(captured[0].consigne.fabrications_suivantes, ['stone_axe', 'stone_sword'])
    assert.ok(captured.some(c => c.consigne.fabrication_cible === 'stone_sword'))
  } finally {
    restorePlanner()
    restoreCraft()
  }
})
