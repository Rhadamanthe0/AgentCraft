'use strict'

// Relaunch of a silent plan call (bot/planner.js, PLANNER_RELAUNCH_MS). The
// network is simulated (llm.call mocked): no remote call, no secret.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')

const llm = require('../bot/llm')

const PLANNER_PATH = require.resolve('../bot/planner')
const VARS = ['PLANNER_BASE_URL', 'PLANNER_MODEL', 'PLANNER_SESSION_ID', 'PLANNER_TIMEOUT_MS', 'PLANNER_RELAUNCH_MS', 'PLANNER_RELAUNCH_MS_BRIEF', 'PLANNER_TIMEOUT_MS_BRIEF', 'PLANNER_MODEL_PLAN',
  'PLANNER_TIMEOUT_MS_PLAN', 'PLANNER_REASONING_EFFORT', 'PLANNER_REASONING_EFFORT_PLAN','PLANNER_API_KEY', 'OPENCODE_SECONDARY_API_KEY', 'PLANNER_KEY_FIRST', 'BOT_USERNAME']

let origCall
let savedEnv
let calls

function okPlan () {
  return { content: '{"fini":0,"pourquoi":"test","plan":[{"action":"regarder_autour"}]}', usage: null, ms: 5 }
}

// Never answers: rejects like the transport on abort or delay.
function silent (options) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error(`pas de reponse en ${options.timeoutMs} ms`), { code: 'LLM_TIMEOUT' })), options.timeoutMs)
    options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('appel annule'), { code: 'LLM_ABORTED' })) }, { once: true })
  })
}

// Loads a warm planner (the warm-up call never relaunches) whose calls follow `impls` in order.
async function warmPlanner (impls, env = {}) {
  delete require.cache[PLANNER_PATH]
  Object.assign(process.env, { PLANNER_TIMEOUT_MS: '3000', PLANNER_RELAUNCH_MS: '200' }, env)
  const planner = require('../bot/planner')
  planner._resetProfile()
  llm.call = async () => okPlan()
  await planner.plan({ consigne: 'chauffe' }, 'recolte', 'harvest')
  calls = []
  let i = 0
  let active = 0
  llm.call = async (system, user, options = {}) => {
    const impl = impls[Math.min(i++, impls.length - 1)]
    calls.push({ options, at: Date.now(), concurrent: active })
    active += 1
    try { return await impl(options) } finally { active -= 1 }
  }
  return planner
}

beforeEach(() => {
  origCall = llm.call
  savedEnv = Object.fromEntries(VARS.map(k => [k, process.env[k]]))
  for (const k of VARS) delete process.env[k]
  process.env.PLANNER_BASE_URL = 'https://opencode.ai/zen/go/v1'
  process.env.PLANNER_MODEL = 'deepseek-v4.1-flash'
  process.env.PLANNER_SESSION_ID = 'minecraft-bot-TestBot'
  process.env.BOT_USERNAME = 'TestBot'
})

