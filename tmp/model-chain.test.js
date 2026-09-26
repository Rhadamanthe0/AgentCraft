'use strict'
// Modele par usage (bot/model-chain.js + planner.callWithProfile) : UN modele
// par usage, jamais de repli vers un autre. Reseau simule (llm.call moque).
//   NODE_PATH=bot/node_modules node --test tmp/model-chain.test.js
const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const chain = require('../bot/model-chain')
const llm = require('../bot/llm')

const PLANNER_PATH = require.resolve('../bot/planner')
const REPAIR_PATH = require.resolve('../bot/repair')
const KEYS = ['PLANNER_BASE_URL', 'PLANNER_MODEL', 'PLANNER_MODEL_PLAN', 'PLANNER_MODEL_CHAT', 'PLANNER_MODEL_BRIEF',
  'PLANNER_MODEL_REPAIR', 'PLANNER_API_KEY', 'PLANNER_THINKING', 'PLANNER_REASONING_EFFORT', 'PLANNER_REASONING_EFFORT_PLAN',
  'PLANNER_REASONING_EFFORT_BRIEF', 'PLANNER_REASONING_EFFORT_REPAIR', 'PLANNER_TIMEOUT_MS_BRIEF', 'OPENCODE_SECONDARY_API_KEY',
  'GROQ_API_KEY', 'BOT_USERNAME']
const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]))
const origCall = llm.call
afterEach(() => {
  llm.call = origCall
  delete require.cache[PLANNER_PATH]
  delete require.cache[REPAIR_PATH]
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

test('modele de l usage : PLANNER_MODEL_<USAGE> sinon PLANNER_MODEL ; une liste ne garde que la tete', () => {
  assert.deepEqual(chain.parse(' a , b@https://x/v1/ ').map(e => [e.model, e.baseUrl]), [['a', null], ['b', 'https://x/v1']])
  const env = { PLANNER_MODEL: 'a,b', PLANNER_MODEL_CHAT: 'c' }
  assert.equal(chain.modelFor('plan', env).model, 'a')
  assert.equal(chain.modelFor('interpretMessage', env).model, 'c')
  assert.equal(chain.modelFor('classify', env).model, 'c')
  assert.equal(chain.modelFor('repair', { PLANNER_MODEL: 'a', PLANNER_MODEL_REPAIR: 'r' }).model, 'r')
})

test('refus du fournisseur : l erreur remonte, AUCUN autre modele n est essaye', async () => {
  const seen = []
  llm.call = async (s, u, o) => { seen.push(o.model); throw httpErr(429, 'GoUsageLimitError') }
  const p = load({ PLANNER_MODEL: 'payant,gratuit' })
  await assert.rejects(p.plan({}, 'recolte', 'harvest'))
  assert.deepEqual([...new Set(seen)], ['payant'])
})

test('entree modele@url : autre base, et JAMAIS la cle du gateway principal', async () => {
  const seen = []
  llm.call = async (s, u, o) => { seen.push([o.model, o.baseUrl, o.apiKey]); return { content: plan, usage: null, ms: 1 } }
  const p = load({ PLANNER_MODEL: 'x@https://opencode.ai/zen/v1' })
  await p.plan({}, 'recolte', 'harvest')
  assert.deepEqual(seen.at(-1), ['x', 'https://opencode.ai/zen/v1', ''])
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

test('cle par fournisseur : liste fermee d hotes, jamais ailleurs', async () => {
  const env = { GROQ_API_KEY: 'gk', GEMINI_API_KEY: 'gm' }
  assert.equal(chain.keyFor('https://api.groq.com/openai/v1', env), 'gk')
  assert.equal(chain.keyFor('https://generativelanguage.googleapis.com/v1beta/openai', env), 'gm')
  assert.equal(chain.keyFor('https://api.groq.com.evil.example/v1', env), '')
  assert.equal(chain.keyFor('https://opencode.ai/zen/v1', env), '')
  assert.equal(chain.keyFor('https://openrouter.ai/api/v1', { OPENROUTER_API_KEY: 'or' }), 'or')
  assert.equal(chain.keyFor('pas une url', env), '')
  assert.equal(chain.modelFor('plan', { PLANNER_MODEL: 'g@https://api.groq.com/openai/v1' }), null, 'sans cle : aucun modele')
  const seen = []
  llm.call = async (s, u, o) => { seen.push([o.baseUrl, o.apiKey]); return { content: plan, usage: null, ms: 1 } }
  const p = load({ PLANNER_MODEL: 'm@https://api.groq.com/openai/v1', GROQ_API_KEY: 'gk' })
  await p.plan({}, 'recolte', 'harvest')
  assert.deepEqual(seen, [['https://api.groq.com/openai/v1', 'gk']])
})

test('alias go2 : gateway Go avec la cle secondaire, jamais la principale', async () => {
  const seen = []
  llm.call = async (s, u, o) => { seen.push([o.model, o.baseUrl, o.apiKey]); return { content: plan, usage: null, ms: 1 } }
  const p = load({ PLANNER_MODEL: 'd@go2', OPENCODE_SECONDARY_API_KEY: 'k2' })
  await p.plan({}, 'recolte', 'harvest')
  assert.deepEqual(seen, [['d', 'https://opencode.ai/zen/go/v1', 'k2']])
})

test('cle absente : erreur claire, jamais la liste brute envoyee comme nom de modele', async () => {
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

test('demander de l aide : modele PLANNER_MODEL_REPAIR avec son effort', async () => {
  const seen = []
  llm.call = async (s, u, o) => { seen.push([o.model, o.reasoning?.effort ?? o.reasoningEffort ?? null]); return { content: '{}', usage: null, ms: 1 } }
  load({ PLANNER_MODEL: 'a', PLANNER_MODEL_REPAIR: 'r1', PLANNER_REASONING_EFFORT_REPAIR: 'high' })
  delete require.cache[REPAIR_PATH]
  const repair = require('../bot/repair')
  assert.ok(repair.isEnabled())
  await repair.askForAction({ probleme: 'bloque', kind: 'recolte', supply: 'harvest', etat: {}, historique: [] })
  assert.deepEqual(seen[0], ['r1', 'high'])
})
