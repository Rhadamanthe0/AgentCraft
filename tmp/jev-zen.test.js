'use strict'

// JEV_PROVIDER=zen (bot/jev-zen.js) : les questions fermees de Jev passent par
// le gateway OpenCode Zen (llm.call, /chat/completions), pas par TypeSafe.
// Transport simule : aucun appel distant, aucun secret.

process.env.ACTION_CHOOSER = 'jev'
delete process.env.JEV_PROVIDER
delete process.env.JEV_ZEN_MODEL
process.env.PLANNER_BASE_URL = 'https://opencode.ai/zen/go/v1'
process.env.PLANNER_API_KEY = 'test-sans-reseau'
process.env.PLANNER_SESSION_ID = 'minecraft-bot-test'
process.env.MISSION_TICK_MS = '20'
process.env.MISSION_QUEUE_TICK_MS = '5'
process.env.MISSION_MAX_STEPS = '2'
process.env.MISSION_MAX_DURATION_MS = '60000'

const { test, describe, beforeEach, after } = require('node:test')
const assert = require('node:assert/strict')

const llm = require('../bot/llm')
const origCall = llm.call
after(() => { llm.call = origCall })

const skills = require('../bot/skills')
const chooser = require('../bot/action-chooser')
const zen = require('../bot/jev-zen')

const PLANNER_ONLY = Object.entries(skills.ACTIONS).filter(([, s]) => s.plannerOnly).map(([n]) => n)
const seen = []

// Chaque appel recoit la reponse suivante du script (texte JSON ou Error).
function script (...answers) {
  seen.length = 0
  let i = 0
  llm.call = async (system, user, options) => {
    seen.push({ system, user: JSON.parse(user), options })
    const a = answers[Math.min(i++, answers.length - 1)]
    if (a instanceof Error) throw a
    return { content: typeof a === 'string' ? a : JSON.stringify(a), usage: null, ms: 3 }
  }
}

const base = { state: { x: 1 }, kind: 'recolte', supply: 'harvest' }

describe('fournisseur', () => {
  test('zen par defaut des qu un gateway est configure, typesafe sinon', () => {
    assert.equal(chooser.readProvider({ PLANNER_BASE_URL: 'https://opencode.ai/zen/go/v1' }), 'zen')
    assert.equal(chooser.readProvider({}), 'typesafe')
    assert.equal(chooser.readProvider({ PLANNER_BASE_URL: 'x', JEV_PROVIDER: 'typesafe' }), 'typesafe')
    assert.equal(chooser.getProvider(), 'zen')
    assert.equal(chooser.jevModule(), zen)
    assert.equal(chooser.snapshot().jev_fournisseur, 'zen')
  })
})