afterEach(() => {
  llm.call = origCall
  delete require.cache[PLANNER_PATH]
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('relance d un plan sans reponse', () => {
  it('appel muet : coupe au delai de relance, refait une fois avec le temps restant', async () => {
    const planner = await warmPlanner([silent, async () => okPlan()])
    const result = await planner.plan({ consigne: 'test' }, 'recolte', 'harvest')
    assert.equal(result.steps.length, 1)
    assert.ok(result.ms >= 190, `duree du plan avec l appel abandonne (${result.ms} ms)`)
    assert.equal(calls.length, 2)
    assert.ok(calls[0].options.timeoutMs > 180 && calls[0].options.timeoutMs <= 200, `premier appel coupe au delai de relance (${calls[0].options.timeoutMs} ms)`)
    assert.equal(calls[1].concurrent, 0, 'jamais deux appels en meme temps')
    assert.ok(calls[1].options.timeoutMs <= 3000 - 190 && calls[1].options.timeoutMs > 2500, 'temps restant du delai total')
    assert.equal(planner.stats.relances, 1)
    assert.equal(planner.stats.relances_reussies, 1)
  })

  it('reponse avant le delai de relance : un seul appel', async () => {
    const planner = await warmPlanner([async () => okPlan()])
    await planner.plan({ consigne: 'test' }, 'recolte', 'harvest')
    assert.equal(calls.length, 1)
    assert.equal(planner.stats.relances, 0)
  })

  it('refus immediat (403) : leve tel quel, sans relance', async () => {
    const refused = async () => { throw Object.assign(new Error('HTTP 403 FreeTierError'), { code: 'LLM_HTTP', status: 403 }) }
    const planner = await warmPlanner([refused, async () => okPlan()])
    await assert.rejects(planner.plan({ consigne: 'test' }, 'recolte', 'harvest'), /FreeTierError/)
    assert.equal(calls.length, 1)
    assert.equal(planner.stats.relances, 0)
  })

  it('deux appels muets : echec au delai total, pas au double', async () => {
    const planner = await warmPlanner([silent], { PLANNER_TIMEOUT_MS: '1500' })
    const started = Date.now()
    await assert.rejects(planner.plan({ consigne: 'test' }, 'recolte', 'harvest'), /planificateur indisponible/)
    assert.equal(calls.length, 2)
    assert.ok(Date.now() - started < 1500 + 150, `echec en ${Date.now() - started} ms`)
    assert.equal(planner.stats.relances_reussies, 0)
  })

  it('relance impossible (moins d une seconde apres elle) : appel ordinaire, tout le delai', async () => {
    const planner = await warmPlanner([silent], { PLANNER_TIMEOUT_MS: '1000', PLANNER_RELAUNCH_MS: '900' })
    await assert.rejects(planner.plan({ consigne: 'test' }, 'recolte', 'harvest'), /planificateur indisponible/)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].options.timeoutMs, 1000, 'premier appel non raccourci')
  })

  it('delai propre au plan plus long : la relance s applique sur ce delai', async () => {
    const planner = await warmPlanner([silent, async () => okPlan()], { PLANNER_TIMEOUT_MS: '150', PLANNER_TIMEOUT_MS_PLAN: '3000' })
    await planner.plan({ consigne: 'test' }, 'recolte', 'harvest')
    assert.equal(calls.length, 2)
    assert.ok(calls[0].options.timeoutMs > 180 && calls[0].options.timeoutMs <= 200, `premier appel coupe au delai de relance (${calls[0].options.timeoutMs} ms)`)
  })

  it('troncature tardive de la relance : son reessai reste dans le delai total', async () => {
    const truncatedLate = options => new Promise((resolve, reject) =>
      setTimeout(() => reject(new Error('reponse incomplete (max_output_tokens)')), options.timeoutMs - 100))
    const planner = await warmPlanner([silent, truncatedLate, silent], { PLANNER_TIMEOUT_MS: '1500' })
    const started = Date.now()
    await assert.rejects(planner.plan({ consigne: 'test' }, 'recolte', 'harvest'), /planificateur indisponible/)
    assert.equal(calls.length, 3, 'appel coupe, relance tronquee, reessai de troncature')
    assert.ok(calls[2].options.timeoutMs <= 150, `reessai borne par le delai restant (${calls[2].options.timeoutMs} ms)`)
    assert.ok(Date.now() - started < 1500 + 150, `echec en ${Date.now() - started} ms`)
  })

  it('refus 400 tardif du champ de raisonnement : le rejeu sans le champ reste dans le delai total', async () => {
    const refusedLate = options => new Promise((resolve, reject) =>
      setTimeout(() => reject(Object.assign(new Error('HTTP 400 : Upstream request failed'), { code: 'LLM_HTTP', status: 400 })), options.timeoutMs - 100))
    const planner = await warmPlanner([silent, refusedLate, silent], { PLANNER_TIMEOUT_MS: '1500', PLANNER_REASONING_EFFORT: 'low' })
    const requestsBefore = planner.stats.tentatives
    const started = Date.now()
    await assert.rejects(planner.plan({ consigne: 'test' }, 'recolte', 'harvest'), /planificateur indisponible/)
    assert.equal(calls.length, 3, 'appel coupe, relance refusee (400), rejeu sans le champ')
    assert.equal(calls[1].options.reasoningEffort, 'low')
    assert.equal(calls[2].options.reasoningEffort, undefined)
    assert.equal(planner.stats.tentatives - requestsBefore, 3, 'le rejeu sans le champ compte comme une requete')
    assert.ok(calls[2].options.timeoutMs <= 150, `rejeu borne par le delai restant (${calls[2].options.timeoutMs} ms)`)
    assert.ok(Date.now() - started < 1500 + 150, `echec en ${Date.now() - started} ms`)
  })

  it('modele du plan encore froid (autre modele deja chaud) : tout le delai, sans relance', async () => {
    const planner = await warmPlanner([silent], { PLANNER_TIMEOUT_MS: '500' })
    process.env.PLANNER_MODEL_PLAN = 'glm-5.3-flash'
    await assert.rejects(planner.plan({ consigne: 'test' }, 'recolte', 'harvest'), /planificateur indisponible/)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].options.timeoutMs, 500)
  })

  it('interrupteur relance_plan coupe : un seul appel, meme muet', async () => {
    const planner = await warmPlanner([silent], { PLANNER_TIMEOUT_MS: '500' })
    await assert.rejects(planner.plan({ consigne: 'test' }, 'recolte', 'harvest', {}, null, { relance: false }), /planificateur indisponible/)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].options.timeoutMs, 500)
    assert.equal(planner.stats.relances, 0)
  })

  it('annulation par l appelant : pas de relance, plan annule', async () => {
    const planner = await warmPlanner([silent])
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    await assert.rejects(planner.plan({ consigne: 'test' }, 'recolte', 'harvest', {}, null, { signal: controller.signal }), /plan annule/)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].options.signal, controller.signal, 'signal de l appelant transmis tel quel')
  })
})

