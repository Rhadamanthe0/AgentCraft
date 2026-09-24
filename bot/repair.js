'use strict'

// Auto-reparation : quand le bot est bloque ou tourne en rond, il decrit son
// probleme a un modele distant plus capable que le sien, et recoit une
// **operation cadree sur la documentation d une action native**.
//
// Il n y a plus d actions apprises : le planificateur compose lui-meme ses
// enchainements a partir des actions natives (`skills.ACTIONS`). Le reparateur
// ne peut donc pas inventer d action executable — le code seul le peut. Il
// ameliore ce que le modele LIT pour composer :
//   - `documenter` : creer/modifier le `quand` et les `exemples` d une action ;
//   - `fusionner`  : reverser les exemples ajoutes d une action dans une autre ;
//   - `oublier`    : retirer une documentation ajoutee (retour a la native).
//
// Chaque operation est revalidee par `skills.documentAction` /
// `skills.mergeActionDocs` / `skills.forgetActionDoc` avant d etre appliquee :
// action inconnue refusee, texte hors bornes refuse, texte commencant par `/`
// refuse. Le modele distant n a donc aucun moyen de faire executer autre chose
// que ce que le bot sait deja faire ; il ne peut que mieux documenter.
//
// Deux limites volontaires :
//   - l operation n est demandee que si le bot est reellement coince (mission.js
//     tient le detecteur ; ici on ne fait que refuser si l appelant ment) ;
//   - REPAIR_MAX_PER_MISSION appels au plus, sinon une mission qui derape
//     appellerait une API payante a chaque tour.
//
// Transport : OpenAI /chat/completions, comme planner.js. Sans REPAIR_API_KEY
// le module est inactif et le dit — il ne bloque jamais une mission.

const skills = require('./skills')
const llm = require('./llm')
const routing = require('./model-routing')

const BASE_URL = (process.env.REPAIR_BASE_URL || 'https://opencode.ai/zen/go/v1').replace(/\/+$/, '')
const API_KEY = process.env.REPAIR_API_KEY || ''
const MODEL = process.env.REPAIR_MODEL || 'deepseek-v4.1-flash'
const TIMEOUT_MS = Number(process.env.REPAIR_TIMEOUT_MS || 25000)
const MAX_TOKENS = Number(process.env.REPAIR_MAX_TOKENS || 1200)
const DEBUG = process.env.REPAIR_DEBUG === '1'

// Meme gateway que le planificateur : le reparateur a besoin des memes en-tetes
// Zen. Une session distincte pour ne pas melanger les deux conversations cote
// routage/cache.
const IS_ZEN = /opencode\.ai\/zen/i.test(BASE_URL)
const SESSION_ID = process.env.REPAIR_SESSION_ID || `minecraft-bot-repair-${process.env.BOT_USERNAME || 'bot'}`
const USER_AGENT = process.env.REPAIR_USER_AGENT || 'minecraft-bot/1.0'

// Ce que le reparateur ne documente pas : `terminer` (une doc qui pousse a
// clore serait une facon elegante d abandonner) et les actions d aide
// elles-memes (on ne documente pas le fait de demander de l aide).
const INTERDITES = new Set(['terminer', 'demander_aide', 'reviser_actions'])

const stats = {
  appels: 0,
  reussites: 0,
  echecs: 0,
  dernier_ms: null,
  derniere_action: null,
  derniere_erreur: null
}
Object.defineProperty(stats, 'routing', { enumerable: true, get: () => routing.status() })

function isEnabled () {
  return routing.isDual() || Boolean(API_KEY && BASE_URL)
}

function why () {
  if (isEnabled()) return null
  return 'REPAIR_API_KEY absente : aucun reparateur distant configure'
}

// ---------------------------------------------------------------------------
// Le prompt : le vocabulaire exact, et la documentation deja en place
//
// On envoie la liste des actions natives disponibles pour CE type de mission.
// Une action citee hors de cette liste sera refusee par skills.documentAction ;
// autant que le modele distant le sache avant d ecrire.
// ---------------------------------------------------------------------------

function allowedActions (kind, supply) {
  return skills.actionsFor(kind, supply, true).filter(name => !INTERDITES.has(name))
}

