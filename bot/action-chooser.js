'use strict'

// Choix de l action suivante d une mission : planificateur JSON ou Jev.
//
// `ACTION_CHOOSER=jev` confie a « Jev » le SEUL role
// « quelle action maintenant ? » de la boucle de mission. Tout le reste ne
// bouge pas et reste sur le planificateur JSON distant (bot/planner.js) :
// routage du chat (`interpretMessage`/`classify`), lecture de l objectif
// (`readBrief`), reflexion (`reviser_actions`) et aide (`demander_aide`,
// bot/repair.js).
//
// Jev = des questions fermees, servies par `JEV_PROVIDER` : `zen` (defaut avec
// un gateway, bot/jev-zen.js : meme gateway, cle et en-tetes que le
// planificateur, une question par appel) ou `typesafe` (bot/jev.js, API
// TypeSafe d origine, inutilisee en CI).
//
// Jev repond a des questions fermees : une action par tour (premier appel,
// `planMission`), puis son ampleur sur une echelle 0-4 (second appel,
// `planParams`, seulement si l action declare un parametre type). La valeur
// dans l unite de l action vient ensuite du code (`mission.scaled()`) : le
// modele classe, il ne compte pas. Aucune action `plannerOnly` ne peut lui
// etre proposee (skills.actionCriteria les ecarte) : il ne sait produire ni
// angle, ni texte, ni pseudo.
//
// Une mission `geste` reste au planificateur : ses gestes (rejoindre_demandeur,
// tourner_vers_demandeur, regarder, dire...) sont tous `plannerOnly`, Jev n y
// aurait que avancer/sortir/attendre/terminer.
//
// Un echec de Jev (pas de cle, delai, erreur, action hors catalogue) ne bloque
// jamais une mission : l appelant repasse ce tour au planificateur JSON
// (`noteFallback`), journalise une fois par cause distincte. Apres plusieurs
// echecs d affilee, Jev est mis en pause (disjoncteur) pour ne pas payer son
// delai a chaque tour.

const skills = require('./skills')

const MODES = new Set(['planner', 'jev'])

function readMode (env = process.env) {
  const raw = String(env.ACTION_CHOOSER ?? '').trim().toLowerCase()
  return MODES.has(raw) ? raw : 'planner'
}

let mode = readMode()

// Qui repond aux questions fermees : `zen` (defaut des qu un gateway est
// configure : bot/jev-zen.js, meme gateway/cle/en-tetes que le planificateur)
// ou `typesafe` (bot/jev.js, l API TypeSafe d origine, gardee pour plus tard).
function readProvider (env = process.env) {
  const raw = String(env.JEV_PROVIDER ?? '').trim().toLowerCase()
  if (raw === 'zen' || raw === 'typesafe') return raw
  return env.PLANNER_BASE_URL ? 'zen' : 'typesafe'
}

let provider = readProvider()

function getProvider () {
  return provider
}

function setProvider (next) {
  provider = next === 'typesafe' ? 'typesafe' : 'zen'
  stats.jev_fournisseur = provider
  return provider
}

// Le module qui repond, selon le fournisseur (charge a la demande).
function jevModule () {
  return provider === 'zen' ? require('./jev-zen') : require('./jev')
}

const stats = {
  mode,
  jev_fournisseur: provider,
  // Decisions servies par Jev (une par action executee).
  decisions_jev: 0,
  // Appels reseau a Jev : 1 par decision, 2 quand l action a une ampleur.
  appels_jev: 0,
  echecs_jev: 0,
  // Tours rendus au planificateur JSON apres un echec de Jev.
  replis_planner: 0,
  // Missions `geste` laissees au planificateur (hors perimetre de Jev).
  geste_via_planner: 0,
  // Latence d une DECISION Jev (un ou deux appels), en ms.
  moyenne_ms_jev: null,
  dernier_ms_jev: null,
  derniere_erreur_jev: null
}

let lastLoggedReason = null

// Disjoncteur : une panne durable de Jev (delai de 8 s par tour) ralentirait
// chaque tour avant son repli. Apres PAUSE_AFTER echecs d affilee, les tours
// vont directement au planificateur pendant PAUSE_MS, puis Jev est retente.
const PAUSE_AFTER = Number(process.env.ACTION_CHOOSER_PAUSE_AFTER || 3)
const PAUSE_MS = Number(process.env.ACTION_CHOOSER_PAUSE_MS || 60000)
let consecutiveFailures = 0
let pausedUntil = 0

function setMode (next) {
  mode = MODES.has(next) ? next : 'planner'
  stats.mode = mode
  return mode
}

function getMode () {
  return mode
}

// Jev est-il le choix voulu pour ce type de mission ? (independamment de sa
// disponibilite : une cle absente est un repli, pas un changement de mode.)
function wantsJev (kind) {
  return mode === 'jev' && kind !== 'geste'
}

function noteGeste () {
  stats.geste_via_planner += 1
}