describe('questions fermees via Zen', () => {
  beforeEach(() => { chooser._reset(); zen._reset() })

  test('casser + ampleur "3" -> echelle 0,75, deux appels, transport Zen', async () => {
    script({ choix: 'casser', confiance: 0.8 }, { choix: '3', confiance: 0.6 })
    const d = await chooser.chooseWithJev({ jev: zen, ...base })
    assert.equal(d.step, 'casser')
    assert.equal(d.scale, 0.75)
    assert.equal(d.scaleLevel, 3)
    assert.deepEqual(d.choices, { ampleur: 3 })
    assert.equal(d.confidence, 0.8)
    assert.equal(seen.length, 2)
    assert.equal(chooser.snapshot().appels_jev, 2)
    for (const c of seen) {
      assert.equal(c.system, zen.SYSTEM, 'prompt systeme fixe, octet pour octet')
      assert.equal(c.options.baseUrl, 'https://opencode.ai/zen/go/v1')
      assert.equal(c.options.apiKey, 'test-sans-reseau')
      assert.equal(c.options.model, 'deepseek-v4.1-flash')
      assert.deepEqual(c.options.thinking, { type: 'disabled' })
      assert.equal(c.options.maxTokens, 300)
      assert.equal(c.options.protocol, 'chat')
      assert.equal(c.options.headers['x-opencode-session'], 'minecraft-bot-test-jev')
      assert.equal(c.options.headers['user-agent'], 'minecraft-bot/1.0')
    }
    assert.deepEqual(Object.keys(seen[1].user.options), ['0', '1', '2', '3', '4'])
    assert.equal(seen[1].user.etat.action_choisie, 'casser')
    assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(zen.SYSTEM))
  })

  test('les actions plannerOnly ne sont jamais proposees', async () => {
    for (const kind of ['recolte', 'construction', 'deplacement']) {
      script({ choix: 'sortir', confiance: 1 })
      await chooser.chooseWithJev({ jev: zen, state: {}, kind, supply: 'harvest' })
      const offered = Object.keys(seen[0].user.options)
      for (const name of PLANNER_ONLY) assert.ok(!offered.includes(name), `${name} propose (${kind})`)
      assert.deepEqual(offered.sort(), skills.actionsFor(kind, 'harvest', false).sort())
    }
  })

  test('choix hors options : rejet (repli planificateur)', async () => {
    script({ choix: 'regarder', confiance: 0.9 })
    await assert.rejects(chooser.chooseWithJev({ jev: zen, ...base }), /hors options/)
    script('pas du json')
    await assert.rejects(chooser.chooseWithJev({ jev: zen, ...base }), /illisible/)
    script(new Error('HTTP 503 : upstream'))
    await assert.rejects(chooser.chooseWithJev({ jev: zen, ...base }), /503/)
  })

  test('ampleur hors options ("7") : action gardee, echelle moyenne', async () => {
    script({ choix: 'avancer', confiance: 0.7 }, { choix: '7', confiance: 1 })
    const d = await chooser.chooseWithJev({ jev: zen, state: {}, kind: 'deplacement', supply: 'harvest' })
    assert.equal(d.step, 'avancer')
    assert.equal(d.scale, 0.5)
    assert.deepEqual(d.choices, {})
  })

  test('fabriquer : objet parmi les recettes calculees, puis ampleur (3 appels)', async () => {
    script({ choix: 'fabriquer', confiance: 0.9 }, { choix: 'planches', confiance: 0.9 }, { choix: '0', confiance: 0.9 })
    const d = await chooser.chooseWithJev({
      jev: zen, ...base, dynamicCriteria: () => ({ fabrications: { planches: 'des planches', etabli: 'un etabli' } })
    })
    assert.deepEqual(d.choices, { objet: 'planches', ampleur: 0 })
    assert.deepEqual(Object.keys(seen[1].user.options), ['planches', 'etabli'])
    assert.equal(chooser.snapshot().appels_jev, 3)
  })

  test('objet a fabriquer invente : rejete, echelle moyenne sans objet', async () => {
    script({ choix: 'fabriquer', confiance: 0.9 }, { choix: 'diamond_sword', confiance: 0.9 })
    const d = await chooser.chooseWithJev({
      jev: zen, ...base, dynamicCriteria: () => ({ fabrications: { planches: 'des planches' } })
    })
    assert.equal(d.step, 'fabriquer')
    assert.deepEqual(d.choices, {})
  })
})

describe('detection du modele (GET /models)', () => {
  beforeEach(() => zen._reset())
  const quiet = () => {}

  function fakeFetch (body, ok = true) {
    const calls = []
    const impl = async (url, init) => {
      calls.push({ url, init })
      return { ok, status: ok ? 200 : 401, json: async () => body }
    }
    impl.calls = calls
    return impl
  }

  test('un modele « jev » qui repond est prefere, sans raisonnement coupe', async () => {
    const fetchImpl = fakeFetch({ data: [{ id: 'deepseek-v4.1-flash' }, { id: 'jev-zen-1' }] })
    script({ choix: 'ok', confiance: 1 })
    const r = await zen.detectModel({ fetchImpl, log: quiet })
    assert.equal(fetchImpl.calls[0].url, 'https://opencode.ai/zen/go/v1/models')
    assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer test-sans-reseau')
    assert.equal(fetchImpl.calls[0].init.headers['x-opencode-session'], 'minecraft-bot-test-jev')
    assert.deepEqual(r.jev_trouves, ['jev-zen-1'])
    assert.equal(r.sonde, 'ok')
    assert.equal(zen.MODEL, 'jev-zen-1')
    assert.equal(seen[0].options.model, 'jev-zen-1')
    assert.equal(seen[0].options.thinking, null)
  })

  test('modele « jev » qui ne repond pas : deepseek par defaut', async () => {
    script(new Error('HTTP 503 : Endpoint is unavailable'))
    const r = await zen.detectModel({ fetchImpl: fakeFetch({ data: [{ id: 'jev-latest' }] }), log: quiet })
    assert.match(r.sonde, /echec/)
    assert.equal(zen.MODEL, 'deepseek-v4.1-flash')
  })

  test('aucun modele « jev », ou /models en erreur : deepseek par defaut', async () => {
    let r = await zen.detectModel({ fetchImpl: fakeFetch({ data: [{ id: 'glm-5.3-flash' }] }), log: quiet })
    assert.deepEqual(r.jev_trouves, [])
    assert.equal(r.choisi, 'deepseek-v4.1-flash')
    zen._reset()
    r = await zen.detectModel({ fetchImpl: fakeFetch({}, false), log: quiet })
    assert.match(r.erreur, /HTTP 401/)
    assert.equal(zen.MODEL, 'deepseek-v4.1-flash')
    assert.equal(zen.detection, r)
  })
})