function vocabulaire (kind, supply) {
  const lines = []

  for (const name of allowedActions(kind, supply)) {
    const spec = skills.ACTIONS[name]
    const intent = typeof spec.intent === 'string' ? spec.intent : spec.intent.what
    const bits = []

    // Le vocabulaire est numerique, comme celui du planificateur : on decrit les
    // bornes reelles de chaque parametre.
    if (skills.paramsFor(name)?.objet) bits.push('objet = nom pris dans les fabrications possibles')

    for (const [param, descriptor] of Object.entries(skills.jsonParamsFor(name) ?? {})) {
      const j = descriptor.json
      if (j.kind === 'number') bits.push(`${param} = nombre de ${j.min} a ${j.max}`)
      else if (j.kind === 'text') bits.push(`${param} = texte`)
      else if (j.kind === 'list') bits.push(`${param} = liste parmi ${j.of.join(', ')}`)
    }

    lines.push(`- ${name}${bits.length ? ` (${bits.join(' ; ')})` : ''} : ${intent}`)
  }

  return lines.join('\n')
}

// La documentation effective des actions disponibles : ce que le modele distant
// doit connaitre pour ne pas reproposer un exemple deja en place.
function documentation (kind, supply) {
  const lines = []
  for (const name of allowedActions(kind, supply)) {
    const doc = skills.actionDoc(name)
    const bits = []
    if (doc.quand) bits.push(`quand : ${doc.quand}`)
    for (const exemple of doc.exemples) bits.push(`ex : ${exemple}`)
    lines.push(`- ${name}${bits.length ? ` -> ${bits.join(' | ')}` : ' -> (aucune documentation ajoutee)'}`)
  }
  return lines.join('\n')
}

function systemPrompt (kind, supply) {
  return `Tu repares un bot Minecraft ecrit avec Mineflayer. Il est pilote par un petit modele qui vient de se bloquer : il repete la meme suite d actions sans progresser, ou toutes ses actions echouent.

Tu ne peux PAS modifier son code, et tu ne peux PAS lui donner une nouvelle action : il compose lui-meme ses enchainements a partir des actions natives ci-dessous. Ce qui peut lui manquer, c est de la DOCUMENTATION : precise QUAND employer une action, et donne des EXEMPLES de composition concrets qui sortent de l impasse.

Tu rends UNIQUEMENT ce JSON, sans texte autour, sans balises de code :
{"diagnostic":"<ce qui bloque, 20 mots max>","action":"<une action native de la liste>","quand":"<dans quelle situation l employer, 15 mots max>","exemples":["<exemple de composition avec les actions de la liste, 20 mots max>"]}

Regles dures, une reponse qui les enfreint est jetee :
- "action" est UN nom de la liste ci-dessous, mot pour mot ; jamais une action inventee ;
- "quand" : une phrase courte, sans commande et sans barre oblique ;
- 1 a ${skills.DOC_EXEMPLES_MAX} "exemples" : chacun decrit une composition avec les actions de la liste, jamais du code ni une commande serveur ;
- AUCUNE coordonnee, aucun nom de bloc invente, aucun texte commencant par une barre oblique.

Ce que tu dois viser : une documentation qui fasse composer au bot une suite qu il n aurait pas essayee seul. S il echoue a atteindre sa cible, explique un contournement (pivoter, appuyer, sauter). S il ne trouve rien, explique une fouille (regarder_autour, pivoter, avancer). S il casse sans ramasser, explique la suite complete.

Actions natives disponibles pour ce bot (mission ${kind}, approvisionnement ${supply}) :
${vocabulaire(kind, supply)}

Documentation deja en place :
${documentation(kind, supply)}`
}

// Le transport vit dans llm.js. Ici, tout ce qui est propre au reparateur est
// dans les prompts et dans la validation.
// `options` sert a `reflect`, qui veut une temperature plus haute et un budget
// de sortie plus large. Passer par ce helper (et non par llm.call directement)
// est ce qui garantit que les en-tetes Zen sont toujours envoyes : c est leur
// oubli sur le chemin `reflect` qui a fait echouer `reviser_actions` en jeu.
function call (system, user, { temperature = 0.2, maxTokens = MAX_TOKENS, signal = null, task = 'repair.askForAction', state = {} } = {}) {
  if (routing.isDual()) return routing.call(task, state, system, user, { temperature, signal })
  return llm.call(system, user, {
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    model: MODEL,
    temperature,
    maxTokens,
    timeoutMs: TIMEOUT_MS,
    signal,
    headers: IS_ZEN
      ? { 'user-agent': USER_AGENT, 'x-opencode-session': SESSION_ID }
      : null
  })
}

const parseJson = llm.parseJson

// ---------------------------------------------------------------------------
// API publique
//
// Rend toujours un objet, ne leve jamais : une reparation ratee est une
// information pour le planificateur, pas une panne de mission.
// ---------------------------------------------------------------------------

