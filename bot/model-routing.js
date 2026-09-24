'use strict'

const llm = require('./llm')
const FAST = 'mimo-v2.6-flash'
const STRATEGY = 'muse-spark-1.3-contributor'
const active = new Map()
const byModel = {}
let sequence = 0
let lastCompleted = null

function isDual (env = process.env) { return env.PLANNER_ROUTING_MODE === 'dual' }

function selectRoute (task, state = {}, env = process.env) {
  if (!isDual(env)) return null
  let reason = 'tache_courante'
  let role = 'fast'
  if (['readBrief', 'repair.askForAction', 'repair.reflect'].includes(task)) {
    role = 'strategy'; reason = task
  } else if (task === 'interpretMessage') {
    const history = state.mission?.historique ?? state.precedent?.historique
    const last = Array.isArray(history) ? history.at(-1) : null
    if (last?.echec === true || ['no_path', 'stuck'].includes(state.etat?.navigation?.code)) {
      role = 'strategy'; reason = 'chat_blocage_mesure'
    }
  } else if (task === 'plan') {
    const last = Array.isArray(state.dernieres_etapes) ? state.dernieres_etapes.at(-1) : null
    reason = state.blocage?.detecte ? 'blocage_detecte' : state.avancer_bloque ? 'avancer_bloque'
      : state.arret_refuse ? 'arret_refuse' : last?.echec === true ? 'derniere_etape_echouee' : 'plan_nominal'
    if (reason !== 'plan_nominal') role = 'strategy'
  }
  const strategic = role === 'strategy'
  const prefix = strategic ? 'PLANNER_STRATEGY' : 'PLANNER_FAST'
  const model = env[`${prefix}_MODEL`] || (strategic ? STRATEGY : FAST)
  if (model !== (strategic ? STRATEGY : FAST)) throw new Error(`mode dual : modele ${role} invalide`)
  const positive = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback
  return { task, role, reason, model, protocol: strategic ? 'responses' : 'chat',
    timeoutMs: positive(env[`${prefix}_TIMEOUT_MS`], strategic ? 120000 : 45000),
    maxTokens: positive(env[`${prefix}_MAX_TOKENS`], strategic ? 16384 : 4096),
    ...(strategic ? { reasoning: { effort: 'xhigh' } } : { thinking: { type: 'disabled' } }) }
}

function planObservation (state) {
  const pick = (obj, keys) => obj == null ? null : Object.fromEntries(keys.filter(key => obj[key] !== undefined)
    .map(key => [key, typeof obj[key] === 'string' ? obj[key].slice(0, 100) : obj[key]]))
  return JSON.parse(JSON.stringify({
    position: pick(state.bot?.position, ['x', 'y', 'z']),
    environnement: {
      bloc_cible_a_portee: state.environnement?.bloc_cible_a_portee ?? null,
      navigation: pick(state.environnement?.navigation, ['cible', 'distance', 'angle', 'a_portee']),
      cible_haute: pick(state.environnement?.cible_haute, ['cible', 'distance', 'denivele']),
      acces_par_montee: state.environnement?.acces_par_montee ? {
        ...pick(state.environnement.acces_par_montee, ['hauteur_min', 'stock', 'manque']),
        cible: { ...pick(state.environnement.acces_par_montee.cible, ['nom']),
          position: pick(state.environnement.acces_par_montee.cible?.position, ['x', 'y', 'z']) }
      } : null
    },
    echafaudage: state.inventaire?.echafaudage ? { total: state.inventaire.echafaudage.total,
      materiaux: (state.inventaire.echafaudage.materiaux ?? []).slice(0, 8).map(item => pick(item, ['nom', 'quantite'])) } : null,
    blocage: pick(state.blocage, ['detecte', 'reparations_restantes', 'reparateur_disponible']),
    avancer_bloque: Boolean(state.avancer_bloque), arret_refuse: Boolean(state.arret_refuse),
    dernieres_etapes: (state.dernieres_etapes ?? []).slice(-4).map(step => pick(step, ['action', 'code', 'echec']))
  }))
}

// Request-local metadata prevents chat completion from overwriting an active plan.
async function call (task, state, system, user, { image = null, signal = null, temperature = 0, route = selectRoute(task, state) } = {}) {
  if (!route) throw new Error('routage dual inactif')
  const baseUrl = (process.env.PLANNER_BASE_URL || '').replace(/\/+$/, '')
  if (!baseUrl) throw new Error('mode dual : PLANNER_BASE_URL absent, aucun repli')
  const request = { requestId: ++sequence, ...route, startedAt: Date.now(),
    result: 'pending', latencyMs: null, usage: null, responseModel: null,
    ...(task === 'plan' ? { observation: planObservation(state) } : {}) }
  active.set(request.requestId, request)
  try {
    const response = await llm.call(system, user, {
      baseUrl, apiKey: process.env.PLANNER_API_KEY || '', model: route.model,
      protocol: route.protocol, maxTokens: route.maxTokens, timeoutMs: route.timeoutMs,
      ...(route.thinking ? { thinking: route.thinking } : { reasoning: route.reasoning }),
      temperature, image, signal,
      headers: /opencode\.ai\/zen/i.test(baseUrl) ? {
        'user-agent': process.env.PLANNER_USER_AGENT || 'minecraft-bot/1.0',
        'x-opencode-session': process.env.PLANNER_SESSION_ID || `minecraft-bot-${process.env.BOT_USERNAME || 'bot'}`
      } : null
    })
    request.result = 'response'
    request.responseModel = response.responseModel ?? null
    request.usage = response.usage ? JSON.parse(JSON.stringify(response.usage)) : null
    return { ...response, model: route.model, routing: { ...route, requestId: request.requestId } }
  } catch (err) {
    request.result = signal?.aborted || err.code === 'LLM_ABORTED' ? 'cancelled' : 'error'
    request.errorCode = err.code || 'LLM_ERROR'
    throw err
  } finally {
    request.latencyMs = Date.now() - request.startedAt
    request.completedAt = Date.now()
    const totals = byModel[route.model] ??= { calls: 0, responses: 0, errors: 0, cancelled: 0, latencyMs: 0,
      usage: { input: 0, output: 0, reasoning: 0, cached: 0 } }
    totals.calls++
    totals[request.result === 'response' ? 'responses' : request.result === 'cancelled' ? 'cancelled' : 'errors']++
    totals.latencyMs += request.latencyMs
    const usage = request.usage ?? {}
    const number = value => Number.isFinite(value) && value >= 0 ? value : 0
    totals.usage.input += number(usage.input_tokens ?? usage.prompt_tokens)
    totals.usage.output += number(usage.output_tokens ?? usage.completion_tokens)
    totals.usage.reasoning += number(usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens)
    totals.usage.cached += number(usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens)
    active.delete(request.requestId)
    lastCompleted = request
  }
}

function status () {
  return JSON.parse(JSON.stringify({ mode: isDual() ? 'dual' : 'legacy', active: [...active.values()], lastCompleted, byModel }))
}

module.exports = { isDual, selectRoute, call, status, FAST, STRATEGY }
