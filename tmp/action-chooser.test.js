'use strict'

// ACTION_CHOOSER=jev (bot/action-chooser.js) : Jev choisit l action de chaque
// tour de mission, le planificateur JSON garde tout le reste et reprend le tour
// quand Jev echoue. Le transport TypeSafe est simule (faux @typesafe-ai/sdk) :
// aucun appel distant, aucun secret.

process.env.ACTION_CHOOSER = 'jev'
process.env.JEV_PROVIDER = 'typesafe'
process.env.MISSION_TICK_MS = '20'
process.env.MISSION_QUEUE_TICK_MS = '5'
process.env.MISSION_MAX_STEPS = '3'
process.env.MISSION_MAX_DURATION_MS = '60000'
process.env.TYPESAFE_API_KEY = 'test-sans-reseau'

const { test, describe, beforeEach, after } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

// --- Faux transport TypeSafe ------------------------------------------------
// jev.js charge le SDK par require() : on intercepte ce seul module.
const calls = []
let respond = () => { throw new Error('reponse non scriptee') }
const fakeSdk = {
  TypeSafeClient: class {
    async systemOne (request, options) {
      calls.push({ request, options })
      return respond(request)
    }
  },
  choice: (question, criteria) => ({ type: 'choice', question, criteria }),
  score: (question, rubric) => ({ type: 'score', question, rubric }),
  noul: (question, options) => ({ type: 'noul', question, options })
}
const origLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === '@typesafe-ai/sdk') return fakeSdk
  return origLoad.call(this, request, ...rest)
}
after(() => { Module._load = origLoad })

const skills = require('../bot/skills')
const jev = require('../bot/jev')
const chooser = require('../bot/action-chooser')
assert.equal(jev.init(), true, 'faux SDK charge')

const PLANNER_ONLY = Object.entries(skills.ACTIONS).filter(([, s]) => s.plannerOnly).map(([n]) => n)

function jevAnswers ({ step, done = 0.1, ampleur = null, objet = null }) {
  return request => {
    const q = request.questions
    if (q.etape) {
      return { answers: { etape: { choice: step, confidence: 0.9 }, termine: { noul: done } } }
    }
    const answers = {}
    if (q.ampleur && ampleur !== null) answers.ampleur = { score: ampleur }
    if (q.objet) answers.objet = { choice: objet, confidence: 0.8 }
    return { answers }
  }
}

describe('mode ACTION_CHOOSER', () => {
  test('defaut planner, jev explicite, valeur inconnue -> planner', () => {
    assert.equal(chooser.readMode({}), 'planner')
    assert.equal(chooser.readMode({ ACTION_CHOOSER: 'JEV ' }), 'jev')
    assert.equal(chooser.readMode({ ACTION_CHOOSER: 'deepseek' }), 'planner')
    assert.equal(chooser.getMode(), 'jev')
  })

  test('les missions geste et deplacement restent au planificateur', () => {
    assert.equal(chooser.wantsJev('recolte'), true)
    assert.equal(chooser.wantsJev('construction'), true)
    // rejoindre_demandeur est plannerOnly : Jev ne saurait pas rejoindre.
    assert.equal(chooser.wantsJev('deplacement'), false)
    assert.equal(chooser.wantsJev('geste'), false)
  })
})