describe('runner reel : Zen en panne -> planificateur pour ce tour', () => {
  const planner = require('../bot/planner')
  const saved = { isEnabled: planner.isEnabled, plan: planner.plan, readBrief: planner.readBrief }
  after(() => Object.assign(planner, saved))

  function pos (x, y, z) {
    return {
      x, y, z,
      floored () { return pos(Math.floor(x), Math.floor(y), Math.floor(z)) },
      offset (dx, dy, dz) { return pos(x + dx, y + dy, z + dz) },
      distanceTo (o) { return Math.hypot(x - o.x, y - o.y, z - o.z) }
    }
  }
  const bot = {
    username: 'TestBot',
    entity: { position: pos(0, 64, 0), yaw: 0, pitch: 0, onGround: true },
    health: 20,
    pathfinder: { isMoving: () => false },
    players: {},
    entities: {},
    registry: null,
    inventory: { items: () => [] },
    on: () => {},
    removeListener: () => {},
    clearControlStates: () => {},
    lookAt: async () => {},
    blockAt: () => ({ name: 'air', boundingBox: 'empty', shapes: [] })
  }
  const host = {
    isReady: () => true,
    getBot: () => bot,
    chat: () => {},
    stopPathfinding: () => {},
    navigateToPlayer: async () => ({ reached: true, code: 'arrived', remaining: 0 }),
    navigateToPosition: async () => ({ reached: true, code: 'arrived', remaining: 0 }),
    recentChat: () => [],
    inLiquid: () => false
  }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

  test('tour 1 : Zen 503 -> plan JSON ; tour 2 : Zen choisit', async () => {
    chooser._reset()
    zen._reset()
    planner.isEnabled = () => true
    planner.readBrief = async () => ({ kind: 'recolte', kindConfidence: 0.9, resource: 'aucune', resourceConfidence: 0.9,
      resourceProbabilities: null, landmark: 'ici', door: false, doorProbability: 0 })
    let plans = 0
    planner.plan = async () => {
      plans += 1
      return { ms: 1, why: 'repli', rejected: [], finished: false, done: 0, seconds: 1,
        steps: [{ action: 'attendre', scale: 0, scaleLevel: 0, choices: { duree: 1 } }] }
    }
    script(new Error('HTTP 503 : upstream'), { choix: 'attendre', confiance: 0.9 }, { choix: '0', confiance: 0.9 })
    const { createMissionRunner } = require('../bot/mission')
    const runner = createMissionRunner(host)
    assert.equal((await runner.start('recolte ce que tu veux', 'Alice')).ok, true)
    let end
    for (let i = 0; i < 400 && !end; i++) {
      const s = runner.status()
      if (s && ['done', 'failed', 'stopped'].includes(s.etat)) end = s
      else await sleep(25)
    }
    assert.ok(end, 'mission terminee')
    assert.equal(plans, 1)
    const s = chooser.snapshot()
    assert.equal(s.replis_planner, 1)
    assert.equal(s.decisions_jev, 1)
    assert.match(s.derniere_erreur_jev, /503/)
  })
})
