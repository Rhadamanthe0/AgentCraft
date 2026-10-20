'use strict'

// Resultat d une action : un contrat structure, pas de la prose a relire.
//
//   { resultat, echec, code, remedes }
//
// `code` nomme l echec ; `remedes` liste les actions du catalogue qui peuvent
// lever l obstacle. Le texte reste pour le modele, mais aucun echec ne
// conseille plus un geste qu aucune action ne sait faire (vu : « changer de
// poste » renvoye dix fois au modele, alors qu aucune action ne choisit un
// poste ; corrige en faisant chercher le poste par le code).
//
// Regle verifiee par tmp/outcomes.test.js : chaque code ecrit dans mission.js
// a une entree ici, et chaque remede nomme une action de skills.ACTIONS.
// Un code sans remede possible (stop, mauvais parametre) a une liste vide :
// c est un constat, pas une impasse.

const REMEDES = {
  // Hauteur et acces
  cible_haute: ['piler', 'casser'],
  pilier: [],
  // Cible rejointe par le moteur d acces unique (succes, reobservation).
  acces: [],
  // Bot absent pendant l acces (deconnexion) : constat, rien a tenter.
  unavailable: [],
  stock_echafaudage_insuffisant: ['casser', 'fabriquer'],
  dug: [],
  dug_out_of_reach: ['avancer', 'piler'],
  // Arbre commence, chantier
  arbre_inacheve: ['recolter', 'piler', 'casser'],
  arbre_a_ramasser: ['ramasser'],
  aucune_cible: ['explorer', 'regarder_autour'],
  // Preconditions declarees (CONTRATS, mission.js)
  chantier_absent: ['choisir_terrain'],
  dans_liquide: ['sortir'],
  plan: [],
  // Sous-buts (action-sous-buts.js) : un echec d une action conduite garde son
  // propre code ; ceux-ci disent que le sous-but lui-meme ne peut plus avancer.
  batir_bloque: ['recolter', 'explorer', 'fabriquer'],
  batir_sans_progres: ['recolter', 'construire', 'choisir_terrain'],
  batir_borne: ['batir', 'construire'],
  obtenir_sans_cible: ['recolter', 'fabriquer'],
  obtenir_bloque: ['explorer', 'recolter'],
  obtenir_sans_progres: ['recolter', 'fabriquer', 'explorer'],
  obtenir_borne: ['obtenir', 'fabriquer'],
  // Poser un objet (action-poser.js)
  objet_inconnu: [],
  objet_absent: ['obtenir', 'fabriquer', 'cuire', 'recolter'],
  ancre_inconnue: [],
  ancre_absente: ['explorer', 'regarder_autour', 'avancer'],
  aucune_case: ['avancer', 'casser'],
  pose_hors_portee: ['avancer', 'sortir'],
  pose_refusee: ['avancer', 'sortir'],
  enfermement: ['sortir', 'avancer'],
  // Dons
  invalid_item: ['donner'],
  invalid_count: ['donner'],
  invalid_player: ['donner'],
  not_requested: [],
  no_ceiling: [],
  uncertain_blocked: [],
  already_covered: [],
  // Executeur et constats generiques
  cancelled: [],
  refused: [],
  no_result: [],
  unknown: [],
  error: [],
  repetition: []
}

// Echec sans code propre : le code generique de l action, et ce qui peut
// lever un echec de cette action. Une action absente ici n a pas de remede
// connu : l echec est un constat.
const REMEDES_PAR_ACTION = {
  avancer: ['pivoter', 'explorer', 'piler'],
  explorer: ['pivoter', 'regarder_autour', 'avancer'],
  casser: ['avancer', 'piler', 'fabriquer'],
  recolter: ['explorer', 'avancer', 'piler'],
  ramasser: ['avancer', 'casser'],
  fabriquer: ['recolter', 'fabriquer'],
  cuire: ['recolter', 'fabriquer'],
  piler: ['casser', 'fabriquer', 'avancer'],
  construire: ['choisir_terrain', 'recolter', 'fabriquer', 'sortir'],
  poser_porte: ['fabriquer', 'construire', 'sortir'],
  poser: ['avancer', 'fabriquer', 'sortir'],
  ouvrir_porte: ['sortir', 'avancer'],
  utiliser: ['sortir', 'avancer'],
  sortir: ['casser', 'piler'],
  choisir_terrain: ['avancer', 'explorer'],
  rejoindre_demandeur: ['avancer', 'explorer'],
  donner: ['rejoindre_demandeur'],
  batir: ['recolter', 'fabriquer', 'construire'],
  obtenir: ['recolter', 'fabriquer', 'explorer']
}

