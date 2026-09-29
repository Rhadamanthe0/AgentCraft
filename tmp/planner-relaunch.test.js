'use strict'

// Relaunch of a silent plan call (bot/planner.js, PLANNER_RELAUNCH_MS). The
// network is simulated (llm.call mocked): no remote call, no secret.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')

const llm = require('../bot/llm')

const PLANNER_PATH = require.resolve('../bot/planner')
const VARS = ['PLANNER_BASE_URL', 'PLANNER_MODEL', 'PLANNER_SESSION_ID', 'PLANNER_TIMEOUT_MS', 'PLANNER_RELAUNCH_MS',
  'PLANNER_TIMEOUT_MS_PLAN', 'PLANNER_API_KEY', 'OPENCODE_SECONDARY_API_KEY', 'PLANNER_KEY_FIRST', 'BOT_USERNAME']

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
  llm.call = async (system, user, options = {}) => {
    const impl = impls[Math.min(i++, impls.length - 1)]
    calls.push({ options, at: Date.now() })
    return impl(options)
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
  it('appel muet : un second appel part apres le delai de relance et sa reponse sert', async () => {
    const planner = await warmPlanner([silent, async () => okPlan()])
    const started = Date.now()
    const result = await planner.plan({ consigne: 'test' }, 'recolte', 'harvest')
    assert.equal(result.steps.length, 1)
    assert.equal(calls.length, 2)
    assert.ok(calls[1].at - started >= 190, 'relance apres PLANNER_RELAUNCH_MS')
    assert.equal(calls[0].options.signal.aborted, true, 'appel muet annule une fois la reponse arrivee')
    assert.ok(calls[1].options.timeoutMs <= 3000 - 150, 'delai total inchange')
    assert.equal(planner.stats.relances, 1)
    assert.equal(planner.stats.relances_gagnantes, 1)
  })

  it('reponse avant le delai de relance : un seul appel', async () => {
    const planner = await warmPlanner([async () => okPlan()])
    await planner.plan({ consigne: 'test' }, 'recolte', 'harvest')
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(calls.length, 1)
    assert.equal(calls[0].options.timeoutMs, 3000)
    assert.equal(planner.stats.relances, 0)
  })

  it('premier appel qui repond pendant la relance : il gagne, la relance est annulee', async () => {
    const late = options => new Promise(resolve => setTimeout(() => resolve(okPlan()), 350))
    const planner = await warmPlanner([late, silent])
    await planner.plan({ consigne: 'test' }, 'recolte', 'harvest')
    assert.equal(calls.length, 2)
    assert.equal(calls[1].options.signal.aborted, true)
    assert.equal(planner.stats.relances, 1)
    assert.equal(planner.stats.relances_gagnantes, 0)
  })

  it('refus immediat (403) : leve tel quel, sans relance', async () => {
    const refused = async () => { throw Object.assign(new Error('HTTP 403 FreeTierError'), { code: 'LLM_HTTP', status: 403 }) }
    const planner = await warmPlanner([refused, async () => okPlan()])
    await assert.rejects(planner.plan({ consigne: 'test' }, 'recolte', 'harvest'), /FreeTierError/)
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(calls.length, 1)
    assert.equal(planner.stats.relances, 0)
  })

  it('deux appels muets : echec au delai total, pas au double', async () => {
    const planner = await warmPlanner([silent], { PLANNER_TIMEOUT_MS: '1200' })
    const started = Date.now()
    await assert.rejects(planner.plan({ consigne: 'test' }, 'recolte', 'harvest'), /planificateur indisponible/)
    assert.equal(calls.length, 2)
    assert.ok(Date.now() - started < 1200 + 300, `echec en ${Date.now() - started} ms`)
  })

  it('interrupteur relance_plan coupe : un seul appel, meme muet', async () => {
    const planner = await warmPlanner([silent], { PLANNER_TIMEOUT_MS: '500' })
    await assert.rejects(planner.plan({ consigne: 'test' }, 'recolte', 'harvest', {}, null, { relance: false }), /planificateur indisponible/)
    assert.equal(calls.length, 1)
    assert.equal(planner.stats.relances, 0)
  })

  it('annulation par l appelant : les deux appels sont annules, plan annule', async () => {
    const planner = await warmPlanner([silent])
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    await assert.rejects(planner.plan({ consigne: 'test' }, 'recolte', 'harvest', {}, null, { signal: controller.signal }), /plan annule/)
    assert.equal(calls.length, 2)
    assert.ok(calls.every(c => c.options.signal.aborted))
  })
})
