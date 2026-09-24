'use strict'

process.env.PLANNER_ROUTING_MODE = 'dual'
process.env.PLANNER_BASE_URL = 'https://opencode.ai/zen/go/v1'
process.env.PLANNER_API_KEY = 'test-secret-never-in-status'
process.env.PLANNER_MODEL = 'deepseek-v4.1-flash'
process.env.REPAIR_API_KEY = 'test-repair'
process.env.MISSION_TICK_MS = '1'
process.env.MISSION_QUEUE_TICK_MS = '1'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const llm = require('../bot/llm')
const planner = require('../bot/planner')
const repair = require('../bot/repair')
const FAST = 'mimo-v2.6-flash'
const STRATEGY = 'muse-spark-1.3-contributor'
const content = JSON.stringify({ fini: 0, pourquoi: 'test', plan: [{ action: 'regarder_autour' }],
  commande: 'aucune', confiance: 1, type: 'recolte', matiere: 'bois', repere: 'ici',
  relation: 'question', response: 'test', action: 'regarder_autour', quand: 'cible absente', exemples: ['regarder_autour'], operations: [] })
const ok = () => ({ content, usage: { total_tokens: 21 }, ms: 7 })

test('vraies entrees planner et repair suivent leur role sans repli historique', async t => {
  const calls = []
  t.mock.method(llm, 'call', async (_system, _user, options) => { calls.push(options); return ok() })
  await planner.classify('bonjour')
  await planner.interpretMessage('bonjour', {})
  await planner.compact('note')
  await planner.warmup()
  await planner.plan({}, 'recolte', 'harvest')
  await planner.readBrief('coupe du bois')
  await repair.askForAction({ kind: 'recolte', supply: 'harvest', etat: {}, probleme: 'test' })
  await repair.reflect({ kind: 'recolte', supply: 'harvest', etat: {}, probleme: 'test' })
  assert.deepEqual(calls.map(call => call.model), [FAST, FAST, FAST, FAST, FAST, STRATEGY, STRATEGY, STRATEGY])
  for (const call of calls) {
    if (call.model === FAST) {
      assert.equal(call.protocol, 'chat'); assert.deepEqual(call.thinking, { type: 'disabled' })
      assert.equal(call.reasoning, undefined); assert.equal(call.timeoutMs, 45000); assert.equal(call.maxTokens, 4096)
    } else {
      assert.equal(call.protocol, 'responses'); assert.deepEqual(call.reasoning, { effort: 'xhigh' })
      assert.equal(call.thinking, undefined); assert.equal(call.timeoutMs, 120000); assert.equal(call.maxTokens, 16384)
    }
  }
})

test('quatre signaux frais orientent Muse puis retour MiMo, ancien echec non sticky', async t => {
  const calls = []
  t.mock.method(llm, 'call', async (system, _user, options) => { calls.push({ system, ...options }); return ok() })
  for (const state of [{ blocage: { detecte: true } }, { avancer_bloque: true }, { arret_refuse: 'quota manque' },
    { dernieres_etapes: [{ echec: true }] }, { dernieres_etapes: [{ echec: true }, { echec: false }] }, {}]) {
    await planner.plan(state, 'recolte', 'harvest')
  }
  assert.deepEqual(calls.map(call => call.model), [STRATEGY, STRATEGY, STRATEGY, STRATEGY, FAST, FAST])
  assert.equal(calls.length, 6, 'aucun appel aide impose apres la strategie')
  assert.doesNotMatch(calls[0].system, /Commence le plan par\s+demander_aide/)
})

test('erreur et annulation dual ne declenchent aucun second modele', async t => {
  let calls = 0
  t.mock.method(llm, 'call', async (_system, _user, options) => {
    calls++
    if (options.signal?.aborted) throw Object.assign(new Error('appel annule'), { code: 'LLM_ABORTED' })
    throw Object.assign(new Error('transport indisponible'), { code: 'LLM_HTTP' })
  })
  await assert.rejects(planner.plan({ blocage: { detecte: true } }, 'recolte', 'harvest'), /indisponible/)
  assert.equal(calls, 1)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(planner.plan({}, 'recolte', 'harvest', {}, null, { signal: controller.signal }), /annule/)
  assert.equal(calls, 2)
  assert.equal(planner.profileStatus().fallbackActive, false)
  assert.equal(planner.profileStatus().fallback, null)
})

