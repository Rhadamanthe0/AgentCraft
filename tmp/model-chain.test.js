'use strict'
// Modeles par usage (bot/model-chain.js + planner.callWithProfile) : le premier
// sert, une limite de debit longue (429 > 10 s ou sans attente dite) passe au
// suivant, aucun autre repli de modele. Reseau simule (llm.call moque).
//   NODE_PATH=bot/node_modules node --test tmp/model-chain.test.js
const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const chain = require('../bot/model-chain')
const llm = require('../bot/llm')

const PLANNER_PATH = require.resolve('../bot/planner')
const KEYS = ['PLANNER_BASE_URL', 'PLANNER_MODEL', 'PLANNER_MODEL_PLAN', 'PLANNER_MODEL_CHAT', 'PLANNER_MODEL_BRIEF',
  'PLANNER_MODEL_REPAIR', 'PLANNER_API_KEY', 'PLANNER_THINKING', 'PLANNER_REASONING_EFFORT', 'PLANNER_REASONING_EFFORT_PLAN',
  'PLANNER_REASONING_EFFORT_BRIEF', 'PLANNER_REASONING_EFFORT_REPAIR', 'PLANNER_TIMEOUT_MS_BRIEF', 'OPENCODE_SECONDARY_API_KEY', 'PLANNER_KEY_FIRST',
  'BOT_USERNAME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL']
const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]))
const origCall = llm.call
afterEach(() => {
  llm.call = origCall
  delete require.cache[PLANNER_PATH]
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
})

function load (env) {
  delete require.cache[PLANNER_PATH]
  for (const k of KEYS) delete process.env[k]
  Object.assign(process.env, { PLANNER_BASE_URL: 'https://opencode.ai/zen/go/v1', PLANNER_API_KEY: 'k-test', BOT_USERNAME: 'T' }, env)
  return require('../bot/planner')
}
const httpErr = (status, message) => Object.assign(new Error(`HTTP ${status} : ${message}`), { code: 'LLM_HTTP', status })
const plan = '{"fini":0,"pourquoi":"t","plan":[{"action":"regarder_autour"}]}'

test('modele de l usage : PLANNER_MODEL_<USAGE> sinon PLANNER_MODEL ; une liste dans l ordre', () => {
  assert.deepEqual(chain.modelsFor('plan', { PLANNER_MODEL: 'a, b,c' }).map(e => e.model), ['a', 'b', 'c'])
  assert.deepEqual(chain.parse(' a , b ').map(e => e.model), ['a', 'b'])
  assert.equal(chain.modelFor('plan', { PLANNER_MODEL: 'b@go2' }), null, 'plus aucun alias')
  const env = { PLANNER_MODEL: 'a,b', PLANNER_MODEL_CHAT: 'c' }
  assert.equal(chain.modelFor('plan', env).model, 'a')
  assert.equal(chain.modelFor('interpretMessage', env).model, 'c')
  assert.equal(chain.modelFor('interpretMessage', env).model, 'c')
})

test('refus du fournisseur (403) : l erreur remonte, AUCUN autre modele n est essaye', async () => {
  const seen = []
  llm.call = async (s, u, o) => { seen.push(o.model); throw httpErr(403, 'FreeTierError') }
  const p = load({ PLANNER_MODEL: 'gratuit,payant' })
  await assert.rejects(p.plan({}, 'recolte', 'harvest'))
  assert.deepEqual([...new Set(seen)], ['gratuit'])
})

test('limite de debit longue ou sans attente dite : modele suivant, puis le limite reste de cote', async () => {
  const seen = []
  llm.call = async (s, u, o) => {
    seen.push(o.model)
    if (o.model === 'step') throw Object.assign(httpErr(429, 'rate limit'), { attenteS: 30 })
    if (o.model === 'exo') throw Object.assign(httpErr(429, 'rate limit'), { attenteS: null })
    return { content: plan, usage: null, ms: 1 }
  }
  const p = load({ PLANNER_MODEL: 'step,exo,deepseek' })
  await p.plan({}, 'recolte', 'harvest')
  assert.deepEqual(seen, ['step', 'exo', 'deepseek'])
  seen.length = 0
  await p.plan({}, 'recolte', 'harvest')
  assert.deepEqual(seen, ['deepseek'], 'step et exo de cote le temps demande')
  assert.equal(p.stats.bascules_modele, 2)
})

test('limite de debit courte (10 s au plus) : pas de changement de modele', async () => {
  const seen = []
  llm.call = async (s, u, o) => { seen.push(o.model); throw Object.assign(httpErr(429, 'rate limit'), { attenteS: 5 }) }
  const p = load({ PLANNER_MODEL: 'step,deepseek' })
  await assert.rejects(p.plan({}, 'recolte', 'harvest'))
  assert.deepEqual([...new Set(seen)], ['step'])
})