function noteFallback (reason, now = Date.now) {
  stats.replis_planner += 1
  stats.echecs_jev += 1
  consecutiveFailures += 1
  if (consecutiveFailures >= PAUSE_AFTER && pausedUntil <= now()) {
    pausedUntil = now() + PAUSE_MS
    consecutiveFailures = 0
  }
  stats.derniere_erreur_jev = String(reason ?? 'inconnu').slice(0, 200)
  // Une seule ligne par cause distincte : une panne durable de Jev ne doit pas
  // inonder le journal (ni le chat, que le logger alimente aussi).
  if (stats.derniere_erreur_jev !== lastLoggedReason) {
    lastLoggedReason = stats.derniere_erreur_jev
    console.log(`[choix] Jev indisponible, tour rendu au planificateur JSON : ${stats.derniere_erreur_jev}`)
  }
}

function recordTiming (ms) {
  stats.dernier_ms_jev = ms
  const n = stats.decisions_jev
  stats.moyenne_ms_jev = Math.round(((stats.moyenne_ms_jev ?? ms) * (n - 1) + ms) / n)
}

// Un tour de choix par Jev. Rend la decision au format consomme par la boucle
// de mission (celui de `decideFromPlan`), ou leve.
//
// `dynamicCriteria` : objet ou fonction (evaluee seulement si l action choisie
// a un parametre dynamique, ex. fabriquer.objet <- craft.targetCriteria).
async function chooseWithJev ({ jev, state, kind, supply, dynamicCriteria = {}, now = Date.now }) {
  if (!jev || !jev.isEnabled()) {
    throw new Error(`Jev inactif (${jev?.initError || 'TYPESAFE_API_KEY absente'})`)
  }

  if (pausedUntil > now()) {
    throw new Error(`Jev en pause ${Math.ceil((pausedUntil - now()) / 1000)} s apres ${PAUSE_AFTER} echecs d affilee`)
  }

  const startedAt = now()
  stats.appels_jev += 1
  const plan = await jev.planMission(state, kind, supply)
  if (!plan) throw new Error('Jev n a rien rendu')

  const allowed = skills.actionsFor(kind, supply, false)
  if (!plan.finished && !allowed.includes(plan.step)) {
    // Ne peut arriver que si Jev sort de ses options : jamais executer une
    // action qu on ne lui a pas proposee (en particulier une plannerOnly).
    throw new Error(`Jev a choisi une action hors catalogue : ${plan.step}`)
  }

  let params = { scale: 0.5, scaleLevel: null, choices: {}, asked: false }
  if (!plan.finished && skills.paramsFor(plan.step)) {
    try {
      const needsDynamic = Object.values(skills.paramsFor(plan.step)).some(d => d.dynamic)
      const criteria = needsDynamic && typeof dynamicCriteria === 'function'
        ? dynamicCriteria()
        : (typeof dynamicCriteria === 'function' ? {} : dynamicCriteria)
      const got = await jev.planParams(state, plan.step, criteria)
      if (got) params = got
      // TypeSafe pose toutes les questions en un appel ; Zen, une par question.
      stats.appels_jev += Number.isFinite(got?.calls) ? got.calls : 1
    } catch (err) {
      // Un second etage rate ne coute pas le tour : ampleur moyenne, traduite
      // par le code. Mieux vaut agir un peu que rien.
      console.error(`[choix] ampleur Jev indisponible pour ${plan.step} : ${err.message}`)
    }
  }

  stats.decisions_jev += 1
  consecutiveFailures = 0
  recordTiming(now() - startedAt)

  if (plan.finished) return { finished: true, done: plan.done, why: null }
  return adaptJevDecision(plan, params)
}

// Le resultat de Jev (action + ampleur 0..1 + choix fermes) au format d une
// etape de plan. Aucune valeur numerique inventee : seule l ampleur normalisee
// voyage, `mission.scaled()` la traduit dans l unite de l action. Les choix
// gardes sont ceux que Jev a reellement tranches (score, choice, noul).
function adaptJevDecision (plan, params = {}) {
  const typed = skills.paramsFor(plan.step) ?? {}
  const choices = {}
  if (params.asked) {
    for (const [name, value] of Object.entries(params.choices ?? {})) {
      if (typed[name] && value !== null && value !== undefined) choices[name] = value
    }
  }
  const scale = Number.isFinite(params.scale) ? Math.max(0, Math.min(1, params.scale)) : 0.5
  return {
    finished: false,
    done: Number.isFinite(plan.done) ? plan.done : 0,
    step: plan.step,
    scale,
    scaleLevel: Number.isFinite(params.scaleLevel) ? params.scaleLevel : null,
    choices,
    confidence: Number.isFinite(plan.confidence) ? plan.confidence : null,
    queued: 0,
    why: null,
    source: 'jev'
  }
}

function snapshot () {
  return { ...stats }
}

function _reset () {
  for (const key of ['decisions_jev', 'appels_jev', 'echecs_jev', 'replis_planner', 'geste_via_planner']) stats[key] = 0
  for (const key of ['moyenne_ms_jev', 'dernier_ms_jev', 'derniere_erreur_jev']) stats[key] = null
  lastLoggedReason = null
  consecutiveFailures = 0
  pausedUntil = 0
}

module.exports = {
  readMode,
  readProvider,
  getProvider,
  setProvider,
  jevModule,
  setMode,
  getMode,
  wantsJev,
  noteGeste,
  noteFallback,
  chooseWithJev,
  adaptJevDecision,
  snapshot,
  stats,
  _reset
}
