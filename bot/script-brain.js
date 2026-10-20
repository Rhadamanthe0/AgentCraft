'use strict'

// Cerveau scripte : remplace le planificateur distant pour une mission dont les
// etapes sont donnees d avance. Il sert au banc de competences (`skill/*`,
// ci/trees.py) : le CODE des actions y est mesure sans le bruit du modele
// (meme monde, memes etapes, meme resultat attendu), alors que les autres
// niveaux mesurent l autonomie du modele, statistiquement.
//
// Tout le reste de la mission est inchange : brief lu par le code (quota,
// dimensions, arbre entier), contrats, reflexes, anti-boucle, refus d arret,
// fins mesurees. Seul le choix de l etape vient du script.
//
// Jamais branche au chat : seule la route /api/mission/script, ouverte par
// MISSION_SCRIPT=1 (banc), le cree.
//
// Script : [{ action, ...parametres, repeter? }]. Chaque entree est servie
// `repeter` fois (1 par defaut, 20 au plus), une etape par plan, dans l ordre.
// Une fois le script epuise, le cerveau declare l objectif atteint ; si les
// chiffres refusent cet arret, la mission echoue en le disant (`fin`).

const planner = require('./planner')

const REPETER_MAX = 20
const ETAPES_MAX = 60

function lireScript (script) {
  if (!Array.isArray(script) || script.length === 0) throw new Error('script vide')
  if (script.length > ETAPES_MAX) throw new Error(`script trop long (${ETAPES_MAX} entrees au plus)`)
  return script.map((entree, i) => {
    if (!entree || typeof entree.action !== 'string') throw new Error(`entree ${i + 1} sans action`)
    const repeter = entree.repeter === undefined ? 1 : Number(entree.repeter)
    if (!Number.isInteger(repeter) || repeter < 1 || repeter > REPETER_MAX) {
      throw new Error(`entree ${i + 1} : repeter entre 1 et ${REPETER_MAX}`)
    }
    const { repeter: _r, ...etape } = entree
    return { etape, repeter }
  })
}

// Le brief que le modele aurait lu, donne tel quel (champs du JSON du brief).
function lireBrief (brief = {}) {
  return {
    route: null,
    incompleteGesture: false,
    clearanceLimit: brief.degagement === 1 ? 1 : 0,
    needsTransfer: brief.livraison === true,
    needsWeb: false,
    fabrication: typeof brief.fabrication === 'string' ? brief.fabrication
      : (Array.isArray(brief.fabrication) ? brief.fabrication[0] ?? null : null),
    fabricationSuite: Array.isArray(brief.fabrication) ? brief.fabrication.slice(1) : [],
    fabricationQuantite: Number.isFinite(Number(brief.fabrication_quantite)) && brief.fabrication_quantite !== null
      ? Number(brief.fabrication_quantite)
      : null,
    kind: typeof brief.type === 'string' ? brief.type : 'recolte',
    kindConfidence: 1,
    resource: typeof brief.matiere === 'string' ? brief.matiere : 'aucune',
    resourceConfidence: 1,
    resourceProbabilities: null,
    landmark: typeof brief.repere === 'string' ? brief.repere : 'ici',
    landmarkConfidence: 1,
    // Mode ouvert (A/B buts_ouverts) : bloc du registre, capacite absente.
    blocRegistre: typeof brief.bloc === 'string' ? brief.bloc : null,
    horsCapacites: typeof brief.hors_capacites === 'string' ? brief.hors_capacites : null,
    // Objets a poser (A/B poser).
    pose: Array.isArray(brief.pose) ? brief.pose : null,
    door: brief.porte === true,
    doorProbability: brief.porte === true ? 1 : 0,
    usage: null,
    ms: 0
  }
}

function createScriptBrain ({ script, brief } = {}) {
  const entrees = lireScript(script)
  const lu = lireBrief(brief)
  let index = 0
  let servies = 0
  let epuise = false
  const stats = { plans: 0 }
  return {
    scripte: true,
    MIN_CONFIDENCE: planner.MIN_CONFIDENCE,
    isEnabled: () => true,
    readBrief: async () => lu,
    stats,
    async plan (_state, kind, supply) {
      stats.plans += 1
      if (index >= entrees.length) {
        if (epuise) {
          const err = new Error('script epuise : arret refuse par les chiffres')
          err.fin = true
          throw err
        }
        epuise = true
        return { done: 1, finished: true, why: 'script epuise', steps: [], rejected: [], seconds: 0, ms: 0 }
      }
      const { etape, repeter } = entrees[index]
      const rang = index + 1
      servies += 1
      if (servies >= repeter) {
        index += 1
        servies = 0
      }
      // Meme validation que pour le modele : une action absente de ce type de
      // mission est rejetee, les parametres sont bornes de la meme facon.
      const result = planner.validate({ plan: [etape], fini: 0 }, kind, supply)
      if (result.rejected.length > 0) {
        const err = new Error(`etape de script rejetee : ${result.rejected.join(', ')}`)
        err.fin = true
        throw err
      }
      return { ...result, why: `script ${rang}/${entrees.length}`, ms: 0 }
    }
  }
}

module.exports = { createScriptBrain, lireScript, lireBrief }
