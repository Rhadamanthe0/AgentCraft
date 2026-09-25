'use strict'

// Questions fermees « facon Jev », servies par le gateway OpenCode Zen.
//
// Meme contrat que bot/jev.js (isEnabled, planMission, planParams) pour que
// action-chooser.js les traite pareil, mais sans l API TypeSafe : chaque
// question fermee part sur le meme gateway, la meme cle et les memes en-tetes
// que le planificateur (PLANNER_BASE_URL, PLANNER_API_KEY, user-agent,
// x-opencode-session), via le transport partage llm.js, /chat/completions.
//
// Une question = un appel = une reponse JSON stricte :
//   { "choix": "<une des options>", "confiance": 0..1 }
// Tout choix hors des options proposees est rejete (l appelant rend alors le
// tour au planificateur JSON). Le modele classe, il ne compte pas : l ampleur
// est une option parmi "0".."4", traduite ensuite par mission.scaled(), et
// l objet a fabriquer est une option parmi les recettes calculees par le code.
//
// Le prompt systeme est court et FIXE (aucun horodatage, aucune position) :
// le gateway le sert depuis son cache. Options, question et etat vont dans le
// message utilisateur.

const llm = require('./llm')
const skills = require('./skills')

const BASE_URL = (process.env.PLANNER_BASE_URL || '').replace(/\/+$/, '')
const API_KEY = process.env.PLANNER_API_KEY || ''
const IS_ZEN = /opencode\.ai\/zen/i.test(BASE_URL)
const USER_AGENT = process.env.PLANNER_USER_AGENT || 'minecraft-bot/1.0'
const PLANNER_SESSION = process.env.PLANNER_SESSION_ID || `minecraft-bot-${process.env.BOT_USERNAME || 'bot'}`
// Session propre (comme le reparateur) : ce prompt n est pas celui du
// planificateur, les melanger nuirait au cache des deux cotes.
const SESSION_ID = process.env.JEV_ZEN_SESSION_ID || `${PLANNER_SESSION}-jev`
const DEFAULT_MODEL = 'deepseek-v4.1-flash'
const EXPLICIT_MODEL = (process.env.JEV_ZEN_MODEL || '').trim()
const TIMEOUT_MS = Number(process.env.JEV_ZEN_TIMEOUT_MS || 8000)
const MAX_TOKENS = Number(process.env.JEV_ZEN_MAX_TOKENS || 300)
const DETECT_TIMEOUT_MS = Number(process.env.JEV_ZEN_DETECT_TIMEOUT_MS || 8000)

let model = EXPLICIT_MODEL || DEFAULT_MODEL
let modelSource = EXPLICIT_MODEL ? 'JEV_ZEN_MODEL' : 'defaut'
let detection = null
let announced = false

const SYSTEM = [
  'Tu es un classificateur pour un bot Minecraft. On te pose UNE question fermee,',
  'avec un etat de jeu mesure par le code et une liste d options nommees.',
  'Choisis exactement UNE option, en recopiant son nom tel quel.',
  'Tu ne comptes rien et tu n inventes ni nombre, ni coordonnee, ni option.',
  'Reponds uniquement par ce JSON, sans texte autour :',
  '{"choix": "<nom exact d une option>", "confiance": <nombre entre 0 et 1>}'
].join('\n')

function headers () {
  return IS_ZEN ? { 'user-agent': USER_AGENT, 'x-opencode-session': SESSION_ID } : null
}

// deepseek-v4.1-flash raisonne par defaut et ses jetons de raisonnement
// comptent dans max_tokens : pour une question fermee on le coupe.
function thinkingFor (name) {
  return /deepseek/i.test(name) ? { type: 'disabled' } : null
}

function isEnabled () {
  return Boolean(BASE_URL && API_KEY)
}

function init () {
  return isEnabled()
}

function initError () {
  if (!BASE_URL) return 'PLANNER_BASE_URL absent'
  if (!API_KEY) return 'PLANNER_API_KEY absente'
  return null
}

// Une question fermee -> { choice, confidence }. Leve si la reponse est
// illisible ou hors des options.
async function ask (question, options, state, opts = {}) {
  const names = Object.keys(options)
  if (names.length === 0) throw new Error(`aucune option pour « ${question} »`)
  const user = JSON.stringify({ question, options, etat: state })
  const response = await llm.call(SYSTEM, user, {
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    model,
    temperature: 0,
    maxTokens: MAX_TOKENS,
    timeoutMs: TIMEOUT_MS,
    headers: headers(),
    thinking: thinkingFor(model),
    protocol: 'chat',
    signal: opts.signal ?? null
  })
  let parsed
  try {
    parsed = llm.parseJson(response.content)
  } catch (err) {
    throw new Error(`Jev Zen illisible : ${err.message}`)
  }
  let raw = typeof parsed?.choix === 'string' || typeof parsed?.choix === 'number' ? String(parsed.choix).trim() : ''
  // Vu en CI : le modele recopie parfois le TEXTE de l option (« Peu : cinq
  // blocs ») au lieu de son nom (« 1 »). Un texte identique a une seule option
  // designe cette option sans ambiguite ; tout le reste reste refuse.
  if (!names.includes(raw)) {
    const byText = names.filter(n => String(options[n]).trim() === raw)
    if (byText.length === 1) raw = byText[0]
  }
  if (!names.includes(raw)) {
    throw new Error(`Jev Zen hors options : ${JSON.stringify(raw).slice(0, 60)}`)
  }
  const confidence = Number(parsed.confiance)
  return {
    choice: raw,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    ms: response.ms
  }
}