describe('chooseWithJev (vrai jev.js, transport simule)', () => {
  beforeEach(() => { calls.length = 0; chooser._reset() })

  test('casser : action + ampleur 3/4 -> echelle 0,75, aucune valeur inventee, deux appels', async () => {
    respond = jevAnswers({ step: 'casser', ampleur: 3 })
    const d = await chooser.chooseWithJev({ jev, state: { x: 1 }, kind: 'recolte', supply: 'harvest' })
    assert.equal(d.finished, false)
    assert.equal(d.step, 'casser')
    assert.equal(d.scale, 0.75)
    assert.equal(d.scaleLevel, 3)
    assert.deepEqual(d.choices, { ampleur: 3 })
    assert.equal(d.choices.duree, undefined, 'la duree vient du code (scaled), pas du modele')
    assert.equal(d.queued, 0)
    assert.equal(d.source, 'jev')
    assert.equal(calls.length, 2)
    assert.equal(calls[1].request.state.action_choisie, 'casser')
    const s = chooser.snapshot()
    assert.equal(s.appels_jev, 2)
    assert.equal(s.decisions_jev, 1)
    assert.equal(typeof s.moyenne_ms_jev, 'number')
  })

  test('les actions plannerOnly ne sont jamais proposees a Jev', async () => {
    for (const kind of ['recolte', 'construction', 'deplacement']) {
      calls.length = 0
      respond = jevAnswers({ step: 'sortir' })
      await chooser.chooseWithJev({ jev, state: {}, kind, supply: 'harvest' })
      const offered = Object.keys(calls[0].request.questions.etape.criteria)
      assert.ok(offered.length > 0)
      for (const name of PLANNER_ONLY) assert.ok(!offered.includes(name), `${name} propose a Jev (${kind})`)
      assert.deepEqual(offered.sort(), skills.actionsFor(kind, 'harvest', false).sort())
    }
  })

  test('action sans parametre (sortir) : un seul appel', async () => {
    respond = jevAnswers({ step: 'sortir' })
    const d = await chooser.chooseWithJev({ jev, state: {}, kind: 'recolte', supply: 'harvest' })
    assert.equal(d.step, 'sortir')
    assert.equal(d.scale, 0.5)
    assert.deepEqual(d.choices, {})
    assert.equal(calls.length, 1)
  })

  test('fabriquer : options dynamiques evaluees seulement si besoin, objet choisi parmi elles', async () => {
    let evaluated = 0
    const dynamicCriteria = () => { evaluated += 1; return { fabrications: { planches: 'des planches' } } }
    respond = jevAnswers({ step: 'fabriquer', ampleur: 0, objet: 'planches' })
    const d = await chooser.chooseWithJev({ jev, state: {}, kind: 'recolte', supply: 'harvest', dynamicCriteria })
    assert.equal(evaluated, 1)
    assert.deepEqual(d.choices, { ampleur: 0, objet: 'planches' })
    assert.deepEqual(Object.keys(calls[1].request.questions.objet.criteria), ['planches'])
    respond = jevAnswers({ step: 'sortir' })
    await chooser.chooseWithJev({ jev, state: {}, kind: 'recolte', supply: 'harvest', dynamicCriteria })
    assert.equal(evaluated, 1, 'pas de calcul des recettes pour une action sans parametre dynamique')
  })

  test('termine au-dessus du seuil : fin proposee (jugee ensuite par finishAllowed)', async () => {
    respond = jevAnswers({ step: 'casser', done: 0.95 })
    const d = await chooser.chooseWithJev({ jev, state: {}, kind: 'recolte', supply: 'harvest' })
    assert.equal(d.finished, true)
    assert.equal(d.done, 0.95)
    assert.equal(calls.length, 1)
  })

  test('ampleur en panne : le tour garde l action, echelle moyenne', async () => {
    respond = request => {
      if (request.questions.etape) return jevAnswers({ step: 'avancer' })(request)
      throw new Error('503')
    }
    const d = await chooser.chooseWithJev({ jev, state: {}, kind: 'deplacement', supply: 'harvest' })
    assert.equal(d.step, 'avancer')
    assert.equal(d.scale, 0.5)
    assert.deepEqual(d.choices, {})
  })

  test('panne Jev, action hors catalogue ou Jev inactif : rejet (l appelant replie)', async () => {
    respond = () => { throw new Error('timeout') }
    await assert.rejects(chooser.chooseWithJev({ jev, state: {}, kind: 'recolte', supply: 'harvest' }), /Jev call failed: timeout/)
    respond = jevAnswers({ step: 'regarder' })
    await assert.rejects(chooser.chooseWithJev({ jev, state: {}, kind: 'recolte', supply: 'harvest' }), /hors catalogue : regarder/)
    const off = { isEnabled: () => false, initError: 'TYPESAFE_API_KEY not set' }
    await assert.rejects(chooser.chooseWithJev({ jev: off, state: {}, kind: 'recolte', supply: 'harvest' }), /Jev inactif/)
  })

  test('noteFallback compte chaque repli et ne journalise qu une fois par cause', () => {
    const lines = []
    const origLog = console.log
    console.log = line => lines.push(line)
    try {
      chooser.noteFallback('timeout')
      chooser.noteFallback('timeout')
      chooser.noteFallback('401')
    } finally {
      console.log = origLog
    }
    assert.equal(chooser.snapshot().replis_planner, 3)
    assert.equal(lines.length, 2)
  })

  test('disjoncteur : apres 3 echecs d affilee, Jev n est plus appele pendant la pause', async () => {
    chooser.noteFallback('timeout')
    chooser.noteFallback('timeout')
    chooser.noteFallback('timeout')
    respond = jevAnswers({ step: 'sortir' })
    await assert.rejects(chooser.chooseWithJev({ jev, state: {}, kind: 'recolte', supply: 'harvest' }), /en pause/)
    assert.equal(calls.length, 0)
    const later = () => Date.now() + 61000
    const d = await chooser.chooseWithJev({ jev, state: {}, kind: 'recolte', supply: 'harvest', now: later })
    assert.equal(d.step, 'sortir')
  })
})