test('silence du modele : pas de changement de modele', async () => {
  const seen = []
  llm.call = async (s, u, o) => { seen.push(o.model); throw Object.assign(new Error('pas de reponse en 10 s'), { code: 'LLM_TIMEOUT' }) }
  const p = load({ PLANNER_MODEL: 'step,deepseek' })
  await assert.rejects(p.plan({}, 'recolte', 'harvest'))
  assert.deepEqual([...new Set(seen)], ['step'])
})

test('mise de cote : attente demandee, 60 s si non dite, dernier modele si tous limites', () => {
  const st = chain.createModelState()
  const e = ['a', 'b'].map(model => ({ model }))
  st.bench(e[0], 30, 0)
  assert.deepEqual(st.order(e, 29000).map(x => x.model), ['b'])
  assert.deepEqual(st.order(e, 30001).map(x => x.model), ['a', 'b'])
  st.bench(e[0], null, 0)
  st.bench(e[1], null, 0)
  assert.deepEqual(st.order(e, 59000).map(x => x.model), ['b'])
  assert.equal(chain.isRateLimitSwitch(Object.assign(httpErr(429, 'x'), { attenteS: 10 })), false)
  assert.equal(chain.isRateLimitSwitch(Object.assign(httpErr(429, 'x'), { attenteS: 11 })), true)
  assert.equal(chain.isRateLimitSwitch(httpErr(429, 'x')), true)
  assert.equal(chain.isRateLimitSwitch(httpErr(403, 'x')), false)
})

test('base tierce `modele@url` refusee : aucun modele, aucun appel', async () => {
  assert.equal(chain.modelFor('plan', { PLANNER_MODEL: 'x@https://opencode.ai/zen/v1' }), null)
  const seen = []
  llm.call = async (s, u, o) => { seen.push(o.model); return { content: plan, usage: null, ms: 1 } }
  const p = load({ PLANNER_MODEL: 'x@https://opencode.ai/zen/v1' })
  await assert.rejects(p.plan({}, 'recolte', 'harvest'))
  assert.deepEqual(seen, [])
})

test('refus du champ thinking compte par modele', async () => {
  const seen = []
  llm.call = async (s, u, o) => {
    seen.push([o.model, Boolean(o.thinking)])
    if (o.model === 'a' && o.thinking) throw httpErr(400, 'Invalid request parameters')
    return { content: plan, usage: null, ms: 1 }
  }
  const p = load({ PLANNER_MODEL: 'a', PLANNER_MODEL_PLAN: 'a', PLANNER_MODEL_CHAT: 'b', PLANNER_THINKING: 'disabled' })
  for (let i = 0; i < 3; i++) await p.plan({}, 'recolte', 'harvest')
  assert.deepEqual(seen.slice(-1), [['a', false]], 'a : champ retire apres deux refus')
  seen.length = 0
  await p.interpretMessage('salut', {}).catch(() => {})
  assert.deepEqual(seen[0], ['b', true], 'b garde le champ')
})

test('effort de raisonnement par usage, a la place de thinking, retire apres deux refus', async () => {
  assert.equal(chain.effortFor('plan', { PLANNER_REASONING_EFFORT: 'medium', PLANNER_REASONING_EFFORT_PLAN: 'low' }), 'low')
  assert.equal(chain.effortFor('readBrief', { PLANNER_REASONING_EFFORT: 'medium' }), 'medium')
  assert.equal(chain.effortFor('readBrief', {}), null)
  const seen = []
  llm.call = async (s, u, o) => {
    seen.push([o.model, o.reasoningEffort ?? null, Boolean(o.thinking)])
    if (o.model === 'b' && o.reasoningEffort) throw httpErr(400, 'Invalid request parameters')
    return { content: plan, usage: null, ms: 1 }
  }
  const p = load({ PLANNER_MODEL: 'a', PLANNER_MODEL_PLAN: 'b', PLANNER_THINKING: 'disabled', PLANNER_REASONING_EFFORT_PLAN: 'low' })
  await p.plan({}, 'recolte', 'harvest')
  assert.deepEqual(seen, [['b', 'low', false], ['b', null, false]], 'effort seul, rejoue sans lui sur 400')
  await p.plan({}, 'recolte', 'harvest')
  seen.length = 0
  await p.plan({}, 'recolte', 'harvest')
  assert.deepEqual(seen, [['b', null, true]], 'effort retire apres deux refus : retour au champ thinking')
  seen.length = 0
  await p.readBrief('coupe un arbre').catch(() => {})
  assert.deepEqual(seen[0], ['a', null, true], 'lecture de l objectif : pas d effort, thinking garde')
})