// Premier etage : quelle action maintenant ? La fin passe par l action
// `terminer`, jugee ensuite par finishAllowed() : pas de question « fini ? ».
async function planMission (state, kind, supply) {
  if (!isEnabled()) return null
  const answer = await ask(
    'Quelle action le bot doit-il effectuer MAINTENANT pour avancer vers l objectif ?',
    skills.actionCriteria(kind, supply),
    state
  )
  return {
    done: 0,
    finished: false,
    step: answer.choice,
    confidence: answer.confidence,
    probabilities: null,
    usage: null
  }
}

// Second etage : une question fermee par parametre type de l action.
async function planParams (state, action, dynamicCriteria = {}) {
  const empty = { scale: 0.5, scaleLevel: null, choices: {}, asked: false, calls: 0 }
  if (!isEnabled()) return empty
  const params = skills.paramsFor(action)
  if (!params) return empty

  const result = { scale: 0.5, scaleLevel: null, choices: {}, confidences: {}, asked: false, calls: 0 }
  const withAction = { ...state, action_choisie: action }

  for (const [name, descriptor] of Object.entries(params)) {
    let options = null
    if (descriptor.type === 'score') {
      const rubric = descriptor.rubric ?? skills.SCALE_RUBRIC
      options = Object.fromEntries(rubric.map((text, i) => [String(i), text]))
    } else if (descriptor.type === 'choice') {
      options = descriptor.dynamic ? dynamicCriteria[descriptor.dynamic] : descriptor.criteria
    } else if (descriptor.type === 'noul') {
      options = { true: descriptor.options?.true ?? 'oui', false: descriptor.options?.false ?? 'non' }
    }
    if (!options || Object.keys(options).length === 0) continue

    result.calls += 1
    const answer = await ask(descriptor.question, options, withAction)
    result.asked = true
    result.confidences[name] = answer.confidence

    if (descriptor.type === 'score') {
      const level = Number(answer.choice)
      const levels = Math.max(1, Object.keys(options).length - 1)
      result.choices[name] = level
      if (name === 'ampleur') {
        result.scale = Math.max(0, Math.min(1, level / levels))
        result.scaleLevel = level
      }
    } else if (descriptor.type === 'noul') {
      result.choices[name] = answer.choice === 'true' ? 1 : 0
    } else {
      result.choices[name] = answer.choice
    }
  }
  return result
}

// Detection du modele : GET /models avec les en-tetes Zen. Un modele dont l id
// contient « jev » est prefere s il repond sur /chat/completions ; sinon
// deepseek-v4.1-flash sans raisonnement. JEV_ZEN_MODEL, s il est pose, prime
// toujours. Ne leve jamais : le resultat est journalise et expose.
async function detectModel ({ fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const found = { jev_trouves: [], sonde: null, erreur: null, choisi: model, source: modelSource }
  if (!isEnabled()) {
    found.erreur = initError()
    detection = found
    return found
  }
  try {
    const hdrs = { authorization: `Bearer ${API_KEY}`, ...(headers() ?? {}) }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DETECT_TIMEOUT_MS)
    let body
    try {
      const response = await fetchImpl(`${BASE_URL}/models`, { headers: hdrs, signal: controller.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      body = await response.json()
    } finally {
      clearTimeout(timer)
    }
    const ids = (Array.isArray(body?.data) ? body.data : [])
      .map(m => (typeof m === 'string' ? m : m?.id))
      .filter(id => typeof id === 'string')
    found.jev_trouves = ids.filter(id => /jev/i.test(id))

    if (!EXPLICIT_MODEL && found.jev_trouves.length > 0) {
      const candidate = found.jev_trouves[0]
      try {
        const previous = model
        model = candidate
        try {
          await ask('Test de disponibilite : choisis ok.', { ok: 'le modele repond' }, {})
        } catch (err) {
          model = previous
          throw err
        }
        found.sonde = 'ok'
        modelSource = 'detecte (/models)'
      } catch (err) {
        found.sonde = `echec : ${err.message}`.slice(0, 160)
      }
    }
  } catch (err) {
    found.erreur = String(err.message || err).slice(0, 160)
  }
  found.choisi = model
  found.source = modelSource
  detection = found
  log(
    `[jev] modeles Zen contenant « jev » : ${found.jev_trouves.length ? found.jev_trouves.join(', ') : 'aucun'}` +
    (found.sonde ? ` (sonde ${found.sonde})` : '') +
    (found.erreur ? ` (detection impossible : ${found.erreur})` : '')
  )
  announceModel(log)
  return found
}

function announceModel (log = console.log) {
  if (announced) return
  announced = true
  log(`[jev] fournisseur zen, modele ${model} (${modelSource})${thinkingFor(model) ? ', raisonnement coupe' : ''}, max_tokens ${MAX_TOKENS}`)
}

function _reset () {
  model = EXPLICIT_MODEL || DEFAULT_MODEL
  modelSource = EXPLICIT_MODEL ? 'JEV_ZEN_MODEL' : 'defaut'
  detection = null
  announced = false
}

module.exports = {
  PROVIDER: 'zen',
  init,
  isEnabled,
  planMission,
  planParams,
  detectModel,
  announceModel,
  SYSTEM,
  DEFAULT_MODEL,
  get MODEL () { return model },
  get initError () { return initError() },
  get detection () { return detection },
  _reset
}

// Chemin CI/debug : `node bot/jev-zen.js` affiche la detection et sort.
if (require.main === module) {
  detectModel().then(result => {
    console.log(JSON.stringify(result, null, 1))
  })
}