// --- Boucle de mission reelle : Jev choisit, le planificateur reprend le tour -
describe('runner reel (createMissionRunner)', () => {
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

  function fakeHost () {
    const handlers = {}
    const bot = {
      username: 'TestBot',
      entity: { position: pos(0, 64, 0), yaw: 0, pitch: 0, onGround: true },
      health: 20,
      pathfinder: { isMoving: () => false },
      players: {},
      entities: {},
      registry: null,
      inventory: { items: () => [] },
      on: (evt, fn) => { (handlers[evt] ??= []).push(fn) },
      removeListener: () => {},
      clearControlStates: () => {},
      lookAt: async () => {},
      blockAt: () => ({ name: 'air', boundingBox: 'empty', shapes: [] })
    }
    return {
      isReady: () => true,
      getBot: () => bot,
      chat: () => {},
      stopPathfinding: () => {},
      navigateToPlayer: async () => ({ reached: true, code: 'arrived', remaining: 0 }),
      navigateToPosition: async () => ({ reached: true, code: 'arrived', remaining: 0 }),
      recentChat: () => [],
      inLiquid: () => false
    }
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  async function waitEnd (runner) {
    for (let i = 0; i < 400; i++) {
      const s = runner.status()
      if (s && ['done', 'failed', 'stopped'].includes(s.etat)) return s
      await sleep(25)
    }
    throw new Error('mission sans fin')
  }

  function briefFor (kind) {
    return async () => ({ kind, kindConfidence: 0.9, resource: 'aucune', resourceConfidence: 0.9,
      resourceProbabilities: null, landmark: 'ici', door: false, doorProbability: 0 })
  }

  test('recolte : 1er tour Jev en panne -> planificateur, puis Jev choisit', async () => {
    chooser._reset()
    const { createMissionRunner } = require('../bot/mission')
    planner.isEnabled = () => true
    planner.readBrief = briefFor('recolte')
    let plans = 0
    planner.plan = async () => {
      plans += 1
      return { ms: 1, why: 'repli', rejected: [], finished: false, done: 0, seconds: 1,
        steps: [{ action: 'attendre', scale: 0, scaleLevel: 0, choices: { duree: 1 } }] }
    }
    let jevTurns = 0
    calls.length = 0
    respond = request => {
      if (request.questions.etape) {
        jevTurns += 1
        if (jevTurns === 1) throw new Error('timeout simule')
      }
      return jevAnswers({ step: 'attendre', ampleur: 0 })(request)
    }
    const runner = createMissionRunner(fakeHost())
    const started = await runner.start('ramasse ce que tu veux', 'Alice')
    assert.equal(started.ok, true)
    const end = await waitEnd(runner)
    assert.match(end.raison ?? '', /limite de 3 etapes/)
    assert.equal(plans, 1, 'un seul tour rendu au planificateur')
    const s = chooser.snapshot()
    assert.equal(s.replis_planner, 1)
    assert.equal(s.decisions_jev, 2)
    assert.equal(s.appels_jev, 1 + 2 * 2, 'un appel rate + (action + ampleur) x 2')
  })

  test('geste : le planificateur garde la main, Jev n est jamais appele', async () => {
    chooser._reset()
    const { createMissionRunner } = require('../bot/mission')
    planner.isEnabled = () => true
    planner.readBrief = briefFor('geste')
    let plans = 0
    planner.plan = async () => {
      plans += 1
      return { ms: 1, why: 'geste', rejected: [], finished: false, done: 0, seconds: 1,
        steps: [{ action: 'rejoindre_demandeur', scale: 0.5, scaleLevel: null, choices: {} }] }
    }
    calls.length = 0
    respond = () => { throw new Error('Jev ne doit pas etre appele') }
    const runner = createMissionRunner(fakeHost())
    const started = await runner.start('viens me voir', 'Alice')
    assert.equal(started.ok, true)
    await waitEnd(runner)
    assert.ok(plans >= 1)
    assert.equal(calls.length, 0)
    assert.equal(chooser.snapshot().decisions_jev, 0)
    assert.ok(chooser.snapshot().geste_via_planner >= 1)
  })
})