// `demander_aide` : une seule operation `documenter` sur une action native.
async function askForAction ({ probleme, kind, supply, etat, historique, signal = null }) {
  if (!isEnabled()) return { ok: false, error: why() }

  const allowed = new Set(allowedActions(kind, supply))
  const user = JSON.stringify({
    probleme: String(probleme ?? '').slice(0, 300),
    etat_du_jeu: etat ?? null,
    dernieres_etapes: historique ?? []
  })

  stats.appels += 1

  const system = systemPrompt(kind, supply)
  let response
  try {
    response = await call(system, user, { signal, state: etat })
  } catch (err) {
    stats.echecs += 1
    stats.derniere_erreur = err.message
    return { ok: false, error: `reparateur injoignable : ${err.message}` }
  }

  // JSON tolerant, second essai borne. Une premiere reponse mal formee (phrase
  // autour du JSON, objet tronque) ne jette plus la reparation : on redemande
  // une fois, avec la meme consigne, puis on tranche.
  let spec = null
  try {
    spec = parseJson(response.content)
  } catch (err1) {
    if (DEBUG) console.log(`[repair] reponse brute rejetee (essai 1/2) : ${response.content.slice(0, 300)}`)
    try {
      response = await call(system, user, { signal, state: etat })
      spec = parseJson(response.content)
    } catch (err2) {
      stats.echecs += 1
      stats.derniere_erreur = err2.message
      if (DEBUG) console.log(`[repair] reponse brute rejetee (essai 2/2) : ${(response?.content ?? '').slice(0, 300)}`)
      return { ok: false, error: `reparateur illisible : ${err2.message}` }
    }
  }

  const action = String(spec?.action ?? '').trim().toLowerCase()
  if (!allowed.has(action)) {
    stats.echecs += 1
    stats.derniere_erreur = `action refusee : ${action || '(vide)'}`
    return {
      ok: false,
      error: `documentation refusee : "${action || '(vide)'}" n est pas une action disponible ici`,
      diagnostic: spec?.diagnostic ?? null
    }
  }

  const operation = {
    op: 'documenter',
    action,
    quand: spec?.quand ?? null,
    exemples: Array.isArray(spec?.exemples) ? spec.exemples : []
  }

  stats.reussites += 1
  stats.dernier_ms = response.ms
  stats.derniere_action = action
  stats.derniere_erreur = null

  return {
    ok: true,
    ms: response.ms,
    operation,
    diagnostic: String(spec?.diagnostic ?? '').slice(0, 120)
  }
}

// ---------------------------------------------------------------------------
// Reflexion sur la documentation des actions
//
// Tache differente de askForAction : il ne s agit plus de sortir d une impasse
// par UN exemple, mais de faire le point sur la documentation — enrichir ce qui
// manque, fusionner ce qui se recoupe, retirer ce qui egare. Le modele distant
// rend une liste d operations, chacune revalidee par skills avant d etre
// appliquee.
// ---------------------------------------------------------------------------

const REFLECT_TOKENS = Number(process.env.REPAIR_REFLECT_MAX_TOKENS || 1500)

function reflectPrompt (kind, supply) {
  return `Tu aides un bot Minecraft pilote par un petit modele a faire le point sur la DOCUMENTATION de ses actions.

Les actions ne sont pas du code : ce sont des actions natives du bot. Tu ne peux ni en creer, ni en renommer, ni en supprimer. Tu peux seulement ameliorer ce que le modele LIT pour composer : le "quand" et les "exemples" d une action.

Tu rends UNIQUEMENT ce JSON, sans texte autour :
{"diagnostic":"<10 mots>","operations":[{"op":"documenter","action":"...","quand":"...","exemples":["..."]},{"op":"fusionner","source":"...","cible":"..."},{"op":"oublier","action":"..."}]}

Regles :
- 0 a 3 operations. Si la documentation est deja bonne, rends {"operations":[]} : c est une reponse valide.
- "documenter" : ajoute ou remplace le "quand" et les "exemples" d une action native listee ci-dessous. "action" est un nom natif, mot pour mot.
- "fusionner" : reverse les exemples ajoutes de "source" dans "cible" (deux actions natives distinctes). A utiliser quand deux docs se recoupent.
- "oublier" : retire la documentation ajoutee d une action pour revenir a la native. A utiliser quand une doc egare.
- "action", "source", "cible" : uniquement des actions natives listees ci-dessous. Jamais une action inventee, jamais une action d aide.
- "quand" : une phrase courte, sans commande et sans barre oblique.
- 1 a ${skills.DOC_EXEMPLES_MAX} "exemples" par operation : une composition avec les actions natives, jamais du code.
- AUCUNE coordonnee, aucun nom de bloc invente, aucun code, aucune commande serveur.

Actions natives disponibles (mission ${kind}, approvisionnement ${supply}) :
${vocabulaire(kind, supply)}

Documentation actuelle :
${documentation(kind, supply)}`
}

