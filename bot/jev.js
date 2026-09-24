'use strict'

// Routage d intention et pilotage de mission par Jev (TypeSafe System One).
//
// Jev repond a des questions typees au lieu de generer du texte. Trois usages :
//   - classify()    : un message de chat -> une commande (ou 'aucune') ;
//   - readBrief()   : un objectif -> ce qu il faut en retenir (type, matiere,
//                     repere, porte), en un seul appel ;
//   - planMission() : un etat de jeu -> "est-ce fini ?", "quelle action ?" et
//                     "avec quelle ampleur ?".
//
// Jev est le SEUL classificateur : il n y a plus de repli sur des mots-cles.
// Sans cle ou en cas de panne, le bot n obeit qu aux commandes prefixees et le
// dit dans le chat, plutot que de deviner.
//
// Regle tenue partout : **Jev classe, il ne compte pas**. Aucune question ne lui
// demande de coordonnees ni de quantite exacte. Les nombres viennent soit d une
// mesure du jeu, soit d une lecture du texte (build.parseDimensions), soit d une
// echelle qualitative (question `score`) traduite ensuite en unites.
//
// Docs : https://docs.typesafe.ai/api

const skills = require('./skills')

const MODEL = process.env.JEV_MODEL || 'jev-latest'
const MIN_CONFIDENCE = Number(process.env.JEV_MIN_CONFIDENCE || 0.6)
const TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS || 4000)
// Le planificateur tourne en boucle : on lui laisse un peu plus d air, un pic de
// latence ne doit pas interrompre une mission en cours.
const PLAN_TIMEOUT_MS = Number(process.env.JEV_PLAN_TIMEOUT_MS || 8000)
// Au-dessus de ce seuil, la reponse "l objectif est atteint" est acceptee.
const DONE_THRESHOLD = Number(process.env.JEV_DONE_THRESHOLD || 0.75)
// Au-dessus de ce seuil, la reponse "le joueur a demande une porte" est retenue.
const DOOR_THRESHOLD = Number(process.env.JEV_DOOR_THRESHOLD || 0.6)

let client = null
let sdk = null
let initError = null

function isEnabled () {
  return Boolean(client)
}

function init () {
  if (!process.env.TYPESAFE_API_KEY) {
    initError = 'TYPESAFE_API_KEY not set'
    return false
  }

  try {
    // Le SDK fournit un build CommonJS, require() convient.
    sdk = require('@typesafe-ai/sdk')
    client = new sdk.TypeSafeClient({ timeout: TIMEOUT_MS })
    return true
  } catch (err) {
    initError = err.message
    client = null
    sdk = null
    return false
  }
}

// Le SDK gere lui-meme le delai et les reessais ; on enveloppe seulement
// l erreur pour que l appelant sache d ou elle vient.
async function ask (questions, state, timeout) {
  try {
    return await client.systemOne({ model: MODEL, state, questions }, { timeout })
  } catch (err) {
    const error = new Error(`Jev call failed: ${err.message}`)
    error.cause = err
    throw error
  }
}

function readChoice (response, name) {
  const answer = response?.answers?.[name]
  if (!answer || typeof answer.choice !== 'string') {
    throw new Error(`Jev returned no usable "${name}" answer`)
  }
  return {
    choice: answer.choice,
    confidence: typeof answer.confidence === 'number' ? answer.confidence : 0,
    probabilities: answer.probabilities ?? null
  }
}

function readNoul (response, name) {
  const answer = response?.answers?.[name]
  if (!answer || typeof answer.noul !== 'number') {
    throw new Error(`Jev returned no usable "${name}" answer`)
  }
  return answer.noul
}

// L ampleur est un confort, pas une necessite : si elle manque, l appelant
// retombe sur un niveau moyen plutot que d echouer.
function readScore (response, name) {
  const answer = response?.answers?.[name]
  if (!answer || typeof answer.score !== 'number') return null
  return answer.score
}

// ---------------------------------------------------------------------------
// 1. Un message de chat -> une commande
// ---------------------------------------------------------------------------