test('statut concurrent distingue appels actifs et dernier termine sans secret', async t => {
  const waiting = []
  t.mock.method(llm, 'call', (_system, _user, options) => new Promise(resolve => waiting.push({ options, resolve })))
  const strategic = planner.plan({ blocage: { detecte: true } }, 'recolte', 'harvest')
  const chat = planner.interpretMessage('bonjour', {})
  const during = planner.profileStatus().routing
  assert.equal(during.active.length, 2)
  assert.equal(new Set(during.active.map(call => call.requestId)).size, 2)
  waiting[1].resolve(ok()); await chat
  const afterChat = planner.profileStatus().routing
  assert.equal(afterChat.active.length, 1)
  assert.equal(afterChat.active[0].model, STRATEGY)
  assert.equal(afterChat.lastCompleted.model, FAST)
  waiting[0].resolve(ok()); await strategic
  const afterAll = planner.profileStatus().routing
  assert.deepEqual(afterAll.active, [])
  assert.equal(afterAll.lastCompleted.model, STRATEGY)
  assert.equal(afterAll.lastCompleted.result, 'response')
  assert.equal(afterAll.lastCompleted.usage.total_tokens, 21)
  assert.doesNotMatch(JSON.stringify(afterAll), /test-secret|test-repair/)
  assert.equal(planner.profileStatus().effective, 'dual')
})

test('chat diagnostique par mesures fraiches, pas par mots ni ancien echec', async t => {
  const calls = []
  const controller = new AbortController()
  t.mock.method(llm, 'call', async (_system, _user, options) => { calls.push(options); return ok() })
  for (const context of [{}, { mission: { historique: [{ echec: true }] } },
    { precedent: { historique: [{ echec: true }] } }, { etat: { navigation: { code: 'no_path' } } },
    { etat: { navigation: { code: 'stuck' } } }, { mission: { historique: [{ echec: true }, { echec: false }] } }]) {
    await planner.interpretMessage('diagnostic complexe', context, { signal: controller.signal })
  }
  assert.deepEqual(calls.map(call => call.model), [FAST, STRATEGY, STRATEGY, STRATEGY, STRATEGY, FAST])
  assert.ok(calls.every(call => call.signal === controller.signal))
})

test('repair dual utilise cle partagee et signal ; JSON invalide reste response transport', async t => {
  const previousKey = process.env.REPAIR_API_KEY
  delete process.env.REPAIR_API_KEY
  t.after(() => { process.env.REPAIR_API_KEY = previousKey })
  const controller = new AbortController()
  let calls = 0
  t.mock.method(llm, 'call', async (_system, _user, options) => {
    calls++
    assert.equal(options.apiKey, process.env.PLANNER_API_KEY)
    assert.equal(options.signal, controller.signal)
    return { ...ok(), content: 'invalid JSON' }
  })
  assert.equal(repair.isEnabled(), true)
  await assert.rejects(planner.plan({}, 'recolte', 'harvest', {}, null, { signal: controller.signal }), /illisible/)
  assert.equal(calls, 1)
  assert.equal(planner.profileStatus().routing.lastCompleted.result, 'response')
  const result = await repair.askForAction({ kind: 'recolte', supply: 'harvest', signal: controller.signal })
  assert.equal(result.ok, false)
  assert.equal(planner.profileStatus().routing.lastCompleted.model, STRATEGY)
})

test('observation copiee bornee et metriques par modele distinctes', async t => {
  const state = { bot: { position: { x: 1, y: 65, z: 2 } }, chat_recent: ['PRIVATE CHAT'],
    environnement: { acces_par_montee: { cible: { nom: 'oak_log', position: { x: 2, y: 67, z: 3 }, private: 'PRIVATE MEMORY' },
      hauteur_min: 1, stock: 4, manque: 0, private: 'PRIVATE CHAT' } },
    memoire: { travail: 'PRIVATE MEMORY' }, dernieres_etapes: Array(9).fill({ action: 'dire', resultat: 'PRIVATE CHAT', echec: false }) }
  t.mock.method(llm, 'call', async () => ({ ...ok(), responseModel: FAST,
    usage: { prompt_tokens: 12, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 0 } } }))
  await planner.plan(state, 'recolte', 'harvest')
  state.bot.position.y = 100
  state.environnement.acces_par_montee.cible.position.y = 100
  const snapshot = planner.profileStatus().routing
  assert.equal(snapshot.lastCompleted.observation.position.y, 65)
  assert.deepEqual(snapshot.lastCompleted.observation.environnement.acces_par_montee,
    { cible: { nom: 'oak_log', position: { x: 2, y: 67, z: 3 } }, hauteur_min: 1, stock: 4, manque: 0 })
  assert.equal(snapshot.lastCompleted.observation.dernieres_etapes.length, 4)
  assert.equal(snapshot.lastCompleted.responseModel, FAST)
  assert.ok(snapshot.byModel[FAST].usage.input >= 12)
  assert.ok(snapshot.byModel[STRATEGY].calls > 0)
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE CHAT|PRIVATE MEMORY/)
  snapshot.lastCompleted.observation.position.y = 0
  assert.equal(planner.profileStatus().routing.lastCompleted.observation.position.y, 65)
})

