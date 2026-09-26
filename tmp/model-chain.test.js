'use strict'
// Chaine de modeles par usage (bot/model-chain.js + planner.callWithProfile).
// Reseau simule (llm.call moque) : aucun appel distant, aucun secret.
//   NODE_PATH=bot/node_modules node --test tmp/model-chain.test.js
const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const chain = require('../bot/model-chain')
const llm = require('../bot/llm')

const PLANNER_PATH = require.resolve('../bot/planner')
const KEYS = ['PLANNER_TIMEOUT_MS_BRIEF', 'PLANNER_BASE_URL', 'PLANNER_MODEL', 'PLANNER_MODEL_PLAN', 'PLANNER_MODEL_CHAT', 'PLANNER_API_KEY', 'PLANNER_THINKING', 'PLANNER_REASONING_EFFORT', 'PLANNER_REASONING_EFFORT_PLAN', 'PLANNER_REASONING_EFFORT_BRIEF', 'BOT_USERNAME']
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

test('liste, base propre et usage : PLANNER_MODEL_<USAGE> sinon PLANNER_MODEL', () => {
  assert.deepEqual(chain.parse(' a , b@https://x/v1/ ').map(e => [e.model, e.baseUrl]), [['a', null], ['b', 'https://x/v1']])
  const env = { PLANNER_MODEL: 'a,b', PLANNER_MODEL_CHAT: 'c' }
  assert.deepEqual(chain.chainFor('plan', env).map(e => e.model), ['a', 'b'])
  assert.deepEqual(chain.chainFor('interpretMessage', env).map(e => e.model), ['c'])
  assert.deepEqual(chain.chainFor('classify', env).map(e => e.model), ['c'])
})

test('bascule sur quota, modele inconnu, 5xx ; jamais sur delai ou 400 de schema', () => {
  assert.ok(chain.isSwitchError(httpErr(429, 'GoUsageLimitError')))
  assert.ok(chain.isSwitchError(httpErr(401, 'Model x is not supported')))
  assert.ok(chain.isSwitchError(httpErr(400, 'Upstream request failed: Model is unavailable.')))
  assert.ok(chain.isSwitchError(httpErr(503, 'down')))
  assert.ok(!chain.isSwitchError(httpErr(400, 'Invalid request parameters')))
  assert.ok(!chain.isSwitchError(Object.assign(new Error('delai'), { code: 'LLM_TIMEOUT' })))
})

test('quota epuise : modele suivant dans le meme appel, puis mis de cote', async () => {
  const seen = []
  llm.call = async (s, u, o) => {
    seen.push(o.model)
    if (o.model === 'payant') throw httpErr(429, '{"type":"GoUsageLimitError"}')
    return { content: plan, usage: null, ms: 1 }
  }
  const p = load({ PLANNER_MODEL: 'payant,gratuit' })
  const r1 = await p.plan({}, 'recolte', 'harvest')
  assert.equal(r1.steps[0].action, 'regarder_autour')
  assert.deepEqual(seen, ['payant', 'gratuit'])
  seen.length = 0
  await p.plan({}, 'recolte', 'harvest')
  assert.deepEqual(seen, ['gratuit'], 'le modele a court de quota est mis de cote')
  assert.equal(p.stats.modele_servi, 'gratuit')
})

test('entree modele@url : autre base, et JAMAIS la cle du gateway principal', async () => {
  const seen = []
  llm.call = async (s, u, o) => {
    seen.push([o.model, o.baseUrl, o.apiKey])
    if (o.baseUrl.includes('/go/')) throw httpErr(401, 'Model x is not supported')
    return { content: plan, usage: null, ms: 1 }
  }
  const p = load({ PLANNER_MODEL: 'x,x@https://opencode.ai/zen/v1' })
  await p.plan({}, 'recolte', 'harvest')
  assert.deepEqual(seen.at(-1), ['x', 'https://opencode.ai/zen/v1', ''])
  assert.ok(seen.some(([, base, key]) => base.includes('/go/') && key === 'k-test'))
})

test('refus du champ thinking compte par modele', async () => {
  const seen = []
  llm.call = async (s, u, o) => {
    seen.push([o.model, Boolean(o.thinking)])
    if (o.model === 'a' && o.thinking) throw httpErr(400, 'Invalid request parameters')
    return { content: plan, usage: null, ms: 1 }
  }
  const p = load({ PLANNER_MODEL: 'a,b', PLANNER_MODEL_PLAN: 'a', PLANNER_MODEL_CHAT: 'b', PLANNER_THINKING: 'disabled' })
  for (let i = 0; i < 3; i++) await p.plan({}, 'recolte', 'harvest')
  assert.deepEqual(seen.slice(-1), [['a', false]], 'a : champ retire apres deux refus')
  seen.length = 0
  await p.interpretMessage('salut', {}).catch(() => {})
  assert.deepEqual(seen[0], ['b', true], 'b garde le champ')
})