function codeGenerique (action) {
  return `${action}_echec`
}

// Normalise le resultat d une etape : un echec porte toujours un code (le sien
// ou le code generique de l action) et ses remedes, filtres sur le catalogue.
// L action qui vient d echouer a l identique n est pas proposee de nouveau.
function normaliser (action, outcome, actions) {
  if (!outcome || typeof outcome !== 'object') return outcome
  if (!outcome.echec) return outcome
  const code = outcome.code || codeGenerique(action)
  const connus = Object.prototype.hasOwnProperty.call(REMEDES, code) ? REMEDES[code] : (REMEDES_PAR_ACTION[action] ?? [])
  const remedes = [...new Set(outcome.remedes ?? connus)]
    .filter(nom => !actions || Object.prototype.hasOwnProperty.call(actions, nom))
    .filter(nom => !(code === 'repetition' && nom === action))
  return { ...outcome, code, remedes }
}

// Anti-boucle : la meme etape (action, parametres, case, inventaire) qui a deja
// rendu deux fois le meme echec n est pas rejouee une troisieme fois sans que
// rien n ait change. detectStuck constatait l impasse apres coup ; ce
// detecteur l empeche, et dit pourquoi avec les remedes de l echec.
// Hors garde : les actions dont l issue depend d un autre joueur (il bouge,
// il repond) ou qui n agissent pas sur le monde. La signature ne voit ni l un
// ni l autre ; les rejouer n est pas une boucle sur place.
const SANS_GARDE = new Set(['rejoindre_demandeur', 'tourner_vers_demandeur', 'donner', 'attendre', 'dire',
  'terminer', 'memoriser', 'oublier'])

function signature (action, choices, cellule, inventaire) {
  if (SANS_GARDE.has(action)) return null
  const params = Object.entries(choices ?? {})
    .filter(([, v]) => v !== undefined && v !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`).join(',')
  const c = cellule ? `${cellule.x},${cellule.y},${cellule.z}` : '?'
  return `${action}|${params}|${c}|${inventaire ?? '?'}`
}

function createLoopGuard ({ repetitions = 2, memoire = 12 } = {}) {
  const passes = []
  return {
    // Echec identique deja vu `repetitions` fois pour cette signature, sans
    // succes entre-temps : le resultat qui serait rejoue, sinon null.
    refuse (sig) {
      if (sig === null) return null
      const memes = passes.filter(p => p.sig === sig)
      if (memes.length < repetitions) return null
      const derniers = memes.slice(-repetitions)
      if (!derniers.every(p => p.echec && p.resultat === derniers[0].resultat)) return null
      return derniers[0]
    },
    note (sig, outcome) {
      if (sig === null) return
      passes.push({ sig, echec: Boolean(outcome?.echec), resultat: String(outcome?.resultat ?? ''), code: outcome?.code ?? null, remedes: outcome?.remedes ?? [] })
      if (passes.length > memoire) passes.shift()
    },
    // Le monde a change (nouvelle mission, revision) : tout est rejouable.
    reset () { passes.length = 0 }
  }
}

function refusRepetition (action, precedent, actions) {
  const connus = precedent.remedes?.length ? precedent.remedes : (REMEDES_PAR_ACTION[action] ?? [])
  const autres = connus.filter(nom => nom !== action)
  return normaliser(action, {
    resultat: `repetition refusee : ${action} a deja rendu deux fois « ${precedent.resultat.slice(0, 140)} » ` +
      'depuis cette case, avec les memes parametres et le meme inventaire' +
      (autres.length ? ` ; essayer plutot : ${autres.join(', ')}` : ' ; changer d action ou de parametres'),
    echec: true,
    code: 'repetition',
    remedes: autres
  }, actions)
}

module.exports = { SANS_GARDE, REMEDES, REMEDES_PAR_ACTION, normaliser, signature, createLoopGuard, refusRepetition }
