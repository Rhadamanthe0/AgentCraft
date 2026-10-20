'use strict'
// Modele par usage, choisi dans le .env (demande du proprietaire, 2026-09-26) :
// UN seul modele par usage, AUCUN repli vers un autre modele.
//
//   PLANNER_MODEL=...           defaut (prechauffage, usage sans variable)
//   PLANNER_MODEL_PLAN=...      actions (plans de mission)
//   PLANNER_MODEL_CHAT=...      chat du joueur          (interpretMessage)
//   PLANNER_MODEL_BRIEF=...     reflexion : lecture de l objectif (readBrief)
//   PLANNER_MODEL_COMPACT=...   generation de la memoire (compact)
//
// Avec pour chacun PLANNER_REASONING_EFFORT_<USAGE> et PLANNER_TIMEOUT_MS_<USAGE>.
// Tous les modeles passent par PLANNER_BASE_URL avec une seule cle,
// PLANNER_API_KEY (un seul abonnement OpenCode Go, 2026-10-20) : aucun repli,
// ni de modele ni de cle. Tout `modele@...` est refuse (erreur claire).

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
    // Plus aucune base tierce (fournisseurs gratuits retires du code) ni alias.
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

// Le modele de l usage : PLANNER_MODEL_<USAGE>, sinon PLANNER_MODEL. Une liste
// (ancien format) ne garde que sa premiere entree. null si sa cle manque.
function modelFor (task, env = process.env, fallback = '') {
  if (overrides[task] && env === process.env) return { model: overrides[task], baseUrl: null, label: overrides[task] }
  const own = TASK_VARS[task] ? env[TASK_VARS[task]] : ''
  const entry = parse(String(own ?? '').trim() || env.PLANNER_MODEL || fallback)[0]
  if (!entry || entry.invalid) return null
  return entry
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

module.exports = { parse, modelFor, setOverrides, effortFor, timeoutFor, TASK_VARS }