async function reflect ({ kind, supply, historique, etat, probleme, signal = null }) {
  if (!isEnabled()) return { ok: false, error: why(), operations: [], rejected: [] }

  const allowed = new Set(allowedActions(kind, supply))
  const user = JSON.stringify({
    probleme: String(probleme ?? '').slice(0, 300),
    etat_du_jeu: etat ?? null,
    dernieres_etapes: historique ?? []
  })

  stats.appels += 1

  const system = reflectPrompt(kind, supply)
  const callOptions = { temperature: 0.3, maxTokens: REFLECT_TOKENS, task: 'repair.reflect', state: etat, signal }
  let response
  try {
    response = await call(system, user, callOptions)
  } catch (err) {
    stats.echecs += 1
    stats.derniere_erreur = err.message
    return { ok: false, error: `reparateur injoignable : ${err.message}`, operations: [], rejected: [] }
  }

  // Meme tolerance que askForAction — second essai borne sur JSON mal forme,
  // sans boucle infinie.
  let parsed = null
  try {
    parsed = parseJson(response.content)
  } catch (err1) {
    if (DEBUG) console.log(`[repair] reflexion rejetee (essai 1/2) : ${response.content.slice(0, 300)}`)
    try {
      response = await call(system, user, callOptions)
      parsed = parseJson(response.content)
    } catch (err2) {
      stats.echecs += 1
      stats.derniere_erreur = err2.message
      if (DEBUG) console.log(`[repair] reflexion rejetee (essai 2/2) : ${(response?.content ?? '').slice(0, 300)}`)
      return { ok: false, error: `reparateur illisible : ${err2.message}`, operations: [], rejected: [] }
    }
  }

  const operations = []
  const rejected = []

  for (const raw of Array.isArray(parsed?.operations) ? parsed.operations.slice(0, 3) : []) {
    const op = String(raw?.op ?? '').toLowerCase()

    if (op === 'documenter') {
      const action = String(raw?.action ?? '').trim().toLowerCase()
      if (!allowed.has(action)) {
        rejected.push(`documenter ${action || '?'} (action indisponible)`)
        continue
      }
      operations.push({ op: 'documenter', action, quand: raw?.quand ?? null, exemples: raw?.exemples ?? [] })
      continue
    }

    if (op === 'oublier' || op === 'supprimer') {
      const action = String(raw?.action ?? '').trim().toLowerCase()
      if (!skills.ACTIONS[action]) {
        rejected.push(`oublier ${action || '?'} (action inconnue)`)
        continue
      }
      if (skills.actionDoc(action).source !== 'aide') {
        rejected.push(`oublier ${action} (aucune documentation ajoutee)`)
        continue
      }
      operations.push({ op: 'oublier', action })
      continue
    }

    if (op === 'fusionner') {
      const source = String(raw?.source ?? '').trim().toLowerCase()
      const cible = String(raw?.cible ?? '').trim().toLowerCase()
      if (source === cible) {
        rejected.push('fusionner (source et cible identiques)')
        continue
      }
      if (skills.actionDoc(source).source !== 'aide') {
        rejected.push(`fusionner ${source || '?'} (aucune documentation ajoutee a reverser)`)
        continue
      }
      if (!allowed.has(cible)) {
        rejected.push(`fusionner vers ${cible || '?'} (cible indisponible)`)
        continue
      }
      operations.push({ op: 'fusionner', source, cible })
      continue
    }

    rejected.push(`operation inconnue : ${op || '?'}`)
  }

  stats.reussites += 1
  stats.dernier_ms = response.ms
  stats.derniere_erreur = null

  return {
    ok: true,
    ms: response.ms,
    diagnostic: String(parsed?.diagnostic ?? '').slice(0, 120),
    operations,
    rejected
  }
}

module.exports = {
  isEnabled,
  why,
  askForAction,
  reflect,
  stats,
  get MODEL () { return routing.isDual() ? routing.STRATEGY : MODEL },
  BASE_URL,
  MAX_PER_MISSION: Number(process.env.REPAIR_MAX_PER_MISSION || 2),
  MAX_REVISIONS: Number(process.env.REPAIR_MAX_REVISIONS || 2)
}