test('muse (/responses) : effort envoye en reasoning.effort', async () => {
  const seen = []
  llm.call = async (s, u, o) => { seen.push([o.model, o.protocol, o.reasoning, o.reasoningEffort ?? null]); return { content: plan, usage: null, ms: 1 } }
  const p = load({ PLANNER_MODEL: 'x', PLANNER_MODEL_PLAN: 'muse-spark-1.3-contributor', PLANNER_REASONING_EFFORT_PLAN: 'high' })
  await p.plan({}, 'recolte', 'harvest')
  assert.deepEqual(seen[0], ['muse-spark-1.3-contributor', 'responses', { effort: 'high' }, null])
})

test('repli de CLE : meme modele, autre cle sur quota ; ordre par PLANNER_KEY_FIRST', async () => {
  assert.deepEqual(chain.keyOrder({ PLANNER_API_KEY: 'p', OPENCODE_SECONDARY_API_KEY: 's' }).map(k => k.name), ['primary', 'secondary'])
  assert.deepEqual(chain.keyOrder({ PLANNER_API_KEY: 'p', OPENCODE_SECONDARY_API_KEY: 's', PLANNER_KEY_FIRST: 'secondary' }).map(k => k.name), ['secondary', 'primary'])
  assert.deepEqual(chain.keyOrder({ OPENCODE_SECONDARY_API_KEY: 's' }).map(k => k.name), ['secondary'])
  const seen = []
  llm.call = async (s, u, o) => {
    seen.push([o.model, o.apiKey])
    if (o.apiKey === 'k-test') throw httpErr(429, 'GoUsageLimitError')
    return { content: plan, usage: null, ms: 1 }
  }
  const p = load({ PLANNER_MODEL: 'd', OPENCODE_SECONDARY_API_KEY: 'k2' })
  await p.plan({}, 'recolte', 'harvest')
  assert.deepEqual(seen, [['d', 'k-test'], ['d', 'k2']])
  assert.equal(p.stats.cle_servie, 'secondary')
  seen.length = 0
  await p.plan({}, 'recolte', 'harvest')
  assert.deepEqual(seen, [['d', 'k2']], 'cle refusee mise de cote')
})

test('repli de cle : jamais sur 5xx ni delai, et jamais un autre modele', async () => {
  const seen = []
  llm.call = async (s, u, o) => { seen.push([o.model, o.apiKey]); throw httpErr(503, 'down') }
  const p = load({ PLANNER_MODEL: 'd,e', OPENCODE_SECONDARY_API_KEY: 'k2' })
  await assert.rejects(p.plan({}, 'recolte', 'harvest'))
  assert.deepEqual([...new Set(seen.map(x => x.join('/')))], ['d/k-test'])
})

test('delai par usage : PLANNER_TIMEOUT_MS_<USAGE>, jamais plus court que le delai commun', async () => {
  assert.equal(chain.timeoutFor('readBrief', { PLANNER_TIMEOUT_MS_BRIEF: '45000' }), 45000)
  assert.equal(chain.timeoutFor('plan', {}), null)
  const seen = []
  llm.call = async (s, u, o) => { seen.push(o.timeoutMs); return { content: '{"type":"recolte","matiere":"bois"}', usage: null, ms: 1 } }
  const p = load({ PLANNER_MODEL: 'a', PLANNER_TIMEOUT_MS_BRIEF: '45000' })
  await p.readBrief('coupe un arbre').catch(() => {})
  assert.ok(seen.length && seen.every(ms => ms >= 45000), JSON.stringify(seen))
})

test('troncature : UN reessai du meme modele a budget elargi, jamais un autre', async () => {
  const seen = []
  llm.call = async (s, u, o) => {
    seen.push([o.model, o.maxTokens])
    if (seen.length === 1) throw new Error('reponse tronquee (length)')
    return { content: plan, usage: null, ms: 1 }
  }
  const p = load({ PLANNER_MODEL: 'a,b' })
  await p.plan({}, 'recolte', 'harvest')
  assert.deepEqual(seen.map(x => x[0]), ['a', 'a'])
  assert.ok(seen[1][1] > seen[0][1])
})

test('chat sans reponse dans le delai : UN rejeu du meme modele, puis l erreur', async () => {
  const chat = JSON.stringify({ relation: 'new', objective: 'coupe un arbre', response: 'OK.' })
  let calls = 0
  llm.call = async (s, u, o) => {
    calls++
    if (calls === 1) throw new Error('pas de reponse en 20000 ms')
    return { content: chat, usage: null, ms: 1 }
  }
  const p = load({ PLANNER_MODEL: 'a' })
  assert.equal((await p.interpretMessage('coupe moi un arbre', {})).relation, 'new')
  assert.equal(calls, 2)
  calls = 0
  llm.call = async () => { calls++; throw new Error('pas de reponse en 20000 ms') }
  await assert.rejects(p.interpretMessage('coupe moi un arbre', {}), /pas de reponse/)
  assert.equal(calls, 2, 'jamais plus d un rejeu')
})

