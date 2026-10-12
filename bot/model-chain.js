'use strict'
// Modeles par usage, choisis dans le .env :
//
//   PLANNER_MODEL=...           defaut (prechauffage, usage sans variable)
//   PLANNER_MODEL_PLAN=...      actions (plans de mission)
//   PLANNER_MODEL_CHAT=...      chat du joueur          (interpretMessage)
//   PLANNER_MODEL_BRIEF=...     reflexion : lecture de l objectif (readBrief)
//   PLANNER_MODEL_COMPACT=...   generation de la memoire (compact)
//
// Avec pour chacun PLANNER_REASONING_EFFORT_<USAGE> et PLANNER_TIMEOUT_MS_<USAGE>.
// Une variable peut lister plusieurs modeles (`a,b,c`, proprietaire,
// 2026-10-12 : modeles gratuits d abord) : le premier sert ; une LIMITE DE
// DEBIT (429) qui demande plus de 10 s d attente, ou ne dit pas combien, fait
// passer au suivant tout de suite et met le modele limite de cote le temps
// demande (`createModelState`). C est le seul repli de modele : un silence,
// une 5xx ou un refus de cle remontent tels quels.
// Tous les modeles passent par PLANNER_BASE_URL. Deux cles possibles pour ce
// gateway : `primary` (PLANNER_API_KEY) et `secondary` (OPENCODE_SECONDARY_API_KEY,
// second espace OpenCode). PLANNER_KEY_FIRST dit laquelle essayer d abord ; un
// refus de cle (quota 429, 401/402/403) rejoue le MEME modele avec l autre cle
// et met la cle refusee de cote PLANNER_KEY_COOLDOWN_MS. Tout `modele@...` est
// refuse (erreur claire).

const TASK_VARS = {
  plan: 'PLANNER_MODEL_PLAN',
  readBrief: 'PLANNER_MODEL_BRIEF',
  interpretMessage: 'PLANNER_MODEL_CHAT',
  compact: 'PLANNER_MODEL_COMPACT'
}

function parse (text) {
  return String(text ?? '').split(',').map(s => s.trim()).filter(Boolean).map(entry => {
    const at = entry.indexOf('@')
    if (at <= 0) return { model: entry, baseUrl: null, label: entry }
    // Plus aucune base tierce (fournisseurs gratuits retires du code) ni alias :
    // la cle se choisit par PLANNER_KEY_FIRST, pas par le nom du modele.
    return { model: entry.slice(0, at).trim(), invalid: true, label: entry }
  })
}

// A/B de modele au banc (POST /api/models, variante `modele(...)` de
// ci/trees.py) : un modele par usage, a la place de la variable, jusqu au
// prochain reset. Toujours UN modele par usage, jamais de repli.
const overrides = {}
const OVERRIDE_TASKS = { plan: 'plan', brief: 'readBrief', chat: 'interpretMessage', compact: 'compact' }

// Effort aussi (`effort_plan`, `effort_chat`, `effort_brief`) : `none` coupe
// le raisonnement (thinking disabled), comme PLANNER_REASONING_EFFORT_*=none.
const effortOverrides = {}
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high'])

function setOverrides (changes = {}) {
  if (changes?.reset === true) {
    for (const k of Object.keys(overrides)) delete overrides[k]
    for (const k of Object.keys(effortOverrides)) delete effortOverrides[k]
  }
  for (const [key, value] of Object.entries(changes ?? {})) {
    const task = OVERRIDE_TASKS[key]
    if (task && typeof value === 'string' && /^(openai\/)?[a-z0-9][a-z0-9.-]{0,63}$/i.test(value)) overrides[task] = value
    const effortTask = key.startsWith('effort_') ? OVERRIDE_TASKS[key.slice(7)] : null
    if (effortTask && EFFORTS.has(value)) effortOverrides[effortTask] = value
  }
  const out = Object.fromEntries(Object.entries(OVERRIDE_TASKS).filter(([, t]) => overrides[t]).map(([k, t]) => [k, overrides[t]]))
  for (const [k, t] of Object.entries(OVERRIDE_TASKS)) if (effortOverrides[t]) out[`effort_${k}`] = effortOverrides[t]
  return out
}

// Les modeles de l usage, dans l ordre : PLANNER_MODEL_<USAGE>, sinon
// PLANNER_MODEL. Une entree invalide est ecartee ; [] si aucune. Une variante
// A/B (overrides) est UN modele, sans suite.
function modelsFor (task, env = process.env, fallback = '') {
  if (overrides[task] && env === process.env) return [{ model: overrides[task], baseUrl: null, label: overrides[task] }]
  const own = TASK_VARS[task] ? env[TASK_VARS[task]] : ''
  return parse(String(own ?? '').trim() || env.PLANNER_MODEL || fallback).filter(e => !e.invalid)
}