// Lecture de l objectif : meme relance, a son propre delai. Deux briefs muets
// de 30 s laissaient le niveau sans mission (bancs du 2026-10-07/08,
// trees/tall et craft/furnace) alors qu un nouvel appel repond en quelques s.
describe('relance de la lecture d objectif', () => {
  const okBrief = async () => ({ content: '{"type":"recolte","matiere":"bois"}', usage: null, ms: 5 })

  it('brief muet : coupe a PLANNER_RELAUNCH_MS_BRIEF, refait dans le delai du brief', async () => {
    const planner = await warmPlanner([silent, okBrief], { PLANNER_TIMEOUT_MS_BRIEF: '3000', PLANNER_RELAUNCH_MS_BRIEF: '300' })
    await planner.readBrief('coupe du bois')
    assert.equal(calls.length, 2)
    assert.ok(calls[0].options.timeoutMs > 280 && calls[0].options.timeoutMs <= 300, `premier appel coupe (${calls[0].options.timeoutMs} ms)`)
    assert.ok(calls[1].options.timeoutMs > 2500 && calls[1].options.timeoutMs <= 2700, 'temps restant du delai du brief')
  })

  it('interrupteur relance_plan coupe : un seul appel', async () => {
    const planner = await warmPlanner([silent], { PLANNER_TIMEOUT_MS: '500', PLANNER_RELAUNCH_MS_BRIEF: '100' })
    await assert.rejects(planner.readBrief('coupe du bois', { relance: false }))
    assert.equal(calls.length, 1)
  })
})

// A/B `plan_sans_raisonnement` (mission.js) : le plan part avec thinking
// desactive a la place de l effort ; un refus du champ ne retire jamais
// l effort des autres usages.
describe('plan sans raisonnement', () => {
  it('thinking desactive, pas d effort ; sans le drapeau, l effort du plan', async () => {
    const planner = await warmPlanner([async () => okPlan()], { PLANNER_REASONING_EFFORT_PLAN: 'low' })
    await planner.plan({ consigne: 'test' }, 'recolte', 'harvest', {}, null, { sansRaisonnement: true })
    assert.deepEqual(calls[0].options.thinking, { type: 'disabled' })
    assert.equal(calls[0].options.reasoningEffort, null)
    await planner.plan({ consigne: 'test' }, 'recolte', 'harvest')
    assert.equal(calls[1].options.reasoningEffort, 'low')
    assert.equal(calls[1].options.thinking ?? null, null)
  })

  it('champ refuse (400) : rejoue sans lui, l effort du plan normal reste', async () => {
    const refus = async () => { throw Object.assign(new Error('HTTP 400 : thinking'), { code: 'LLM_HTTP', status: 400 }) }
    const planner = await warmPlanner([refus, async () => okPlan(), refus, async () => okPlan(), async () => okPlan()], { PLANNER_REASONING_EFFORT_PLAN: 'low' })
    await planner.plan({ consigne: 'test' }, 'recolte', 'harvest', {}, null, { sansRaisonnement: true })
    await planner.plan({ consigne: 'test' }, 'recolte', 'harvest', {}, null, { sansRaisonnement: true })
    await planner.plan({ consigne: 'test' }, 'recolte', 'harvest')
    assert.equal(calls.at(-1).options.reasoningEffort, 'low', 'effort du plan intact apres deux refus de thinking')
  })
})