test('A/B de modele : setOverrides remplace le modele d un usage jusqu au reset', () => {
  const mc = require('../bot/model-chain')
  const env = process.env
  const before = env.PLANNER_MODEL
  env.PLANNER_MODEL = 'deepseek-v4.1-flash'
  try {
    assert.deepEqual(mc.setOverrides({ plan: 'claude-haiku-5-5', chat: 'claude-haiku-5-5', inconnu: 'x', brief: 'a b' }),
      { plan: 'claude-haiku-5-5', chat: 'claude-haiku-5-5' })
    assert.equal(mc.modelFor('plan').model, 'claude-haiku-5-5')
    assert.equal(mc.modelFor('interpretMessage').model, 'claude-haiku-5-5')
    assert.equal(mc.modelFor('readBrief').model, 'deepseek-v4.1-flash')
    assert.equal(mc.modelFor('plan', { PLANNER_MODEL: 'z' }).model, 'z', 'un env explicite n est pas touche')
    assert.deepEqual(mc.setOverrides({ brief: 'openai/gpt-5.4-mini', chat: 'autre/x' }),
      { plan: 'claude-haiku-5-5', brief: 'openai/gpt-5.4-mini', chat: 'claude-haiku-5-5' }, 'seul le prefixe openai/ est admis')
    assert.deepEqual(mc.setOverrides({ reset: true }), {})
    assert.equal(mc.modelFor('plan').model, 'deepseek-v4.1-flash')
  } finally {
    mc.setOverrides({ reset: true })
    if (before === undefined) delete env.PLANNER_MODEL; else env.PLANNER_MODEL = before
  }
})

test('A/B d effort : effort_plan none ou medium jusqu au reset, valeur inconnue ignoree', () => {
  const mc = require('../bot/model-chain')
  try {
    assert.deepEqual(mc.setOverrides({ effort_plan: 'none', effort_chat: 'medium', effort_brief: 'enorme' }),
      { effort_plan: 'none', effort_chat: 'medium' })
    assert.equal(mc.effortFor('plan'), 'none')
    assert.equal(mc.effortFor('interpretMessage'), 'medium')
    assert.equal(mc.effortFor('plan', { PLANNER_REASONING_EFFORT_PLAN: 'low' }), 'low', 'un env explicite n est pas touche')
    mc.setOverrides({ reset: true })
    assert.notEqual(mc.effortFor('plan'), 'none')
  } finally {
    mc.setOverrides({ reset: true })
  }
})

test('effort none : le plan part avec thinking disabled et sans effort', async () => {
  const sent = []
  llm.call = async (s, u, o) => { sent.push(o); return { content: plan, usage: null, ms: 1 } }
  const p = load({ PLANNER_MODEL: 'claude-haiku-5-5', PLANNER_REASONING_EFFORT_PLAN: 'none' })
  await p.plan({}, 'recolte', 'harvest')
  assert.deepEqual(sent[0].thinking, { type: 'disabled' })
  assert.equal(sent[0].reasoningEffort ?? null, null)
})

test('openai/<modele> : API OpenAI en direct avec OPENAI_API_KEY, sans en-tetes Zen ni bascule de cle', async () => {
  const seen = []
  llm.call = async (s, u, o) => { seen.push(o); return { content: plan, usage: null, ms: 1 } }
  const p = load({ PLANNER_MODEL: 'claude-haiku-5-5', PLANNER_MODEL_PLAN: 'openai/gpt-5.4-mini', OPENAI_API_KEY: 'k-openai', OPENCODE_SECONDARY_API_KEY: 'k-go2' })
  await p.plan({}, 'recolte', 'harvest')
  assert.equal(seen[0].baseUrl, 'https://api.openai.com/v1')
  assert.equal(seen[0].apiKey, 'k-openai')
  assert.equal(seen[0].model, 'gpt-5.4-mini')
  assert.equal(seen[0].headers, null)
  assert.equal(p.stats.cle_servie, 'openai')
  seen.length = 0
  await p.interpretMessage('salut', {}).catch(() => {})
  assert.equal(seen[0].baseUrl, 'https://opencode.ai/zen/go/v1', 'les autres usages restent sur Go')
  assert.equal(seen[0].apiKey, 'k-test')
})

test('openai/<modele> sans OPENAI_API_KEY : refus remonte, jamais la cle Go', async () => {
  const seen = []
  llm.call = async (s, u, o) => { seen.push(o.apiKey); throw httpErr(401, 'Incorrect API key') }
  const p = load({ PLANNER_MODEL: 'openai/gpt-5-mini' })
  await assert.rejects(p.plan({}, 'recolte', 'harvest'))
  assert.deepEqual([...new Set(seen)], [''])
})