// Renvoie { command, confidence, actionable, ... }, ou null si Jev est inactif.
async function classify (message) {
  if (!client) return null

  const response = await ask(
    {
      intent: sdk.choice(
        'Quelle action le joueur demande-t-il au bot Minecraft dans ce message de chat ?',
        skills.intentCriteria()
      )
    },
    { message },
    TIMEOUT_MS
  )

  const intent = readChoice(response, 'intent')

  return {
    command: intent.choice,
    confidence: intent.confidence,
    probabilities: intent.probabilities,
    actionable: intent.choice !== 'aucune' && intent.confidence >= MIN_CONFIDENCE,
    usage: response.usage ?? null
  }
}

// ---------------------------------------------------------------------------
// 2. Un objectif -> son brief
//
// Quatre questions dans un seul appel, posees une seule fois au lancement. Le
// resultat est conserve pour toute la mission et reinjecte dans l etat a chaque
// tour : c est ce qui fait que le bot « se souvient » de la consigne complete au
// lieu de la reduire a une seule etiquette.
// ---------------------------------------------------------------------------

async function readBrief (objective) {
  if (!client) return null

  const response = await ask(
    {
      type: sdk.choice(
        "De quelle sorte d objectif s agit-il ?",
        skills.kindCriteria()
      ),
      matiere: sdk.choice(
        'Quelle matiere ou quel type de bloc du jeu Minecraft cet objectif concerne-t-il, que le bot doive la recolter, s en approcher, ou batir avec ?',
        skills.resourceCriteria()
      ),
      repere: sdk.choice(
        "Par rapport a quoi le joueur situe-t-il ce qu il demande ?",
        skills.landmarkCriteria()
      ),
      porte: sdk.noul(
        "Le joueur demande-t-il explicitement une porte ou une entree dans ce qui doit etre construit ?",
        {
          true: 'Une porte, une entree ou un acces est demande',
          false: "Aucune porte n est mentionnee"
        }
      )
    },
    { objectif: objective },
    TIMEOUT_MS
  )

  const type = readChoice(response, 'type')
  const matiere = readChoice(response, 'matiere')
  const repere = readChoice(response, 'repere')
  const porte = readNoul(response, 'porte')

  return {
    kind: type.choice,
    kindConfidence: type.confidence,
    resource: matiere.choice,
    resourceConfidence: matiere.confidence,
    resourceProbabilities: matiere.probabilities,
    landmark: repere.choice,
    landmarkConfidence: repere.confidence,
    door: porte >= DOOR_THRESHOLD,
    doorProbability: porte,
    usage: response.usage ?? null
  }
}

// ---------------------------------------------------------------------------
// 3. Un etat de jeu -> fini ? sinon quelle action ?  (premier etage)
//
// Les deux questions partent dans le meme appel : la decision d arret est ainsi
// prise sur le meme etat que le choix de l action suivante.
//
// `kind` restreint les options proposees au type de mission en cours (un
// chantier ne se voit pas proposer « ramasser ») et `supply` les restreint
// encore : en creative, un chantier n a ni a casser ni a fabriquer.
//
// L ampleur **n est plus demandee ici**. Elle l etait autrefois dans le meme
// appel, donc a l aveugle : le modele devait situer « beaucoup » sans savoir
// s il parlait de blocs, de secondes ou de metres, et une question propre a une
// seule action (« fabriquer quoi ? ») n avait nulle part ou vivre. Voir
// planParams, le second etage.
// ---------------------------------------------------------------------------

async function planMission (state, kind, supply) {
  if (!client) return null

  const response = await ask(
    {
      termine: sdk.noul(
        "D apres l etat fourni, l objectif confie au bot est-il deja entierement accompli ?",
        {
          true: "Tout ce que le joueur a demande est fait. Pour une recolte : progression.unites_recoltees a atteint la quantite demandee, ou a defaut quota_par_defaut. Pour une construction : chantier.blocs_restants vaut 0, et si une porte etait demandee chantier.porte_posee est vrai. Pour un deplacement : environnement.bloc_cible_a_portee est vrai",
          false: "Il reste du travail : la quantite visee n est pas atteinte, ou des blocs restent a poser, ou la porte manque, ou le bot n est pas encore arrive aupres de sa cible"
        }
      ),
      etape: sdk.choice(
        "Quelle action le bot doit-il effectuer MAINTENANT pour avancer vers l objectif ?",
        skills.actionCriteria(kind, supply)
      )
    },
    state,
    PLAN_TIMEOUT_MS
  )

  const step = readChoice(response, 'etape')
  const done = readNoul(response, 'termine')

  return {
    done,
    finished: done >= DONE_THRESHOLD,
    step: step.choice,
    confidence: step.confidence,
    probabilities: step.probabilities,
    usage: response.usage ?? null
  }
}