async function prefetchFixture (t, initiallyComplex, switchDuringWait = false) {
  const { Vec3 } = require('vec3')
  const craft = require('../bot/craft')
  const { createMissionRunner } = require('../bot/mission')
  const selectRoute = planner.selectPlanRoute
  let complex = initiallyComplex
  // Control the measured difficulty at the selector boundary, while exercising the real runner.
  t.mock.method(planner, 'selectPlanRoute', state => selectRoute({ ...state, blocage: { detecte: complex } }))
  t.mock.method(craft, 'targetCriteria', () => ({}))
  t.mock.method(planner, 'readBrief', async () => ({ kind: 'recolte', kindConfidence: 1, resource: 'bois', resourceConfidence: 1,
    landmark: 'ici', door: false, doorProbability: 0 }))
  const calls = []
  const messages = []
  t.mock.method(planner, 'plan', async state => {
    const route = planner.selectPlanRoute(state)
    calls.push(route)
    if (switchDuringWait && calls.length === 2) {
      await new Promise(resolve => setTimeout(() => { complex = true; resolve() }, 20))
    }
    const step = (action, texte) => ({ action, scale: 0, scaleLevel: null, choices: { texte } })
    return { ms: 0, seconds: 0, rejected: [], done: 0, finished: false, routing: route,
      steps: calls.length === 1 ? [step('dire', 'SWITCH'), step('regarder', '')]
        : route.role === 'fast' ? [step('dire', 'STALE PREFETCH')] : [step('terminer', '')] }
  })
  const bot = { entity: { position: new Vec3(0, 65, 0), yaw: 0, pitch: 0 },
    registry: { blocksByName: {}, itemsByName: {} }, inventory: { items: () => [] }, players: {}, entities: {},
    findBlocks: () => [], findBlock: () => null, blockAt: () => null, clearControlStates () {}, async look () {} }
  const runner = createMissionRunner({ getBot: () => bot, isReady: () => true, inLiquid: () => false,
    stopPathfinding () {}, chat: text => { messages.push(text); if (text === 'SWITCH' && !switchDuringWait) complex = true } })
  t.after(() => runner.stop('test cleanup'))
  await runner.start('coupe du bois', 'human')
  for (let i = 0; i < 100 && runner.isRunning(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(runner.isRunning(), false)
  return { status: runner.status(), calls, messages }
}

test('vrai runner : route complexe ne lance aucun prefetch', async t => {
  const f = await prefetchFixture(t, true)
  assert.equal(f.status.appel_anticipe.lances, 0)
  assert.equal(f.calls.length, 2)
})

test('vrai runner : prefetch MiMo pret jete lorsque etat frais exige Muse', async t => {
  const f = await prefetchFixture(t, false)
  assert.deepEqual(f.calls.map(call => call.role), ['fast', 'fast', 'strategy'])
  assert.equal(f.status.appel_anticipe.consommes, 0)
  assert.equal(f.status.appel_anticipe.annules, 1)
  assert.equal(f.messages.some(text => text === 'STALE PREFETCH'), false)
})

test('vrai runner : difficulte apparue pendant attente du prefetch reobservee', async t => {
  const f = await prefetchFixture(t, false, true)
  assert.deepEqual(f.calls.map(call => call.role), ['fast', 'fast', 'strategy'])
  assert.equal(f.status.appel_anticipe.consommes, 0)
  assert.equal(f.status.appel_anticipe.annules, 1)
})
