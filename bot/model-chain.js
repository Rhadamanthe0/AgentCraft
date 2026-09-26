'use strict'
// Chaine de modeles par usage, choisie dans le .env (demande du proprietaire,
// 2026-09-26 : quota hebdomadaire Go epuise, modeles gratuits a la place).
//
//   PLANNER_MODEL=space-bunny-free,longcat-2.5-preview-free
//   PLANNER_MODEL_PLAN=...      plans de mission        (tache plan)
//   PLANNER_MODEL_BRIEF=...     lecture de l objectif   (readBrief)
//   PLANNER_MODEL_CHAT=...      chat du joueur          (interpretMessage, classify)
//   PLANNER_MODEL_COMPACT=...   resume de la memoire    (compact)
//
// Chaque usage prend sa liste, sinon PLANNER_MODEL. Une entree `modele@url`
// passe par une autre base, SANS cle (ex : l offre gratuite anonyme de Zen,
// `space-bunny-free@https://opencode.ai/zen/v1`) : la cle du gateway principal
// n est jamais envoyee ailleurs. On essaie dans l ordre ; un refus HTTP du
// fournisseur (quota 429, modele inconnu ou indisponible, 401/403, 5xx) met le
// modele de cote `PLANNER_MODEL_COOLDOWN_MS` et passe au suivant dans le meme
// appel. Delai, annulation, JSON illisible : jamais de bascule (le modele a
// repondu, ou c est le code qui a coupe).

const TASK_VARS = {
  plan: 'PLANNER_MODEL_PLAN',
  readBrief: 'PLANNER_MODEL_BRIEF',
  interpretMessage: 'PLANNER_MODEL_CHAT',
  classify: 'PLANNER_MODEL_CHAT',
  compact: 'PLANNER_MODEL_COMPACT'
}

function parse (text) {
  return String(text ?? '').split(',').map(s => s.trim()).filter(Boolean).map(entry => {
    const at = entry.indexOf('@')
    if (at <= 0) return { model: entry, baseUrl: null, label: entry }
    const baseUrl = entry.slice(at + 1).trim().replace(/\/+$/, '')
    return { model: entry.slice(0, at).trim(), baseUrl: baseUrl || null, label: entry }
  })
}

function chainFor (task, env = process.env, fallback = '') {
  const own = TASK_VARS[task] ? env[TASK_VARS[task]] : ''
  return parse(String(own ?? '').trim() || env.PLANNER_MODEL || fallback)
}

// Refus du fournisseur qui justifie d essayer un autre modele. 400 seulement
// s il dit que le modele n est pas servi (un 400 de schema resterait un 400).
function isSwitchError (err) {
  if (err?.code !== 'LLM_HTTP') return false
  const s = Number(err.status)
  if ([401, 402, 403, 404, 429].includes(s) || s >= 500) return true
  return s === 400 && /model is unavailable|not supported|unknown model|model.*not found/i.test(String(err.message ?? ''))
}

function createState (cooldownMs = 600000) {
  const until = new Map()
  const reasons = new Map()
  return {
    cooldownMs,
    order (chain, now = Date.now()) {
      const ready = chain.filter(e => !(until.get(e.label) > now))
      const cooled = chain.filter(e => until.get(e.label) > now)
        .sort((a, b) => until.get(a.label) - until.get(b.label))
      return [...ready, ...cooled]
    },
    bench (entry, err, now = Date.now()) {
      until.set(entry.label, now + cooldownMs)
      reasons.set(entry.label, String(err?.message ?? err ?? '').slice(0, 160))
    },
    clear (entry) { until.delete(entry.label); reasons.delete(entry.label) },
    status (now = Date.now()) {
      return Object.fromEntries([...until].filter(([, t]) => t > now)
        .map(([label, t]) => [label, { jusqu_a: new Date(t).toISOString(), raison: reasons.get(label) }]))
    }
  }
}

// Effort de raisonnement par usage : PLANNER_REASONING_EFFORT_<USAGE> sinon
// PLANNER_REASONING_EFFORT (vide = rien envoye). Les actions (plan, chat)
// gagnent a raisonner peu ; la lecture de l objectif garde le defaut.
function effortFor (task, env = process.env) {
  const own = TASK_VARS[task] ? env[TASK_VARS[task].replace('PLANNER_MODEL_', 'PLANNER_REASONING_EFFORT_')] : ''
  const value = String(own ?? '').trim() || String(env.PLANNER_REASONING_EFFORT ?? '').trim()
  return value.toLowerCase() || null
}

module.exports = { parse, chainFor, effortFor, isSwitchError, createState, TASK_VARS }
