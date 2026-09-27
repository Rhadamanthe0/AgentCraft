'use strict'
// Modele par usage, choisi dans le .env (demande du proprietaire, 2026-09-26) :
// UN seul modele par usage, AUCUN repli vers un autre modele.
//
//   PLANNER_MODEL=...           defaut (prechauffage, usage sans variable)
//   PLANNER_MODEL_PLAN=...      actions (plans de mission)
//   PLANNER_MODEL_CHAT=...      chat du joueur          (interpretMessage, classify)
//   PLANNER_MODEL_BRIEF=...     reflexion : lecture de l objectif (readBrief)
//   PLANNER_MODEL_COMPACT=...   generation de la memoire (compact)
//   PLANNER_MODEL_REPAIR=...    demander de l aide, reviser les actions (repair.js)
//
// Avec pour chacun PLANNER_REASONING_EFFORT_<USAGE> et PLANNER_TIMEOUT_MS_<USAGE>.
// Tous les modeles passent par PLANNER_BASE_URL. Deux cles possibles pour ce
// gateway : `primary` (PLANNER_API_KEY) et `secondary` (OPENCODE_SECONDARY_API_KEY,
// second espace OpenCode). PLANNER_KEY_FIRST dit laquelle essayer d abord ; un
// refus de cle (quota 429, 401/402/403) rejoue le MEME modele avec l autre cle
// et met la cle refusee de cote PLANNER_KEY_COOLDOWN_MS. C est le seul repli :
// jamais un autre modele. Tout `modele@...` est refuse (erreur claire).

const TASK_VARS = {
  plan: 'PLANNER_MODEL_PLAN',
  readBrief: 'PLANNER_MODEL_BRIEF',
  interpretMessage: 'PLANNER_MODEL_CHAT',
  classify: 'PLANNER_MODEL_CHAT',
  compact: 'PLANNER_MODEL_COMPACT',
  // demander_aide et reviser_actions (bot/repair.js)
  repair: 'PLANNER_MODEL_REPAIR'
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

// Le modele de l usage : PLANNER_MODEL_<USAGE>, sinon PLANNER_MODEL. Une liste
// (ancien format) ne garde que sa premiere entree. null si sa cle manque.
function modelFor (task, env = process.env, fallback = '') {
  const own = TASK_VARS[task] ? env[TASK_VARS[task]] : ''
  const entry = parse(String(own ?? '').trim() || env.PLANNER_MODEL || fallback)[0]
  if (!entry || entry.invalid) return null
  return entry
}

// Effort de raisonnement par usage : PLANNER_REASONING_EFFORT_<USAGE> sinon
// PLANNER_REASONING_EFFORT (vide = rien envoye). Les actions (plan, chat)
// gagnent a raisonner peu ; la lecture de l objectif garde le defaut.
function effortFor (task, env = process.env) {
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

module.exports = { parse, modelFor, effortFor, timeoutFor, keyOrder, isKeySwitchError, createKeyState, KEY_VARS, TASK_VARS }