// Le premier modele de l usage (null si aucun).
function modelFor (task, env = process.env, fallback = '') {
  return modelsFor(task, env, fallback)[0] ?? null
}

// Effort de raisonnement par usage : PLANNER_REASONING_EFFORT_<USAGE> sinon
// PLANNER_REASONING_EFFORT (vide = rien envoye). Les actions (plan, chat)
// gagnent a raisonner peu ; la lecture de l objectif garde le defaut.
function effortFor (task, env = process.env) {
  if (effortOverrides[task] && env === process.env) return effortOverrides[task]
  const own = TASK_VARS[task] ? env[TASK_VARS[task].replace('PLANNER_MODEL_', 'PLANNER_REASONING_EFFORT_')] : ''
  const value = String(own ?? '').trim() || String(env.PLANNER_REASONING_EFFORT ?? '').trim()
  return value.toLowerCase() || null
}

// Delai d un appel par usage : PLANNER_TIMEOUT_MS_<USAGE> (vide = delai commun).
function timeoutFor (task, env = process.env) {
  const name = TASK_VARS[task]?.replace('PLANNER_MODEL_', 'PLANNER_TIMEOUT_MS_')
  const value = Number(name ? env[name] : NaN)
  return Number.isFinite(value) && value > 0 ? value : null
}

const KEY_VARS = { primary: 'PLANNER_API_KEY', secondary: 'OPENCODE_SECONDARY_API_KEY' }

// Cles dans l ordre d essai (PLANNER_KEY_FIRST=primary|secondary, defaut
// primary), sans les cles vides.
function keyOrder (env = process.env) {
  const first = String(env.PLANNER_KEY_FIRST ?? '').trim().toLowerCase() === 'secondary' ? 'secondary' : 'primary'
  return [first, first === 'primary' ? 'secondary' : 'primary']
    .map(name => ({ name, key: String(env[KEY_VARS[name]] ?? '').trim() }))
    .filter(k => k.key)
}

// Refus qui tient a la CLE (quota, droits) : l autre cle peut passer. Un delai,
// une 5xx ou un 400 de schema ne changent rien d une cle a l autre.
function isKeySwitchError (err) {
  return err?.code === 'LLM_HTTP' && [401, 402, 403, 429].includes(Number(err.status))
}

// Limite de debit qui fait changer de modele : 429 dont l attente depasse
// LIMITE_ATTENTE_S ou n est pas dite (`attenteS`, bot/llm.js).
function isRateLimitSwitch (err, limiteS = 10) {
  return err?.code === 'LLM_HTTP' && Number(err.status) === 429 && !(Number.isFinite(err.attenteS) && err.attenteS <= limiteS)
}

// Modeles mis de cote apres une limite de debit, le temps qu elle demande
// (60 s si elle ne le dit pas, une heure au plus) : les appels suivants vont
// droit au modele d apres, puis reviennent au premier.
function createModelState ({ defautS = 60, maxS = 3600 } = {}) {
  const until = new Map()
  return {
    order (entries, now = Date.now()) {
      const ready = entries.filter(e => !(until.get(e.model) > now))
      return ready.length ? ready : entries.slice(-1)
    },
    bench (entry, attenteS, now = Date.now()) {
      const s = Math.min(maxS, Math.max(1, Number.isFinite(attenteS) ? attenteS : defautS))
      until.set(entry.model, now + s * 1000)
    },
    status (now = Date.now()) {
      return Object.fromEntries([...until].filter(([, t]) => t > now).map(([n, t]) => [n, new Date(t).toISOString()]))
    }
  }
}

function createKeyState (cooldownMs = 600000) {
  const until = new Map()
  return {
    order (keys, now = Date.now()) {
      const ready = keys.filter(k => !(until.get(k.name) > now))
      return [...ready, ...keys.filter(k => until.get(k.name) > now)]
    },
    bench (k, now = Date.now()) { until.set(k.name, now + cooldownMs) },
    clear (k) { until.delete(k.name) },
    status (now = Date.now()) {
      return Object.fromEntries([...until].filter(([, t]) => t > now).map(([n, t]) => [n, new Date(t).toISOString()]))
    }
  }
}

module.exports = { parse, modelFor, modelsFor, isRateLimitSwitch, createModelState, setOverrides, effortFor, timeoutFor, keyOrder, isKeySwitchError, createKeyState, KEY_VARS, TASK_VARS }