test('delai depasse : modele suivant une fois, sans le mettre de cote', async () => {
  const seen = []
  llm.call = async (s, u, o) => {
    seen.push(o.model)
    if (o.model === 'lent') throw Object.assign(new Error('pas de reponse en 30000 ms'), { code: 'LLM_TIMEOUT' })
    return { content: plan, usage: null, ms: 1 }
  }
  const p = load({ PLANNER_MODEL: 'lent,rapide' })
  await p.plan({}, 'recolte', 'harvest')
  assert.deepEqual(seen, ['lent', 'rapide'])
  seen.length = 0
  await p.plan({}, 'recolte', 'harvest')
  assert.deepEqual(seen, ['lent', 'rapide'], 'un delai ne met pas le modele de cote')
})

test('tous refuses apres un delai : le modele muet est re-essaye une fois', async () => {
  const seen = []
  let lent = 0
  llm.call = async (s, u, o) => {
    seen.push(o.model)
    if (o.model === 'lent' && lent++ === 0) throw Object.assign(new Error('pas de reponse en 30000 ms'), { code: 'LLM_TIMEOUT' })
    if (o.model === 'quota') throw httpErr(429, 'GoUsageLimitError')
    return { content: plan, usage: null, ms: 1 }
  }
  const p = load({ PLANNER_MODEL: 'lent,quota' })
  const r = await p.plan({}, 'recolte', 'harvest')
  assert.equal(r.steps[0].action, 'regarder_autour')
  assert.deepEqual(seen, ['lent', 'quota', 'lent'])
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

test('cle par fournisseur : liste fermee d hotes, jamais ailleurs', async () => {
  const env = { GROQ_API_KEY: 'gk', GEMINI_API_KEY: 'gm' }
  assert.equal(chain.keyFor('https://api.groq.com/openai/v1', env), 'gk')
  assert.equal(chain.keyFor('https://generativelanguage.googleapis.com/v1beta/openai', env), 'gm')
  assert.equal(chain.keyFor('https://api.groq.com.evil.example/v1', env), '')
  assert.equal(chain.keyFor('https://opencode.ai/zen/v1', env), '')
  assert.equal(chain.keyFor('https://openrouter.ai/api/v1', { OPENROUTER_API_KEY: 'or' }), 'or')
  assert.equal(chain.keyFor('pas une url', env), '')
  assert.deepEqual(chain.chainFor('plan', { PLANNER_MODEL: 'g@https://api.groq.com/openai/v1,s@https://opencode.ai/zen/v1' }).map(e => e.model), ['s'], 'sans cle : entree ignoree')
  const seen = []
  llm.call = async (s, u, o) => { seen.push([o.baseUrl, o.apiKey]); return { content: plan, usage: null, ms: 1 } }
  process.env.GROQ_API_KEY = 'gk'
  try {
    const p = load({ PLANNER_MODEL: 'm@https://api.groq.com/openai/v1' })
    await p.plan({}, 'recolte', 'harvest')
  } finally { delete process.env.GROQ_API_KEY }
  assert.deepEqual(seen, [['https://api.groq.com/openai/v1', 'gk']])
})

test('alias go2 : gateway Go avec la cle secondaire, jamais la principale', async () => {
  assert.deepEqual(chain.chainFor('plan', { PLANNER_MODEL: 'd@go2,s' }).map(e => e.model), ['s'], 'sans cle secondaire : ignore')
  const seen = []
  llm.call = async (s, u, o) => {
    seen.push([o.model, o.baseUrl, o.apiKey])
    if (o.apiKey === 'k-test') throw httpErr(429, 'GoUsageLimitError')
    return { content: plan, usage: null, ms: 1 }
  }
  process.env.OPENCODE_SECONDARY_API_KEY = 'k2'
  try {
    const p = load({ PLANNER_MODEL: 'd,d@go2' })
    await p.plan({}, 'recolte', 'harvest')
  } finally { delete process.env.OPENCODE_SECONDARY_API_KEY }
  assert.deepEqual(seen, [['d', 'https://opencode.ai/zen/go/v1', 'k-test'], ['d', 'https://opencode.ai/zen/go/v1', 'k2']])
})

test('chaine vide (cles absentes) : erreur claire, jamais la liste brute envoyee', async () => {
  const seen = []
  llm.call = async (s, u, o) => { seen.push(o.model); return { content: plan, usage: null, ms: 1 } }
  const p = load({ PLANNER_MODEL: 'd@go2' })
  await assert.rejects(p.plan({}, 'recolte', 'harvest'))
  assert.deepEqual(seen, [])
})

test('delai par usage : PLANNER_TIMEOUT_MS_<USAGE>, jamais plus court que le delai commun', async () => {
  assert.equal(chain.timeoutFor('readBrief', { PLANNER_TIMEOUT_MS_BRIEF: '45000' }), 45000)
  assert.equal(chain.timeoutFor('plan', {}), null)
  const seen = []
  llm.call = async (s, u, o) => { seen.push(o.timeoutMs); return { content: '{"type":"recolte","matiere":"bois"}', usage: null, ms: 1 } }
  const p = load({ PLANNER_MODEL: 'a,b', PLANNER_TIMEOUT_MS_BRIEF: '45000' })
  await p.readBrief('coupe un arbre').catch(() => {})
  assert.ok(seen.length && seen.every(ms => ms >= 45000), JSON.stringify(seen))
})
