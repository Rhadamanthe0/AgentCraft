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
// Une entree `modele@url` passe par une autre base, avec la seule cle propre a
// cet hote (PROVIDER_KEYS) ; `modele@go2` = gateway Go avec la cle secondaire.
// La cle du gateway principal n est jamais envoyee ailleurs.

// Alias de base a cle PROPRE (liste fermee) : `modele@go2` = gateway Go avec
// la cle d un second espace OpenCode (secret OPENCODE_SECONDARY_API_KEY), mis
// de cote independamment de la cle principale (quota Go distinct).
const KEY_ALIASES = {
  go2: { baseUrl: 'https://opencode.ai/zen/go/v1', keyVar: 'OPENCODE_SECONDARY_API_KEY' }
}

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
    const alias = KEY_ALIASES[entry.slice(at + 1).trim().toLowerCase()]
    if (alias) return { model: entry.slice(0, at).trim(), baseUrl: alias.baseUrl, keyVar: alias.keyVar, label: entry }
    const baseUrl = entry.slice(at + 1).trim().replace(/\/+$/, '')
    return { model: entry.slice(0, at).trim(), baseUrl: baseUrl || null, label: entry }
  })
}

// Le modele de l usage : PLANNER_MODEL_<USAGE>, sinon PLANNER_MODEL. Une liste
// (ancien format) ne garde que sa premiere entree. null si sa cle manque.
function modelFor (task, env = process.env, fallback = '') {
  const own = TASK_VARS[task] ? env[TASK_VARS[task]] : ''
  const entry = parse(String(own ?? '').trim() || env.PLANNER_MODEL || fallback)[0]
  if (!entry) return null
  const keyed = entry.keyVar ? String(env[entry.keyVar] ?? '').trim()
    : !entry.baseUrl || !needsKey(entry.baseUrl) || keyFor(entry.baseUrl, env)
  return keyed ? entry : null
}

function needsKey (baseUrl) {
  try { return Boolean(PROVIDER_KEYS[new URL(baseUrl).hostname.toLowerCase()]) } catch { return false }
}

// Effort de raisonnement par usage : PLANNER_REASONING_EFFORT_<USAGE> sinon
// PLANNER_REASONING_EFFORT (vide = rien envoye). Les actions (plan, chat)
// gagnent a raisonner peu ; la lecture de l objectif garde le defaut.
function effortFor (task, env = process.env) {
  const own = TASK_VARS[task] ? env[TASK_VARS[task].replace('PLANNER_MODEL_', 'PLANNER_REASONING_EFFORT_')] : ''
  const value = String(own ?? '').trim() || String(env.PLANNER_REASONING_EFFORT ?? '').trim()
  return value.toLowerCase() || null
}

// Cle d un fournisseur tiers (`modele@url`) : liste FERMEE hote -> variable.
// Une cle ne part jamais que vers l hote exact auquel elle appartient ; toute
// autre base est appelee sans cle (acces anonyme, ex : Zen gratuit).
const PROVIDER_KEYS = {
  'api.groq.com': 'GROQ_API_KEY',
  'generativelanguage.googleapis.com': 'GEMINI_API_KEY',
  'openrouter.ai': 'OPENROUTER_API_KEY'
}

function keyFor (baseUrl, env = process.env) {
  let host
  try { host = new URL(baseUrl).hostname.toLowerCase() } catch { return '' }
  const name = PROVIDER_KEYS[host]
  return name ? String(env[name] ?? '').trim() : ''
}

// Delai d un appel par usage : PLANNER_TIMEOUT_MS_<USAGE> (vide = delai commun).
function timeoutFor (task, env = process.env) {
  const name = TASK_VARS[task]?.replace('PLANNER_MODEL_', 'PLANNER_TIMEOUT_MS_')
  const value = Number(name ? env[name] : NaN)
  return Number.isFinite(value) && value > 0 ? value : null
}

module.exports = { KEY_ALIASES, parse, modelFor, effortFor, timeoutFor, keyFor, PROVIDER_KEYS, TASK_VARS }