// ---------------------------------------------------------------------------
// 4. L action est choisie -> ses parametres  (second etage)
//
// N est appele que si l action en declare (skills.paramsFor). Les actions sans
// parametre — approcher, choisir_terrain, poser_porte, sortir, terminer — ne
// coutent donc toujours qu un seul appel par tour, comme avant.
//
// Deux natures de parametre, toutes deux typees :
//   - `score` : une ampleur dont la rubrique est ecrite dans l unite de
//     l action (« une dizaine de blocs », « cinq secondes ») plutot qu en termes
//     generiques ;
//   - `choice` : une option dont les criteres peuvent etre calcules a
//     l execution. `fabriquer` s en sert pour ne proposer que les recettes dont
//     les ingredients sont **deja en inventaire** : Jev choisit parmi ce qui est
//     reellement possible, il n a jamais a deviner l ordre des recettes.
//
// `dynamicCriteria` porte ces options calculees, indexees par le nom declare
// dans `dynamic`. L etat recoit en plus `action_choisie` : la question du second
// etage doit etre lue en sachant ce qui vient d etre decide.
// ---------------------------------------------------------------------------

async function planParams (state, action, dynamicCriteria = {}) {
  const empty = { scale: 0.5, scaleLevel: null, choices: {}, usage: null, asked: false }
  if (!client) return empty

  const params = skills.paramsFor(action)
  if (!params) return empty

  const questions = {}
  const rubrics = {}

  for (const [name, descriptor] of Object.entries(params)) {
    if (descriptor.type === 'score') {
      const rubric = descriptor.rubric ?? skills.SCALE_RUBRIC
      rubrics[name] = rubric
      questions[name] = sdk.score(descriptor.question, rubric)
      continue
    }

    if (descriptor.type === 'choice') {
      const criteria = descriptor.dynamic
        ? dynamicCriteria[descriptor.dynamic]
        : descriptor.criteria

      // Une question sans option ne peut rien renvoyer d utilisable. On ne la
      // pose pas, et l appelant decide (ici : l action echoue en disant qu il
      // n y a rien de fabricable, ce qui renvoie Jev vers « casser »).
      if (!criteria || Object.keys(criteria).length === 0) continue
      questions[name] = sdk.choice(descriptor.question, criteria)
      continue
    }

    if (descriptor.type === 'noul') {
      questions[name] = sdk.noul(descriptor.question, descriptor.options)
    }
  }

  if (Object.keys(questions).length === 0) return empty

  const response = await ask(
    questions,
    { ...state, action_choisie: action },
    PLAN_TIMEOUT_MS
  )

  const result = {
    scale: 0.5,
    scaleLevel: null,
    choices: {},
    confidences: {},
    usage: response.usage ?? null,
    asked: true
  }

  for (const [name, descriptor] of Object.entries(params)) {
    if (!questions[name]) continue

    if (descriptor.type === 'score') {
      const score = readScore(response, name)
      const levels = Math.max(1, (rubrics[name]?.length ?? 5) - 1)
      result.choices[name] = score

      if (name === 'ampleur') {
        // Normalise sur 0..1 : mission.js le traduit dans l unite de l action.
        result.scale = score === null ? 0.5 : Math.max(0, Math.min(1, score / levels))
        result.scaleLevel = score
      }
      continue
    }

    if (descriptor.type === 'choice') {
      const answer = readChoice(response, name)
      result.choices[name] = answer.choice
      result.confidences[name] = answer.confidence
      continue
    }

    if (descriptor.type === 'noul') {
      result.choices[name] = readNoul(response, name)
    }
  }

  return result
}

module.exports = {
  init,
  isEnabled,
  classify,
  readBrief,
  planMission,
  planParams,
  get initError () { return initError },
  MODEL,
  MIN_CONFIDENCE,
  DONE_THRESHOLD,
  DOOR_THRESHOLD
}