// Pannes passageres (bancs du 2026-10-08 : 30 s de « fetch failed » sur 13
// bots) : classees par le code, rejouees tant que dure le budget.
describe('panne passagere', () => {
  const reseau = async () => { throw Object.assign(new TypeError('fetch failed'), { code: 'LLM_NETWORK' }) }

  it('classement : silence, reseau, 5xx, 429 oui ; 403, annulation, contenu non', () => {
    const planner = require('../bot/planner')
    const e = (code, status, message = 'x') => Object.assign(new Error(message), { code, status })
    assert.equal(planner.estPassager(e('LLM_TIMEOUT')), true)
    assert.equal(planner.estPassager(e('LLM_NETWORK')), true)
    assert.equal(planner.estPassager(e('LLM_HTTP', 503)), true)
    assert.equal(planner.estPassager(e('LLM_HTTP', 429)), true)
    assert.equal(planner.estPassager(e('LLM_HTTP', 400, 'HTTP 400 : Upstream request failed')), true)
    assert.equal(planner.estPassager(e('LLM_HTTP', 403, 'HTTP 403 FreeTierError')), false)
    assert.equal(planner.estPassager(e('LLM_ABORTED')), false)
    assert.equal(planner.estPassager(new Error('relation de chat invalide')), false)
  })

  it('plan : l erreur rendue dit si la panne est passagere', async () => {
    const planner = await warmPlanner([reseau])
    await assert.rejects(planner.plan({ consigne: 'test' }, 'recolte', 'harvest'), err => err.passager === true)
    const refuse = async () => { throw Object.assign(new Error('HTTP 403 FreeTierError'), { code: 'LLM_HTTP', status: 403 }) }
    const p2 = await warmPlanner([refuse])
    await assert.rejects(p2.plan({ consigne: 'test' }, 'recolte', 'harvest'), err => err.passager === false)
  })

  it('chat : un reseau coupe se rejoue jusqu a la reponse', async () => {
    const okChat = async () => ({ content: '{"relation":"new","objectif":"coupe du bois"}', usage: null, ms: 5 })
    const planner = await warmPlanner([reseau, reseau, okChat], { PLANNER_TIMEOUT_MS: '6000' })
    const decision = await planner.interpretMessage('coupe du bois', {})
    assert.equal(calls.length, 3)
    assert.equal(decision.relation, 'new')
  })

  it('chat : un refus (403) n est pas rejoue', async () => {
    const refuse = async () => { throw Object.assign(new Error('HTTP 403 FreeTierError'), { code: 'LLM_HTTP', status: 403 }) }
    const planner = await warmPlanner([refuse])
    await assert.rejects(planner.interpretMessage('coupe du bois', {}), /FreeTierError/)
    assert.equal(calls.length, 1)
  })
})

// deepseek abime parfois le NOM de la cle relation (« relation_nouvelle »,
// « relationer », 6 a 9 fois par banc complet, 1 a 2 ordres perdus) : la
// valeur reste juste et suffit, sans rejeu.
describe('chat : nom de cle relation abime', () => {
  it('relation_nouvelle / objectif : lus sans rejeu', async () => {
    const abime = async () => ({ content: '{"relation_nouvelle":"new","objectif":"Coupe un arbre","response":"OK"}', usage: null, ms: 5 })
    const planner = await warmPlanner([abime])
    const decision = await planner.interpretMessage('coupe moi un arbre', {})
    assert.equal(decision.relation, 'new')
    assert.equal(decision.objective, 'Coupe un arbre')
    assert.equal(calls.length, 1)
  })

  it('deux cles relation contradictoires : rejeu, puis erreur', async () => {
    const ambigu = async () => ({ content: '{"relation_a":"new","relation_b":"stop"}', usage: null, ms: 5 })
    const planner = await warmPlanner([ambigu])
    await assert.rejects(planner.interpretMessage('coupe moi un arbre', {}), /relation de chat invalide/)
    assert.equal(calls.length, 2)
  })
})
