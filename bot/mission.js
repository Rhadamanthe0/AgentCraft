'use strict'

// Boucle de mission : le planificateur pilote le bot en continu jusqu a ce que
// l objectif soit atteint.
//
// Au lancement, un appel unique etablit le **brief** : type d objectif, matiere,
// repere, porte demandee ou non (`brain().readBrief`), plus les dimensions lues
// dans le texte (build.parseDimensions). Ce brief est conserve et reinjecte dans
// l etat a chaque tour — sans lui, le bot reduisait « une maison en terre de
// 5 par 5 par 5 avec une porte » a l etiquette « terre » et se mettait a creuser.
//
// Ensuite, a chaque tour, un appel au planificateur rend un **plan JSON de
// plusieurs actions** (voir planner.js), executees dans l ordre. Le premier
// echec vide la file et fait replanifier sur l etat reel.
//
// Le planificateur choisit entre des actions, il ne calcule pas : tout ce qui
// est numerique (ou est le bloc, a quelle distance, quelles dimensions) est
// mesure ou lu ici.

const skills = require('./skills')
const build = require('./build')
const outcomes = require('./outcomes')
const perception = require('./perception')
const missionState = require('./mission-state')
const missionTrace = require('./trace')
const { createGestes } = require('./action-gestes')
const { createPoser } = require('./action-poser')
const { createSousButs, prochainGesteSolveur } = require('./action-sous-buts')
const {
  PILER_DIRT, scaffoldingStock, estLiquide, estSolide, blocExpose, colonnesSousHitbox, peutSauter,
  marcheDevant, videDevant, sondeAlentours, capDepuisVecteur, choisirCoteContournement, dansEmprise
} = perception
const craft = require('./craft')
const acquirePlan = require('./acquire-plan')
const { planCraft } = require('./recipe-plan')
const delivery = require('./delivery')
const { DELIVERY, DOOR } = require('./conversation')
const reflexes = require('./reflexes')
const Vec3 = require('vec3').Vec3
const planner = require('./planner')
const { awaitPhysicalWithTimeout, unwrapExecutionEnvelope } = require('./executor')
const { createScriptBrain } = require('./script-brain')
const memory = require('./memory')
const screenshot = require('./screenshot')
const { blockInReach, clearSegment, itemInPickupRange, isWoodDoor, doorClosed } = require('./navigation')
// R19 : parsing central des variables numeriques (bot/config.js) : un NaN
// silencieux desactiverait les garde-fous compares (`steps >= MAX_STEPS`).
const config = require('./config')

// Qui decide : le planificateur JSON distant (plan de plusieurs etapes par
// appel).
// Une mission scriptee (banc de competences, script-brain.js) porte son propre
// cerveau ; toutes les autres passent par le planificateur.
function brain (m = null) {
  return m?.cerveau ?? planner
}

// Pause entre deux etapes **deja planifiees** : il n y a pas d appel reseau a
// amortir, seulement le temps que le jeu prenne en compte l etape precedente.
// C est la moitie du gain de latence, l autre etant l appel economise.
const QUEUE_TICK_MS = config.positiveInt(process.env.MISSION_QUEUE_TICK_MS, 250, 'MISSION_QUEUE_TICK_MS')

// Delai minimal entre deux phrases du bot dans le chat. Sans lui, le modele
// boucle sur « dire -> attendre » et inonde le chat.

// Delai minimal entre deux messages SYSTEME du bot (impasse, apprentissage d une
// action). Ils ne passent pas par l action `dire`, donc echappent a sa limite de
// repetition ; ce delai court les empeche de spammer a eux seuls.
const ANNOUNCE_COOLDOWN_MS = config.positiveInt(process.env.MISSION_ANNOUNCE_COOLDOWN_MS, 5000, 'MISSION_ANNOUNCE_COOLDOWN_MS')

// Un chantier est approvisionne d une seule facon : le bot casse, ramasse et
// fabrique ce qu il pose.
//
// Il y avait ici un mode 'creative' ou la main se remplissait toute seule par
// `creative.setInventorySlot()` : la maison ne coutait alors aucune ressource.
// Supprime avec le reste des pouvoirs d administration, a la demande du
// proprietaire. Le bot joue avec ce qu il a ramasse, ou il echoue.
const SUPPLY = 'harvest'

const TICK_MS = config.positiveInt(process.env.MISSION_TICK_MS, 1200, 'MISSION_TICK_MS')
const MAX_STEPS = config.positiveIntOrThrow(process.env.MISSION_MAX_STEPS, 60, 'MISSION_MAX_STEPS')
// Un geste ne se mesure pas en quantite : il doit se conclure vite. Sans cette
// borne, un modele qui n ose jamais dire « fini » boucle sur regarder_autour.
const GESTE_MAX_STEPS = config.positiveIntOrThrow(process.env.MISSION_GESTE_MAX_STEPS, 10, 'MISSION_GESTE_MAX_STEPS')
// Un geste dont le plan echoue replanifie au lieu de conclure sur un echec
// (voir la boucle). Plafond : le plan initial plus ce nombre de replanifications,
// pour qu un geste irrealisable rende quand meme la main.
const GESTE_MAX_PLANS = config.positiveIntOrThrow(process.env.MISSION_GESTE_MAX_PLANS, 3, 'MISSION_GESTE_MAX_PLANS')
const MAX_DURATION_MS = config.positiveIntOrThrow(process.env.MISSION_MAX_DURATION_MS, 600000, 'MISSION_MAX_DURATION_MS')
const SEARCH_RADIUS = config.positiveInt(process.env.MISSION_SEARCH_RADIUS, 32, 'MISSION_SEARCH_RADIUS')
const STEP_TIMEOUT_MS = config.positiveIntOrThrow(process.env.MISSION_STEP_TIMEOUT_MS, 20000, 'MISSION_STEP_TIMEOUT_MS')
// Quantite visee quand l objectif n en precise aucune ("ramasse de l herbe").
const DEFAULT_QUOTA = config.positiveInt(process.env.MISSION_DEFAULT_QUOTA, 16, 'MISSION_DEFAULT_QUOTA')

// Mini-carte PNG jointe au planificateur (voir screenshot.js). DESACTIVEE par
// defaut : sans MISSION_SCREENSHOT=1, aucun pixel n est genere et l etat envoye
// est strictement celui d avant. Une seule capture toutes N etapes : l image
// coute des jetons d entree et un peu de latence, donc on ne la paie pas a
// chaque tour. `RAYON` est la demi-cote de la carte, en blocs.
const SCREENSHOT_ON = process.env.MISSION_SCREENSHOT === '1'

// Interrupteurs A/B du banc : chaque nouveau mode peut etre coupe (ou la vue
// allumee) pour mesurer ce qu il apporte, sans redemarrer le bot. Priorite :
// /api/features, puis la variable FEATURE_<NOM> ('0'/'1'), puis le defaut du
// mode. Un processus = un bot, donc un etat par bot.
// Tree in progress and its scaffold, carried across a revision or a restart:
// declared once in mission-state.js (read and written from the same schema).
const { celluleValide } = missionState
const suiviArbre = source => missionState.restaurer(missionState.SUIVI_ARBRE, source)

const featureOverrides = {}
function featureOn (name, fallback = true) {
  if (Object.prototype.hasOwnProperty.call(featureOverrides, name)) return featureOverrides[name]
  const env = process.env[`FEATURE_${name.toUpperCase()}`]
  if (env === '0') return false
  if (env === '1') return true
  return fallback
}
function setFeatures (changes = {}) {
  if (changes?.reset === true) {
    for (const key of Object.keys(featureOverrides)) delete featureOverrides[key]
  }
  for (const [key, value] of Object.entries(changes ?? {})) {
    if (key !== 'reset' && /^[a-z_]{1,24}$/.test(key) && typeof value === 'boolean') featureOverrides[key] = value
  }
  syncActionFeatures()
  return { ...featureOverrides }
}
// Actions a interrupteur (`spec.feature` dans skills.js) : catalogue et
// validation du planificateur suivent featureOn.
function syncActionFeatures () {
  for (const spec of Object.values(skills.ACTIONS)) {
    if (spec.feature) skills.setFeatureEnabled(spec.feature, featureOn(spec.feature, spec.featureDefault ?? true))
  }
}
syncActionFeatures()
const SCREENSHOT_EVERY = config.positiveInt(process.env.MISSION_SCREENSHOT_EVERY, 5, 'MISSION_SCREENSHOT_EVERY')
const SCREENSHOT_RAYON = config.positiveInt(process.env.MISSION_SCREENSHOT_RAYON, 16, 'MISSION_SCREENSHOT_RAYON')
// Portee de casse cote serveur : ~4.5 blocs. On garde une marge.
const REACH = perception.REACH
// Degagement de feuilles vers un tronc enferme (mission bois) : feuilles
// cassees au plus par appel a `avancer`, hors quota, seulement dans le couloir
// a hauteur du corps entre le bot et la buche visee, et seulement apres un
// no_path vers cette buche. Aucune autre feuille n est touchee.
const LEAF_CLEAR_MAX = config.positiveInt(process.env.MISSION_LEAF_CLEAR_MAX, 12, 'MISSION_LEAF_CLEAR_MAX')
// « un arbre », « l arbre », « cet arbre » : un arbre entier est demande.
const WHOLE_TREE_TEXT = /\b(?:un|1|cet|ce|l'|l )\s*arbre\b/i
// Un objectif reecrit par le modele cite souvent la position du joueur
// (« x:2330.5, y:200 ») : ces nombres ne sont pas une quantite (vu sur
// chat/join-then-tree : « un arbre » devenu un quota, bot parti en chercher
// d autres une fois l arbre fini).
const sansCoordonnees = text => String(text ?? '').replace(/\b[xyz]\s*[:=]\s*-?\d+(?:[.,]\d+)?/gi, '')
// Volume de l arbre commence, autour de sa premiere buche coupee : branches
// jusqu a 4 blocs de cote, cime jusqu a 14 blocs plus haut.
const TREE_RADIUS = 4
const TREE_HEIGHT = 14
const TREE_LOG = /_log$|_wood$/
const ITEM_PICKUP_RADIUS = 12
// En dessous de cette distance, le serveur fait entrer l objet dans l inventaire
// sans que le bot ait a se deplacer.
const ITEM_AUTO_PICKUP = 1.6
// Profondeur maximale sous ses propres pieds ou le bot accepte de casser.
// Sans cette borne, une mission « terre » se transforme en puits : la matiere
// visee est litteralement le sol, et le bot s enterre.
// Borne anti-puits : 0 interdit de casser sous ses pieds, 16 reste un garde-fou.
const MAX_DIG_DEPTH = config.boundedNumberOrThrow(process.env.MISSION_MAX_DIG_DEPTH, 1, 0, 16, 'MISSION_MAX_DIG_DEPTH', { integer: true })
// Hauteur maximale au-dessus des pieds ou le bot accepte de viser un bloc.
// Le haut d un tronc est hors de portee et le bot ne grimpe pas (le
// deplacement de mission est fait de gestes, pas de pathfinder) : sans cette
// borne, la navigation pointerait sans fin vers une buche a 5 blocs de haut
// au lieu de passer a l arbre suivant.
const MAX_REACH_UP = perception.MAX_REACH_UP
const MAX_PLANNER_ERRORS = 3
// Panne passagere du planificateur (planner.estPassager : silence, reseau
// coupe, 5xx, 429). Bancs du 2026-10-07/08 : 67 a 122 plans muets par banc
// complet, 5 a 11 missions tuees par trois silences de suite, puis 13 par
// 30 s de « fetch failed ». Une serie de pannes passageres est toleree tant
// qu elle dure moins que ce delai ; tout autre echec (refus, 403) arrete au
// troisieme.
const PLANNER_OUTAGE_MS = config.finiteNumber(process.env.MISSION_PLANNER_OUTAGE_MS, 90000, 'MISSION_PLANNER_OUTAGE_MS', { min: 0 })
const MAX_REPEATED_FAILURES = 5
// Pilier : bornes de la montee en blocs. Un pilier coute sa dirt (inventaire
// reel, jamais de creatif) et expose a la chute a la descente : 6 blocs
// suffisent a rendre cassable un tronc dont le pied est hors de portee.
const PILER_MIN = 1
const PILER_MAX = perception.PILER_MAX
// Dirt SECONDAIRE en mission bois : le carburant du pilier. `grass_block`
// casse lache de la dirt et se repose en dirt : on l accepte comme source de
// secours quand un pilier est utile, sans jamais compter dans le quota bois.
const SECONDARY_DIRT = /^(dirt|coarse_dirt|grass_block)$/

// Le modele ecrit parfois un nom d OBJET (« stick », « crafting_table »,
// « oak_planks ») la ou `fabriquer` attend un nom de CIBLE pris dans
// `fabrications_possibles` (« batons », « etabli », « planches »). La
// traduction se fait au point unique d execution, pour les deux
// planificateurs : un nom vraiment inconnu reste une erreur qui liste les
// possibles, jamais un succes fictif.
const FAB_ALIAS = {
  stick: 'batons',
  baton: 'batons',
  crafting_table: 'etabli',
  door: 'porte',
  axe: 'hache',
  pickaxe: 'pioche',
  shovel: 'pelle'
}

function fabTargetName (raw) {
  // Normalisation generique via skills (alias FR + familles d items), sans
  // regex de phrase du joueur : le brief a extrait la cible, le code normalise.
  if (typeof skills.normalizeFabricationTarget === 'function') {
    const norm = skills.normalizeFabricationTarget(raw)
    if (norm) return norm
  }
  const name = String(raw ?? '').trim().toLowerCase()
  if (!name) return name
  if (craft.TARGETS[name]) return name
  if (FAB_ALIAS[name]) return FAB_ALIAS[name]
  if (/_planks$/.test(name)) return 'planches'
  if (/_door$/.test(name)) return 'porte'
  if (/_axe$/.test(name)) return 'hache'
  if (/_pickaxe$/.test(name)) return 'pioche'
  if (/_shovel$/.test(name)) return 'pelle'
  return name
}

// Une fabrication sert-elle la cible du brief ? La cible elle-meme (ou un
// objet de sa famille : wooden_axe pour « hache »), ou un intermediaire commun.
const FAMILLES_FAB = { hache: /_axe$/, pioche: /_pickaxe$/, pelle: /_shovel$/, porte: /_door$/, planches: /_planks$/, batons: /^stick$/, etabli: /^crafting_table$/ }
// Objet representatif d une cible francaise, pour lire ses recettes.
const CIBLE_ITEM = {
  etabli: 'crafting_table', planches: 'oak_planks', batons: 'stick', porte: 'oak_door',
  hache: 'wooden_axe', pioche: 'wooden_pickaxe', pelle: 'wooden_shovel'
}

// Items one copy of which is enough for any recipe chain.
const OUTIL_OU_POSTE = /^(crafting_table|furnace)$|_(pickaxe|axe|shovel|hoe|sword)$/

// Where an already obtained table, furnace or tool is, or null.
function dejaObtenu (bot, item) {
  if (item === 'crafting_table') {
    const posee = craft.placedTable(bot)
    if (posee) return `un etabli est deja pose a ${bot.entity.position.distanceTo(posee.position).toFixed(1)} bloc(s)`
  }
  if (item === 'furnace') {
    const four = craft.furnaceBlock(bot)
    if (four) return `un four est deja pose a ${bot.entity.position.distanceTo(four.position).toFixed(1)} bloc(s)`
  }
  if (craft.countOf(bot, new RegExp(`^${item}$`)) > 0) {
    return item === 'crafting_table' ? 'un etabli est deja dans l inventaire' : `${item} deja dans l inventaire`
  }
  return null
}

// Des batons entrent-ils dans une recette de la cible ? Vu sur craft/table :
// 1 buche, 4 planches, puis 2 batons (2 planches perdues) et plus assez pour
// l etabli. Sans registre (tests purs), on garde l ancienne tolerance.
function cibleUtiliseBatons (registry, cible) {
  const name = CIBLE_ITEM[cible] ?? cible
  const item = registry?.itemsByName?.[name]
  const stick = registry?.itemsByName?.stick
  if (!item || !stick || !registry.recipes) return true
  const ids = recipe => [...(recipe.ingredients ?? []), ...(recipe.inShape ?? []).flat()]
    .map(i => (i && typeof i === 'object' ? i.id : i))
  return (registry.recipes[item.id] ?? []).some(r => ids(r).includes(stick.id))
}

function fabricationUtile (target, cible, registry = null) {
  if (!target || !cible || target === cible) return true
  if (/^(batons|stick)$/.test(target) && !cibleUtiliseBatons(registry, cible)) return false
  if (['planches', 'batons', 'etabli'].includes(target) || /_planks$|^stick$|^crafting_table$/.test(target)) return true
  const famille = FAMILLES_FAB[cible]
  if (famille && famille.test(target)) return true
  const autre = FAMILLES_FAB[target]
  return Boolean(autre && autre.test(cible))
}

// Comptage generique de la cible de fabrication dans l inventaire REEL
// (le code compte, jamais le modele). Cibles FR : motifs d items ; item
// direct : nom exact. Aucune recette hardcodee par phrase.
function countFabricationItems (bot, cible) {
  if (!cible) return 0
  if (cible === 'hache') return craft.countOf(bot, /_axe$/)
  if (cible === 'pioche') return craft.countOf(bot, /_pickaxe$/)
  if (cible === 'pelle') return craft.countOf(bot, /_shovel$/)
  if (cible === 'planches') return craft.countOf(bot, /_planks$/)
  if (cible === 'batons') return craft.countOf(bot, /^stick$/)
  if (cible === 'etabli') return craft.countOf(bot, /^crafting_table$/)
  if (cible === 'porte') return craft.countOf(bot, /_door$/)
  try {
    return craft.countOf(bot, new RegExp(`^${String(cible).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
  } catch (_) {
    return 0
  }
}

// Quantite visee d une fabrication : brief (indicatif) puis lecture code de
// la phrase, sinon 1. Bornee 1..16 (CRAFT_MAX). Jamais le quota recolte (16)
// par defaut : "fabrique une hache" vaut 1, pas 16.
function fabricationWanted (text, briefQty) {
  if (briefQty !== null && briefQty !== undefined && briefQty !== '') {
    const fromBrief = Number(briefQty)
    if (Number.isFinite(fromBrief)) {
      return Math.max(CRAFT_MIN, Math.min(CRAFT_MAX, Math.round(fromBrief)))
    }
  }
  const fromText = build.parseQuota(String(text ?? ''), { allowBlockUnits: false })
  if (Number.isFinite(fromText)) {
    return Math.max(CRAFT_MIN, Math.min(CRAFT_MAX, Math.round(fromText)))
  }
  return 1
}

// Validation registre de la cible brute du brief : alias FR (craft.TARGETS)
// ou item reel (itemsByName). Inconnu => null (legacy recolte inchange).
// Aucune regex de phrase ici : le modele a extrait, le code valide.
// Objets a poser lus dans le brief : [{ objet, quantite }] au registre des
// objets, six au plus, quantite 1 a 64 ou null (au moins un).
function posesDuBrief (bot, brut) {
  if (!Array.isArray(brut)) return []
  const vus = new Set()
  const out = []
  for (const p of brut.slice(0, 6)) {
    const objet = resolveFabricationCible(bot, typeof p === 'string' ? p : p?.objet)
    if (!objet || vus.has(objet) || (bot?.registry?.itemsByName && !bot.registry.itemsByName[objet])) continue
    vus.add(objet)
    const q = Number(p?.quantite)
    out.push({ objet, quantite: p?.quantite !== null && Number.isFinite(q) ? Math.max(1, Math.min(64, Math.round(q))) : null })
  }
  return out
}

function resolveFabricationCible (bot, raw) {
  const norm = fabTargetName(raw)
  if (!norm) return null
  if (craft.TARGETS[norm]) return norm
  const itemsByName = bot?.registry?.itemsByName
  if (itemsByName && itemsByName[norm]) return norm
  // Pluriel du modele (« torches », « furnaces ») : le singulier du registre.
  const single = norm.replace(/(?<=[a-z])e?s$/, '')
  if (itemsByName && single !== norm) {
    if (itemsByName[norm.slice(0, -1)]) return norm.slice(0, -1)
    if (itemsByName[single]) return single
  }
  // Sans registre (jamais en prod), le format suffit : le make tranchera
  // (unknown/missing honnetes). En prod le registre existe toujours.
  if (!itemsByName && /^[a-z0-9_]+$/.test(norm)) return norm
  return null
}

// Detecteur de blocage : quand le bot n avance plus, il le dit (chat,
// journal `[blocage]`). Un seuil en etapes (et non en secondes) parce que tout ce
// qui compte ici est mesure par avancement : blocs casses, objets recoltes,
// blocs poses d un chantier.
const NO_PROGRESS_STEPS = config.positiveInt(process.env.MISSION_NO_PROGRESS_STEPS, 8, 'MISSION_NO_PROGRESS_STEPS')

// Bornes des actions parametrees : une valeur omise par le modele est
// interpolee entre ces bornes (milieu de plage).
const HARVEST_MIN = 2
const HARVEST_MAX = config.positiveInt(process.env.MISSION_HARVEST_BURST_MAX, 16, 'MISSION_HARVEST_BURST_MAX')
// Duree max d une action `recolter` (chaine avancer/casser/ramasser).
const RECOLTER_MAX_MS = config.positiveInt(process.env.MISSION_RECOLTER_MAX_MS, 60000, 'MISSION_RECOLTER_MAX_MS')
// Action `explorer` : trajets de recherche au plus, et duree max.
const EXPLORE_LEGS = config.positiveInt(process.env.MISSION_EXPLORE_LEGS, 4, 'MISSION_EXPLORE_LEGS')
const EXPLORE_MAX_MS = config.positiveInt(process.env.MISSION_EXPLORE_MAX_MS, 45000, 'MISSION_EXPLORE_MAX_MS')
const HARVEST_BURST_MS = config.positiveInt(process.env.MISSION_HARVEST_BURST_MS, 15000, 'MISSION_HARVEST_BURST_MS')
const PICKUP_MIN = 1
const PICKUP_MAX = 6
const EXPLORE_MAX = 40
const PLACE_MIN = 4
const PLACE_MAX = 40
const PLACE_BURST_MS = config.positiveInt(process.env.MISSION_PLACE_BURST_MS, 25000, 'MISSION_PLACE_BURST_MS')
// Garde-fou par bloc : une pose qui ne rend pas la main figerait toute la
// mission, puisque la borne de rafale n est relue qu entre deux blocs.
// 18 s et non 6 : `placeOne` inclut le ralliement au poste de tir, borne lui
// a 12 s par `BUILD_MOVE_TIMEOUT_MS`. Un cap sous le trajet prevu tuait les
// poses lointaines (« pose trop longue » a 13 blocs du chantier) alors que
// la marche fonctionnait. La borne de rafale reste le vrai garde-fou global.
const PLACE_ONE_TIMEOUT_MS = config.positiveInt(process.env.MISSION_PLACE_ONE_TIMEOUT_MS, 18000, 'MISSION_PLACE_ONE_TIMEOUT_MS')
const CRAFT_MIN = 1
const CRAFT_MAX = config.positiveInt(process.env.MISSION_CRAFT_MAX, 16, 'MISSION_CRAFT_MAX')
// Persisted resume fields (mission-state.js), with this module's bounds.
const REPRISE = missionState.schemaReprise({ landmarks: skills.LANDMARKS, defaultQuota: DEFAULT_QUOTA, craftMin: CRAFT_MIN, craftMax: CRAFT_MAX })

// Deplacement en gestes : reglage de la primitive `walkForward` (utilisee par
// `avancer`, `rejoindre_demandeur` et `ramasser`).
// Vitesse au sol observee : ~4,5 blocs en 4 s, soit un peu plus d une seconde
// par bloc ; la marge couvre les sauts de denivele.
const STEP_MS_PER_BLOCK = 1100
const WALK_EXTRA_MS = 4000
const WALK_TICK_MS = 100
// Progres minimal (blocs) considere comme un mouvement sur la fenetre.
const STUCK_CHECK_STEP = 0.3
// Saut de denivele : on declenche tot (600 ms sans progres), puis on RE-essaie
// en relachant puis rappuyant `jump` (un seul appui ne suffisait pas en mesure).
// Au-dela de JUMP_MAX_ATTEMPTS, l obstacle est declare infranchissable.
const JUMP_FIRST_MS = config.positiveInt(process.env.MISSION_JUMP_FIRST_MS, 600, 'MISSION_JUMP_FIRST_MS')
const JUMP_RETRY_MS = config.positiveInt(process.env.MISSION_JUMP_RETRY_MS, 700, 'MISSION_JUMP_RETRY_MS')
const JUMP_MAX_ATTEMPTS = config.positiveInt(process.env.MISSION_JUMP_MAX_ATTEMPTS, 3, 'MISSION_JUMP_MAX_ATTEMPTS')

// Navigation par paliers vers une cible (sans pathfinder) : quand la cible est
// loin, on vise un point intermediaire atteignable dans la direction puis on
// re-pivote, au lieu de foncer 20 blocs d un coup vers un obstacle. NAV_PALIER_MAX
// garde "avance de 5" intact (un seul palier) tout en decoupant les longs trajets.
// Le repli strafe est borne (NAV_MAX_STRAFES) : au-dela, echec explicite.
// NAV_GAIN_MIN / NAV_STAGNANT_MAX portent l anti-oscillation entre gestes : sans
// gain de distance XZ sous N gestes de mouvement, on force le contournement.
const NAV_PALIER_MAX = 6
const NAV_STRAFE_MS = 1000
const NAV_MAX_STRAFES = 2
const NAV_GAIN_MIN = 0.5
const NAV_STAGNANT_MAX = 3

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const movementTask = require('./movement-task')
const activity = require('./activity')
// 0 coupe l annonce (mission-duration.test.js) : borne basse 0, pas 1.
const BRIEF_NOTICE_MS = config.finiteNumber(process.env.MISSION_BRIEF_NOTICE_MS, 3000, 'MISSION_BRIEF_NOTICE_MS', { min: 0 })

// Traduit l ampleur 0..1 (defaut 0,5 : milieu de plage) dans l unite de l action.
function scaled (scale, min, max) {
  const value = min + (max - min) * (Number.isFinite(scale) ? scale : 0.5)
  return Math.max(min, Math.min(max, Math.round(value)))
}

// `host` donne acces au bot vivant (il est recree a chaque reconnexion) et aux
// fonctions d index.js qu une mission doit pouvoir declencher.
// Cycle durable : `injected` (ou `host.executor` / `host.objectives`) branche
// l executeur a proprietaire unique et le controleur d objectifs, sans changer
// le comportement quand ils sont absents (repli : execution directe).
// L executeur ne libere son slot qu a la resolution REELLE : aucun
// Promise.race autour de son run (voir executor.js).
function createMissionRunner (host, injected = {}) {
  let mission = null
  let loopPromise = null
  let startGeneration = 0
  let startAbort = null
  let preparation = null
  // Missions suspendues (arbitrage pause_reprise) : objets intacts en memoire,
  // progression/origine/contraintes/id preserves. La pile du controleur reste
  // la source de verite durable ; celle-ci ne porte que les boucles vivantes.
  // Bornee (5) : au-dela, la plus ancienne est oubliee ici mais gardee par le
  // controleur (reprise explicite ulterieure via rehydrate).
  const suspended = []
  const SUSPENDED_MAX = 5
  const injectedExecutor = injected.executor ?? host.executor ?? null
  const injectedObjectives = injected.objectives ?? host.objectives ?? null
  // Proprietaire du slot executeur (reentrance) : l etape (ou le parcours)
  // qui tient le writer partage un TOKEN OBJET opaque (identite par
  // reference, jamais devine : l id de slot public ne suffit pas) aux
  // sous-etapes nav, qui s executent DANS le slot sans reacquerir (defaut
  // busy permanent sinon). Jamais d exemption globale : sans token => file
  // normale ; token inconnu/obsolete => refus 'stale'. Le token n est expose
  // par aucune API (status, chat, /api/*) : usage serveur interne uniquement.
  let stepOwner = null
  let stepToken = null
  function getStepOwner () {
    return stepOwner
  }
  function getStepToken () {
    return stepToken
  }
  function physicalExecutor () {
    return injectedExecutor && typeof injectedExecutor.run === 'function' ? injectedExecutor : null
  }
  function currentObjectiveId () {
    return mission?.objectiveId ?? null
  }

  // Borne une promesse physique SANS jamais liberer avant son settle reel
  // (R01). Au timeout, stopDigging est appele (annulation concrete d un
  // creusage en vol ; sans effet sur lookAt/equip/pose, qui attendent
  // simplement leur settle), le settle reel est attendu, puis seulement
  // l erreur de delai est levee. Comme l etape tourne DANS le slot executeur,
  // celui-ci reste tenu jusqu a la fin reelle : une operation lente bornee
  // court ne laisse jamais entrer la suivante (busy) avant d avoir fini.
  // Un 4e argument fonction remplace l annulation par defaut.
  function withTimeout (promise, ms, label, onTimeout) {
    const live = host.getBot()
    const cancel = typeof onTimeout === 'function'
      ? onTimeout
      : () => { try { live?.stopDigging?.() } catch (_) {} }
    return awaitPhysicalWithTimeout(promise, ms, label, { onTimeout: cancel })
  }

  // Grand livre durable des dons (S6/D20) : par engagement (objectif),
  // destinataire et objet. Survit a stop/reprise, revision, rehydrate (via
  // descripteur) ; jamais efface par la file, le prefetch, terminer/fini ni
  // un nouvel essai automatique. Une sortie observee sans preuve = budget
  // INCERTAIN consomme : tout retoss auto du meme engagement est interdit
  // (pause ou aide honnete, contexte conserve). Un nouvel ordre explicite
  // ouvre un nouvel objectif (nouveau scope), l ancienne preuve est gardee.
  const deliveryLedgers = new Map() // `${scope}::${dest}::${item}` -> ledger
  function deliveryScope (m) {
    return m?.objectiveId ?? m?.id ?? 'sans-objectif'
  }
  // R25 : scope memoire d un demarrage : l objectiveId (stable a la reprise,
  // y compris apres restart), a defaut le contexte de la revision, a defaut
  // null (contexte legacy 'defaut' de memory.js). Une revision garde TOUJOURS
  // le contexte de sa mission d origine. Pur : ni activation ni vidage ici,
  // c est start() qui active AVANT tout resetWork.
  function scopeMemoire (opts = {}) {
    const rev = opts.revisionOf
    const id = rev?.memoryScope ?? rev?.objectiveId ?? opts.objectiveId ?? rev?.id ?? null
    const texte = String(id ?? '').trim()
    return texte ? texte : null
  }
  function deliveryLedgerKey (scope, dest, item) {
    return `${scope}::${String(dest).toLowerCase()}::${String(item).toLowerCase()}`
  }
  function deliveryLedgersFor (m) {
    if (!m) return []
    const prefix = `${deliveryScope(m)}::`
    const out = []
    for (const [key, ledger] of deliveryLedgers) {
      if (key.startsWith(prefix)) out.push(ledger)
    }
    return out
  }
  function deliveryLedgerView (l) {
    return {
      destinataire: l.recipient,
      objet: l.item,
      plafond: l.ceiling,
      tente: l.attempted,
      retire: l.removed,
      prouve: l.proven,
      incertain: l.uncertain,
      invocations: [...l.invocations],
      termine: l.done,
      ...(l.cancelled ? { annule: true } : {})
    }
  }
  // Conserve aussi un don choisi dans le plan du trajet qui le precede.
  // Une coupe encore ouverte peut faire abandonner cette file, sans effacer
  // l engagement du modele ni inventer de quantite demandee par le joueur.
  function engagementDon (params = {}) {
    const objet = String(params.objet ?? '').trim().toLowerCase()
    const quantite = Number(params.quantite)
    const destinataire = String(params.destinataire ?? mission.requester ?? '').trim()
    if (!livraisonDemandee(mission) || !/^[a-z0-9_]+$/.test(objet) ||
      !Number.isInteger(quantite) || quantite < 1 || quantite > 64 ||
      !/^[A-Za-z0-9_]{3,16}$/.test(destinataire)) return null
    const ceiling = deliveryCeiling(mission, objet)
    const key = deliveryLedgerKey(deliveryScope(mission), destinataire, objet)
    let ledger = deliveryLedgers.get(key)
    if (!ledger) {
      ledger = { key, scope: deliveryScope(mission), recipient: destinataire, item: objet,
        ceiling, attempted: 0, removed: 0, proven: 0, uncertain: 0, invocations: [], done: false }
      deliveryLedgers.set(key, ledger)
    } else ledger.ceiling = ceiling
    // Reprendre un don explicite reactive son obligation, jamais son budget.
    ledger.cancelled = false
    return ledger
  }
  // Plafond d engagement : la demande chiffree du texte courant, lue par le
  // code (meme expression que mission.quota), jamais inventee. null = budget
  // indeterminable (clarification au lieu de sur-don).
  function deliveryCeiling (m, objet = null) {
    let q = null
    try {
      q = build.parseQuota(String(m?.objective ?? ''),
        { allowBlockUnits: m?.kind === 'recolte' && !m?.fabricationCible })
    } catch (_) {}
    if (Number.isInteger(q) && q >= 1) return q
    // « Coupe un arbre et rapporte-moi le bois » : sans chiffre, le bois de
    // CET arbre, mesure par le code (buches de l arbre prouvees ramassees).
    // Ni le modele ni le reste de l inventaire n en fixent la quantite.
    const arbre = Number(m?.arbreCollectes)
    if (m?.wholeTree && TREE_LOG.test(String(objet ?? '')) && Number.isInteger(arbre) && arbre >= 1) return arbre
    return null
  }
  // Le joueur a-t-il demande qu on lui remette quelque chose ? Objectif et
  // precisions DU DEMANDEUR seulement (jamais le plan du modele).
  function demandeDuJoueur (m, motif) {
    const textes = [m?.objective ?? '', ...(m?.instructions ?? [])
      .filter(entry => entry?.de === m?.requester).map(entry => entry.message ?? '')]
    return textes.some(texte => motif.test(texte))
  }
  function livraisonDemandee (m) {
    return demandeDuJoueur(m, DELIVERY)
  }
  function deliveryProvenFor (m) {
    let n = 0
    for (const l of deliveryLedgersFor(m)) if (!l.cancelled) n += l.proven
    return n
  }
  // Premier blocage don a servir dans l etat (l incertain prime : il interdit
  // tout nouvel essai du meme engagement).
  function deliveryBlockReason (m) {
    for (const l of deliveryLedgersFor(m)) {
      if (l.cancelled) continue
      if (l.uncertain > 0) {
        return `don ${l.item} vers ${l.recipient} incertain : ${l.uncertain} sorti(s) sans preuve`
      }
      if (l.ceiling !== null && l.proven + l.uncertain >= l.ceiling) {
        return `don ${l.item} vers ${l.recipient} couvert : ${l.proven}/${l.ceiling} prouve(s)`
      }
    }
    return null
  }
  function activeDurationMs (current = mission) {
    if (!current) return 0
    return (current.activeElapsedMs ?? 0) + (current.activeSince == null
      ? 0 : Math.max(0, Date.now() - current.activeSince))
  }

  function freezeActiveDuration (current = mission) {
    current.activeElapsedMs = activeDurationMs(current)
    current.activeSince = null
  }

  // One snapshot shape for action reports and immediate context admission.
  function progressSnapshot (instructions = mission.instructions) {
    return {
      objectifId: currentObjectiveId(),
      mission: mission.id,
      etapes: mission.steps,
      casses: mission.broken,
      recoltes: collected(),
      dirtSecondaire: mission.dirtSecondaire ?? 0,
      origine: mission.movementTask?.origin
        ? { x: mission.movementTask.origin.x, y: mission.movementTask.origin.y, z: mission.movementTask.origin.z }
        : (mission.originFixed ? { ...mission.originFixed } : null),
      curseur: mission.movementTask ? mission.movementTask.cursor : null,
      preuves: mission.history.slice(-5),
      contexte: instructions.map(entry => ({ ...entry })),
      // Descripteur de reprise : sans lui, aucune rehydratation apres
      // restart (l objectif seul ne dit ni kind ni quota ni route).
      descripteur: {
        // Type, matiere, quotas, fabrication : le schema de reprise.
        ...missionState.serialiser(REPRISE, mission),
        // Grand livre des dons (S6) : preuves persistantes pour rehydrate.
        livraison: deliveryLedgersFor(mission).map(deliveryLedgerView),
        dimensions: mission.dimensions ? { ...mission.dimensions } : null,
        // Arbre commence et echafaudage : le schema declare (mission-state.js).
        ...missionState.serialiser(missionState.SUIVI_ARBRE, mission),
        route: mission.movementTask
          ? { steps: JSON.parse(JSON.stringify(mission.movementTask.steps)), cursor: mission.movementTask.cursor, origin: mission.movementTask.origin ? { ...mission.movementTask.origin } : null }
          : null
      }
    }
  }

  function reportProgressSafe () {
    if (!injectedObjectives || typeof injectedObjectives.recordProgress !== 'function') return
    if (!mission) return
    try {
      injectedObjectives.recordProgress(progressSnapshot())
    } catch (_) { /* persistance best-effort : jamais de succes fictif */ }
  }

  function cloneContext (value) {
    if (!Array.isArray(value) || value.length > 8 || value.some(entry =>
      !entry || typeof entry !== 'object' || Array.isArray(entry) ||
      typeof entry.de !== 'string' || typeof entry.message !== 'string' || entry.message.length > 300)) {
      throw new Error('contexte de mission corrompu (8 precisions de 300 caracteres maximum)')
    }
    return value.map(({ de, message }) => ({ de, message }))
  }

  function isRunning () {
    return Boolean(mission && mission.state === 'running')
  }

  // -------------------------------------------------------------------------
  // Mesures : tout ce que le modele recoit comme etat est calcule ici
  // -------------------------------------------------------------------------

  // Matiere du catalogue, ou bloc ouvert du registre (`libre:<bloc>`, A/B
  // buts_ouverts) : meme forme, lue partout par ce seul accesseur.
  function ressource (key) {
    return skills.resourceSpec(key, host.getBot()?.registry)
  }

  function blockIdsFor (resource) {
    const bot = host.getBot()
    if (!bot?.registry || !resource) return []

    const names = ressource(resource)?.blocks ?? []
    const blocks = names.map(name => bot.registry.blocksByName[name]).filter(Boolean)
    // Une matiere a plusieurs blocs (minerai : fer, or, redstone...) : seuls
    // ceux que les outils en poche font lacher, s il y en a. Vu sur
    // composite/powered-rail-line (06d881f) : pioche en pierre en main, fer en
    // vue, le bot visait l or le plus proche (« ne lache rien sans pioche en
    // fer ») pendant 20 min. Sans aucun bloc faisable, tous restent vises :
    // l echec dit l outil a fabriquer.
    if (blocks.length < 2) return blocks.map(block => block.id)
    const faisables = blocks.filter(block => {
      try { return craft.harvestCheck(bot, block).ok } catch (_) { return true }
    })
    return (faisables.length > 0 ? faisables : blocks).map(block => block.id)
  }

  function targetBlockIds () {
    return mission ? blockIdsFor(harvestResource()) : []
  }

  // Solveur de prerequis (acquire-plan.js, idee GITM/Mindcraft) : en
  // fabrication, le code calcule la chaine complete depuis l inventaire reel
  // (recolter, fabriquer, outil exige par un bloc, etabli) ; le modele decide
  // quoi en faire. Recalcule quand l inventaire ou l etabli proche changent.
  // Regles du prompt d actions utiles a CETTE mission (A/B `prompt_type`) :
  // bois (pilier, dirt secondaire, hache), fabrication (prerequis). Coupe :
  // null, prompt complet comme avant.
  function profilPrompt () {
    if (!mission) return null
    const sansDonner = !livraisonDemandee(mission)
    if (!featureOn('prompt_type')) return { tout: true, sansDonner }
    return { bois: harvestResource() === 'bois', fabrication: Boolean(mission.fabricationCible), sansDonner }
  }

  // Outil exige par la matiere de la mission (pierre, minerai) et absent de
  // l inventaire : le plus modeste qui convient (wooden_pickaxe pour la
  // pierre). Sans lui, une construction ou une recolte de pierre depuis rien
  // tournait en rond : `explorer`/`recolter` visaient la pierre, qui ne lache
  // rien a la main (composite/stone-hut-from-scratch be9e866 : 45 min, 0 bloc,
  // « pas de pioche, il faut du bois » a chaque plan). Nul sinon.
  const TOOL_TIERS = ['wooden', 'golden', 'stone', 'copper', 'iron', 'diamond', 'netherite']
  // Objets a poser pas encore tous poses : voulus, poses (verifies), en poche,
  // et le manque a obtenir avant de poser le reste.
  function posesManquantes () {
    const items = host.getBot()?.inventory?.items() ?? []
    return (mission?.poses ?? []).map(p => {
      const voulues = p.quantite ?? 1
      const posees = mission.posesFaites?.[p.objet] ?? 0
      const enPoche = items.filter(i => i.name === p.objet).reduce((n, i) => n + i.count, 0)
      return { objet: p.objet, voulues, posees, enPoche, manque: Math.max(0, voulues - posees - enPoche) }
    }).filter(p => p.posees < p.voulues)
  }

  function outilManquant (bot) {
    if (!mission || mission.fabricationCible || !['construction', 'recolte'].includes(mission.kind) ||
      mission.supply !== 'harvest') return null
    const name = ressource(mission.resource)?.blocks?.[0]
    const tools = name ? bot.registry?.blocksByName?.[name]?.harvestTools : null
    if (!tools || Object.keys(tools).length === 0) return null
    const ids = Object.keys(tools).map(Number)
    const items = bot.inventory?.items() ?? []
    if (items.some(item => ids.includes(item.type))) return null
    // Chantier dont le materiau en poche suffit (pierre donnee) : pas d outil.
    if (mission.kind === 'construction') {
      const stock = items.filter(i => mission.buildMatch?.test(i.name)).reduce((n, i) => n + i.count, 0)
      if (stock > 0 && stock >= (mission.plan ? buildProgress().left : 1)) return null
    }
    const noms = ids.map(id => bot.registry?.items?.[id]?.name).filter(Boolean)
    return noms.sort((a, b) => TOOL_TIERS.indexOf(a.split('_')[0]) - TOOL_TIERS.indexOf(b.split('_')[0]))[0] ?? null
  }

  // `demande` : objet et manque nommes par le modele (`obtenir {objet,
  // quantite}`), a la place de la cible de la mission.
  function acquisition (demande = mission?.demandeObtenir ?? null) {
    // Interrupteur A/B `solveur` : coupe, la mission retombe sur la seule
    // matiere du brief et le modele remonte seul la chaine.
    if (!mission || !featureOn('solveur')) return null
    const bot = host.getBot()
    if (!bot?.entity) return null
    // Cible du plan : l objet a fabriquer, sinon l outil qu exige la matiere
    // de la mission (le plan disparait des qu il est en poche).
    // Puis le premier objet a poser qui manque en poche (A/B `poser`).
    const aPoser = demande ?? (mission.fabricationCible || outilManquant(bot) ? null : posesManquantes().find(p => p.manque > 0))
    const cible = demande?.objet ?? mission.fabricationCible ?? outilManquant(bot) ?? aPoser?.objet
    if (!cible) return null
    const registry = craft.getDataset(bot)
    if (!registry?.itemsByName) return null
    const inv = craft.inventoryMap(bot)
    const now = Date.now()
    const cache = mission.acquisition
    let tableNearby = cache?.tableNearby ?? false
    let furnaceNearby = cache?.furnaceNearby ?? false
    if (!cache || now - cache.tableAt > 2000) {
      const tableId = bot.registry?.blocksByName?.crafting_table?.id
      // Meme rayon que craft.ensureTable : un etabli pose plus loin reste utilisable.
      tableNearby = Boolean(tableId && craft.placedTable(bot))
      // Four pose (meme rayon que craft.ensureFurnace) : sans lui, le plan
      // redemandait 8 pierres et un four neuf (iron-pickaxe 453d7f4).
      furnaceNearby = Boolean(craft.furnaceBlock(bot))
    }
    // Essences a preferer (acquire-plan `prefer`) : celles deja en poche, puis
    // le bois visible. Sans elles, le plan hesitait entre chene et bouleau
    // d un appel a l autre (craft/furnace 212ccac : « recolter 2 oak_log »
    // pres d un bouleau, planches de bouleau en poche).
    const prefer = []
    for (const name of Object.keys(inv)) {
      const m = /^([a-z_]+?)_(?:log|planks|wood)$/.exec(name)
      if (m) prefer.push(`${m[1]}_log`, `${m[1]}_planks`)
    }
    if (!cache || now - cache.tableAt > 2000) {
      try {
        // Ids (tri rapide par palette), jamais une fonction : tout le rayon
        // serait parcouru toutes les 2 s.
        const logIds = Object.values(bot.registry?.blocksByName ?? {}).filter(b => /_log$/.test(b.name)).map(b => b.id)
        const seen = logIds.length ? bot.findBlock({ matching: logIds, maxDistance: SEARCH_RADIUS }) : null
        if (seen) mission.essenceVue = seen.name
      } catch (_) { /* chunk absent */ }
    }
    if (mission.essenceVue) prefer.push(mission.essenceVue, mission.essenceVue.replace(/_log$/, '_planks'))
    const key = JSON.stringify([cible, mission.fabricationQuantite, aPoser?.manque ?? null, inv, tableNearby, furnaceNearby, prefer])
    if (cache?.key === key) return cache.plan
    // Alias FR (pioche, hache...) : le candidat au plan le plus court.
    const alias = craft.TARGETS[cible]
    const candidates = alias ? alias.resolve(bot) : [cible]
    const wanted = !demande && mission.fabricationCible ? Math.max(1, (mission.fabricationQuantite ?? 1) - fabricationProduced()) : (aPoser?.manque ?? 1)
    let best = null
    for (const target of candidates) {
      let plan
      try {
        plan = acquirePlan.planAcquire({ registry, target, count: wanted, inventory: inv, resources: skills.RESOURCES, tableNearby, furnaceNearby, prefer })
      } catch (_) { continue }
      if (!best || (plan.ok && !best.ok) || (plan.ok === best.ok && plan.etapes.length < best.etapes.length)) best = plan
    }
    mission.acquisition = { key, plan: best, tableNearby, furnaceNearby, tableAt: cache && now - cache.tableAt <= 2000 ? cache.tableAt : now }
    // Trace a chaque changement : sans elle, un echec de fabrication ne dit
    // pas ce que le solveur a montre au modele (craft/furnace 89fa489 :
    // « il manque bois et etabli » avec etabli pose, cause illisible).
    if (best) console.log(`[mission] solveur (etabli proche : ${tableNearby ? 'oui' : 'non'}, four : ${furnaceNearby ? 'oui' : 'non'}) : ${acquirePlan.describe(best, 4).join(' ; ') || 'rien a faire'}${best.bloque.length ? ` ; bloque : ${best.bloque.map(b => b.objet).join(', ')}` : ''}`)
    return best
  }

  // Matiere a recolter maintenant : en fabrication, celle de la premiere
  // recolte du plan (bois, puis pierre pour une pioche en pierre) ; sinon la
  // matiere du brief.
  // Premiere recolte du plan dont la matiere est EN VUE ; sinon la premiere.
  // Sans ce choix, un plan « 3 fer puis 7 pierre » restait sur le fer invisible
  // alors que la pierre du four etait a cote (craft/iron-pickaxe 66d7caf :
  // 2/3 fer, puis errance jusqu au plafond). Memorise 1 s (appel frequent).
  let harvestMemo = null
  // A harvest is feasible unless its tool is crafted earlier in the plan.
  function recolteFaisable (toutes, s, i) {
    return !s.outil || !toutes.slice(0, i).some(e => e.op === 'fabriquer' && e.objet === s.outil)
  }
  // The plan's harvests all wait for a tool still to craft: harvesting now
  // yields nothing (craft/iron-pickaxe 7b01683: wood done, stone asked before
  // the wooden pickaxe, « stone ne lache rien sans pioche »).
  function recolteEnAttenteOutil () {
    const toutes = acquisition()?.etapes ?? []
    const recoltes = toutes.map((s, i) => [s, i]).filter(([s]) => s.op === 'recolter' && s.matiere)
    if (recoltes.length === 0 || recoltes.some(([s, i]) => recolteFaisable(toutes, s, i))) return null
    return recoltes[0][0]
  }
  function harvestResource () {
    if (!mission) return null
    // `recolter` fige sa matiere le temps de l action : le choix « premiere
    // recolte en vue » pouvait basculer en cours de route (fer puis pierre),
    // et le compte « 5/3 » melangeait deux matieres (iron-pickaxe 45ee8cf).
    if (mission.matiereFigee) return mission.matiereFigee
    // A tree in progress comes first, whatever the plan needs next.
    if (arbreInacheve()) return 'bois'
    // A harvest whose tool the plan still has to craft before it cannot yield
    // yet (craft/iron-pickaxe e6e8328: iron in view, stone pickaxe planned
    // first, « iron_ore ne lache rien sans pioche »).
    const toutes = acquisition()?.etapes ?? []
    const faisable = (s, i) => recolteFaisable(toutes, s, i)
    const recoltes = toutes.filter(s => s.op === 'recolter' && s.matiere)
    const etapes = toutes.filter((s, i) => s.op === 'recolter' && s.matiere && faisable(s, i))
    if (etapes.length === 0) return recoltes[0]?.matiere ?? mission.resource
    if (etapes.length === 1) return etapes[0].matiere
    const cle = etapes.map(s => s.matiere).join('|')
    if (harvestMemo && harvestMemo.mission === mission && harvestMemo.cle === cle && Date.now() - harvestMemo.at < 1000) {
      return harvestMemo.valeur
    }
    let valeur = etapes[0].matiere
    for (const s of etapes) {
      let vu = null
      try { vu = findTargetBlock(s.matiere, { anyHeight: true }) } catch (_) { vu = null }
      if (vu) { valeur = s.matiere; break }
    }
    harvestMemo = { mission, cle, valeur, at: Date.now() }
    return valeur
  }

  // Construction dont le materiau en poche couvre deja les blocs restants :
  // chercher ou recolter encore serait une errance. Rend un texte, ou null.
  function materiauSuffisant () {
    if (mission?.kind !== 'construction' || !mission.plan) return null
    const reste = buildProgress().left
    const bot = host.getBot()
    const stock = (bot?.inventory?.items() ?? []).filter(i => mission.buildMatch?.test(i.name)).reduce((n, i) => n + i.count, 0)
    return reste > 0 && stock >= reste ? `materiau en poche suffisant (${stock} pour ${reste} bloc(s) restants) : construire` : null
  }

  // Fabrication dont le plan complet n a plus rien a recolter (tout est en
  // poche) : recolter ou explorer la matiere du brief serait une errance
  // (craft/iron-pickaxe 68ea147 : 3 minerais en poche, four fait, plan
  // « cuire puis fabriquer », le modele cherchait encore du minerai 5 min).
  // Rend l etape suivante a faire, ou null.
  function rienARecolter () {
    const plan = acquisition()
    if (!plan?.ok || !plan.etapes?.length) return null
    if (plan.etapes.some(e => e.op === 'recolter')) return null
    return acquirePlan.describe(plan, 1)[0] ?? null
  }

  // The solver's next step, done in place of a step with nothing left to do
  // (craft/iron-pickaxe 76553e7: ingots already smelted, « cuire » asked
  // twice then « explorer », « recolter », 90 s and five planner calls before
  // « fabriquer iron_pickaxe »). Only a craft or a smelt: a harvest stays the
  // model's call. Returns the action result, or null.
  async function etapeSuivanteAuLieu (prefixe) {
    const suivante = acquisition()?.etapes?.[0]
    if (suivante?.op !== 'fabriquer' && suivante?.op !== 'cuire') return null
    const r = await ACTIONS[suivante.op](null, { objet: suivante.objet, quantite: suivante.quantite })
    return { ...r, resultat: `${prefixe}, etape suivante du plan faite a la place : ${r.resultat}` }
  }

  // Le meilleur bloc de la matiere visee a travailler : ni le bloc qui porte le
  // bot, ni un bloc situe trop bas sous lui, ni un bloc trop haut pour etre
  // atteint. Parmi les candidats, on preferre TOUJOURS un bloc reellement
  // cassable (a portee), et parmi eux le plus BAS : le pied du tronc, pas une
  // buche en hauteur. Viser le bloc le plus proche en 3D faisait choisir une
  // buche haute, hors de portee verticale — le bot avancait vers un bloc qu il
  // ne pourrait jamais casser, le depassait, revenait : l oscillation observee
  // en jeu entre 2,7 et 10,8 blocs de l arbre.
  async function dropFromLeaves (item) {
    const bot = host.getBot()
    if (harvestResource() !== 'bois' || !bot?.entity) return false
    let dropped = null
    try { dropped = item.getDroppedItem?.() } catch (_) {}
    if (!dropped || !TREE_LOG.test(dropped.name)) return false
    const support = bot.blockAt(item.position.offset(0, -0.2, 0))
    // Feuilles, ou colonne d echafaudage du bot (vu sur trees/tall : derniere
    // buche posee au sommet d un ancien pilier, sans chemin depuis l autre).
    // Jamais la colonne ou le bot se tient : la casser le ferait chuter (vu :
    // degats sur trees/tall et trees/bent au premier essai de ce geste).
    const pieds = bot.entity.position.floored()
    const colonne = support && (PILER_DIRT.test(support.name) || /_planks$/.test(support.name)) && isPillarBlock(bot, support) &&
      !(support.position.x === pieds.x && support.position.z === pieds.z)
    if (!support || !(/_leaves$/.test(support.name) || colonne)) return false
    const center = support.position.offset(0.5, 0.5, 0.5)
    if (bot.entity.position.offset(0, 1.62, 0).distanceTo(center) > REACH) {
      const nav = await host.navigateToPosition(center, {
        signal: mission.navigationAbort.signal, __owner: stepToken, interaction: true, distanceBudget: 16
      })
      if (!nav.reached || mission.cancelled) return false
    }
    const live = host.getBot()
    try {
      await withTimeout(live.lookAt(center, true), 4000, 'visee trop longue')
      await withTimeout(live.dig(support), 6000, 'creusage trop long')
    } catch (_) {
      return false
    }
    if (!colonne) mission.leavesCleared = (mission.leavesCleared ?? 0) + 1
    await sleep(600)
    // L objet retombe sur le bloc suivant de la colonne : recommencer tant que
    // c est encore de l echafaudage (jamais le sol naturel, jamais un puits).
    if (colonne && item.isValid !== false) await dropFromLeaves(item)
    return true
  }

  // Niveau ou l on se tient au pied de `cible` : la plus basse buche de sa
  // colonne (un arbre pousse depuis le sol).
  function standingLevel (cible) {
    const bot = host.getBot()
    let y = cible.position.y
    for (let i = 0; i < 16; i += 1) {
      const below = bot.blockAt(new Vec3(cible.position.x, y - 1, cible.position.z))
      if (!below || !TREE_LOG.test(below.name)) break
      y -= 1
    }
    return y
  }

  // Prend de la terre dans le relief voisin (a hauteur des pieds et au-dessus,
  // jamais sous les pieds) jusqu a en avoir `besoin` en stock d echafaudage.
  // `epargne(x, z)` exclut des colonnes a garder intactes (le rebord vise).
  async function gatherDirt (besoin, epargne = () => false, { sol = false, budgetMs = Infinity } = {}) {
    const bot = host.getBot()
    let creuses = 0
    const deadline = Date.now() + budgetMs
    for (let i = 0; i < besoin + 4 && scaffoldingStock(bot).total < besoin && !mission.cancelled && Date.now() < deadline; i += 1) {
      const here = bot.entity.position
      const feetY = Math.floor(here.y + 0.01)
      const eye = here.offset(0, 1.62, 0)
      // Perche sur son pilier : le sol est deux niveaux plus bas (vu sur
      // trees/tall : rien a creuser a -1, piler echouait faute de terre).
      const sous = bot.blockAt(here.offset(0, -0.5, 0))
      const perche = sol && Boolean(sous) && (PILER_DIRT.test(sous.name) || /_planks$/.test(sous.name)) && isPillarBlock(bot, sous)
      let best = null
      for (let dx = -3; dx <= 3; dx += 1) {
        for (let dz = -3; dz <= 3; dz += 1) {
          for (let dy = sol ? (perche ? -2 : -1) : 0; dy <= 2; dy += 1) {
            // Le sol n est pris qu a cote du bot, jamais sous ses pieds.
            if (dy < 0 && Math.abs(dx) + Math.abs(dz) < 2) continue
            const block = bot.blockAt(new Vec3(Math.floor(here.x) + dx, feetY + dy, Math.floor(here.z) + dz))
            if (!block || !/^(dirt|grass_block|coarse_dirt)$/.test(block.name)) continue
            if (epargne(block.position.x, block.position.z)) continue
            const d = eye.distanceTo(block.position.offset(0.5, 0.5, 0.5))
            if (d > REACH) continue
            if (!best || d < best.d) best = { block, d }
          }
        }
      }
      if (!best) break
      try {
        await withTimeout(bot.lookAt(best.block.position.offset(0.5, 0.5, 0.5), true), 4000, 'visee trop longue')
        await withTimeout(bot.dig(best.block), 6000, 'creusage trop long')
      } catch (_) {
        break
      }
      creuses += 1
      await sleep(500)
    }
    return creuses
  }

  // Sortie par le haut vers une cible plus haute de 2 a CLIMB_MAX blocs (fond
  // de trou, puits, pied de falaise, bot enterre) : choisit une case au pied
  // d une paroi dont le haut est praticable, du cote de la cible ; la colonne
  // au-dessus peut etre de la terre (creusee en montant). Puis monte niveau par
  // niveau : creuse ce qui gene au-dessus de la tete, pose un bloc sous soi.
  // La terre creusee sert d echafaudage ; le reste est pris dans les parois.
  const CLIMB_MAX = config.positiveIntOrThrow(process.env.MISSION_CLIMB_MAX, 12, 'MISSION_CLIMB_MAX')
  const TERRE_NATURELLE = /^(dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium|sand|red_sand|gravel|clay|[a-z_]*_leaves)$/
  async function climbOutToward (target, owner) {
    const bot = host.getBot()
    if (!bot?.entity || !target) return null
    const feetY = Math.floor(bot.entity.position.y + 0.01)
    const hauteur = Math.floor(target.y + 0.01) - feetY
    if (hauteur < 2 || hauteur > CLIMB_MAX) return null
    const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
    const libre = (x, y, z) => { const b = at(x, y, z); return !!b && b.boundingBox === 'empty' && !/water|lava/.test(b.name) }
    const terre = (x, y, z) => { const b = at(x, y, z); return !!b && TERRE_NATURELLE.test(b.name) }
    const here = bot.entity.position.floored()
    let best = null
    for (let dx = -8; dx <= 8; dx += 1) {
      for (let dz = -8; dz <= 8; dz += 1) {
        const x = here.x + dx
        const z = here.z + dz
        if (!estSolide(at(x, feetY - 1, z)) || !libre(x, feetY, z) || !libre(x, feetY + 1, z)) continue
        let aCreuser = 0
        let colonne = true
        for (let y = feetY + 2; y <= feetY + hauteur + 1; y += 1) {
          if (libre(x, y, z)) continue
          if (terre(x, y, z)) aCreuser += 1
          else colonne = false
        }
        if (!colonne) continue
        for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (!estSolide(at(x + ox, feetY + hauteur - 1, z + oz))) continue
          if (!libre(x + ox, feetY + hauteur, z + oz) || !libre(x + ox, feetY + hauteur + 1, z + oz)) continue
          const score = Math.hypot(x + ox + 0.5 - target.x, z + oz + 0.5 - target.z) + 0.5 * Math.hypot(dx, dz) + aCreuser
          if (!best || score < best.score) best = { x, z, rx: x + ox, rz: z + oz, score }
        }
      }
    }
    if (!best) {
      console.log(`[mission] sortie par le haut : aucun poste contre une paroi de ${hauteur}`)
      return null
    }
    const poste = new Vec3(best.x + 0.5, feetY, best.z + 0.5)
    const auPoste = () => {
      const p = host.getBot().entity.position
      return Math.floor(p.x) === best.x && Math.floor(p.z) === best.z
    }
    const rejoindrePoste = async () => {
      if (auPoste()) return true
      await host.navigateToPosition(poste, { signal: mission.navigationAbort.signal, __owner: owner, radius: 0.4, distanceBudget: 24 })
      return auPoste()
    }
    if (!await rejoindrePoste()) {
      console.log('[mission] sortie par le haut : poste contre la paroi injoignable')
      return null
    }
    const epargne = (x, z) => (x === best.rx && z === best.rz) || (x === best.x && z === best.z)
    let creuses = await gatherDirt(Math.min(hauteur, 4), epargne)
    await collectScaffoldDrops(owner)
    if (!await rejoindrePoste() || mission.cancelled) return null
    let montes = 0
    for (let niveau = 0; niveau < hauteur && !mission.cancelled; niveau += 1) {
      const live = host.getBot()
      const pieds = live.entity.position.floored()
      for (const dy of [2, 1]) {
        const b = live.blockAt(pieds.offset(0, dy, 0))
        if (!b || b.boundingBox === 'empty') continue
        if (!TERRE_NATURELLE.test(b.name)) return null
        try {
          await withTimeout(live.lookAt(b.position.offset(0.5, 0.5, 0.5), true), 4000, 'visee trop longue')
          await withTimeout(live.dig(b), 8000, 'creusage trop long')
          creuses += 1
        } catch (_) {
          return null
        }
      }
      await sleep(300)
      if (scaffoldingStock(live).total < 1) {
        creuses += await gatherDirt(Math.min(hauteur - niveau, 3), epargne)
        if (scaffoldingStock(host.getBot()).total < 1) {
          console.log(`[mission] sortie par le haut : plus de terre apres ${montes} niveau(x)`)
          return null
        }
      }
      let pile = await ACTIONS.piler(null, { hauteur: 1, interne: true })
      if (pile?.echec && /atterrissage/.test(pile.resultat || '')) {
        await sleep(400)
        pile = await ACTIONS.piler(null, { hauteur: 1, interne: true })
      }
      if (pile?.echec) {
        console.log(`[mission] sortie par le haut : pilier refuse au niveau ${niveau} (${pile.resultat})`)
        return montes > 0 ? `${montes} niveau(x) montes sur ${hauteur}` : null
      }
      montes += 1
    }
    return `${creuses} bloc(s) de terre creuses, monte de ${montes} contre la paroi`
  }

  // Eau, lave ou vide au niveau du sol sur la ligne droite (axe dominant)
  // vers `target`, a 12 cases au plus : un pont est necessaire.
  function gapToward (target, { liquidOnly = false } = {}) {
    const bot = host.getBot()
    if (!bot?.entity || !target) return false
    const start = bot.entity.position.floored()
    const ddx = target.x - (start.x + 0.5)
    const ddz = target.z - (start.z + 0.5)
    const dir = Math.abs(ddx) >= Math.abs(ddz) ? new Vec3(Math.sign(ddx), 0, 0) : new Vec3(0, 0, Math.sign(ddz))
    if (dir.x === 0 && dir.z === 0) return false
    const steps = Math.min(12, Math.floor(Math.max(Math.abs(ddx), Math.abs(ddz))))
    const liquide = b => !!b && /water|lava/.test(b.name)
    const vide = b => !b || (b.boundingBox === 'empty' && !liquide(b))
    // Une cible plus basse se rejoint en descendant : seul un liquide est un
    // obstacle (vu : pont suspendu construit depuis le haut d une falaise).
    const plusBas = target.y < start.y - 1
    for (let i = 1; i <= steps; i += 1) {
      const p = start.plus(dir.scaled(i))
      const sol = bot.blockAt(p.offset(0, -1, 0))
      if (liquide(sol)) return true
      if (!liquidOnly && !plusBas && vide(sol) && vide(bot.blockAt(p.offset(0, -2, 0))) && vide(bot.blockAt(p.offset(0, -3, 0)))) return true
    }
    return false
  }

  // Pont de terre en ligne droite vers `target` (axe dominant) : avance sur le
  // sol ferme, et pose un bloc devant soi, au niveau du sol, a chaque case
  // d eau, de lave ou de vide. S arrete a la terre ferme de l autre cote.
  // Rend un resume, ou null si rien n a ete franchi.
  async function bridgeToward (target, owner) {
    const bot = host.getBot()
    if (!bot?.entity || !target) return null
    const start = bot.entity.position.floored()
    const ddx = target.x - (start.x + 0.5)
    const ddz = target.z - (start.z + 0.5)
    const dir = Math.abs(ddx) >= Math.abs(ddz) ? new Vec3(Math.sign(ddx), 0, 0) : new Vec3(0, 0, Math.sign(ddz))
    if (dir.x === 0 && dir.z === 0) return null
    const trou = b => !b || b.boundingBox === 'empty' || /water|lava/.test(b.name)
    if (!gapToward(target)) return null
    let poses = 0
    let pas = 0
    for (let i = 0; i < 24 && !mission.cancelled; i += 1) {
      const live = host.getBot()
      const here = live.entity.position.floored()
      const next = here.plus(dir)
      const sol = live.blockAt(next.offset(0, -1, 0))
      if (!trou(live.blockAt(next)) || !trou(live.blockAt(next.offset(0, 1, 0)))) break
      if (trou(sol)) {
        if (poses > 0 && Math.hypot(next.x + 0.5 - target.x, next.z + 0.5 - target.z) < 1) break
        const stock = scaffoldingStock(live).materiaux[0]
        const owned = stock && live.inventory.items().find(item => item.name === stock.nom)
        if (!owned) break
        try {
          if (!live.heldItem || live.heldItem.name !== owned.name) await withTimeout(live.equip(owned, 'hand'), 4000, 'equipement trop long')
          const appui = live.blockAt(here.offset(0, -1, 0))
          await withTimeout(live.lookAt(next.offset(0.5, -0.5, 0.5), true), 3000, 'visee trop longue')
          await withTimeout(live.placeBlock(appui, dir), 5000, 'pose trop longue')
        } catch (_) {}
        const posee = live.blockAt(next.offset(0, -1, 0))
        if (trou(posee)) break
        poses += 1
      } else if (poses > 0) {
        // Terre ferme de l autre cote : le trajet normal reprend.
        break
      }
      await host.navigateToPosition(next.offset(0.5, 0, 0.5), { signal: mission.navigationAbort.signal, __owner: owner, radius: 0.4, distanceBudget: 3 })
      const now = host.getBot().entity.position.floored()
      if (now.x !== next.x || now.z !== next.z) break
      pas += 1
    }
    return poses > 0 ? `${poses} bloc(s) poses, ${pas} pas` : null
  }

  // Par tours : terre prise derriere la tete de pont (un trou au bord de l eau
  // agrandirait la riviere), retour a la tete de pont, blocs poses tant qu il
  // en reste ; jusqu a l autre rive. Rend vrai si plus aucun trou ne barre.
  async function bridgeRounds (goal, owner, { liquidOnly = false } = {}) {
    for (let tour = 0; tour < 4 && gapToward(goal, { liquidOnly }) && !mission?.cancelled; tour += 1) {
      const tete = host.getBot().entity.position.clone()
      if (scaffoldingStock(host.getBot()).total < 3) {
        // Terre prise derriere soi seulement : un trou au bord de l eau se
        // remplirait et agrandirait la riviere.
        const vx = goal.x - tete.x
        const vz = goal.z - tete.z
        const derriere = (x, z) => (x + 0.5 - tete.x) * vx + (z + 0.5 - tete.z) * vz > -1.5 * Math.hypot(vx, vz)
        const pris = await gatherDirt(6, derriere, { sol: true })
        await collectScaffoldDrops(owner)
        await host.navigateToPosition(tete, { signal: mission.navigationAbort.signal, __owner: owner, radius: 0.5, distanceBudget: 12 })
        console.log(`[mission] pont : ${pris} bloc(s) de terre creuses, stock ${scaffoldingStock(host.getBot()).total}`)
      }
      if (scaffoldingStock(host.getBot()).total < 1) break
      const bridged = await bridgeToward(goal, owner)
      console.log(`[mission] pont : ${bridged ?? 'rien pose'}`)
      if (!bridged) break
    }
    return !gapToward(goal, { liquidOnly })
  }

  // Ramasse la terre tombee pres du bot (un bloc creuse dans une paroi lache
  // son objet hors du rayon de collecte) : trajet de ramassage vers chacun.
  async function collectScaffoldDrops (owner, { budgetMs = Infinity, pattern = PILER_DIRT } = {}) {
    if (!pattern) return
    const deadline = Date.now() + budgetMs
    for (let i = 0; i < 8 && !mission.cancelled && Date.now() < deadline; i += 1) {
      const bot = host.getBot()
      const here = bot.entity.position
      const drop = Object.values(bot.entities).find(e => {
        if (e.name !== 'item' || !e.position || e.position.distanceTo(here) > 6) return false
        let item = null
        try { item = e.getDroppedItem?.() } catch (_) {}
        return item && pattern.test(item.name)
      })
      if (!drop) return
      const nav = await host.navigateToPosition(drop.position, {
        signal: mission.navigationAbort.signal, __owner: owner, pickup: true, radius: 1.2, distanceBudget: 10,
        ...(Number.isFinite(budgetMs) ? { timeoutMs: Math.max(1000, Math.min(8000, deadline - Date.now())) } : {})
      })
      await sleep(400)
      if (!nav?.reached && drop.isValid !== false) {
        if (!await stepOnto(drop)) return
      }
    }
  }

  // Forme du chantier, une fois par mission : { compiled } pour un plan libre
  // valide, {} pour la boite (demandee, ou repli apres deux plans refuses).
  async function designShape () {
    if (mission.shape) return mission.shape
    // Interrupteur A/B `plans` : coupe, toujours la boite du code. Un cerveau
    // sans conception de plan (mission scriptee, banc de competences) aussi :
    // la forme est un choix du modele, jamais un appel cache.
    const cerveau = brain(mission)
    if (!featureOn('plans') || typeof cerveau.designBlueprint !== 'function') {
      mission.shape = {}
      return mission.shape
    }
    let erreurs = []
    const dims = build.parseDimensions(mission.objective)
    // Materiau de construction en poche : le plan doit y tenir, sauf si le
    // joueur a fixe les trois dimensions (il faudra alors en recolter).
    const bot = host.getBot()
    const stock = (bot?.inventory?.items() ?? []).filter(i => mission.buildMatch?.test(i.name)).reduce((n, i) => n + i.count, 0)
    const dimensionsImposees = /trois/.test(dims.source)
    for (let essai = 0; essai < 3 && cerveau.isEnabled?.() !== false; essai++) {
      let bp = null
      try {
        bp = await cerveau.designBlueprint({
          objectif: mission.objective,
          // Une seule dimension (« tour de 6 blocs de haut ») n est pas un
          // cube : parseDimensions la recopie sur les trois axes (vu : tour
          // 6x6x6 de 152 blocs pour 64 de terre). Le modele lit la phrase.
          dimensions_lues: /trois|deux/.test(dims.source) ? { largeur: dims.width, profondeur: dims.depth, hauteur: dims.height }
            : dims.nommees ? Object.fromEntries(Object.entries(dims.nommees).map(([k, v]) => [{ width: 'largeur', depth: 'profondeur', height: 'hauteur' }[k], v]))
              : null,
          blocs_en_stock: stock,
          matiere: mission.resource,
          porte_demandee: Boolean(mission.wantsDoor),
          erreurs_precedentes: erreurs
        }, { signal: mission.navigationAbort?.signal })
      } catch (err) {
        console.warn(`[mission] conception du plan en echec : ${err.message}`)
        break
      }
      if (!bp || bp.forme !== 'libre') break
      const compiled = build.compileBlueprint(bp)
      if (compiled.ok && stock > 0 && !dimensionsImposees && compiled.cells.length > stock) {
        compiled.ok = false
        compiled.errors = [`${compiled.cells.length} blocs pour ${stock} en stock : fais une forme qui tient dans le stock`]
      }
      if (compiled.ok && mission.wantsDoor && !compiled.door) {
        compiled.ok = false
        compiled.errors = ['porte demandee : donne "porte": [x, z] sur le bord']
      }
      if (compiled.ok) {
        const retires = compiled.retires?.length
          ? ` ; ${compiled.retires.length} bloc(s) hors de portee retire(s) (ex : [${compiled.retires[0].join(',')}], forme ouverte a cet endroit)`
          : ''
        console.log(`[mission] plan libre ${compiled.width}x${compiled.depth}x${compiled.height}, ${compiled.cells.length} blocs${retires}`)
        mission.shape = { compiled, note: retires ? retires.slice(3) : undefined }
        return mission.shape
      }
      erreurs = compiled.errors
      console.log(`[mission] plan libre refuse : ${erreurs.join(' ; ')}`)
    }
    mission.shape = erreurs.length ? { note: `plan libre refuse (${erreurs[0]}), boite a la place` } : {}
    // La boite de repli tient dans le stock quand le joueur n a pas impose
    // les trois dimensions : hauteur puis largeur/profondeur reduites (>= 3).
    // Hauteur jamais sous 4 (plancher + deux blocs d air + toit) : a 3, le
    // vide interieur fait un bloc, le bot s y retrouve le toit dans la tete
    // et ne peut plus ni en sortir ni poser la derniere case (build/windows
    // 33abea6 : 63/64, « poste de tir injoignable » jusqu au plafond).
    if (stock > 0 && !dimensionsImposees) {
      const box = { ...mission.dimensions }
      const minHeight = Math.min(4, box.height)
      const count = d => build.planHouse({ origin: new Vec3(0, 0, 0), ...d }).blocks.length
      while (count(box) > stock && (box.height > minHeight || box.width > 3 || box.depth > 3)) {
        if (box.height > minHeight) box.height -= 1
        else if (box.width >= box.depth && box.width > 3) box.width -= 1
        else box.depth -= 1
      }
      if (box.height !== mission.dimensions.height || box.width !== mission.dimensions.width || box.depth !== mission.dimensions.depth) {
        mission.shape.box = box
        mission.shape.note = `${mission.shape.note ?? 'boite'} reduite a ${box.width}x${box.depth}x${box.height} pour tenir dans ${stock} blocs`
      }
    }
    return mission.shape
  }

  // Reflexes (reflexes.js, modes de Mindcraft) : entre deux etapes, dans le
  // slot de l etape, sans le modele. Danger (bloc qui tombe, feu/lave, tete
  // prise), monstre, joueur colle, objets au sol tout pres. Chaque geste est
  // journalise dans mission.reflexes et servi au modele (reflexes_recents).
  async function reflexPass (owner, lastAction) {
    const bot = host.getBot()
    if (!mission || mission.cancelled || !bot?.entity || lastAction === 'terminer') return
    // Interrupteur A/B `reflexes`.
    if (!featureOn('reflexes')) return
    const myMission = mission
    const note = (reflexe, detail) => {
      myMission.reflexes = (myMission.reflexes ?? []).concat({ apres_etape: myMission.steps + 1, reflexe, detail }).slice(-6)
      console.log(`[reflexe] ${reflexe} : ${detail}`)
    }
    const move = (target, timeoutMs) => host.navigateToPosition(target, {
      signal: myMission.navigationAbort?.signal, __owner: owner, radius: 1.2, distanceBudget: 14, timeoutMs
    })
    try {
      const danger = reflexes.detectDanger(bot)
      if (danger?.type === 'etouffement') {
        const head = bot.blockAt(bot.entity.position.floored().offset(0, 1, 0))
        if (head && head.diggable !== false) {
          await craft.equipForBlock(bot, head).catch(() => {})
          await withTimeout(bot.dig(head), 4000, 'creusage trop long')
          note('degagement', `tete prise dans ${danger.bloc} : bloc casse`)
        }
      } else if (danger) {
        const r = await move(reflexes.awayFrom(bot.entity.position, danger.source, 3), 4000)
        note('mise_a_l_abri', `${danger.type} (${danger.bloc}) : ${r?.reached ? 'ecarte de 3 blocs' : 'ecart tente'}`)
      }
      if (myMission.cancelled) return
      const hostile = reflexes.detectHostile(bot)
      if (hostile) {
        const r = await move(reflexes.awayFrom(bot.entity.position, hostile.entity.position, 10), 5000)
        note('fuite', `${hostile.entity.name ?? 'monstre'} a ${hostile.distance.toFixed(1)} bloc(s) : ${r?.reached ? 'eloigne' : 'eloignement tente'}`)
      }
      if (myMission.cancelled || myMission.kind === 'geste') return
      const crowd = reflexes.detectCrowding(bot)
      if (crowd) {
        await move(reflexes.awayFrom(bot.entity.position, crowd.position, 1.5), 2000)
        note('place', `${crowd.joueur} colle au bot : un pas de cote`)
      }
      // Jamais apres un don ni pendant une livraison : le bot reprendrait
      // ce qu il vient de poser aux pieds du joueur.
      // Ni apres ramasser/recolter : ils viennent de tenter ces memes objets.
      if (myMission.cancelled || ['donner', 'ramasser', 'recolter'].includes(lastAction) ||
        deliveryLedgersFor(myMission).length > 0) return
      // Objet deja tente sans succes : ignore ensuite (pas 4 s par etape).
      myMission.reflexSkip = myMission.reflexSkip ?? new Set()
      const drops = reflexes.detectDrops(bot).filter(e => !myMission.reflexSkip.has(e.id)).slice(0, 3)
      if (drops.length > 0) {
        const count = () => bot.inventory.items().reduce((n, it) => n + it.count, 0)
        const before = count()
        const deadline = Date.now() + 4000
        for (const drop of drops) {
          if (myMission.cancelled || Date.now() > deadline || drop.isValid === false) continue
          const nav = await host.navigateToPosition(drop.position, {
            signal: myMission.navigationAbort?.signal, __owner: owner, pickup: true, radius: 1.2, distanceBudget: 8,
            timeoutMs: Math.max(1000, Math.min(3000, deadline - Date.now()))
          })
          await sleep(300)
          if (!nav?.reached && drop.isValid !== false) await stepOnto(drop)
          if (drop.isValid !== false) myMission.reflexSkip.add(drop.id)
        }
        const gained = count() - before
        if (gained > 0) note('ramassage', `${gained} objet(s) au sol ramasse(s) a proximite`)
      }
    } catch (err) {
      console.warn(`[reflexe] ${err.message}`)
    }
  }

  // Monte d une hauteur H vers une cible posee sur un relief plus haut :
  // obtient H blocs de terre dans le relief voisin (jamais sous les pieds),
  // pile de H, puis laisse l approche normale finir a pied. Rend un resume ou
  // null si ce n est pas le cas (cible pas plus haute, pas assez de terre).
  async function climbToward (cible) {
    const bot = host.getBot()
    if (!bot?.entity || !cible) return null
    const feetY = Math.floor(bot.entity.position.y + 0.01)
    const vraiSol = b => b && b.boundingBox === 'block' && !/_leaves$|_log$|_wood$/.test(b.name)
    let pied = standingLevel(cible)
    // Seulement pour un arbre pose sur un relief : sous son pied, un vrai sol.
    // Une buche restee en l air (tronc coupe par le bas) n est pas une falaise
    // (vu sur trees/pillar : pilier de 5 construit sous elle, chute, degats) ;
    // mais si la colonne sous elle descend sur un relief plus haut que le bot
    // (haut de falaise), on monte sur ce relief, piler fera le reste
    // (terrain/plateau bdc903d : tronc coupe par le bas depuis un pilier, bot
    // redescendu ramasser, derniere buche jamais rejointe).
    if (!vraiSol(bot.blockAt(new Vec3(cible.position.x, pied - 1, cible.position.z)))) {
      let relief = null
      for (let y = pied - 2; y > feetY; y--) {
        const b = bot.blockAt(new Vec3(cible.position.x, y, cible.position.z))
        if (b && b.boundingBox === 'block') { relief = vraiSol(b) ? y + 1 : null; break }
      }
      if (relief === null) return null
      pied = relief
    }
    const hauteur = pied - feetY
    if (hauteur < 2 || hauteur > PILER_MAX) return null
    const creuses = await gatherDirt(hauteur)
    if (scaffoldingStock(bot).total < hauteur) return null
    const pile = await ACTIONS.piler(null, { hauteur, interne: true })
    if (pile?.echec) return `montee impossible : ${pile.resultat}`
    return `${creuses} bloc(s) de terre pris, pilier de ${hauteur}`
  }

  // Descend d un pilier pose par le bot : casse le bloc d echafaudage (dirt,
  // planches) sous ses pieds, attend l atterrissage, et recommence tant que
  // le bot est plus d un bloc et demi au-dessus de `targetY`. S arrete sur tout
  // autre bloc (sol naturel, feuilles) : jamais de puits.
  async function stepOnto (item) {
    const bot = host.getBot()
    if (!bot?.entity || !item?.position) return false
    const here = bot.entity.position
    if (Math.abs(item.position.y - here.y) > 0.6) return false
    const support = bot.blockAt(item.position.offset(0, -0.5, 0))
    if (!support || support.boundingBox !== 'block') return false
    try {
      await bot.lookAt(item.position.offset(0, 1.6, 0), true)
      bot.setControlState('forward', true)
      const until = Date.now() + 1500
      while (Date.now() < until && item.isValid !== false) {
        const p = host.getBot()?.entity?.position
        if (!p || Math.hypot(p.x - item.position.x, p.z - item.position.z) < 0.6) break
        await sleep(50)
      }
    } catch (_) {
      return false
    } finally {
      try { host.getBot()?.setControlState('forward', false) } catch (_) {}
    }
    await sleep(300)
    return true
  }

  // Colonne isolee : les quatre voisins du bloc porteur sont vides. C est ce
  // qui distingue un pilier pose par le bot d un sol naturel en terre, qu il
  // ne faut jamais creuser sous ses pieds.
  // Feuilles, buches et plantes ne sont pas un sol : un pilier monte contre
  // un tronc, dans la couronne, reste un pilier (vu en jeu : bot bloque en haut
  // d un pilier de planches entoure de feuilles, « parcours interrompu »).
  function isPillarBlock (bot, block) {
    return [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => {
      const side = bot.blockAt(block.position.offset(dx, 0, dz))
      return !side || side.boundingBox !== 'block' || /_leaves$|_log$|_wood$|_stem$/.test(side.name)
    })
  }

  // Perche sur sa propre colonne (pilier monte pour une buche haute) : rien a
  // poser autour (etabli, four), chantier injoignable a pied. Descente jusqu au
  // sol, colonne isolee seulement (composite 93a6f04 : 10 echecs d affilee).
  async function quitterPilier (raison) {
    const bot = host.getBot()
    const dessous = bot?.entity ? bot.blockAt(bot.entity.position.offset(0, -0.5, 0)) : null
    if (!dessous || !(PILER_DIRT.test(dessous.name) || /_planks$/.test(dessous.name)) || !isPillarBlock(bot, dessous)) return 0
    const n = await descendScaffold(-Infinity, { pillarOnly: true })
    if (n) console.log(`[mission] ${raison} : pilier defait avant (${n} bloc(s))`)
    return n
  }

  async function descendScaffold (targetY = -Infinity, { pillarOnly = false } = {}) {
    let removed = 0
    for (let i = 0; i < PILER_MAX + 2 && !mission.cancelled; i += 1) {
      const bot = host.getBot()
      if (!bot?.entity || bot.entity.position.y - targetY <= 1.5) break
      const below = bot.blockAt(bot.entity.position.offset(0, -0.5, 0))
      if (!below || !(PILER_DIRT.test(below.name) || /_planks$/.test(below.name))) break
      if (pillarOnly && !isPillarBlock(bot, below)) break
      // Chute d un bloc au plus : il faut un appui sous le bloc casse.
      const dessous = bot.blockAt(below.position.offset(0, -1, 0))
      if (!dessous || dessous.boundingBox !== 'block') break
      try {
        await withTimeout(bot.lookAt(below.position.offset(0.5, 0.5, 0.5), true), 4000, 'visee trop longue')
        await withTimeout(bot.dig(below), 6000, 'creusage trop long')
      } catch (_) {
        break
      }
      const until = Date.now() + 1500
      while (Date.now() < until && !(host.getBot()?.entity?.onGround && host.getBot().entity.position.y < below.position.y + 0.5)) {
        await sleep(50)
      }
      removed += 1
    }
    return removed
  }

  // Trajet vers un joueur ou une position : perche sur son propre pilier, le
  // navigateur refuse la chute (> 2 blocs) et repond no_path. On defait alors
  // le pilier (seulement une colonne isolee) puis on re-tente une fois.
  function playerPosition (username) {
    const p = host.getBot()?.players?.[username]?.entity?.position
    return p ? p.clone() : null
  }

  async function navWithDescent (call, { target = null, owner = null } = {}) {
    let result = await call()
    const bloque = !result?.reached && ['no_path', 'stuck', 'timeout'].includes(result?.code)
    if (bloque && !mission?.cancelled) {
      const removed = await descendScaffold(-Infinity, { pillarOnly: true })
      if (removed > 0) {
        console.log(`[mission] pilier defait (${removed} bloc(s)) avant de repartir`)
        result = await call()
      }
      // Toujours perche sur de l echafaudage : descente en creusant, chute de
      // deux blocs au plus, vers le sol juste sous le bot, puis nouvel essai.
      const bot = host.getBot()
      const under = bot?.entity ? bot.blockAt(bot.entity.position.offset(0, -0.5, 0)) : null
      if (!result?.reached && under && (PILER_DIRT.test(under.name) || /_planks$/.test(under.name)) &&
        isPillarBlock(bot, under) && typeof host.digToward === 'function' && !mission?.cancelled) {
        // Le sol est le premier bloc qui n est plus une colonne isolee
        // d echafaudage : la terre du sol (souvent de la dirt sous un pilier)
        // ne doit jamais etre creusee (vu : bot descendu dans le sol).
        let ground = under.position.y
        while (ground > under.position.y - 16) {
          const b = bot.blockAt(new Vec3(under.position.x, ground - 1, under.position.z))
          if (!b || b.boundingBox !== 'block') { ground -= 1; continue }
          if (!(PILER_DIRT.test(b.name) || /_planks$/.test(b.name)) || !isPillarBlock(bot, b)) break
          ground -= 1
        }
        const down = await host.digToward(new Vec3(bot.entity.position.x, ground, bot.entity.position.z),
          { signal: mission.navigationAbort.signal, range: 1.5, timeoutMs: 20000 })
        console.log(`[mission] descente creusee depuis l echafaudage : ${down.code}`)
        if (down.reached) result = await call()
      }
      // Cible plus haute (fond d un trou, pied d un mur) : pilier contre la
      // paroi jusqu au rebord, puis nouvel essai a pied.
      const goal = typeof target === 'function' ? target() : target
      if (!result?.reached && goal && !mission?.cancelled) {
        const climbed = await climbOutToward(goal, owner)
        if (climbed) {
          console.log(`[mission] sortie par le haut : ${climbed}`)
          result = await call()
        }
      }
      // Dernier recours : le pathfinder qui creuse (escalier, tunnel, tour 1x1),
      // chute de deux blocs au plus, sans toucher a ce qu un joueur a construit.
      const goal2 = typeof target === 'function' ? target() : target
      if (!result?.reached && goal2 && typeof host.digToward === 'function' && !mission?.cancelled) {
        // Feuilles autour du bot (buisson, couronne) : couloir ouvert a hauteur
        // du corps vers la cible, plutot qu un tunnel sous le sol.
        const feuilles = await clearLeavesToward({ position: new Vec3(Math.floor(goal2.x), Math.floor(goal2.y), Math.floor(goal2.z)) }, LEAF_CLEAR_MAX).catch(() => 0)
        if (feuilles > 0) {
          console.log(`[mission] ${feuilles} feuille(s) cassee(s) vers la cible`)
          result = await call()
          if (result?.reached) return result
        }
        // Eau ou vide en ligne droite vers la cible : pont de terre pose a la
        // main (le pathfinder s y prend mal et le bot ne ressort pas de l eau).
        // La terre n est prise que dans ce cas (des trous dans le sol perdaient
        // le pathfinder), puis retour au point de depart (bridgeRounds).
        await bridgeRounds(goal2, owner)
        if (!gapToward(goal2)) result = await call()
        else if (!result?.reached) {
          // Le pathfinder qui creuse entrerait dans l eau, dont le bot ne
          // ressort pas en 26.1 : echec franc plutot que noyade.
          console.log('[mission] pont inacheve : pas de trajet en creusant a travers l eau')
          return result
        }
      }
      if (!result?.reached && goal2 && typeof host.digToward === 'function' && !mission?.cancelled) {
        const dug = await host.digToward(goal2, { signal: mission.navigationAbort.signal, range: 2, protectBuilt: true })
        const here = host.getBot()?.entity?.position
        console.log(`[mission] trajet en creusant vers la cible (${goal2.x.toFixed(1)} ${goal2.y.toFixed(1)} ${goal2.z.toFixed(1)}) : ${dug.code}` +
          (here ? `, bot en ${here.x.toFixed(1)} ${here.y.toFixed(1)} ${here.z.toFixed(1)}` : ''))
        if (dug.reached) result = await call()
      }
    }
    return result
  }

  // Feuilles dans le couloir a hauteur du corps (pieds et tete) entre le bot
  // et la colonne de `cible`, a portee, les plus proches d abord. Cassees une
  // par une, verifiees cote serveur ; rend le nombre reellement cassees.
  async function clearLeavesToward (cible, max, approached = false) {
    const bot = host.getBot()
    if (!bot?.entity || max <= 0) return 0
    const feet = bot.entity.position
    const eye = feet.offset(0, 1.62, 0)
    const tx = cible.position.x + 0.5
    const tz = cible.position.z + 0.5
    const dx = tx - feet.x
    const dz = tz - feet.z
    const length = Math.hypot(dx, dz)
    const y0 = Math.floor(feet.y + 0.01)
    const seen = new Set()
    const candidates = []
    for (let t = 0; t <= length; t += 0.3) {
      const x = Math.floor(feet.x + dx * t / length)
      const z = Math.floor(feet.z + dz * t / length)
      if (x === cible.position.x && z === cible.position.z) break
      for (const y of [y0, y0 + 1]) {
        const key = `${x},${y},${z}`
        if (seen.has(key)) continue
        seen.add(key)
        const block = bot.blockAt(new Vec3(x, y, z))
        if (!block || !/_leaves$/.test(block.name)) continue
        candidates.push({ block, t, reachable: eye.distanceTo(block.position.offset(0.5, 0.5, 0.5)) <= REACH })
      }
    }
    candidates.sort((a, b) => a.t - b.t)
    if (candidates.length === 0) return 0
    // Le buisson commence hors de portee : rejoindre d abord un poste d ou la
    // premiere feuille du couloir se casse, puis recalculer le couloir.
    if (!candidates.some(c => c.reachable)) {
      if (approached) return 0
      const first = candidates[0].block
      const nav = await host.navigateToPosition(first.position.offset(0.5, 0.5, 0.5), {
        signal: mission.navigationAbort.signal, __owner: stepToken, interaction: true, distanceBudget: 16
      })
      if (!nav.reached || mission.cancelled) return 0
      return clearLeavesToward(cible, max, true)
    }
    let cleared = 0
    for (const { block } of candidates.filter(c => c.reachable)) {
      if (cleared >= max || mission.cancelled) break
      try {
        await withTimeout(bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true), 4000, 'visee trop longue')
        await withTimeout(bot.dig(block), 6000, 'creusage trop long')
      } catch (_) {
        break
      }
      const after = bot.blockAt(block.position)
      if (after && after.name === block.name) break
      cleared += 1
    }
    return cleared
  }

  // Cibles sans chemin (avancer en no_path, meme en creusant) : mises de cote
  // INJOIGNABLE_MS pour que la recherche suivante en vise une autre. Vu sur
  // craft/stone-pickaxe : la pierre la plus proche etait la face du dessous
  // d une couche sous le sol (a l air libre par en dessous) ; trois avancer de
  // suite visaient ce meme bloc et le bot finissait dans un trou.
  const injoignables = new Map()
  const INJOIGNABLE_MS = 180000
  const posKey = p => `${p.x},${p.y},${p.z}`
  function injoignable (pos) {
    const until = injoignables.get(posKey(pos))
    return Boolean(until && until > Date.now() && injoignables.missionId === mission?.id)
  }
  function marquerInjoignable (pos) {
    if (injoignables.missionId !== mission?.id) { injoignables.clear(); injoignables.missionId = mission?.id }
    injoignables.set(posKey(pos), Date.now() + INJOIGNABLE_MS)
  }

  // Chantier en cours : ne jamais creuser son emprise (+1 autour), ni le sol
  // dessous ni la maison deja posee (vu sur build/no-materials : terre prise
  // sous le chantier, « aucun appui »).
  function empriseChantier () {
    if (mission?.kind !== 'construction' || !mission.plan?.blocks?.length) return null
    const xs = mission.plan.blocks.map(b => b.position.x)
    const zs = mission.plan.blocks.map(b => b.position.z)
    const ys = mission.plan.blocks.map(b => b.position.y)
    return { x0: Math.min(...xs) - 1, x1: Math.max(...xs) + 1, z0: Math.min(...zs) - 1, z1: Math.max(...zs) + 1, y: Math.min(...ys) }
  }

  function findTargetBlock (resource, opts = {}) {
    // Surcharge toleree : findTargetBlock({ yaw }) vaut secteur sur la matiere
    // courante. Rien d autre n utilise cette forme aujourd hui.
    if (resource && typeof resource === 'object' && !Array.isArray(resource) &&
      (resource.yaw !== undefined || resource.demiAngle !== undefined)) {
      opts = resource
      resource = undefined
    }
    const bot = host.getBot()
    const ids = resource ? blockIdsFor(resource) : targetBlockIds()
    if (!bot?.entity || ids.length === 0) return null

    // Filtre optionnel par secteur (cone de yaw) : ne garde que les blocs
    // situes dans la direction visee. Convention mineflayer : avant =
    // (-sin yaw, -cos yaw), yaw 0 = nord (-Z). Sans yaw, comportement
    // inchange (aucun filtrage directionnel).
    const yaw = opts.yaw
    const filtreSecteur = Number.isFinite(yaw)
    const demiAngle = Number.isFinite(opts.demiAngle) ? opts.demiAngle : Math.PI / 4

    // Seulement un bloc qu un joueur verrait : au moins une face a l air
    // libre (feuilles, plantes et liquides laissent voir). La pierre enfouie
    // sous le sol etait visee pour avancer (« rejoint a portee ») puis
    // introuvable pour casser, en boucle (vu : craft/stone-pickaxe, 90 etapes,
    // les 32 plus proches etant toutes sous le sol de l arene).
    const feetLevel = Math.floor(bot.entity.position.y)
    const exposed = pos => blocExpose(bot, pos, feetLevel)
    let positions
    try {
      // Filtre PENDANT la recherche : sous une arene ou un sol de pierre, des
      // milliers de blocs enfouis sont plus proches que le rocher visible (vu :
      // les 256 plus proches toutes enfouies, « pierre introuvable »). La
      // `useExtraInfo` en fonction = filtre applique aux seuls blocs de la
      // matiere (mineflayer garde le tri rapide par palette sur `ids`).
      positions = bot.findBlocks({
        matching: ids, useExtraInfo: block => exposed(block.position), maxDistance: SEARCH_RADIUS, count: 64
      }).filter(exposed).slice(0, 32)
    } catch (err) {
      return null
    }
    // Tree in progress: its logs only, the others wait (player rule).
    const arbre = (resource ?? harvestResource()) === 'bois' ? arbreInacheve() : null
    if (arbre) {
      const visibles = arbre.filter(exposed)
      positions = visibles.length > 0 ? visibles : arbre
    }
    if (mission.wholeTree && mission.tree && (resource ?? harvestResource()) === 'bois') {
      // Le contrat d un arbre entier reste precis meme sans arbre_fini.
      recapturerArbreDemande()
      const cells = mission.buchesArbreDemande ?? [mission.tree]
      positions = cells.map(c => new Vec3(c.x, c.y, c.z))
        .filter(p => !bot.blockAt(p) || TREE_LOG.test(bot.blockAt(p)?.name ?? '') || !mission.buchesArbreDemande)
    }

    const here = bot.entity.position
    const feetY = Math.floor(here.y)
    // anyHeight : pour SE DEPLACER vers la matiere (fond de trou, haut de
    // falaise), pas pour la casser d ici. Les bornes verticales ci-dessous
    // restent celles de `casser`.
    const anyHeight = opts.anyHeight === true
    const emprise = empriseChantier()

    // Cible mise de cote (sans chemin) : ignoree tant qu il en reste une
    // autre, jamais quand c est la derniere. Vu sur terrain/plateau (a45b981,
    // 9b5fe31) : buche du haut mise de cote depuis le pied de la falaise, puis
    // invisible une fois le bot monte (« rien » partout, errance, chute).
    const candidates = []
    const collect = list => { for (const position of list) {
      if (dansEmprise(emprise, position)) continue
      if (!anyHeight && position.y < feetY - MAX_DIG_DEPTH) continue
      // Trop haut pour etre atteint depuis le sol : passer a la cible suivante
      // plutot que de s acharner sur le haut d un tronc.
      if (!anyHeight && position.y > feetY + MAX_REACH_UP) continue

      const dx = position.x + 0.5 - here.x
      const dz = position.z + 0.5 - here.z
      const horizontal = Math.hypot(dx, dz)
      // Le bloc sous ses pieds le ferait tomber dans son propre trou.
      if (position.y < feetY && horizontal < 1.5) continue

      // Secteur : cap du bloc = atan2(-dx, -dz) (inverse de
      // avant = (-sin yaw, -cos yaw)). Ecart normalise dans [-PI, PI].
      // Un bloc quasi a la verticale du bot n a pas de cap defini : on le
      // garde (il est visible depuis toutes les directions).
      if (filtreSecteur && horizontal >= 0.5) {
        const capBloc = Math.atan2(-dx, -dz)
        let ecart = (capBloc - yaw) % (Math.PI * 2)
        if (ecart > Math.PI) ecart -= Math.PI * 2
        if (ecart < -Math.PI) ecart += Math.PI * 2
        if (Math.abs(ecart) > demiAngle) continue
      }

      const measured = bot.blockAt(position)
      const unknownTree = mission.wholeTree && mission.tree && (!measured || !mission.buchesArbreDemande)
      if (unknownTree && !anyHeight) continue
      const block = unknownTree ? { name: mission.arbreSources?.find(c => c.confirmee)?.objet ?? 'oak_log', position, boundingBox: 'block', inconnue: true } : measured
      if (!block) continue

      candidates.push({
        block,
        interactable: blockInReach(bot, here, position.offset(0.5, 0.5, 0.5), REACH),
        // Distance 3D centre a centre : celle que le serveur applique a la casse.
        reach: here.distanceTo(position.offset(0.5, 0.5, 0.5))
      })
    } }
    collect(positions.filter(p => !injoignable(p)))
    if (candidates.length === 0) collect(positions.filter(p => injoignable(p)))


    if (candidates.length === 0) return null

    candidates.sort((a, b) => {
      // A visible reachable block must not be hidden by a lower occluded candidate.
      if (a.interactable !== b.interactable) return a.interactable ? -1 : 1
      // Un bloc a portee vaut mieux qu un bloc plus proche mais injoignable :
      // casser n echoue plus sur « bloc trop loin » s il existe mieux.
      const ra = a.reach <= REACH ? 0 : 1
      const rb = b.reach <= REACH ? 0 : 1
      if (ra !== rb) return ra - rb
      // A portee egale, le plus bas d abord. Casser le pied fait tomber la
      // suite dans la portee, buche apres buche.
      if (a.block.position.y !== b.block.position.y) {
        return a.block.position.y - b.block.position.y
      }
      return a.reach - b.reach
    })

    return candidates[0].block
  }

  // Bloc de dirt SECONDAIRE en mission bois : le carburant du pilier quand un
  // bloc haut est utile mais la dirt manque. Memes filtres anti-puits que
  // findTargetBlock (pas le bloc porteur, pas sous les pieds, pas trop haut) :
  // on ne cherche pas une carriere, juste quelques blocs meubles a portee pour
  // monter. Nul hors mission bois, ou sans dirt a portee. Le quota bois n est
  // jamais touche : l appelant compte ces blocs a part (mission.dirtSecondaire).
  function findSecondaryDirtBlock () {
    const bot = host.getBot()
    if (!mission || harvestResource() !== 'bois') return null
    if (!bot?.entity || !bot.registry) return null

    let positions
    try {
      const ids = []
      for (const name of ['dirt', 'coarse_dirt', 'grass_block']) {
        const block = bot.registry.blocksByName[name]
        if (block) ids.push(block.id)
      }
      if (ids.length === 0) return null
      positions = bot.findBlocks({ matching: ids, maxDistance: SEARCH_RADIUS, count: 16 })
    } catch (_) {
      return null
    }

    const here = bot.entity.position
    const feetY = Math.floor(here.y)
    let best = null

    for (const position of positions) {
      if (position.y < feetY - MAX_DIG_DEPTH) continue
      if (position.y > feetY + MAX_REACH_UP) continue
      const horizontal = Math.hypot(position.x + 0.5 - here.x, position.z + 0.5 - here.z)
      if (position.y < feetY && horizontal < 1.5) continue
      const block = bot.blockAt(position)
      if (!block || !SECONDARY_DIRT.test(block.name)) continue
      const reach = here.distanceTo(position.offset(0.5, 0.5, 0.5))
      if (reach > REACH) continue
      if (!best || reach < best.reach) best = { block, reach }
    }

    return best ? best.block : null
  }

  // Share the effective fallback choice with the state sent to the planner.
  function secondaryDirtFor (primary, admitted) {
    const bot = host.getBot()
    if (!admitted || !bot?.entity) return null
    if (primary && bot.entity.position.distanceTo(primary.position.offset(0.5, 0.5, 0.5)) <= REACH) return null
    return findSecondaryDirtBlock()
  }

  // Hache recommandee : mission bois, aucune hache en inventaire, et une
  // fabrication utile vers la hache (la hache elle-meme, ou la chaine
  // planches -> batons -> etabli qui y mene). Mesure sur l inventaire reel via
  // craft.targetCriteria reports an optional optimization; productive bare-hand
  // harvesting remains available when no tool is required.
  function hacheRecommandee () {
    const bot = host.getBot()
    if (!mission || harvestResource() !== 'bois') return false
    if (!bot?.inventory) return false
    if (craft.bestToolOfKind(bot, 'axe')) return false
    let possibles = []
    try {
      possibles = Object.keys(craft.targetCriteria(bot))
    } catch (_) {
      return false
    }
    if (possibles.includes('hache')) return true
    const chaine = ['planches', 'batons', 'etabli']
    return chaine.some(nom => possibles.includes(nom))
  }

  // Dirt secondaire admise : mission bois, un bloc haut designe un pilier utile
  // (cible_haute), et le stock de dirt est insuffisant pour le monter. Le code
  // mesure le besoin, le modele decide de casser de la dirt au sol.
  function dirtSecondaireAdmise (cibleHaute) {
    const bot = host.getBot()
    if (!mission || harvestResource() !== 'bois') return false
    if (!bot?.inventory) return false
    if (!cibleHaute) return false
    return scaffoldingStock(bot).total < PILER_MAX
  }

  // Arbre demande : buches encore en place et buches tombees non ramassees.
  // null tant qu aucune buche n a ete coupee (arbre pas encore choisi).
  function recapturerArbreDemande () {
    if (!mission?.tree || mission.buchesArbreDemande) return
    const cells = logsOfTree(mission.tree)
    if (cells === null) return
    mission.buchesArbreDemande = [...cells, ...(!cells.some(c => c.x === mission.tree.x && c.y === mission.tree.y && c.z === mission.tree.z) ? [mission.tree] : [])].map(celluleValide)
    if (mission.arbreEnCours && !mission.buchesArbre) mission.buchesArbre = mission.buchesArbreDemande
    arbreMemo = null
  }
  function treeStatus () {
    const bot = host.getBot()
    const t = mission?.tree
    if (!mission?.wholeTree || !t || !bot?.entity) return null
    observerCollecteArbre()
    recapturerArbreDemande()
    const cells = mission.buchesArbreDemande
    // Une ancienne reprise sans cellules mesurees ne prouve pas l arbre fini.
    if (!cells?.length) return { buches_restantes: 1, buches_au_sol: 0, termine: false, incertain: true }
    const measured = cells.map(c => bot.blockAt(new Vec3(c.x, c.y, c.z)))
    const standing = measured.filter(b => !b || TREE_LOG.test(b.name)).length
    // La mesure reste ouverte jusqu a la preuve de collecte : un spawn ou
    // sa metadata peut arriver apres la fin de la rafale de casse.
    noterDropsArbre()
    prouverCollectesArbre()
    const owned = new Set(mission.dropsArbreDemande ?? [])
    const onGround = Object.entries(bot.entities ?? {})
      .filter(([id, e]) => e && owned.has(e.uuid || id) && e.name === 'item')
      .reduce((sum, [, e]) => {
        let item = null
        try { item = e.getDroppedItem?.() } catch (_) {}
        return sum + (item && TREE_LOG.test(item.name) ? item.count : 0)
      }, 0)
    let sansPreuve = Math.max(0, (mission.arbreCoupes ?? 0) - (mission.arbreCollectes ?? 0))
    // Preuve par la mesure quand la provenance se perd : deux buches tombees
    // ensemble fusionnent en une pile (compte lu avant la fusion, ou case de
    // disparition hors tolerance). Plus une buche debout, plus une buche au
    // sol pres de l arbre, et l inventaire a gagne au moins autant de buches
    // que de coupes : tout est ramasse (chat/question-keeps-mission 41565cc,
    // bb4212f : 3/3 en poche, mission jamais close). Bois depense entre-temps :
    // gain trop court, la preuve ordinaire reste seule juge.
    if (standing === 0 && onGround === 0 && sansPreuve > 0 && Number.isFinite(mission.arbreInventaireDepart) &&
      !boisAuSolPres(t) && craft.countOf(bot, TREE_LOG) - mission.arbreInventaireDepart >= (mission.arbreCoupes ?? 0)) {
      mission.arbreCollectes = mission.arbreCoupes
      sansPreuve = 0
    }
    const restant = Math.max(onGround, sansPreuve)
    return { buches_restantes: standing, buches_au_sol: restant,
      termine: standing === 0 && restant === 0, incertain: sansPreuve > onGround }
  }

  // Une buche au sol a moins de 8 blocs de l arbre, d ou qu elle vienne.
  function boisAuSolPres (t) {
    return Object.values(host.getBot()?.entities ?? {}).some(e => {
      if (e?.name !== 'item' || !e.position) return false
      let item = null
      try { item = e.getDroppedItem?.() } catch (_) {}
      return (!item || TREE_LOG.test(item.name)) && Math.hypot(e.position.x - t.x, e.position.z - t.z) <= 8
    })
  }

  let botCollecteObserve = null
  let coupeArbreActive = null
  // Mission revisee pendant la lecture du nouvel objectif : ses coupes deja
  // mesurees restent observees (spawn et collecte tardifs), puis la revision
  // en recopie les preuves (suiviArbre). Jeton : seul l appel qui l a posee
  // la retire s il echoue.
  let revisionArbre = null
  const collectesEnAttente = new Map()
  function recevoirSpawnArbre (entity) {
    if (!mission?.wholeTree || entity?.name !== 'item' || !entity.position) return
    if (!['running', 'paused'].includes(mission.state) && mission !== revisionArbre?.mission) return
    let item
    try { item = entity.getDroppedItem?.() } catch (_) {}
    const proche = c => Math.hypot(entity.position.x - c.x - 0.5, entity.position.y - c.y - 0.5, entity.position.z - c.z - 0.5) <= 0.9
    const source = mission.arbreSources?.find(c => c.id === coupeArbreActive && c.ouverte && proche(c)) ??
      mission.arbreSources?.find(c => c.confirmee && !c.drop && proche(c) && (!item || item.name === c.objet))
    if (!source || (item && item.name !== source.objet)) return
    const id = entity.uuid || String(entity.id)
    mission.arbreSpawns ??= []
    if (mission.arbreSpawns.some(s => s.id === id)) return
    if (mission.arbreSpawns.filter(s => s.source === source.id).length >= 2) { source.ambigu = true; return }
    mission.arbreSpawns.push({ id, source: source.id, x: entity.position.x, y: entity.position.y, z: entity.position.z,
      objet: null, gone: false, tiers: false, collectedByBot: false, collectCount: null, collectPosition: null })
    actualiserSpawnArbre(entity)
  }
  function actualiserSpawnArbre (entity) {
    const spawn = mission?.arbreSpawns?.find(s => s.id === (entity?.uuid || String(entity?.id)))
    if (!spawn) return
    try { const item = entity.getDroppedItem?.(); if (item) { spawn.objet = item.name; if (spawn.collectedByBot) spawn.collectCount = item.count } } catch (_) {}
  }
  function recevoirDisparitionArbre (entity) {
    actualiserSpawnArbre(entity)
    const spawn = mission?.arbreSpawns?.find(s => s.id === (entity?.uuid || String(entity?.id)))
    if (spawn) { spawn.gone = true; if (entity.position) spawn.fin = { x: entity.position.x, y: entity.position.y, z: entity.position.z } }
  }
  function recevoirCollecteArbre (collector, entity) {
    if (!mission?.wholeTree || !entity) return
    if (collector?.id !== host.getBot()?.entity?.id) {
      const spawn = mission.arbreSpawns?.find(s => s.id === (entity.uuid || String(entity.id)))
      if (spawn) spawn.tiers = true
      return
    }
    const id = entity.uuid || String(entity.id)
    const spawn = mission.arbreSpawns?.find(s => s.id === id)
    if (spawn) {
      spawn.collectedByBot = true
      spawn.collectPosition = entity.position ? { x: entity.position.x, y: entity.position.y, z: entity.position.z } : null
      actualiserSpawnArbre(entity)
    }
    if (!spawn && !(mission.arbreEntitiesInitial ?? []).includes(id)) return
    collectesEnAttente.set(id, entity)
    prouverCollectesArbre()
    reportProgressSafe()
  }
  function observerCollecteArbre (revision = false) {
    if (mission?.state !== 'running' && !revision) return
    const bot = host.getBot()
    if (botCollecteObserve === bot) return
    const attente = new Map(collectesEnAttente)
    retirerObservateurArbre()
    for (const [id, entity] of attente) if (mission.arbreSpawns?.some(s => s.id === id)) collectesEnAttente.set(id, entity)
    installerObservateurArbre(bot)
  }
  function observerRevisionArbre (m, attente) {
    if (!m?.wholeTree || m !== mission || !m.arbreSources?.some(c => c.confirmee && !c.drop)) return null
    for (const [id, entity] of attente ?? []) collectesEnAttente.set(id, entity)
    observerCollecteArbre(true)
    revisionArbre = { mission: m }
    return revisionArbre
  }
  function installerObservateurArbre (bot) {
    bot?.on?.('entitySpawn', recevoirSpawnArbre)
    bot?.on?.('entityUpdate', actualiserSpawnArbre)
    bot?.on?.('itemDrop', actualiserSpawnArbre)
    bot?.on?.('entityGone', recevoirDisparitionArbre)
    bot?.on?.('playerCollect', recevoirCollecteArbre)
    bot?.once?.('end', retirerObservateurArbre)
    botCollecteObserve = bot
  }
  function retirerObservateurArbre () {
    for (const entity of collectesEnAttente.values()) actualiserSpawnArbre(entity)
    coupeArbreActive = null
    botCollecteObserve?.removeListener?.('entitySpawn', recevoirSpawnArbre)
    botCollecteObserve?.removeListener?.('entityUpdate', actualiserSpawnArbre)
    botCollecteObserve?.removeListener?.('itemDrop', actualiserSpawnArbre)
    botCollecteObserve?.removeListener?.('entityGone', recevoirDisparitionArbre)
    botCollecteObserve?.removeListener?.('playerCollect', recevoirCollecteArbre)
    botCollecteObserve?.removeListener?.('end', retirerObservateurArbre)
    botCollecteObserve = null
    revisionArbre = null
    collectesEnAttente.clear()
  }
  function prouverCollectesArbre () {
    if (!mission?.tree || !mission.buchesArbreDemande?.length) return
    const avant = mission.arbreCollectes
    for (const spawn of mission.arbreSpawns ?? []) {
      if (spawn.collectedByBot && !collectesEnAttente.has(spawn.id)) collectesEnAttente.set(spawn.id, { position: spawn.collectPosition, getDroppedItem: () => spawn.objet && spawn.collectCount !== null ? { name: spawn.objet, count: spawn.collectCount } : null })
      if (spawn.objet) attribuerDropArbre(spawn.id, { getDroppedItem: () => ({ name: spawn.objet }) })
    }
    const exclus = new Set(mission.arbreEntitiesInitial ?? [])
    const deja = new Set(mission.arbreCollecteIds ?? [])
    for (const [id, e] of collectesEnAttente) {
      if (deja.has(id)) { collectesEnAttente.delete(id); continue }
      let item
      try { item = e.getDroppedItem?.() } catch (_) {}
      if (!item || !e.position) continue
      actualiserSpawnArbre({ ...e, uuid: id })
      if (exclus.has(id)) {
        const baseline = mission.arbreBaseline?.find(b => b.id === id && b.objet === item.name)
        const candidats = (mission.arbreSpawns ?? []).filter(spawn => spawn.gone && !spawn.tiers && !deja.has(spawn.id) &&
          spawn.objet === item.name && (mission.dropsArbreDemande ?? []).includes(spawn.id) && baseline &&
          spawn.fin && Math.hypot(spawn.fin.x - e.position.x, spawn.fin.y - e.position.y, spawn.fin.z - e.position.z) <= 0.75)
        const delta = baseline ? item.count - baseline.count : 0
        // Sans origine mesuree disparue et delta exact, la fusion reste ambigue.
        if (delta > 0 && delta === candidats.length) {
          mission.arbreCollectes = (mission.arbreCollectes ?? 0) + delta
          for (const spawn of candidats) deja.add(spawn.id)
          collectesEnAttente.delete(id)
        }
        continue
      }
      attribuerDropArbre(id, e)
      if ((mission.dropsArbreDemande ?? []).includes(id) && TREE_LOG.test(item.name)) {
        // Une coupe prouve une unite, jamais les objets etrangers fusionnes dans sa pile.
        const fusionnes = (mission.arbreSpawns ?? []).filter(spawn => spawn.id !== id && spawn.gone && !spawn.tiers &&
          !deja.has(spawn.id) && spawn.objet === item.name && (mission.dropsArbreDemande ?? []).includes(spawn.id) &&
          spawn.fin && Math.hypot(spawn.fin.x - e.position.x, spawn.fin.y - e.position.y, spawn.fin.z - e.position.z) <= 0.75)
        const credits = item.count === 1 + fusionnes.length ? fusionnes : []
        mission.arbreCollectes = (mission.arbreCollectes ?? 0) + Math.min(1, Math.max(0, Number(item.count) || 0)) + credits.length
        for (const spawn of credits) deja.add(spawn.id)
        deja.add(id)
        collectesEnAttente.delete(id)
      }
    }
    mission.arbreCollecteIds = [...deja]
    if (mission.arbreCollectes !== avant) reportProgressSafe()
  }

  // La position initiale du paquet spawn reste immuable : un objet voisin
  // qui roule vers cet arbre ne devient pas une preuve de sa coupe.
  function attribuerDropArbre (id, entity) {
    if ((mission.arbreEntitiesInitial ?? []).includes(id)) return
    if ((mission.dropsArbreDemande ?? []).includes(id)) return
    const spawn = mission.arbreSpawns?.find(s => s.id === id)
    let item
    try { item = entity.getDroppedItem?.() } catch (_) {}
    if (!spawn || !item || !TREE_LOG.test(item.name)) return
    const source = mission.arbreSources?.find(c => c.id === spawn.source && c.confirmee && !c.ouverte && !c.ambigu && !c.drop && c.objet === item.name &&
      Math.hypot(spawn.x - c.x - 0.5, spawn.y - c.y - 0.5, spawn.z - c.z - 0.5) <= 0.9)
    if (!source) return
    const possibles = mission.arbreSpawns.filter(s => s.source === source.id && (!s.objet || s.objet === source.objet))
    if (possibles.length !== 1) { source.ambigu = true; return }
    source.drop = id
    mission.dropsArbreDemande ??= []
    mission.dropsArbreDemande.push(id)
  }
  function noterDropsArbre () {
    if (!mission.wholeTree || !mission.tree) return
    for (const [id, e] of Object.entries(host.getBot()?.entities ?? {})) {
      if (e?.name === 'item') attribuerDropArbre(e.uuid || id, e)
    }
  }

  // Tree started by any wood job: the first log cut fixes it. Its logs are
  // those 26-connected to the first cut, within TREE_RADIUS: a bent trunk
  // or a branch stays in, a neighbour tree that does not touch it stays out.
  // The first cut may be high on the trunk (bot on a ledge): the scan goes
  // TREE_HEIGHT down as well as up. null = a cell is not loaded (chunk far
  // away): unknown, never read as a finished tree.
  function logsOfTree (t) {
    const bot = host.getBot()
    if (!t || !bot?.entity) return null
    let inconnu = false
    const isLog = p => {
      const b = bot.blockAt(p)
      if (!b) inconnu = true
      return TREE_LOG.test(b?.name ?? '')
    }
    const key = p => `${p.x},${p.y},${p.z}`
    const seen = new Set()
    const logs = []
    // Start at the cut cell only. A disconnected log in the same column
    // is not part of this tree. The initial connected set is saved before digging.
    const anchor = new Vec3(t.x, t.y, t.z)
    seen.add(key(anchor))
    logs.push(anchor)
    for (let i = 0; i < logs.length; i += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dz = -1; dz <= 1; dz += 1) {
            const q = logs[i].offset(dx, dy, dz)
            if (Math.abs(q.x - t.x) > TREE_RADIUS || Math.abs(q.z - t.z) > TREE_RADIUS) continue
            if (Math.abs(q.y - t.y) > TREE_HEIGHT || seen.has(key(q))) continue
            seen.add(key(q))
            if (isLog(q)) logs.push(q)
          }
        }
      }
    }
    return inconnu ? null : logs.filter(isLog)
  }

  // Logs still standing on the tree in progress, or null (none started, or
  // finished). While not null, no other tree is a target and the job does
  // not end (player rule: never leave a tree partly cut). Switch arbre_fini.
  // Memo: read many times per step; a break or 250 ms renew it.
  let arbreMemo = null
  function arbreInacheve () {
    if (!mission?.arbreEnCours || !featureOn('arbre_fini')) return null
    const t = mission.arbreEnCours
    const cle = `${mission.id}|${t.x},${t.y},${t.z}|${mission.broken}|${mission.dirtSecondaire ?? 0}`
    if (!arbreMemo || arbreMemo.cle !== cle || Date.now() - arbreMemo.at > 250) {
      const bot = host.getBot()
      const tracked = mission.buchesArbre
      const measured = tracked?.map(c => ({ pos: new Vec3(c.x, c.y, c.z), block: bot?.blockAt(new Vec3(c.x, c.y, c.z)) }))
      const logs = measured ? (measured.some(c => !c.block) ? null : measured.filter(c => TREE_LOG.test(c.block.name)).map(c => c.pos)) : logsOfTree(t)
      // Unknown (unloaded): keep the last measure of this tree; none yet
      // (restored after a restart, far away) counts as not finished.
      const memeArbre = arbreMemo && arbreMemo.cle.split('|').slice(0, 2).join('|') === cle.split('|').slice(0, 2).join('|')
      const connu = logs ?? (memeArbre ? arbreMemo.logs : [new Vec3(t.x, t.y, t.z)])
      arbreMemo = { cle, at: Date.now(), logs: connu && connu.length > 0 ? connu : null }
    }
    return arbreMemo.logs
  }

  // Tree finished: the pillars climbed for it come down (player rule: remove
  // what was built next to it). The one under the feet first, then the
  // columns left standing, top first, from the ground. One pass: what stays
  // out of reach is kept for up to three passes, then reported for recovery.
  // Runs inside the step slot (owner token), after the step that cut the
  // last log, like the reflexes.
  async function demonterEchafaudage (owner) {
    if (!mission || !featureOn('arbre_fini')) return 0
    if (mission.arbreEnCours && !arbreInacheve()) {
      mission.arbreEnCours = null
      mission.buchesArbre = null
      mission.echafaudageEnAttente = [...(mission.echafaudageEnAttente ?? []), ...(mission.echafaudagePose ?? [])]
      mission.echafaudagePose = []
    }
    // Keep unresolved cells separate from the next tree's scaffold. Three
    // attempts per mission; persisted cells can be retried after a restart.
    const pending = mission.echafaudageEnAttente ?? []
    const attempts = mission.echafaudageEssais ??= {}
    const key = p => `${p.x},${p.y},${p.z}`
    const poses = pending.filter(p => (attempts[key(p)] ?? 0) < 3)
    for (const p of poses) attempts[key(p)] = (attempts[key(p)] ?? 0) + 1
    const present = p => {
      const b = host.getBot()?.blockAt(p)
      return Boolean(b && (PILER_DIRT.test(b.name) || /_planks$/.test(b.name)))
    }
    // An unloaded cell is unknown, not proof that the scaffold is gone.
    const unresolved = p => !host.getBot()?.blockAt(p) || present(p)
    let restants = poses.filter(present)
    if (restants.length === 0) {
      mission.echafaudageEnAttente = pending.filter(unresolved)
      mission.echafaudageLaisse = mission.echafaudageEnAttente.length
      return 0
    }
    // Down through recorded cells only: terrain or a player build under the
    // feet is never dug.
    const enregistre = new Set(restants.map(p => `${p.x},${p.y},${p.z}`))
    let retires = 0
    for (let i = 0; i < restants.length && !mission.cancelled; i += 1) {
      const bot = host.getBot()
      if (!bot?.entity) break
      const below = bot.blockAt(bot.entity.position.offset(0, -0.5, 0))
      if (!below || !enregistre.has(`${below.position.x},${below.position.y},${below.position.z}`) || !present(below.position)) break
      const dessous = bot.blockAt(below.position.offset(0, -1, 0))
      if (!dessous || dessous.boundingBox !== 'block') break
      try {
        await withTimeout(bot.lookAt(below.position.offset(0.5, 0.5, 0.5), true), 4000, 'visee trop longue')
        await withTimeout(bot.dig(below), 6000, 'creusage trop long')
      } catch (_) {
        break
      }
      const until = Date.now() + 1500
      while (Date.now() < until && !(host.getBot()?.entity?.onGround && host.getBot().entity.position.y < below.position.y + 0.5)) {
        await sleep(50)
      }
      retires += 1
    }
    restants = restants.filter(present).sort((a, b) => b.y - a.y)
    for (const p of restants) {
      if (mission.cancelled) break
      const bot = host.getBot()
      if (!bot?.entity || !present(p)) continue
      const centre = p.offset(0.5, 0.5, 0.5)
      if (!blockInReach(bot, bot.entity.position, centre, REACH)) {
        try {
          await host.navigateToPosition(new Vec3(p.x + 0.5, bot.entity.position.y, p.z + 0.5), {
            signal: mission.navigationAbort.signal, __owner: owner, radius: 2, distanceBudget: 16, timeoutMs: 8000
          })
        } catch (_) {}
      }
      const live = host.getBot()
      if (!live?.entity || !blockInReach(live, live.entity.position, centre, REACH)) continue
      try {
        await withTimeout(live.lookAt(centre, true), 4000, 'visee trop longue')
        await withTimeout(live.dig(live.blockAt(p)), 6000, 'creusage trop long')
        retires += 1
      } catch (_) {}
    }
    mission.echafaudageEnAttente = pending.filter(unresolved)
    const laisses = mission.echafaudageEnAttente.length
    console.log(`[mission] arbre fini : echafaudage retire (${retires} bloc(s))` +
      (laisses ? `, ${laisses} hors de portee laisse(s)` : ''))
    mission.echafaudageLaisse = laisses
    return retires
  }

  function nearbyItems () {
    const bot = host.getBot()
    if (!bot?.entities || !bot.entity) return []

    return Object.values(bot.entities)
      .filter(e => e && e.name === 'item' && e.position)
      .filter(e => e.position.distanceTo(bot.entity.position) <= ITEM_PICKUP_RADIUS)
      .sort((a, b) =>
        a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
  }

  function objetsAuSol (max = 4) {
    const bot = host.getBot()
    if (!bot?.entity) return []
    return nearbyItems().slice(0, max).map(e => {
      let item = null
      try { item = e.getDroppedItem?.() } catch (_) {}
      return {
        objet: item?.name ?? 'inconnu',
        nombre: item?.count ?? 1,
        distance: Number(e.position.distanceTo(bot.entity.position).toFixed(1)),
        dy: Math.round(e.position.y - bot.entity.position.y)
      }
    })
  }

  // Hauteurs des objets proches stables sur deux releves (150 ms), 2 s max.
  async function waitItemsSettled (maxMs = 2000) {
    const fin = Date.now() + maxMs
    let avant = null
    while (Date.now() < fin) {
      const releve = new Map(nearbyItems().map(e => [e.id, e.position.y]))
      if (avant && [...releve].every(([id, y]) => avant.has(id) && Math.abs(avant.get(id) - y) < 0.05)) return
      avant = releve
      await sleep(150)
    }
  }

  // L inventaire est la verite terrain : on compte ce qui y est entre depuis le
  // debut de la mission plutot que de faire confiance aux evenements de ramassage.
  function countResourceItems () {
    const bot = host.getBot()
    const pattern = mission && ressource(harvestResource())?.items
    if (!bot?.inventory || !pattern) return 0

    return bot.inventory.items()
      .reduce((sum, item) => sum + (pattern.test(item.name) ? item.count : 0), 0)
  }

  // Quantite recoltee depuis le debut. Memorisee, parce qu une mission peut se
  // clore apres la deconnexion du bot, quand l inventaire n est plus lisible.
  function collected () {
    if (!mission) return 0

    const bot = host.getBot()
    if (!bot?.inventory) return mission.collected

    mission.collected = Math.max(0, countResourceItems() - mission.startingItems)
    return mission.collected
  }

  // Objets cibles fabriques depuis le debut (preuve mesuree, jamais annoncee).
  // Initial porte par mission.fabricationInitial : le stock deja la ne compte
  // pas comme produit. Hors fabrication : 0, legacy inchange.
  function fabricationProduced () {
    if (!mission?.fabricationCible) return 0
    try {
      const bot = host.getBot()
      if (!bot?.inventory) return 0
      return Math.max(0, countFabricationItems(bot, mission.fabricationCible) - (mission.fabricationInitial ?? 0))
    } catch (_) {
      return 0
    }
  }

  // Cible atteinte et d autres objets demandes : le suivant devient la cible,
  // son stock du debut de mission comme initial. Vrai si la cible a change.
  function fabricationSuivante () {
    if (!mission?.fabricationCible || !mission.fabricationSuite?.length) return false
    if (fabricationProduced() < (mission.fabricationQuantite ?? 1)) return false
    const fait = mission.fabricationCible
    const suivant = mission.fabricationSuite.shift()
    mission.fabricationCible = suivant.objet
    mission.fabricationQuantite = 1
    mission.fabricationInitial = suivant.initial ?? 0
    mission.fabricationLastError = null
    mission.fabricationsFaites = [...(mission.fabricationsFaites ?? []), fait]
    console.log(`[mission] ${fait} fabrique(s) : cible suivante ${suivant.objet}` +
      (mission.fabricationSuite.length ? `, puis ${mission.fabricationSuite.map(f => f.objet).join(', ')}` : ''))
    return true
  }

  // Plusieurs objets demandes : un arret avant le dernier est refuse et
  // reinjecte comme une quantite explicite, pas clos en echec.
  function plusieursFabrications () {
    return Boolean(mission?.fabricationSuite?.length || mission?.fabricationsFaites?.length)
  }

  // Avancement du chantier, relu dans le monde plutot que compte a l aveugle :
  // un bloc pose puis casse doit redevenir « a faire ».
  // Besoins TOTAUX d un chantier en survie, calcules par le code (le modele ne
  // compte pas) : ce qui reste a poser, en poche, a fabriquer et a recolter,
  // porte et etabli compris. Sans eux, le bot coupait 1 a 3 buches, posait 10
  // a 16 blocs et recommencait (~8 allers-retours arbre/chantier par cabane,
  // revue de performance du 2026-09-27). Avant le choix du terrain, le total
  // est celui de la boite aux dimensions lues.
  function besoinsConstruction (progress, stock) {
    const bot = host.getBot()
    if (!bot?.inventory || !mission) return null
    const d = mission.dimensions ?? {}
    const w = d.width ?? 0; const dp = d.depth ?? 0; const h = d.height ?? 0
    const boite = w && dp && h ? w * dp * 2 + Math.max(0, 2 * (w + dp) - 4) * Math.max(0, h - 2) - (mission.wantsDoor ? 2 : 0) : null
    const restants = mission.plan ? progress.left : boite
    if (restants === null) return null
    // Plan libre pas encore concu : la boite aux dimensions lues surestime
    // (arche 5x1x4 = 11 blocs, boite 5x5x4 = 82 ; build/arch e58d6cd : 20 s
    // d exploration pour une pierre deja en poche). Le besoin se chiffre une
    // fois le terrain choisi.
    if (!mission.plan && featureOn('plans')) {
      return { blocs_restants: null, en_poche: stock, a_obtenir: null,
        resume: 'choisir_terrain d abord : le besoin exact se calcule avec la forme du chantier' }
    }
    const aPoser = Math.max(0, restants - stock)
    const porteManquante = Boolean(mission.wantsDoor) && !doorPlaced() && !doorItem()
    const items = bot.inventory.items()
    const compte = re => items.filter(i => re.test(i.name)).reduce((n, i) => n + i.count, 0)
    const planches = /planks/.test(String(mission.buildMatch))
    const besoins = { blocs_restants: restants, en_poche: stock, a_obtenir: aPoser, porte_a_fabriquer: porteManquante }
    if (planches || porteManquante) {
      const now = Date.now()
      if (!mission.tableSeen || now - mission.tableSeen.at > 2000) {
        let proche = false
        try { proche = Boolean(craft.placedTable(bot)) } catch (_) {}
        mission.tableSeen = { at: now, proche }
      }
      const etabli = porteManquante && !mission.tableSeen.proche && compte(/^crafting_table$/) === 0
      const planchesPoche = planches ? 0 : compte(/_planks$/)
      const planchesAFaire = Math.max(0, (planches ? aPoser : 0) + (porteManquante ? 6 : 0) + (etabli ? 4 : 0) - planchesPoche)
      const buches = compte(/_(log|stem)$/)
      besoins.etabli_a_fabriquer = etabli
      besoins.planches_a_fabriquer = planchesAFaire
      besoins.buches_en_poche = buches
      besoins.buches_a_recolter = Math.max(0, Math.ceil(planchesAFaire / 4) - buches)
      besoins.resume = besoins.buches_a_recolter > 0
        ? `recolter ${besoins.buches_a_recolter} buche(s) d un coup, puis ${planchesAFaire} planches${etabli ? ', etabli' : ''}${porteManquante ? ', porte' : ''}, puis poser ${restants} bloc(s)`
        : planchesAFaire > 0
          ? `fabriquer ${planchesAFaire} planches${etabli ? ', etabli' : ''}${porteManquante ? ', porte' : ''}, puis poser ${restants} bloc(s)`
          : `poser ${restants} bloc(s)${porteManquante ? ', fabriquer puis poser la porte' : ''}`
    } else {
      besoins.resume = aPoser > 0 ? `obtenir ${aPoser} bloc(s) de ${mission.resource}, puis poser ${restants} bloc(s)` : `poser ${restants} bloc(s)`
    }
    return besoins
  }

  function buildProgress () {
    if (!mission?.plan) return { total: 0, done: 0, left: 0 }

    const bot = host.getBot()
    const total = mission.plan.blocks.length
    if (!bot) return { total, done: mission.placed, left: total - mission.placed }

    let done = 0
    try {
      for (const entry of mission.plan.blocks) {
        const block = bot.blockAt(entry.position)
        // Le motif, pas le nom exact : en survie l essence du bois depend de
        // l arbre coupe, et un mur en `birch_planks` est aussi fini qu un mur en
        // `oak_planks`.
        if (block && mission.buildMatch.test(block.name)) done += 1
      }
    } catch (_) {
      // Reconnexion : pas de monde avant le spawn ; la derniere mesure vaut.
      return { total, done: mission.placed, left: total - mission.placed }
    }

    mission.placed = done
    return { total, done, left: total - done }
  }

  function doorPlaced () {
    if (!mission?.plan?.door) return false

    const bot = host.getBot()
    if (!bot) return mission.doorPlaced

    let block
    try { block = bot.blockAt(mission.plan.door.position) } catch (_) { return Boolean(mission.doorPlaced) }
    mission.doorPlaced = Boolean(block && /_door$/.test(block.name))
    return mission.doorPlaced
  }

  // -------------------------------------------------------------------------
  // Blocage : « il tourne en rond » a une mesure, et c est celle-ci
  // -------------------------------------------------------------------------

  // Ce qui doit augmenter quand le bot avance vraiment : des blocs casses, des
  // objets entres en inventaire, des blocs poses, une porte. Lire une position
  // ne suffit pas — le bot peut arpenter la meme zone sans rien produire.
  // La dirt secondaire (carburant de pilier en mission bois) compte comme un
  // progres anti-blocage, jamais comme du quota bois (voir `finishAllowed`).
  // Les dons prouves aussi : un depot mesure fait avancer, l incertain non.
  function progressFingerprint () {
    const built = mission.kind === 'construction' ? buildProgress().done : 0
    return mission.broken + collected() + built + (doorPlaced() ? 1 : 0) +
      (mission.dirtSecondaire ?? 0) + deliveryProvenFor(mission)
  }

  const gardes = new WeakMap()
  function gardeBoucle (m) {
    if (!gardes.has(m)) gardes.set(m, outcomes.createLoopGuard())
    return gardes.get(m)
  }
  const traces = new WeakMap()
  function traceDe (m) {
    if (!m) return null
    if (!traces.has(m)) traces.set(m, missionTrace.createTrace())
    return traces.get(m)
  }

  function inventaireTotal () {
    try {
      return (host.getBot()?.inventory?.items?.() ?? []).reduce((n, item) => n + (item.count ?? 0), 0)
    } catch (_) {
      return null
    }
  }

  // Trois signatures d une impasse, toutes mesurees ici :
  //   - la meme action rend exactement le meme resultat trois fois de suite ;
  //   - des actions en echec d affilee ;
  //   - aucun progres mesurable depuis NO_PROGRESS_STEPS.
  function detectStuck () {
    const tail = mission.history.slice(-3)
    if (tail.length === 3 &&
        tail.every(h => h.action === tail[0].action && h.resultat === tail[0].resultat)) {
      return { detecte: true, raison: `l action "${tail[0].action}" se repete a l identique sans rien changer` }
    }

    if (mission.failures >= 3) {
      return { detecte: true, raison: `${mission.failures} action(s) en echec d affilee` }
    }

    const since = mission.steps - mission.lastProgressStep
    if (since >= NO_PROGRESS_STEPS) {
      return { detecte: true, raison: `aucun progres mesurable depuis ${since} etapes` }
    }

    return { detecte: false, raison: null }
  }

  // -------------------------------------------------------------------------
  // Inventaire : en survie, c est lui qui decide de ce qui est possible
  // -------------------------------------------------------------------------

  // Le materiau de construction reellement disponible : le premier objet en
  // inventaire qui corresponde au motif de la matiere, le plus abondant en tete.
  function buildItem () {
    const bot = host.getBot()
    if (!bot?.inventory || !mission) return null

    const best = craft.mostAbundant(bot, mission.buildMatch)
    return best ? best.name : null
  }

  function doorItem () {
    const bot = host.getBot()
    if (!bot?.inventory) return null

    // La porte configuree d abord (`MISSION_DOOR_BLOCK`), sinon la plus
    // abondante : la variable d environnement n avait aucun effet avant.
    const preferred = mission?.doorBlock
    if (preferred && bot.inventory.items().some(item => item.name === preferred)) return preferred

    const best = craft.mostAbundant(bot, /_door$/)
    return best ? best.name : null
  }

  // Ce que le modele voit de l inventaire. Sans ces champs il ne pourrait pas choisir
  // « fabriquer » au bon moment : rien dans l etat ne dirait qu il y a des
  // buches mais pas encore de planches.
  function stocks () {
    const bot = host.getBot()
    if (!bot?.inventory || !mission) return null

    const snapshot = craft.snapshot(bot)
    const material = buildItem()
    const raw = ressource(harvestResource())?.raw

    return {
      materiau_de_construction: material,
      materiau_en_inventaire: material ? craft.countOf(bot, mission.buildMatch) : 0,
      matiere_brute_en_inventaire: raw ? craft.countOf(bot, raw) : 0,
      // Dirt disponible pour un pilier : le modele ne peut pas deviner ce
      // stock, et `piler` sans dirt echoue en le disant.
      dirt_en_inventaire: craft.countOf(bot, PILER_DIRT),
      echafaudage: scaffoldingStock(bot),
      buches: snapshot.buches,
      planches: snapshot.planches,
      batons: snapshot.batons,
      etablis: snapshot.etablis,
      porte_en_inventaire: snapshot.portes,
      outils: snapshot.outils
      // `fabrications_possibles` n est PAS ici : il est deja a la racine de
      // l etat (voir extraState), et le prompt ne cite que celle-la. Le
      // dupliquer ici doublait les jetons a chaque tour.
    }
  }

  // Orientation : le modele lit un cap utilisable, pas des radians. La
  // convention est celle de skills.regarder (0 deg = nord, 90 = ouest, 180 =
  // sud, -90 = est), celle-la meme qu il emploie quand il demande `regarder`.
  function orientation () {
    const bot = host.getBot()
    if (!bot?.entity) return null

    const lacet = ((Math.round((bot.entity.yaw * 180) / Math.PI) + 180) % 360 + 360) % 360 - 180
    let cap = 'nord'
    if (lacet > 45 && lacet <= 135) cap = 'ouest'
    else if (lacet > 135 || lacet <= -135) cap = 'sud'
    else if (lacet > -135 && lacet <= -45) cap = 'est'

    return {
      cap,
      lacet,
      tangage: Math.round((bot.entity.pitch * 180) / Math.PI)
    }
  }

  // Substitut textuel a la capture d ecran : le bloc que le bot regarde. Le
  // planificateur local n est pas multimodal, une image serait ignoree ; ce
  // seul point de visee suffit a savoir ce qu il a sous les yeux.
  function lookedAtBlock () {
    const bot = host.getBot()
    if (!bot?.blockAtCursor) return null
    try {
      const block = bot.blockAtCursor(6)
      return block && block.name !== 'air' ? block.name : null
    } catch (_) {
      return null
    }
  }

  // Le bot previent le joueur de ce qui compte : une impasse. Le modele ne
  // decide pas de ce message — il ne le dirait pas — et il ne passe pas par
  // `dire`, donc il ne subit pas sa limite de repetition. Un delai court suffit
  // a eviter le spam.
  function announce (texte) {
    if (!texte || !mission) return

    const now = Date.now()
    if (now - (mission.lastAnnounceAt ?? 0) < ANNOUNCE_COOLDOWN_MS) return

    mission.lastAnnounceAt = now
    host.chat(texte)
  }

  // La memoire long terme vit desormais dans le prompt systeme (couche 3, mise
  // en cache) et la memoire de mission dans la couche 4, recollee a chaque
  // appel par planner.systemPrompt(). Le message utilisateur ne garde que les
  // COMpteurs : le modele connait ses budgets et sa place restante sans qu on
  // duplique le texte deja present dans le prompt.
  // `jetons_utilises` / `jetons_max` / `jetons_restants` restent exposes : ce
  // sont les champs historiques consomes par l interface web.
  function memoireCompteurs () {
    const snap = memory.snapshot()
    return {
      jetons: snap.jetons,
      plafonds: snap.plafonds,
      restants: snap.restants,
      generation: snap.generation,
      jetons_utilises: snap.jetons_utilises,
      jetons_max: snap.jetons_max,
      jetons_restants: snap.jetons_restants
    }
  }

  // L indice de navigation : pour la cible courante (bloc de la matiere visee,
  // ou repere de chantier), combien de degres tourner et de combien de blocs
  // avancer pour s en rapprocher. Le code mesure, le modele ne compte pas : il
  // lit `angle` et `distance` et compose `pivoter`/`regarder` + `avancer`.
  // Convention d angle : positif = tourner a gauche, negatif = a droite — le
  // signe du delta de yaw, celui qu appliquent `pivoter` et /api/turn.
  //
  // La distance est HORIZONTALE (XZ) : c est celle que la marche au sol reduit.
  // La distance 3D d une buche haute ne descend jamais sous sa hauteur, donc
  // le bot avancait sans jamais atteindre le seuil de portee, puis le
  // depassait : l oscillation observee autour de l arbre.
  function navigationHint (block) {
    const bot = host.getBot()
    if (!bot?.entity) return null

    const here = bot.entity.position

    // Cible : le bloc de la matiere visee, sinon le repere du chantier.
    const target = block ?? (mission.kind === 'construction' && mission.landmarkResource
      ? findTargetBlock(mission.landmarkResource)
      : null)
    if (!target) return null

    const dx = target.position.x + 0.5 - here.x
    const dz = target.position.z + 0.5 - here.z
    const distance = Math.hypot(dx, dz)

    // Yaw qui ferait face a la cible (0 = nord, +90 deg = ouest), puis delta
    // normalise en -180..180. Un delta positif se corrige par un tour a gauche.
    const wantedYaw = Math.atan2(-dx, -dz)
    let angle = ((wantedYaw - bot.entity.yaw) * 180) / Math.PI
    angle = ((angle + 180) % 360 + 360) % 360 - 180

    // A portee = assez pres HORIZONTALEMENT, et le bloc vise assez BAS pour etre
    // casse depuis ici. Un tronc haut n est pas a portee meme au pied : c est
    // le bloc le plus bas, choisi par findTargetBlock, qu il faut casser.
    const verticalGap = Math.max(0, target.position.y - here.y)
    const aPortee = blockInReach(bot, here, target.position.offset(0.5, 0.5, 0.5), REACH)

    return {
      cible: target.name,
      distance: Math.round(distance),
      angle: Math.round(angle),
      a_portee: aPortee
    }
  }

  // Fix 2 : indice vers l objet tombe le plus proche, pour que `ramasser` ait  // une direction meme quand aucun bloc n est en vue. Meme convention que
  // navigationHint (angle positif = a gauche, distance HORIZONTALE XZ).
  // `a_portee` vaut vrai dans le rayon de ramassage automatique
  // (ITEM_AUTO_PICKUP) : marcher dessus suffit, pas besoin d etre a 4 blocs.
  // Champ separe de `navigation` : celle-ci designe un BLOC a casser, celle-la
  // un OBJET a marcher dessus. Les confondre ferait casser sur un objet.
  function itemNavigationHint () {
    const bot = host.getBot()
    if (!bot?.entity) return null

    const items = nearbyItems()
    if (items.length === 0) return null

    const here = bot.entity.position
    const nearest = items[0]
    const dx = nearest.position.x - here.x
    const dz = nearest.position.z - here.z
    const distance = Math.hypot(dx, dz)

    const wantedYaw = Math.atan2(-dx, -dz)
    let angle = ((wantedYaw - bot.entity.yaw) * 180) / Math.PI
    angle = ((angle + 180) % 360 + 360) % 360 - 180

    return {
      cible: 'objet_au_sol',
      distance: Number(distance.toFixed(1)),
      angle: Math.round(angle),
      a_portee: itemInPickupRange(bot, here, nearest.position, ITEM_AUTO_PICKUP),
      combien: items.length
    }
  }

  // Blocs de la matiere visee proches mais TROP HAUTS pour etre casses depuis
  // le sol (filtres par findTargetBlock via MAX_REACH_UP). Sans cet indice,
  // un tronc haut est invisible de l etat (navigation null) et `piler` ne
  // serait jamais choisi. On ne retient que ce qu un pilier de PILER_MAX peut
  // rendre cassable : denivele au-dela de MAX_REACH_UP mais dans la montee
  // possible, et proche horizontalement (on pile sur place). Le plus bas
  // d abord : monter juste assez, jamais plus haut que necessaire.
  function highTargetHint () {
    const bot = host.getBot()
    const ids = targetBlockIds()
    if (!bot?.entity || ids.length === 0) return null

    const here = bot.entity.position
    const feetY = Math.floor(here.y)
    // Same sight rule as findTargetBlock, applied during the search: buried
    // matches (stone under the floor) must not fill the result cap.
    // Same footprint exclusion as findTargetBlock, also during the search:
    // the house being built is not a resource to climb to, and its placed
    // blocks must not fill the result cap.
    const emprise = empriseChantier()
    const admis = pos => !dansEmprise(emprise, pos) && blocExpose(bot, pos, feetY)
    let positions
    try {
      positions = bot.findBlocks({ matching: ids, useExtraInfo: block => admis(block.position), maxDistance: SEARCH_RADIUS, count: 32 })
        .filter(admis)
    } catch (_) {
      return null
    }
    const arbre = harvestResource() === 'bois' ? arbreInacheve() : null
    if (arbre) positions = arbre.filter(admis)

    let best = null

    for (const position of positions) {
      const dy = position.y - feetY
      if (dy <= MAX_REACH_UP || dy > MAX_REACH_UP + PILER_MAX) continue
      const horizontal = Math.hypot(position.x + 0.5 - here.x, position.z + 0.5 - here.z)
      if (horizontal > REACH) continue
      const block = bot.blockAt(position)
      if (!block) continue
      if (!best || dy < best.dy) best = { block, dy, horizontal }
    }

    if (!best) return null
    const hint = {
      cible: best.block.name,
      denivele: best.dy,
      distance: Number(best.horizontal.toFixed(1))
    }
    // Code-side only: the planner state serializes the three fields above.
    Object.defineProperty(hint, 'position', { value: best.block.position, enumerable: false })
    return hint
  }

  // Moteur d acces unique (interrupteur acces_unifie, eteint par defaut) : UN
  // calcul A* dont les pas sont marcher, sauter, chuter, ouvrir une porte,
  // casser un bloc tendre au niveau du corps, monter en tour et poser un sol
  // (navigation.js, options dig et place). Il remplace, quand il reussit, la
  // cascade d avancer (descendre du pilier, feuilles, montee, pont, trajet qui
  // creuse, poste de pilier) ; quand il echoue, la cascade reste le recours,
  // le temps que l A/B tranche.
  //
  // Politique, la meme pour toute cible :
  //   - casse : blocs tendres (durete <= 1 : terre, sable, gravier, feuilles),
  //     jamais sous le niveau des pieds de depart (pas de puits), jamais une
  //     buche, un bloc construit ni l emprise du chantier ; une feuille coute
  //     cher (detour prefere, l arbre reste entier) ;
  //   - pose : echafaudage de piler (terre d abord, puis planches pleines),
  //     jamais pendant un chantier ; une tour posee pour un arbre est retiree
  //     avec les piliers une fois l arbre fini.
  const ACCES_POSE_MAX = config.positiveIntOrThrow(process.env.MISSION_ACCES_POSE_MAX, 12, 'MISSION_ACCES_POSE_MAX')
  async function atteindre (bloc) {
    const bot = host.getBot()
    if (!bot?.entity || !bloc?.position) return { reached: false, code: 'unavailable' }
    const travail = ['recolte', 'construction'].includes(mission.kind)
    const chantier = empriseChantier()
    const piedsY = Math.floor(bot.entity.position.y)
    const casses = []
    const poses = []
    const pourArbre = featureOn('arbre_fini') && (TREE_LOG.test(bloc.name ?? '') || Boolean(arbreInacheve()))
    const dig = travail ? {
      cantBreak: Object.values(bot.registry.blocksByName).filter(b => TREE_LOG.test(b.name) || /_planks$|_door$|chest|crafting_table|furnace/.test(b.name)).map(b => b.id),
      canBreak: b => Number.isFinite(b.hardness) && b.hardness >= 0 && b.hardness <= 1 && b.diggable !== false &&
        b.position.y >= piedsY && !TREE_LOG.test(b.name) && !(chantier && dansEmprise(chantier, b.position)),
      cost: b => /_leaves$/.test(b.name ?? '') ? 8 : 0,
      digBlock: async b => {
        try {
          await craft.equipForBlock(bot, b)
          await withTimeout(bot.dig(b, true), 6000, 'creusage trop long')
        } catch (_) {
          return false
        }
        const gone = bot.blockAt(b.position)?.boundingBox !== 'block'
        if (gone) casses.push(b.name)
        return gone
      }
    } : null
    const items = scaffoldingStock(bot).materiaux.map(m => bot.registry.itemsByName[m.nom]?.id).filter(Number.isInteger)
    const place = travail && !chantier && items.length ? {
      items,
      max: ACCES_POSE_MAX,
      onPlaced: (cellule, { tour }) => {
        poses.push(cellule)
        if (tour && pourArbre) (mission.echafaudagePose ??= []).push(new Vec3(cellule.x, cellule.y, cellule.z))
      }
    } : null
    const result = await host.navigateToPosition(bloc.position.offset(0.5, 0.5, 0.5), {
      signal: mission.navigationAbort.signal, __owner: stepToken, interaction: true, dig, place,
      distanceBudget: 64, timeoutMs: 45000
    })
    mission.acces = { appels: (mission.acces?.appels ?? 0) + 1, atteints: (mission.acces?.atteints ?? 0) + (result.reached ? 1 : 0),
      poses: (mission.acces?.poses ?? 0) + poses.length, casses: (mission.acces?.casses ?? 0) + casses.length }
    return { ...result, poses: poses.length, casses: casses.length }
  }

  // Walks to the best untried pillar post for this target (own pillar undone
  // first: walking off its top is a fall). Each post is tried once per
  // mission and target, so the search ends instead of looping.
  async function rejoindrePosteDePilier (high, centre) {
    const bot = host.getBot()
    if (!bot?.entity || !['recolte', 'construction'].includes(mission.kind)) return {}
    const cleCible = `${high.position.x},${high.position.y},${high.position.z}`
    mission.postesPilier ??= {}
    const essayes = new Set(mission.postesPilier[cleCible] ?? [])
    const postes = perception.postesDePilier(bot, high.position, centre, essayes, { emprise: empriseChantier() })
    if (!postes.length) {
      return { resultat: `aucun poste de pilier libre autour de ${high.cible}` +
        (essayes.size ? ` (${essayes.size} deja essaye(s))` : '') + ' : viser une autre cible ou degager l acces' }
    }
    const porteur = bot.blockAt(bot.entity.position.offset(0, -0.5, 0))
    if (porteur && isPillarBlock(bot, porteur)) await descendScaffold(-Infinity, { pillarOnly: true })
    for (const poste of postes.slice(0, 3)) {
      if (mission.cancelled) break
      essayes.add(poste.cle)
      mission.postesPilier[cleCible] = [...essayes]
      const walk = await host.navigateToPosition(poste.pose, {
        signal: mission.navigationAbort.signal, __owner: stepToken, radius: 0.3, distanceBudget: 32, timeoutMs: 15000
      })
      if (walk?.reached) {
        return { atteint: true, resultat: `poste de pilier rejoint en ${poste.cle} (pilier de ${poste.hauteur} mesure)` }
      }
    }
    return { resultat: 'postes de pilier mesures autour de la cible injoignables a pied : viser une autre cible ou degager l acces' }
  }

  // Measure access from supported virtual posts without changing the world or permissions.
  function climbAccessHint (target) {
    const bot = host.getBot()
    if (!target || !bot?.entity?.onGround) return null
    const here = bot.entity.position
    const centre = target.position.offset(0.5, 0.5, 0.5)
    if (blockInReach(bot, here, centre, REACH)) return null
    const anchor = here.floored()
    if (Math.abs(here.y - anchor.y) > 0.05 || !estSolide(bot.blockAt(anchor.offset(0, -1, 0))) ||
      !clearSegment(bot, here, here, true)) return null
    const virtual = new Map()
    const key = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
    const view = { entity: bot.entity, blockAt: p => virtual.get(key(p)) ?? bot.blockAt(p) }
    const stock = scaffoldingStock(bot).total
    for (let height = 1; height <= PILER_MAX; height++) {
      const base = anchor.offset(0, height - 1, 0)
      // Match the action's per-level column checks; unknown or liquid is never free.
      for (let dy = 0; dy <= 2; dy++) {
        const block = view.blockAt(base.offset(0, dy, 0))
        if (!block || estLiquide(block.name) || estSolide(block)) return null
      }
      const from = here.offset(0, height - 1, 0)
      for (let sample = 0; sample <= 10; sample++) {
        const feet = from.offset(0, sample / 10, 0)
        if (!clearSegment(view, feet, feet)) return null
      }
      virtual.set(key(base), { name: 'dirt', position: base, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] })
      const feet = here.offset(0, height, 0)
      const feetY = Math.floor(feet.y)
      const horizontal = Math.hypot(centre.x - feet.x, centre.z - feet.z)
      // The next harvest must still admit this target, including the anti-pit filters.
      if (target.position.y < feetY - MAX_DIG_DEPTH || target.position.y > feetY + MAX_REACH_UP ||
        (target.position.y < feetY && horizontal < 1.5)) continue
      if (blockInReach(view, feet, centre, REACH)) {
        return { cible: { nom: target.name, position: { x: target.position.x, y: target.position.y, z: target.position.z } },
          hauteur_min: height, stock, manque: Math.max(0, height - stock) }
      }
    }
    return null
  }

  // Conseil de repli quand `avancer` est totalement bloque : si un tronc haut
  // pilable est a proximite (cible_haute) et que la dirt est en stock, marcher
  // ne sert a rien — il faut piler sur place puis casser depuis le haut.
  // Mesure en jeu : sans cette directive dans le resultat, le modele insistait
  // avec avancer (15 echecs a 0.0 bloc) malgre cible_haute et dirt en stock.
  function conseilPilier () {
    try {
      if (!mission || harvestResource() !== 'bois') return ''
      const bot = host.getBot()
      if (!bot?.entity) return ''
      const hint = highTargetHint()
      if (!hint) return ''
      const stock = scaffoldingStock(bot).total
      if (stock <= 0) return ''
      const hauteur = Math.max(PILER_MIN, Math.min(PILER_MAX, hint.denivele - 1))
      return ` Tronc haut a ${hint.distance} bloc(s) (+${hint.denivele}) et ${stock} blocs d echafaudage : ` +
        (stock >= hauteur
          ? `piler peut monter de ${hauteur} si appui et plafond le permettent ; reobserver ensuite.`
          : `stock insuffisant pour monter de ${hauteur} ; obtenir le manque puis reobserver.`)
    } catch (_) {
      return ''
    }
  }

  // Relief des 8 cases autour, lu sur les chunks deja charges (bot.blockAt),
  // sans pathfinder ni calcul de chemin. `null` si le bot est indisponible ;
  // une case vaut `null` quand son chunk n est pas charge. Ne leve jamais.
  function reliefLocal () {
    const bot = host.getBot()
    if (!bot?.entity || typeof bot.blockAt !== 'function') return null
    try {
      const p = bot.entity.position
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null
      const piedsY = Math.floor(p.y)
      const lire = (x, y, z) => {
        try {
          return bot.blockAt(p.offset(x - p.x, y - p.y, z - p.z))
        } catch (_) {
          return null
        }
      }
      return sondeAlentours(lire, Math.floor(p.x), piedsY, Math.floor(p.z))
    } catch (_) {
      return null
    }
  }

  // Denivele signe (blocs, entier) entre le pied de la cible et les pieds du
  // bot. `null` sans cible. Le modele ne pousse pas droit vers un relief >= 2.
  function deniveleCible (bloc) {
    try {
      const bot = host.getBot()
      if (!bloc?.position || !bot?.entity) return null
      return Math.round(bloc.position.y - Math.floor(bot.entity.position.y))
    } catch (_) {
      return null
    }
  }

  // Piste anti-oscillation : les 3 dernieres positions distinctes a >= 1 bloc
  // (distance 3D, comme safeTrail), arrondies a 0,1. Trace locale a la mission
  // (index.js garde sa propre safeTrail, hors perimetre) : mise a jour a chaque
  // etat, exposee telle quelle pour que le modele voie une boucle.
  function pisteRecente () {
    try {
      const bot = host.getBot()
      if (!bot?.entity) return null
      const p = bot.entity.position
      const pt = [Number(p.x.toFixed(1)), Number(p.y.toFixed(1)), Number(p.z.toFixed(1))]
      if (!Array.isArray(mission.piste)) mission.piste = []
      const dernier = mission.piste[mission.piste.length - 1]
      if (!dernier || Math.hypot(pt[0] - dernier[0], pt[1] - dernier[1], pt[2] - dernier[2]) >= 1) {
        mission.piste.push(pt)
        if (mission.piste.length > 3) mission.piste = mission.piste.slice(-3)
      }
      return mission.piste.length > 0 ? mission.piste.slice() : null
    } catch (_) {
      return null
    }
  }

  // Boussole de secours quand aucune cible n est en vue (navigation null) :
  // direction opposee a la piste recente si elle montre un deplacement net,
  // sinon rotation sur les 8 caps pour varier a chaque tour. Texte court, sans
  // coordonnees. `null` des qu une navigation existe.
  function boussoleSecours (navigation, piste) {
    if (navigation) return null
    try {
      if (Array.isArray(piste) && piste.length >= 2) {
        const a = piste[0]
        const b = piste[piste.length - 1]
        const dx = a[0] - b[0]
        const dz = a[2] - b[2]
        if (Math.hypot(dx, dz) >= 1) return `essaie ${capDepuisVecteur(dx, dz)}`
      }
      const caps = ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ouest', 'ouest', 'nord-ouest']
      const i = Number.isInteger(mission.boussoleIdx) ? mission.boussoleIdx : 0
      mission.boussoleIdx = (i + 1) % caps.length
      return `essaie ${caps[i]}`
    } catch (_) {
      return null
    }
  }

  // Diagnostic des « Timed out » du banc (2026-10-10) : un bot dont la boucle
  // d evenements se bloque plus de ~30 s est expulse par le serveur. Un etat
  // long a construire (solveur, recherches de blocs) se dit dans le journal.
  function buildState () {
    const debut = Date.now()
    try {
      return buildStateMesure()
    } finally {
      const ms = Date.now() - debut
      if (ms >= 1000) console.log(`[lent] etat de mission construit en ${ms} ms`)
    }
  }

  function buildStateMesure () {
    const bot = host.getBot()
    const position = bot.entity.position
    const block = findTargetBlock()
    // Meme metrique que l indice de navigation : distance horizontale, et
    // portee jugee sur l ecart vertical. La distance 3D d une buche haute ne
    // descend jamais sous sa hauteur : le bot etait juge « pas encore arrive »
    // meme au pied de l arbre, d ou l ordre d avancer sans fin.
    const horizontal = block
      ? Math.hypot(block.position.x + 0.5 - position.x, block.position.z + 0.5 - position.z)
      : null
    const verticalGap = block ? Math.max(0, block.position.y - position.y) : null
    const dims = mission.dimensions

    // Un geste est court et sans ressource : on ne lui envoie pas l etat d une
    // recolte (inventaire, chantier, blocs cibles), qui n a aucun sens ici et que
    // le petit modele prendrait pour une consigne. Etat minimal, decision nette.
    if (mission.kind === 'geste') {
      const demandeur = bot.players[mission.requester]?.entity
      // Servi une fois, comme dans l etat complet : le tour d apres est un
      // nouvel essai, l obstacle est derriere.
      const bloque = Boolean(mission.lastBlocked)
      mission.lastBlocked = false
      // Version minimale : pas de cible donc pas de denivele ; le relief, la
      // piste et la boussole suffisent a avancer sans alterner a pile ou face.
      const pisteGeste = pisteRecente()
      return {
        consigne: {
          texte: mission.objective,
          precisions: mission.instructions,
          demandeur: mission.requester,
          type: 'geste'
        },
        // Les compteurs de memoire sont envoyes meme en `geste` :
        // `memoriser`/`oublier` y sont disponibles. Le texte de la memoire,
        // lui, vit dans le prompt systeme (couches 3 et 4).
        memoire: memoireCompteurs(),
        bot: {
          position: {
            x: Number(position.x.toFixed(1)),
            y: Number(position.y.toFixed(1)),
            z: Number(position.z.toFixed(1))
          },
          dans_liquide: host.inLiquid(),
          orientation: orientation()
        },
        demandeur: demandeur
          ? { visible: true, distance: Number(position.distanceTo(demandeur.position).toFixed(1)) }
          : { visible: false },
        // Anti-oscillation visible aussi en geste : avancer droit devant sans
        // relief alterne left/right a pile ou face devant le premier mur.
        environnement: {
          relief_local: reliefLocal(),
          piste_recente: pisteGeste,
          boussole_secours: boussoleSecours(null, pisteGeste)
        },
        dernieres_etapes: mission.history.slice(-4),
        // Meme signal de contournement que pour les autres missions : un
        // `avancer` qui vient d echouer bloque doit faire contourner, pas
        // re-avancer au meme cap. Servi une fois, comme dans l etat complet.
        avancer_bloque: bloque,
        // Grand livre des dons (S6) : tente/retire/prouve/incertain et blocage.
        livraison: {
          engagements: deliveryLedgersFor(mission).map(deliveryLedgerView),
          blocage_don: deliveryBlockReason(mission)
        },
        chat_recent: host.recentChat ? host.recentChat() : [],
        blocage: {
          detecte: mission.pendingJoin || detectStuck().detecte,
          raison: mission.pendingJoin ? 'demandeur non rejoint' : detectStuck().raison
        }
      }
    }

    // Relief, denivele, piste et boussole : mesures avant l etat, pour que la
    // boussole reuse la meme navigation (un seul balayage du repere).
    // Matiere presente mais hors des bornes de casse (fond de trou, haut de
    // falaise) : l indice de navigation la montre quand meme, sinon le modele
    // la croyait absente et marchait a l aveugle.
    const lointaine = !block && mission.kind === 'recolte' ? findTargetBlock(undefined, { anyHeight: true }) : null
    const nav = navigationHint(block ?? lointaine)
    const piste = pisteRecente()
    const cibleDeniv = block ??
      (mission.kind === 'construction' && mission.landmarkResource
        ? findTargetBlock(mission.landmarkResource)
        : null)
    // Cible haute (pilier utile) : mesuree une fois, servie deux fois (le champ
    // `cible_haute` et le signal `dirt_secondaire_admise` qui en derive).
    const cibleHaute = highTargetHint()
    const secondaryAdmitted = dirtSecondaireAdmise(cibleHaute)
    const secondaryDirt = secondaryDirtFor(block, secondaryAdmitted)

    const state = {
      // Le brief complet, a chaque tour : c est ce qui fait que la consigne
      // d origine ne se perd pas en cours de route. La cible de fabrication
      // y est persistee (fabrication_cible/quantite) : le pilote la lit a
      // chaque tour au lieu de retomber sur un quota de recolte.
      consigne: {
        texte: mission.objective,
        precisions: mission.instructions,
        demandeur: mission.requester,
        type: mission.kind,
        matiere: mission.resource,
        repere: mission.landmark,
        porte_demandee: mission.wantsDoor,
        // Le chantier choisi fait foi (plan libre ou boite reduite au stock) :
        // la phrase lue en cube annoncait 20 blocs pour une arche de 11 (vu :
        // arche complete, modele en boucle 300 s sur « il manque des blocs »).
        dimensions: mission.plan
          ? `${mission.plan.width} x ${mission.plan.depth} x ${mission.plan.height} (chantier choisi, ${mission.plan.blocks.length} blocs)`
          : `${dims.width} x ${dims.depth} x ${dims.height}`,
        fabrication_cible: mission.fabricationCible ?? null,
        fabrication_quantite: mission.fabricationCible ? (mission.fabricationQuantite ?? 1) : null,
        // Objets demandes ensuite, un a la fois, dans l ordre du joueur.
        fabrications_suivantes: mission.fabricationSuite?.length ? mission.fabricationSuite.map(f => f.objet) : null,
        // Objets a poser dans le monde (A/B `poser`), comptes par le code.
        poses: mission.poses?.length
          ? mission.poses.map(p => ({ objet: p.objet, voulues: p.quantite ?? 1, posees: mission.posesFaites?.[p.objet] ?? 0 }))
          : null
      },
      quota_par_defaut: DEFAULT_QUOTA,
      // La quantite reellement visee (lue dans la consigne, sinon le defaut).
      // Le modele la lit ; c est `finishAllowed` qui s en sert pour juger.
      quota_vise: mission.wholeTree ? null : mission.quota,
      // Un arbre entier demande : le code compte ses buches, le modele decide.
      arbre_demande: mission.wholeTree
        ? (treeStatus() ?? { commence: false, consigne: 'coupe une premiere buche : elle fixe l arbre' })
        : null,
      // Tree started (any wood job): finished before anything else.
      arbre_en_cours: arbreInacheve()
        ? { buches_debout: arbreInacheve().length, consigne: 'couper toutes ses buches avant toute autre chose (piler si trop haut) ; aucun autre arbre avant' }
        : null,
      // Compteurs de memoire seulement : la memoire long terme est passee en
      // couche 3 du prompt systeme (mise en cache), la memoire de mission en
      // couche 4 recollee a chaque appel. Une ecriture memoire n invalide donc
      // plus rien (voir memory.js et planner.systemPrompt).
      memoire: memoireCompteurs(),
      progression: {
        etapes_effectuees: mission.steps,
        blocs_casses: mission.broken,
        objets_recoltes: collected(),
        // Apres rehydrate, le passe est porte par baseUnits (preuve durable),
        // jamais recompte comme des actions de cette session.
        unites_recoltees: Math.max(mission.broken, collected()) + (mission.baseUnits ?? 0),
        // Dirt cassee en mission bois pour alimenter un pilier : compte a part,
        // jamais dans le quota bois (voir `casser` secondaire). Le modele la
        // lit, `finishAllowed` l ignore.
        dirt_secondaire: mission.dirtSecondaire ?? 0,
        // Preuve de fabrication (mesuree) : objets cibles produits depuis le
        // debut + visee. Hors fabrication : 0/null, legacy recolte inchange.
        fabrication_produits: fabricationProduced(),
        fabrication_visee: mission.fabricationCible ? (mission.fabricationQuantite ?? 1) : null,
        temps_ecoule_s: Math.round(activeDurationMs() / 1000)
      },
      // Grand livre des dons (S6) : le pilote y lit tente/retire/prouve/
      // incertain par engagement, et le blocage ecrit (pas de retoss auto).
      livraison: {
        engagements: deliveryLedgersFor(mission).map(deliveryLedgerView),
        blocage_don: deliveryBlockReason(mission)
      },
      bot: {
        position: {
          x: Number(position.x.toFixed(1)),
          y: Number(position.y.toFixed(1)),
          z: Number(position.z.toFixed(1))
        },
        vie: bot.health ?? null,
        dans_liquide: host.inLiquid(),
        en_deplacement: Boolean(bot.pathfinder?.isMoving?.()),
        // Cap et inclinaison : sans eux le modele ne sait pas ce qu il regarde,
        // et `regarder`/`pivoter` deviennent des gestes a l aveugle.
        orientation: orientation()
      },
      environnement: {
        bloc_cible_le_plus_proche: block ? block.name : null,
        distance_du_bloc_cible: horizontal === null ? null : Number(horizontal.toFixed(1)),
        bloc_cible_a_portee: Boolean(block && blockInReach(bot, position, block.position.offset(0.5, 0.5, 0.5), REACH)),
        // Indice de navigation : le code mesure, le modele ne compte pas. Il
        // lit l angle a tourner (positif = a gauche, negatif = a droite) puis
        // demande `avancer` de la distance indiquee. C est ce qui remplace
        // `approcher`/`explorer`, delegues au pathfinder et retires.
        navigation: nav,
        objets_au_sol_a_proximite: nearbyItems().length,
        // Nom, nombre et hauteur relative (dy) des objets tombes : un minerai
        // tombe sur un rebord (dy >= 2) ne se ramasse pas en marchant.
        objets_au_sol: objetsAuSol(),
        // Fix 2 : direction du plus proche objet tombe (pivoter angle puis
        // avancer distance, ou `ramasser` qui s en charge seul). Separe de
        // `navigation` (bloc a casser) pour ne pas faire casser sur un objet.
        navigation_objet: itemNavigationHint(),
        // Le bloc sous le reticule, a defaut d image (voir lookedAtBlock).
        bloc_regarde: lookedAtBlock(),
        // Bloc proche mais trop haut pour etre casse depuis le sol : la raison
        // de choisir `piler` (monter en pilier avec de la dirt) puis de casser
        // depuis le haut. Nul quand tout est a portee ou quand rien ne depasse.
        cible_haute: cibleHaute,
        acces_par_montee: climbAccessHint(block),
        // Hache recommandee : mission bois sans hache alors qu une fabrication
        // utile existe (la hache, ou planches/batons/etabli vers elle). Le code
        // mesure la faisabilite, le modele decide de l ordre.
        hache_recommandee: hacheRecommandee(),
        // Gestes faits par les reflexes (sans toi) depuis peu : ramassage,
        // mise a l abri, pas de cote. Tiens-en compte, ne les refais pas.
        reflexes_recents: (mission.reflexes ?? []).slice(-3),
        // Fabrication, ou outil exige par la matiere de la mission : chaine de
        // prerequis calculee par le code depuis l inventaire reel (recolter /
        // fabriquer / outil exige, etabli). La premiere etape est la prochaine
        // chose utile ; `bloque` dit ce que le bot ne sait pas faire
        // (cuisson...). Nul sinon.
        prerequis: (() => {
          const plan = acquisition()
          return plan ? { ...acquirePlan.summarize(plan), matiere_a_recolter: harvestResource() } : null
        })(),
        // Dirt secondaire admise : mission bois avec cible_haute et stock de
        // dirt insuffisant pour piler. Autorise `casser` sur de la dirt au sol
        // sans toucher au quota bois.
        dirt_secondaire_admise: secondaryAdmitted,
        // Same candidate as the dig fallback, not a promise that digging succeeds.
        dirt_secondaire_cible: secondaryDirt ? {
          nom: secondaryDirt.name,
          position: { x: secondaryDirt.position.x, y: secondaryDirt.position.y, z: secondaryDirt.position.z },
          distance: Number(position.distanceTo(secondaryDirt.position.offset(0.5, 0.5, 0.5)).toFixed(2)),
          a_portee: true
        } : null,
        // Deplacement robuste sans pathfinder : le relief des 8 cases dit ou
        // passer, le denivele dit s il faut contourner, la piste montre une
        // boucle, la boussole donne un cap quand rien n est en vue. Champs
        // nuls si illisibles : jamais d exception sur un chunk non charge.
        relief_local: reliefLocal(),
        denivele_cible: deniveleCible(cibleDeniv),
        piste_recente: piste,
        boussole_secours: boussoleSecours(nav, piste)
      },
      dernieres_etapes: mission.history.slice(-4),
      // Ce que les joueurs viennent de dire. Relu a chaque etape, pour qu un
      // ordre glisse pendant la mission soit entendu au tour suivant.
      chat_recent: host.recentChat ? host.recentChat() : []
    }

    // Anti-oscillation entre gestes : la distance XZ vers la cible doit diminuer
    // geste apres geste. Si N gestes de mouvement se succedent sans gain
    // (avancer bloque a 0,0 bloc, appuyer immobile, casser trop loin redemande),
    // on force le signal de contournement au lieu de laisser osciller. Le seuil
    // est en gestes (NAV_STAGNANT_MAX), pas en secondes : tout ce qui compte ici
    // est mesure en blocs. Servi comme un avancer_bloque classique.
    if (mission.kind !== 'geste' && block && horizontal !== null) {
      const key = `${block.position.x},${block.position.y},${block.position.z}`
      if (mission.approachKey !== key) {
        mission.approachKey = key
        mission.approachDist = horizontal
        mission.approachStagnant = 0
      } else if (mission.approachDist !== null) {
        if (horizontal + NAV_GAIN_MIN < mission.approachDist) {
          mission.approachDist = horizontal
          mission.approachStagnant = 0
        } else {
          const tail = mission.history.slice(-3)
          const gestesMouvement = ['avancer', 'appuyer', 'pivoter', 'casser', 'ramasser']
          if (tail.length > 0 && tail.every(h => gestesMouvement.includes(h.action))) {
            mission.approachStagnant += 1
          } else if (tail.length > 0) {
            mission.approachDist = horizontal
            mission.approachStagnant = 0
          }
          if (mission.approachStagnant >= NAV_STAGNANT_MAX) {
            mission.lastBlocked = true
            mission.approachStagnant = 0
            mission.approachDist = horizontal
          }
        }
      }
    } else if (!block) {
      mission.approachKey = null
      mission.approachDist = null
      mission.approachStagnant = 0
    }

    // Un `avancer` vient d echouer sur un obstacle : le dire STRUCTURE, une
    // fois, au tour suivant seulement. Le texte de dernieres_etapes disait
    // deja « bloque », mais un petit modele n en tire pas la sequence de
    // contournement ; un champ booleen frais, lu avec la regle du prompt,
    // si. Reinitialise des qu il est servi : l obstacle est derriere, le tour
    // d apres c est un nouvel essai.
    if (mission.lastBlocked) {
      state.avancer_bloque = true
      mission.lastBlocked = false
    }

    // Un arret refuse au tour precedent : le modele doit savoir pourquoi, sinon
    // il repropose le meme arret et on brule les trois refus pour rien.
    if (mission.refusalNote) {
      state.arret_refuse = mission.refusalNote
      mission.refusalNote = null
    }

    // Une etape a ete rabotee ou rejetee au tour precedent : le modele doit le
    // savoir, sinon il repropose exactement le meme plan. Sans cela, `explorer`
    // ramene a 8 blocs etait reclame a l ampleur 4 indefiniment.
    if (mission.planAdjustNote) {
      state.plan_ajuste = mission.planAdjustNote
      mission.planAdjustNote = null
    }

    // En survie, l inventaire est la moitie de la decision : c est lui qui dit
    // s il faut casser, fabriquer ou poser. En creative il ne veut rien dire,
    // la main se remplissant toute seule, donc on ne l envoie pas.
    if (mission.supply === 'harvest') {
      state.inventaire = stocks()

      if (block) {
        const check = craft.harvestCheck(bot, block)
        state.environnement.outil_necessaire = check.ok ? null : check.need
        state.environnement.casse_productive = check.ok
      }
    }

    if (mission.kind === 'construction') {
      const progress = buildProgress()
      const material = buildItem()

      state.chantier = {
        emplacement_choisi: Boolean(mission.plan),
        materiau: material ?? mission.buildBlock,
        blocs_prevus: progress.total,
        blocs_poses: progress.done,
        blocs_restants: progress.left,
        porte_posee: doorPlaced(),
        repere_en_vue: Boolean(findTargetBlock(mission.landmarkResource))
      }

      if (mission.supply === 'harvest') {
        const stock = state.inventaire?.materiau_en_inventaire ?? 0
        state.chantier.materiau_en_inventaire = stock
        state.chantier.blocs_posables_maintenant = Math.min(stock, progress.left)
        // Le fait saillant du mode survie : il reste des blocs a poser mais
        // rien pour les poser. C est ce qui doit faire choisir « casser » ou
        // « fabriquer » plutot que « construire ».
        state.chantier.materiau_manquant = Math.max(0, progress.left - stock)
        state.chantier.porte_en_inventaire = state.inventaire?.porte_en_inventaire ?? 0
        const besoins = besoinsConstruction(progress, stock)
        if (besoins) state.besoins = besoins
      }
    }

    // Le progres est reevalue a chaque tour : c est lui qui dit si le bot
    // avance, et donc s il est bloque (detectStuck).
    const fingerprint = progressFingerprint()
    if (fingerprint > mission.lastProgress) {
      mission.lastProgress = fingerprint
      mission.lastProgressStep = mission.steps
      // Un progres mesure rouvre les reparations (arbre suivant : nouveau tronc haut).
      mission.reparesCodes?.clear()
    }

    const stuck = detectStuck()
    mission.stuck = stuck.detecte
    mission.stuckWhy = stuck.raison

    // Ce que le modele voit du blocage : l impasse mesuree et sa cause. Le code
    // l annonce au joueur et le journalise (`[blocage]`).
    state.blocage = { detecte: stuck.detecte, raison: stuck.raison }

    // Le joueur qui a donne la consigne. Sert de deux facons au planificateur :
    // repondre juste a « tu me vois ? », et savoir vers qui aller. La position
    // reste une mesure du code, jamais une valeur demandee au modele.
    const demandeur = bot.players[mission.requester]?.entity
    state.demandeur = demandeur
      ? {
          visible: true,
          distance: Number(position.distanceTo(demandeur.position).toFixed(1))
        }
      : { visible: false }

    return state
  }

  // -------------------------------------------------------------------------
  // Deplacement : des gestes unitaires, pas de pathfinder (Fix 3).
  //
  // Le pathfinder de cette version est casse au-dela de quelques blocs : il
  // annonce `goal_reached` en s arretant a une dizaine de blocs de la cible, ou
  // reste en calcul jusqu au delai. Le deplacement de mission est donc fait de
  // gestes directs (touches tenues), que le planificateur compose lui-meme :
  // `regarder`/`pivoter` pour orienter, `avancer` pour parcourir, `sauter` pour
  // un denivele. Meme le ralliement au poste de tir d un chantier
  // (build.moveTo) est en gestes (pivoter + forward + jump par paliers, memes
  // regles que walkForward). Seul le sauvetage aquatique (`sortir` ->
  // host.rescue, hors de ce fichier) garde le pathfinder : c est Fix 4, intouche.
  // -------------------------------------------------------------------------

  // Distance horizontale entre deux positions : l altitude ne compte pas dans
  // un parcours au sol, sinon chaque denivele fausse le compte de blocs.
  function horizontalDistance (a, b) {
    return Math.hypot(a.x - b.x, a.z - b.z)
  }

  // La primitive de deplacement : avancer dans la direction REGARDSEE en tenant
  // `forward`, avec `jump` ajoute des que le bot ne progresse plus au sol (pour
  // franchir un denivele d un bloc). Rend le nombre de blocs REELLEMENT
  // parcourus, et echoue si un obstacle de deux blocs ou plus immobilise le bot.
  //
  // Le modele ne donne qu un nombre de cases (`distance`) : la direction vient
  // du regard, la mesure du deplacement vient du code.
  async function walkForward (distance) {
    const bot = host.getBot()
    if (!bot?.entity) return { moved: 0, blocked: true }

    // Un objectif de pathfinder en cours se battrait avec les touches tenues.
    host.stopPathfinding()

    const start = bot.entity.position.clone()
    // Garde-fou : le delai d une etape de mission borne tout geste de marche,
    // meme long. Un trajet qui depasse rend la main avec la distance parcourue.
    const deadline = Date.now() + Math.min(
      STEP_TIMEOUT_MS,
      distance * STEP_MS_PER_BLOCK + WALK_EXTRA_MS
    )
    let lastProgressAt = Date.now()
    let lastAnchor = bot.entity.position.clone()
    // Nombre de sauts deja tentes depuis le dernier progres REEl. Remis a zero
    // des que le bot avance, il borne les tentatives sur un obstacle donne.
    let jumpAttempts = 0

    // Bord d une chute blessante vu a CHAQUE tick de physique, touches
    // relachees dans le meme tick : la boucle ne passe que toutes les 100 ms
    // (plus sous charge) et le bot court souvent (saut preventif, sprint
    // tenu) ; il voyait le vide puis glissait par-dessus (terrain/plateau
    // a45b981 : « arret au bord », chute de 5 blocs).
    let videVu = null
    const surveilleBord = () => {
      if (videVu !== null) return
      const chute = videDevant(bot)
      if (chute === null) return
      videVu = chute
      try { bot.clearControlStates() } catch (_) {}
    }
    if (typeof bot.on === 'function') bot.on('physicsTick', surveilleBord)

    bot.setControlState('forward', true)
    // Saut PREVENTIF en cours : `jump` (et `sprint`) tenus avant le contact.
    let sautPreventif = false

    try {
      while (true) {
        // Le bot peut etre deconnecte en plein trajet.
        const live = host.getBot()
        if (!live?.entity) return { moved: 0, blocked: true }

        // Un stop du joueur ou une fin de mission coupe le geste en cours.
        if (mission?.cancelled) {
          return { moved: Number(horizontalDistance(start, live.entity.position).toFixed(2)), blocked: false }
        }

        const here = live.entity.position
        const moved = horizontalDistance(start, here)

        if (moved >= distance) return { moved: Number(moved.toFixed(2)), blocked: false }

        if (Date.now() > deadline) {
          return { moved: Number(moved.toFixed(2)), blocked: moved < 0.5 }
        }

        // Jamais de chute de plus de deux blocs a la marche : arret au bord.
        const chute = videVu ?? videDevant(live)
        if (chute !== null) {
          return { moved: Number(moved.toFixed(2)), blocked: true, vide: chute }
        }

        // Saut PREVENTIF : franchir la marche d un bloc AVANT le contact.
        // Cause racine mesuree : une fois pousse contre le mur, `onGround` est
        // faux en continu (prismarine-physics ne saute que si onGround), donc
        // le saut APRES blocage ne part jamais. Le seul moment ou il part est
        // cette fenetre, ~0,9 bloc avant (plus large avec `sprint`). Un obstacle
        // de deux blocs ou plus ('wall') n est pas saute : le contournement de
        // l appelant s en charge. En liquide on ne saute pas (piege 3).
        const devant = marcheDevant(live)
        if (devant === 'step' && !host.inLiquid()) {
          if (!sautPreventif) {
            try { bot.setControlState('jump', true) } catch (_) {}
            try { bot.setControlState('sprint', true) } catch (_) {}
            sautPreventif = true
          }
        } else if (sautPreventif) {
          try { bot.setControlState('jump', false) } catch (_) {}
          try { bot.setControlState('sprint', false) } catch (_) {}
          sautPreventif = false
        }

        const progress = horizontalDistance(lastAnchor, here)
        if (progress >= STUCK_CHECK_STEP) {
          lastAnchor = here.clone()
          lastProgressAt = Date.now()
          jumpAttempts = 0
        } else {
          // Premier saut plus tot (JUMP_FIRST_MS) que les suivants
          // (JUMP_RETRY_MS), pour franchir un denivele d un bloc sans trainer.
          const fenetre = jumpAttempts === 0 ? JUMP_FIRST_MS : JUMP_RETRY_MS
          if (Date.now() - lastProgressAt >= fenetre) {
            // Plus de progres au sol : un denivele d un bloc se franchit au
            // saut. En liquide on ne saute pas (le bot ne sait pas nager,
            // piege 3) : on laisse le chien de garde et `sortir` gerer ce cas.
            if (host.inLiquid()) {
              // Bloque sans pouvoir sauter (liquide) : echec.
              return { moved: Number(moved.toFixed(2)), blocked: true }
            }
            if (peutSauter(live)) {
              if (jumpAttempts >= JUMP_MAX_ATTEMPTS) {
                // Plusieurs sauts sans rien degager : obstacle de deux blocs ou
                // plus, ou paroi. On echoue proprement pour que le
                // planificateur tourne, contourne ou change d approche.
                return { moved: Number(moved.toFixed(2)), blocked: true }
              }
              // Saut FRAIS : relacher puis rappuyer. Un appui jamais relache ne
              // relance pas le saut, et c est ce qui rendait la tentative
              // unique peu fiable (mesure en jeu).
              // Cause mesuree en plus : pousse contre un mur (table, tronc),
              // `forward` tenu garde `onGround` faux en continu et la physique
              // ignore le saut meme frais — le bot reste colle a 0.0 bloc.
              // On relache donc `forward` le temps que le saut parte, puis on
              // le retient : sans cela, ni les rattrapages ni les strafes
              // (qui tiennent forward) ne decolent jamais du mur.
              try { bot.setControlState('forward', false) } catch (_) {}
              try { bot.setControlState('jump', false) } catch (_) {}
              await sleep(120)
              try { bot.setControlState('jump', true) } catch (_) {}
              await sleep(250)
              if (mission?.cancelled) {
                return { moved: Number(horizontalDistance(start, live.entity.position).toFixed(2)), blocked: false }
              }
              // `sprint` avec le saut : un saut vertical retombe dans le trou
              // (mesure en jeu : levre de 1 bloc, apex 1.25 sans elan).
              // Sprint + saut franchit 2 blocs et porte sur 2+ blocs — tenu
              // jusqu a la fin du trajet (finally le relache).
              try { bot.setControlState('forward', true) } catch (_) {}
              try { bot.setControlState('sprint', true) } catch (_) {}
              jumpAttempts += 1
              lastProgressAt = Date.now()
            } else {
              // En l air (saut en cours, descente) : on patiente encore.
              lastProgressAt = Date.now()
            }
          }
        }

        await sleep(WALK_TICK_MS)
      }
    } finally {
      try { bot.removeListener?.('physicsTick', surveilleBord) } catch (_) {}
      bot.setControlState('forward', false)
      bot.setControlState('jump', false)
      try { bot.setControlState('sprint', false) } catch (_) {}
    }
  }

  // Repli de contournement (sans pathfinder) : un pas de cote + avant + saut
  // d environ une seconde, comme build.moveTo. L obstacle d un bloc se franchit
  // au saut auto de walkForward ; un obstacle trop haut (deux blocs ou plus) se
  // contourne, il ne se pousse pas droit. Rend les blocs parcourus, sans jamais
  // lever : l appelant decide de l echec.
  async function strafeStep (side) {
    const bot = host.getBot()
    if (!bot?.entity) return 0

    host.stopPathfinding()
    const before = bot.entity.position.clone()

    try {
      bot.setControlState(side, true)
      bot.setControlState('forward', true)
      bot.setControlState('jump', true)
      await sleep(NAV_STRAFE_MS)
    } finally {
      try { bot.setControlState(side, false) } catch (_) {}
      try { bot.setControlState('forward', false) } catch (_) {}
      try { bot.setControlState('jump', false) } catch (_) {}
    }

    await sleep(150)
    const after = host.getBot()?.entity?.position
    return after ? Number(horizontalDistance(before, after).toFixed(2)) : 0
  }

  // Il y avait ici `enterBuildMode` / `leaveBuildMode`, qui basculaient le bot
  // en creative le temps d un chantier. Plus de bascule : le bot n a plus de
  // pouvoir d administration. La pose depuis un poste de tir au sol n a de
  // toute facon jamais demande le creative (voir build.findVantage).

  // `avancer` sans cible bloque (mur, marche de 2, arbre) : au lieu de
  // renvoyer le modele a `appuyer` (souvent immobile, encastre : banc de la
  // PR #38), le navigateur partage cherche un detour vers le point debout le
  // plus lointain du cap (denivele de 2 au plus). Rend la distance gagnee.
  function pointDansLeCap (yaw, distance) {
    const bot = host.getBot()
    if (!bot?.entity || typeof bot.blockAt !== 'function') return null
    const p = bot.entity.position
    const dx = -Math.sin(yaw)
    const dz = -Math.cos(yaw)
    for (let k = Math.min(24, Math.round(distance)); k >= 3; k -= 1) {
      const x = Math.floor(p.x + dx * k)
      const z = Math.floor(p.z + dz * k)
      for (const dy of [0, 1, -1, 2, -2]) {
        const y = Math.floor(p.y) + dy
        try {
          if (build.standable(bot, x, y, z)) return new Vec3(x + 0.5, y, z + 0.5)
        } catch (_) { return null }
      }
    }
    return null
  }
  async function detourDansLeCap (yaw, restant) {
    if (mission.cancelled || typeof host.navigateToPosition !== 'function' || restant < 1) return 0
    const point = pointDansLeCap(yaw, restant)
    if (!point) return 0
    const avant = host.getBot()?.entity?.position?.clone?.()
    const r = await host.navigateToPosition(point, {
      signal: mission.navigationAbort.signal, __owner: stepToken,
      radius: 1.5, timeoutMs: 15000, distanceBudget: Math.min(48, Math.ceil(restant * 2) + 4)
    })
    const apres = host.getBot()?.entity?.position
    const gagne = avant && apres ? Math.hypot(apres.x - avant.x, apres.z - avant.z) : 0
    console.log(`[mission] avancer : detour vers ${point.x.toFixed(1)} ${point.y} ${point.z.toFixed(1)} -> ${r.code}, ${gagne.toFixed(1)} bloc(s)`)
    return r.reached || gagne >= 1 ? gagne : 0
  }

  // Arbre commence, arbre fini : aucun bloc du chantier avant sa derniere
  // buche. Sinon le bot fermait sa cabane (murs, porte) avec l arbre encore
  // debout dehors et restait dedans, fin refusee jusqu au plafond
  // (composite/cabin-from-scratch, bancs 5a0fe24, 8090c3b, 41565cc).
  function arbreAvantChantier () {
    const ouvert = arbreInacheve()
    return ouvert
      ? { resultat: `arbre commence : ${ouvert.length} buche(s) encore debout, finir la coupe avant de construire`, echec: true, code: 'arbre_inacheve' }
      : null
  }

  // Un retour ou don demande apres la coupe attend aussi le bois tombe.
  // Le plan anticipe peut proposer de partir avant la derniere mesure.
  function arbreAvantLivraison (objet = null) {
    if (!livraisonDemandee(mission)) return null
    // Un trajet sans objet connu peut servir une autre etape du chantier.
    // L arbre entier explicitement demande reste une obligation mesuree ;
    // les autres dons de bois sont controles quand leur objet est connu.
    if (objet === null && !mission.wholeTree) return null
    if (objet !== null && !skills.RESOURCES.bois.raw.test(objet) && !skills.RESOURCES.bois.items.test(objet)) return null
    const ouvert = arbreInacheve()
    if (ouvert) return { resultat: `arbre commence : ${ouvert.length} buche(s) encore debout, finir la coupe avant de rapporter le bois`, echec: true, code: 'arbre_inacheve' }
    if (!mission.wholeTree) return null
    const arbre = treeStatus()
    if (!arbre || arbre.buches_restantes > 0) {
      return { resultat: 'arbre demande encore a couper avant de rapporter le bois', echec: true, code: 'arbre_inacheve' }
    }
    if (arbre.buches_au_sol > 0) {
      return { resultat: `${arbre.buches_au_sol} buche(s) au sol a ramasser avant de rapporter le bois`, echec: true, code: 'arbre_a_ramasser' }
    }
    return null
  }

  // Remedes que le code connait et mesure lui-meme, pour un echec dont la cause
  // est sure : les jouer evite un aller-retour au modele (5 a 20 s) qui
  // proposait les memes (bancs du 2026-10-01 : ~40 % des echecs qui vidaient
  // un plan, hors variantes sans solveur ni plans). Une seule table pour la
  // boucle de mission (A/B `reparer`) et les sous-buts. null : au modele.
  //   tronc haut (cible_haute, ou arbre commence hors de portee d ici) =>
  //   piler de la hauteur qui met la buche a portee (meme mesure que
  //   conseilPilier), puis casser depuis le sommet (recolter commencerait par
  //   redescendre en marchant) ; arbre commence ailleurs => le finir
  //   (recolter vise l arbre commence) ; buches au sol => ramasser ;
  //   chantier absent => le placer ; dans un liquide => sortir.
  function remedesMesures (code, action = null) {
    if (code === 'cible_haute' || code === 'arbre_inacheve') {
      const hint = highTargetHint()
      if (hint) {
        const hauteur = Math.max(PILER_MIN, Math.min(PILER_MAX, hint.denivele - 1))
        return [{ action: 'piler', params: { hauteur }, pourquoi: `tronc haut +${hint.denivele}` },
          { action: 'casser', params: { duree: 6 }, pourquoi: 'depuis le sommet' }]
      }
      if (code === 'arbre_inacheve' && action !== 'recolter') {
        return [{ action: 'recolter', params: { quantite: 16 }, pourquoi: 'arbre commence a finir' }]
      }
      return null
    }
    if (code === 'arbre_a_ramasser' && action !== 'ramasser') return [{ action: 'ramasser', params: {}, pourquoi: 'buches au sol' }]
    if (code === 'chantier_absent' && action !== 'choisir_terrain') return [{ action: 'choisir_terrain', params: {}, pourquoi: 'chantier a placer' }]
    if (code === 'dans_liquide' && action !== 'sortir') return [{ action: 'sortir', params: {}, pourquoi: 'hors du liquide' }]
    if (code === 'aucune_cible' && action === 'recolter') return [{ action: 'explorer', params: { distance: 16 }, pourquoi: 'matiere hors de vue' }]
    return null
  }

  const gestes = createGestes({ host, getMission: () => mission, findTargetBlock, scaled })
  // Poser un objet (A/B `poser`) : l objet et le lieu sont des parametres
  // (regle immuable, AGENTS.md) ; chaque pose verifiee est comptee par objet.
  const poserObjet = createPoser({
    getBot: () => host.getBot(),
    resoudreObjet: texte => {
      const bot = host.getBot()
      const nom = resolveFabricationCible(bot, texte)
      if (!nom) return null
      if (bot?.registry?.itemsByName?.[nom]) return nom
      // Alias de famille (porte, hache) : le membre en poche.
      const candidats = craft.TARGETS[nom]?.resolve?.(bot) ?? []
      return candidats.find(c => bot?.inventory?.items().some(i => i.name === c)) ?? candidats[0] ?? null
    },
    enInventaire: objet => host.getBot()?.inventory?.items().find(i => i.name === objet && i.count > 0) ?? null,
    rejoindre: async stand => (await host.navigateToPosition(stand, {
      signal: mission.navigationAbort.signal, __owner: stepToken, radius: 0.35, timeoutMs: 8000
    }))?.reached === true,
    signal: () => mission?.navigationAbort?.signal,
    compter: (objet, n) => {
      mission.posesFaites = { ...(mission.posesFaites ?? {}), [objet]: (mission.posesFaites?.[objet] ?? 0) + n }
    }
  })
  // Sous-buts (A/B sous_buts) : chantier et objet du solveur conduits jusqu au
  // bout par le code, guides par les besoins et le plan qu il mesure deja.
  const sousButs = createSousButs({
    getMission: () => mission,
    actions: () => ACTIONS,
    planSolveur: demande => acquisition(demande ?? undefined),
    recolteFaisable,
    // Remedes mesures d un geste rate, joues une fois par le sous-but :
    // la meme table que la boucle de mission (remedesMesures).
    reparation: remedesMesures,
    etatChantier: () => {
      const bot = host.getBot()
      const progress = mission.plan ? buildProgress() : { left: null, done: 0, total: 0 }
      const stock = (bot?.inventory?.items() ?? []).filter(i => mission.buildMatch?.test(i.name)).reduce((n, i) => n + i.count, 0)
      const besoins = besoinsConstruction(progress, stock)
      // L outil qu exige la matiere (pioche pour la pierre) passe avant.
      const outil = bot && outilManquant(bot) ? prochainGesteSolveur(acquisition(), recolteFaisable) : null
      return {
        arbreInacheve: Boolean(arbreInacheve()),
        planChoisi: Boolean(mission.plan),
        restants: mission.plan ? progress.left : (besoins?.blocs_restants ?? 1),
        stock,
        besoins,
        porteVoulue: Boolean(mission.wantsDoor),
        portePosee: doorPlaced(),
        porteEnPoche: Boolean(doorItem()),
        etapeSolveur: outil?.action ? outil : null
      }
    },
    empreinte: () => {
      const m = mesuresEffet()
      return `${m.inventaire}|${m.poses}|${m.casses}|${Boolean(mission.plan)}|${doorPlaced()}`
    }
  })

  const ACTIONS = {
    // Il y avait ici `approcher`, qui deleguait au pathfinder (GoalNearXZ). Le
    // pathfinder est casse au-dela de quelques blocs sur cette version (arret a
    // distance en annoncant success, ou timeout) : le deplacement de mission est
    // desormais compose par le planificateur avec les gestes unitaires
    // `regarder`/`pivoter` + `avancer`, guides par l indice de navigation
    // (environnement.navigation) mesure dans buildState().

    // Meme navigateur que !viens : A* pour le chemin, execution locale verifiee.
    // Le modele choisit la destination, jamais les touches du trajet.
    async rejoindre_demandeur (scale, params = {}) {
      // Le modele identifie le don de ce trajet, meme si donner est servi
      // dans un autre plan. Ce parametre definit la portee du trajet.
      const objet = String(params.objet ?? '').trim().toLowerCase() || null
      mission.pendingJoin = true
      for (const step of mission.queue) {
        if (step.action === 'donner') engagementDon(step.choices)
      }
      const arbre = arbreAvantLivraison(objet)
      if (arbre) return arbre
      // Token proprietaire prive (objet opaque) : la sous-etape nav s execute
      // DANS le slot de l etape, sans reacquerir (busy permanent sinon).
      const result = await navWithDescent(() =>
        host.navigateToPlayer(mission.requester, { signal: mission.navigationAbort.signal, __owner: stepToken }),
      { target: () => playerPosition(mission.requester), owner: stepToken })
      // Conserve l obligation non satisfaite : un "dire" au tour suivant ne
      // transforme pas un deplacement echoue en geste accompli.
      mission.pendingJoin = !result.reached
      return {
        resultat: result.reached
          ? `rejoint ${mission.requester} a ${result.remaining} blocs`
          : `ne peut pas rejoindre ${mission.requester} : ${result.code}` +
            (result.remaining === null ? '' : `, reste ${result.remaining} blocs`),
        echec: !result.reached,
        code: result.code
      }
    },

    async tourner_vers_demandeur () {
      const bot = host.getBot()
      const target = bot.players[mission.requester]?.entity
      if (!target) return { resultat: `${mission.requester} n est pas en vue`, echec: true }

      await bot.lookAt(target.position.offset(0, 1, 0), true)
      return { resultat: `tourne vers ${mission.requester}` }
    },

    async casser (scale, params = {}) {
      const bot = host.getBot()
      // Le planificateur dit COMBIEN DE TEMPS casser ; sans duree, le budget
      // de blocs par defaut s applique (milieu de plage).
      const dureeSec = Number.isFinite(Number(params.duree))
        ? Math.max(0.5, Math.min(HARVEST_BURST_MS / 1000, Number(params.duree)))
        : null
      const budget = dureeSec === null ? scaled(scale, HARVEST_MIN, HARVEST_MAX) : HARVEST_MAX
      const deadline = dureeSec === null ? HARVEST_BURST_MS : dureeSec * 1000

      // Dirt secondaire (mission bois uniquement) : quand un pilier est utile
      // (cible_haute) et que la dirt manque, casser de la dirt au sol a portee
      // plutot que d echouer sur « bloc trop loin ». Comptee a part
      // (mission.dirtSecondaire), jamais dans le quota bois. Passe par
      // run()/outcome comme toute action : un echec vide la file.
      const secondaireAutorise = harvestResource() === 'bois' &&
        dirtSecondaireAdmise(highTargetHint())
      const findBloc = secondaire =>
        secondaire ? findSecondaryDirtBlock() : findTargetBlock()

      let first = findTargetBlock()
      const secondary = secondaryDirtFor(first, secondaireAutorise)
      const secondaire = Boolean(secondary)
      if (secondary) first = secondary
      if (!first) return { resultat: 'aucun bloc cible sain a casser' }

      // La portee se juge comme le serveur : distance 3D centre a centre.
      // findTargetBlock preferre deja un bloc a portee (le plus bas) ; s il n
      // en existe aucun, on echoue en le disant plutot que de viser un bloc
      // hors de portee — l echec informe le planificateur qu il faut avancer.
      // Repli dirt : un bois trop loin avec de la dirt a portee et un pilier
      // utile ne repart pas bredouille, il ramene du carburant de pilier.
      let reach = bot.entity.position.distanceTo(first.position.offset(0.5, 0.5, 0.5))
      // Cible en vue mais hors de portee (plan anticipe perime, bloc casse
      // entre-temps) : le trajet d `avancer` d abord, puis la casse, au lieu
      // d un echec qui jetait le plan (« bloc trop loin », 5 bancs).
      if (reach > REACH && !secondaire) {
        const approche = await ACTIONS.avancer(null, { distance: 24 })
        const suivant = findTargetBlock()
        const live = host.getBot()
        if (!approche.echec && suivant && live?.entity) {
          first = suivant
          reach = live.entity.position.distanceTo(first.position.offset(0.5, 0.5, 0.5))
        } else if (approche.echec) {
          return { resultat: `bloc trop loin, approche impossible : ${approche.resultat}`, echec: true, code: approche.code }
        }
      }
      if (reach > REACH) {
        return { resultat: `bloc trop loin (${reach.toFixed(1)} blocs), il faut d abord avancer`, echec: true }
      }

      // En survie, un bloc qui exige un outil casse quand meme a la main mais ne
      // lache RIEN. Compter une reussite rendrait la mission interminable sans
      // jamais dire pourquoi ; on echoue en nommant l outil manquant, ce qui
      // fait choisir « fabriquer » au tour suivant.
      if (mission.supply === 'harvest') {
        const check = craft.harvestCheck(bot, first)
        if (!check.ok) {
          return { resultat: `${check.reason} : il faut d abord une ${check.need}`, echec: true }
        }
        await craft.equipForBlock(bot, first)
      }

      const started = Date.now()
      let broken = 0
      let refusal = null
      const nomsCasses = new Map()

      // On enchaine sans relacher : relacher entre chaque bloc pour redemander
      // son avis au modele fait perdre du temps et donne en jeu l impression
      // d un bot qui tapote.
      while (!mission.cancelled && broken < budget && Date.now() - started < deadline) {
        const block = findBloc(secondaire)
        if (!block) break
        // Meme metrique que le premier bloc : centre a centre, portee serveur.
        // findTargetBlock rend le plus bas des blocs a portee ; s il n y en a
        // plus, on arrete la rafale au lieu de viser un bloc haut injoignable.
        if (bot.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5)) > REACH) break

        const debutArbre = !secondaire && TREE_LOG.test(block.name) && featureOn('arbre_fini') && !mission.arbreEnCours
        const debutArbreDemande = !secondaire && mission.wholeTree && !mission.tree && TREE_LOG.test(block.name)
        const initialLogs = debutArbre || debutArbreDemande ? logsOfTree(block.position) : null
        if (debutArbreDemande) {
          mission.arbreInventaireDepart = craft.countOf(bot, TREE_LOG)
          mission.arbreEntitiesInitial = Object.entries(bot.entities ?? {}).map(([id, e]) => e.uuid || id)
          mission.arbreBaseline = Object.entries(bot.entities ?? {}).flatMap(([id, e]) => {
            let item
            try { item = e.getDroppedItem?.() } catch (_) {}
            return item && TREE_LOG.test(item.name) && e.position
              ? [{ id: e.uuid || id, objet: item.name, count: item.count, x: e.position.x, y: e.position.y, z: e.position.z }] : []
          })
        }
        if (mission.wholeTree) observerCollecteArbre()
        let coupeMesuree = null
        let creusageInterrompu = null
        try {
          // L outil peut changer en cours de rafale (une touffe d herbe, puis
          // la terre en dessous). equipForBlock rend la main tout de suite si
          // le bon outil est deja en main.
          if (mission.supply === 'harvest') {
            // Outil verifie pour CHAQUE bloc : la matiere visee peut changer en
            // cours de rafale (plan recalcule a chaque objet), et un minerai
            // casse sans le bon outil disparait sans rien lacher
            // (craft/iron-pickaxe 13208e8 : fer casse a la pioche en bois).
            const outil = craft.harvestCheck(bot, block)
            if (!outil.ok) {
              refusal = `${outil.reason} : il faut d abord une ${outil.need}`
              break
            }
            await craft.equipForBlock(bot, block)
          }
          // Viser avant de creuser : le serveur refuse un bloc que le joueur ne
          // regarde pas, et l animation part quand meme cote client.
          //
          // Chaque operation est bornee : un `lookAt` ou un `dig` qui ne rend pas
          // la main figeait la mission entiere, car la deadline de rafale n est
          // relue qu entre deux blocs (voir piege 12).
          await withTimeout(
            bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true), 4000, 'visee trop longue')
          if (!secondaire && mission.wholeTree && TREE_LOG.test(block.name)) {
            mission.arbreSources ??= []
            coupeMesuree = { ...celluleValide(block.position), objet: block.name, id: `${mission.id}:${mission.arbreSources.length}`, ouverte: true, confirmee: false, ambigu: false, drop: null }
            mission.arbreSources.push(coupeMesuree)
            coupeArbreActive = coupeMesuree.id
          }
          await withTimeout(bot.dig(block), 6000, 'creusage trop long')
        } catch (err) {
          // Le serveur a le dernier mot dans les deux sens : un creusage coupe
          // par une pause ou un arret (stopDigging) peut avoir deja casse le
          // bloc. Ignorer cette coupe perdait l arbre et sa buche ramassee
          // (chat/stop-resume 6d5e479 : arbre fini, mission sans fin).
          const apres = bot.blockAt(block.position)
          if (!apres || apres.name === block.name) {
            if (coupeMesuree) coupeMesuree.ouverte = false
            coupeArbreActive = null
            refusal = err.message
            break
          }
          creusageInterrompu = err.message
        }

        // Le serveur a le dernier mot : si le bloc est toujours la, le creusage
        // a ete refuse et compter une reussite masquerait la panne.
        const after = bot.blockAt(block.position)
        if (after && after.name === block.name) {
          if (coupeMesuree) coupeMesuree.ouverte = false
          coupeArbreActive = null
          refusal = `${block.name} toujours en place apres le creusage`
          break
        }

        broken += 1
        nomsCasses.set(block.name, (nomsCasses.get(block.name) ?? 0) + 1)
        // Dirt secondaire : carburant de pilier, hors quota bois. Le bois seul
        // fait avancer `blocs_casses`/`unites_recoltees` (voir `finishAllowed`).
        if (secondaire) mission.dirtSecondaire = (mission.dirtSecondaire ?? 0) + 1
        else mission.broken += 1
        if (debutArbreDemande) {
          mission.tree = { x: block.position.x, y: block.position.y, z: block.position.z }
          mission.buchesArbreDemande = initialLogs?.map(celluleValide) ?? null
        }
        if (!secondaire && mission.wholeTree && TREE_LOG.test(block.name)) {
          if (coupeMesuree) coupeMesuree.confirmee = true
          mission.arbreCoupes = (mission.arbreCoupes ?? 0) + 1
          prouverCollectesArbre()
        }
        if (debutArbre) {
          mission.arbreEnCours = { x: block.position.x, y: block.position.y, z: block.position.z }
          mission.buchesArbre = initialLogs?.map(celluleValide) ?? null
        }
        await sleep(120)
        if (coupeMesuree) coupeMesuree.ouverte = false
        coupeArbreActive = null
        prouverCollectesArbre()
        if (!secondaire && TREE_LOG.test(block.name)) {
          noterDropsArbre()
        }
        if (creusageInterrompu) {
          refusal = creusageInterrompu
          break
        }
        // The tree boundary also applies inside nested casser/recolter bursts.
        // Teardown runs in the same physical slot before another tree is anchored.
        if (mission.arbreEnCours && !arbreInacheve()) {
          await demonterEchafaudage(stepToken)
          break
        }
      }

      if (broken === 0) {
        return { resultat: `casse impossible : ${refusal ?? 'aucun bloc a portee'}`, echec: true }
      }

      // Laisse les objets tomber et entrer dans l inventaire avant l etat suivant.
      await sleep(400)
      noterDropsArbre()
      // Hors bois (dont le ramassage est deja pilote par l arbre) : l objet
      // casse a distance reste au sol ; le prendre aussitot (vu sur
      // gather/flowers : 4 fleurs cassees, 2 en inventaire, mission close).
      let ramasses = 0
      if (!secondaire && harvestResource() !== 'bois') {
        const avant = countResourceItems()
        await collectScaffoldDrops(stepToken, { budgetMs: 8000, pattern: ressource(harvestResource())?.items })
        ramasses = Math.max(0, countResourceItems() - avant)
      }

      const ecoule = Math.round((Date.now() - started) / 100) / 10
      return {
        resultat: secondaire
          ? `${broken} bloc(s) de dirt secondaire casse(s) en ${ecoule} s (total dirt ${mission.dirtSecondaire})` +
            (dureeSec === null ? '' : ` sur ${dureeSec} s demandee`) +
            (refusal ? `, arret : ${refusal}` : '') + ' — quota bois inchange'
          : `${broken} bloc(s) casse(s) (${[...nomsCasses].map(([nom, n]) => `${nom} x${n}`).join(', ')}) en ${ecoule} s (total ${mission.broken})` +
            (dureeSec === null ? '' : ` sur ${dureeSec} s demandee`) +
            (refusal ? `, arret : ${refusal}` : '') +
            (ramasses ? `, ${ramasses} objet(s) ramasse(s) aussitot` : '')
      }
    },

    // Chaine d une recolte en une action : rejoindre le bloc vise le plus
    // proche (`avancer`), le casser (`casser`), ramasser ce qui tombe
    // (`ramasser`), recommencer jusqu a la quantite. Memes gestes, memes
    // garde-fous, mais sans un appel au modele entre chaque geste. Rend la
    // main au premier echec de trajet ou de casse, avec son resultat : le
    // modele decide alors (piler, fabriquer un outil, autre cible).
    async recolter (scale, params = {}) {
      const visee = Number.isFinite(Number(params.quantite))
        ? Math.max(1, Math.min(16, Math.round(Number(params.quantite))))
        : scaled(scale, 1, 16)
      const arbreEnCours = Boolean(arbreInacheve())
      const suite = arbreEnCours ? null : rienARecolter()
      // Pas un echec : rien n a rate, la file continue (plan anticipe perime).
      if (suite) {
        return (await etapeSuivanteAuLieu('rien a recolter : tout est en poche')) ??
          { resultat: `rien a recolter : tout est en poche, etape suivante du plan : ${suite}`, code: 'plan' }
      }
      const assez = arbreEnCours ? null : materiauSuffisant()
      if (assez) return { resultat: `rien a recolter : ${assez}` }
      const enAttente = recolteEnAttenteOutil()
      if (enAttente) {
        const r = await etapeSuivanteAuLieu(`${enAttente.bloc ?? enAttente.matiere} exige ${enAttente.outil}, encore a fabriquer`)
        if (r) return r
      }
      const matiere = harvestResource()
      if (!ressource(matiere)?.items) {
        return { resultat: 'aucune matiere a recolter pour cette mission', echec: true }
      }
      mission.matiereFigee = matiere
      try {
        return await boucle()
      } finally {
        if (mission) mission.matiereFigee = null
      }

      async function boucle () {
        const debut = Date.now()
        const avant = countResourceItems()
        const gagne = () => Math.max(0, countResourceItems() - avant)
        const etapes = []
        let arret = null
        let rienARamasser = 0
        // A tree in progress is cut to the last log, past the quantity asked.
        while (!mission.cancelled && (gagne() < visee || arbreInacheve()) && Date.now() - debut < RECOLTER_MAX_MS) {
          const bot = host.getBot()
          if (!bot?.entity) break
          const cible = findTargetBlock()
          const aPortee = cible &&
            bot.entity.position.distanceTo(cible.position.offset(0.5, 0.5, 0.5)) <= REACH
          let r
          if (aPortee) {
            r = await ACTIONS.casser(null, { duree: 8 })
            etapes.push('casser')
          } else if (nearbyItems().length > 0 && rienARamasser < 2) {
            // Rien a portee mais des objets au sol (buches tombees d un arbre
            // fini) : les prendre avant de chercher un autre bloc.
            r = await ACTIONS.ramasser(null, { quantite: 6 })
            etapes.push('ramasser')
            if (r.echec) { rienARamasser += 1; continue }
          } else if (cible || findTargetBlock(undefined, { anyHeight: true }) || highTargetHint()) {
            r = await ACTIONS.avancer(null, { distance: 24 })
            etapes.push('avancer')
          } else if (arbreInacheve()) {
            const n = arbreInacheve().length
            r = { resultat: `arbre commence, ${n} buche(s) encore debout hors de portee d ici : piler ou changer de poste pour les couper, aucun autre arbre avant`, echec: true, code: 'arbre_inacheve' }
          } else {
            // Jamais de marche a l aveugle : `avancer` sans cible irait droit
            // devant. Explorer reste une decision du modele.
            r = { resultat: 'aucun bloc de la matiere visee en vue : explorer, puis recolter', echec: true, code: 'aucune_cible' }
          }
          if (r.echec) { arret = r; break }
          rienARamasser = 0
          if (etapes[etapes.length - 1] === 'casser' && (gagne() < visee || arbreInacheve())) {
            await waitItemsSettled()
            if (nearbyItems().length > 0) {
              const pris = await ACTIONS.ramasser(null, { quantite: 6 })
              etapes.push('ramasser')
              if (pris.echec) rienARamasser += 1
            }
          }
        }
        // Ce qui reste au sol a la fin (quantite atteinte en cours de casse).
        if (!mission.cancelled && !arret && nearbyItems().length > 0 && harvestResource() === 'bois') {
          await waitItemsSettled()
          await ACTIONS.ramasser(null, { quantite: 6 })
          etapes.push('ramasser')
        }
        const n = gagne()
        const ecoule = Math.round((Date.now() - debut) / 100) / 10
        const bilan = `${n}/${visee} objet(s) de ${matiere} en ${ecoule} s (${etapes.length} geste(s) : ${etapes.slice(-6).join(', ')})`
        if (arret) {
          return {
            resultat: `${bilan} ; arret : ${arret.resultat}`,
            echec: n === 0,
            code: arret.code
          }
        }
        if (n === 0) {
          return { resultat: `${bilan} ; rien obtenu`, echec: true }
        }
        return { resultat: n >= visee ? bilan : `${bilan} ; delai de ${RECOLTER_MAX_MS / 1000} s atteint` }
      }
    },

    // Fix 2 : `ramasser` marche VRAIMENT sur les objets, en gestes unitaires,
    // et ne ment jamais sur le resultat. Le defaut corrige : `visited` comptait
    // un trajet des que le bot avait bouge de 0,3 bloc, meme a 5 blocs de
    // l objet — d ou « 2/2 atteints, +0 inventaire » compte comme un succes.
    // Desormais : est « atteint » un objet dont on est REELLEMENT a portee de
    // ramassage (ITEM_AUTO_PICKUP) apres le trajet, et +0 inventaire est un
    // ECHEC explicite, pas un succes.
    async ramasser (scale, params = {}) {
      const bot = host.getBot()
      const budget = Number.isFinite(Number(params.quantite))
        ? Math.max(PICKUP_MIN, Math.min(PICKUP_MAX, Math.round(Number(params.quantite))))
        : scaled(scale, PICKUP_MIN, PICKUP_MAX)
      // Objets encore en chute (buche coupee depuis un pilier) : attendre
      // qu ils se posent, sinon leur hauteur trompe la descente d echafaudage
      // (trees/tall 5f0545a : buches tombees de +5, ramasser 0/1 deux fois,
      // bot reste perche).
      await waitItemsSettled()
      const items = nearbyItems()
      // Rien au sol : rien a faire, pas un echec. Le modele planifie souvent
      // « ramasser -> recolter » avant la coupe (19 fois au banc 453d7f4) ;
      // en echec, ce ramasser vide jetait la recolte qui suivait. Une boucle
      // de ramasser vides reste vue par detectStuck (meme resultat 3 fois).
      if (items.length === 0) return { resultat: 'aucun objet au sol a proximite : rien a ramasser' }

      const before = countResourceItems()
      const totalPoche = () => (host.getBot()?.inventory?.items() ?? []).reduce((n, i) => n + i.count, 0)
      const beforeTotal = totalPoche()
      // Dirt secondaire (mission bois) : le carburant du pilier. `ramasser`
      // ne creditait que la matiere visee : une dirt cassee pour un pilier
      // puis ramasee rendait un faux echec (« rien de la matiere visee ») qui
      // vidait la file et apprenait au modele que la dirt ne se ramasse pas —
      // le pilier restait a sec malgre la dirt cassee. La dirt compte ici
      // comme un succes, sans jamais entrer dans le quota bois (collecte
      // et `countResourceItems` restent bois seul).
      const dirtVisee = harvestResource() === 'bois'
      const beforeDirt = dirtVisee ? craft.countOf(bot, PILER_DIRT) : 0
      // La dirt n est un progres que s il manquait du carburant au debut de
      // l action (stock sous PILER_MAX) : sinon elle ne doit pas masquer un
      // vrai echec.
      const dirtManquante = dirtVisee && beforeDirt < PILER_MAX
      const dirtGagnee = () => dirtManquante
        ? Math.max(0, craft.countOf(host.getBot(), PILER_DIRT) - beforeDirt)
        : 0
      // Use the same supported pickup post as navigation, including height:
      // an item nearby in XZ can still be two floors below the bot.
      let pasCourt = false
      let distant = items.filter(
        item => !itemInPickupRange(bot, bot.entity.position, item.position, ITEM_AUTO_PICKUP))

      if (distant.length === 0) {
        await sleep(600)
        const gainedNow = countResourceItems() - before
        if (gainedNow > 0) {
          return { resultat: `${items.length} objet(s) a portee, +${gainedNow} dans l inventaire (ramassage automatique)` }
        }
        const autoDirt = dirtGagnee()
        if (autoDirt > 0) {
          return { resultat: `${items.length} objet(s) a portee, +${autoDirt} dirt secondaire dans l inventaire (ramassage automatique, carburant de pilier)` }
        }
        // Juge « a portee » mais rien n est entre : le ramassage du jeu est
        // plus court (~1,3 bloc) que ce seuil. Marcher dessus au lieu d echouer
        // (vu : buche a 1,6 bloc jamais ramassee, mission bloquee).
        distant = items
        pasCourt = true
      }

      let atteints = 0
      let bloqueVu = false

      for (const item of distant.slice(0, budget)) {
        if (mission.cancelled) break
        const live = host.getBot()
        if (!live?.entity) break
        // Perche sur son propre pilier au-dessus de l objet : le navigateur ne
        // descend que de deux blocs, donc on defait le pilier sous ses pieds.
        if (item.position.y < live.entity.position.y - 1.5) {
          const removed = await descendScaffold(item.position.y)
          const still = host.getBot()?.entity?.position
          console.log(`[mission] descente d echafaudage : ${removed} bloc(s), objet a y=${item.position.y.toFixed(1)}, bot a y=${still?.y?.toFixed(2)}`)
          // Toujours perche : trajet qui creuse vers l objet, sans chute > 2.
          if (still && item.position.y < still.y - 1.5 && typeof host.digToward === 'function') {
            await host.digToward(item.position, { signal: mission.navigationAbort.signal, range: 1.5, timeoutMs: 20000 })
          }
        }
        // Bois tombe sur des feuilles (bout de branche) : hors d atteinte au
        // sol. On casse la feuille qui le porte, s il est a portee, pour qu il
        // tombe ; seule cette feuille est touchee.
        await dropFromLeaves(item)
        // Objet sur un rebord de deux blocs ou plus (minerai casse au sommet
        // d une paroi) et pas sur des feuilles (dropFromLeaves ci-dessus) : le
        // navigateur ne monte qu une marche ; le pathfinder qui creuse et pose
        // (escalier, tour 1x1) le rejoint.
        const encore = host.getBot()?.entities?.[item.id]
        const support = encore && host.getBot().blockAt(encore.position.offset(0, -0.5, 0))
        // Hors bois : les buches perchees (branche, echafaudage) ont leurs
        // propres gestes (dropFromLeaves, descente de pilier).
        if (encore && harvestResource() !== 'bois' && !/leaves/.test(support?.name ?? '') && typeof host.digToward === 'function' &&
            encore.position.y > (host.getBot().entity?.position.y ?? Infinity) + 1.5) {
          const r = await host.digToward(encore.position, { signal: mission.navigationAbort.signal, range: 1, timeoutMs: 20000 })
          console.log(`[mission] objet en hauteur : trajet qui creuse -> ${r?.reached ? 'arrive' : (r?.code ?? 'echec')}`)
        }
        // Objet deja « proche » mais pas ramasse : un pas droit dessus, sur sol
        // plat seulement (meme niveau, appui solide), jamais vers un vide.
        if (pasCourt) await stepOnto(item)
        // Meme navigateur que l approche de ressource, mais jusqu au rayon
        // de collecte. Pas de succes sans gain d inventaire plus bas.
        let walk = await host.navigateToPosition(item.position, {
          signal: mission.navigationAbort.signal, __owner: stepToken,
          radius: ITEM_AUTO_PICKUP, pickup: true, timeoutMs: 10000
        })
        // Trajet refuse depuis son propre pilier (objet un bloc plus bas, sous
        // le seuil de descente) : pilier defait jusqu au sol, puis nouvel essai
        // (trees/tall 68ea147 : buche a y=201, bot perche a y=202, 0/1 cinq fois).
        if (!walk.reached && !mission.cancelled) {
          const live = host.getBot()
          const dessous = live?.entity && live.blockAt(live.entity.position.offset(0, -0.5, 0))
          if (dessous && (PILER_DIRT.test(dessous.name) || /_planks$/.test(dessous.name)) && isPillarBlock(live, dessous) &&
              (await descendScaffold(-Infinity, { pillarOnly: true })) > 0) {
            walk = await host.navigateToPosition(item.position, {
              signal: mission.navigationAbort.signal, __owner: stepToken,
              radius: ITEM_AUTO_PICKUP, pickup: true, timeoutMs: 10000
            })
          }
        }
        if (!walk.reached) {
          bloqueVu = true
          // Trajet refuse alors que l objet est tout pres et au meme niveau :
          // un pas droit dessus (vu sur trees/double : buche a 1,6 bloc dans
          // l emprise du tronc abattu, ramasser 0/1 cinq fois de suite).
          const p = host.getBot()?.entity?.position
          if (p && Math.hypot(p.x - item.position.x, p.z - item.position.z) <= 3) await stepOnto(item)
        }
        await sleep(300)
        const after = host.getBot()?.entity?.position
        if (!after) break
        // Atteint = vraiment a portee de ramassage APRES le trajet, pas
        // « le bot a bouge ». Un trajet bloque loin de l objet ne compte pas.
        if (itemInPickupRange(host.getBot(), after, item.position, ITEM_AUTO_PICKUP)) {
          atteints += 1
          // A portee mais toujours au sol (vu sur trees/tall : 1/1 atteint,
          // +0 en inventaire, cinq fois) : un pas droit dessus.
          if (item.isValid !== false && host.getBot()?.entities?.[item.id]) await stepOnto(item)
        }
      }

      // Un trajet bloque sur un obstacle : le signal du contournement, pour que
      // le tour suivant contourne au lieu de re-avancer au meme cap (Fix 1).
      if (bloqueVu) mission.lastBlocked = true

      const gained = countResourceItems() - before
      const total = Math.min(budget, distant.length)
      const dirt = dirtGagnee()
      // Objets ramasses, mais pas de la matiere visee (terre cassee pour le
      // pilier, pousse) : le geste a reussi, le quota ne bouge pas (trees/tall
      // 93a6f04 : « +0 », echec qui jetait la suite du plan).
      const autres = totalPoche() - beforeTotal
      if (gained <= 0 && dirt <= 0 && autres > 0) {
        return { resultat: `${atteints}/${total} objet(s) atteint(s), +${autres} hors matiere visee (quota inchange)` }
      }
      if (gained <= 0 && dirt <= 0) {
        return {
          resultat: `${atteints}/${total} objet(s) atteint(s), +0 dans l inventaire : rien de la matiere visee collectee`,
          echec: true
        }
      }
      if (gained > 0) {
        return {
          resultat: `${atteints}/${total} objet(s) atteint(s), +${gained} dans l inventaire`
        }
      }
      return {
        resultat: `${atteints}/${total} objet(s) atteint(s), +${dirt} dirt secondaire dans l inventaire (carburant de pilier)`
      }
    },

    // Cuisson au four (craft.smelt). L objet vient du modele (nom du jeu ou
    // mot francais), sinon de la prochaine cuisson du solveur de prerequis.
    async cuire (scale, params = {}) {
      const bot = host.getBot()
      const brut = String(params.objet ?? '').trim().toLowerCase()
      const alias = [[/charbon de bois|charcoal/, 'charcoal'], [/fer|iron/, 'iron_ingot'], [/\bor\b|gold/, 'gold_ingot'],
        [/cuivre|copper/, 'copper_ingot'], [/verre|glass/, 'glass'], [/pierre|^stone$/, 'stone']]
      let objet = acquirePlan.SMELT[brut] ? brut : (alias.find(([re]) => re.test(brut))?.[1] ?? null)
      const etape = acquisition()?.etapes?.find(e => e.op === 'cuire')
      if (!objet && etape) objet = etape.objet
      if (!objet && acquirePlan.SMELT[mission.fabricationCible]) objet = mission.fabricationCible
      if (!objet) return { resultat: `cuisson impossible : objet non reconnu (${brut || 'vide'}) ; ex : iron_ingot, charcoal, glass`, echec: true, code: 'unknown' }
      const demandee = Number.isFinite(Number(params.quantite))
        ? Math.max(1, Math.min(16, Math.round(Number(params.quantite))))
        : (etape?.objet === objet ? etape.quantite : scaled(scale, 1, 16))
      // Le solveur mesure ce que la chaine exige ; une cuisson plus petite
      // brule une unite de combustible entiere pour moins d objets (buche =
      // 1,5 cuisson) et laisse la suite sans combustible (craft/iron-pickaxe
      // bff20b0 : « cuire 1 » sur 3, bois cherche loin, plafond atteint).
      const quantite = etape?.objet === objet ? Math.min(16, Math.max(demandee, etape.quantite)) : demandee
      // Output already smelted: the solver, run on the real inventory, has
      // no smelt left. Its next step instead of « rien a cuire ».
      const plan = acquisition()
      if (mission.fabricationCible && plan?.ok && !etape && objet !== (CIBLE_ITEM[mission.fabricationCible] ?? mission.fabricationCible) &&
        craft.countOf(bot, new RegExp(`^${objet}$`)) > 0) {
        const r = await etapeSuivanteAuLieu(`${objet} deja cuit(s)`)
        if (r) return r
      }
      try {
        const r = await craft.smelt(bot, objet, quantite, {
          move: async stand => (await host.navigateToPosition(stand, {
            signal: mission.navigationAbort.signal, __owner: stepToken, radius: 1, timeoutMs: 20000, distanceBudget: 48
          }))?.reached === true
        })
        const res = `${r.produced}/${r.wanted} ${objet} cuit(s) depuis ${r.input} (combustible : ${r.fuelCount} ${r.fuel})${r.arret ? `, arret : ${r.arret}` : ''}`
        return r.produced > 0 ? { resultat: res } : { resultat: `${res} : rien sorti du four`, echec: true }
      } catch (err) {
        const manque = (err.missing ?? []).map(m => `${m.count} ${m.name}`).join(', ')
        if (/aucune place libre/.test(err.message) && (await quitterPilier('cuire')) > 0) return ACTIONS.cuire(scale, params)
        return { resultat: `cuisson de ${objet} impossible : ${err.message}${manque ? ` (manque : ${manque})` : ''}`, echec: true, code: err.code }
      }
    },

    // Le seul endroit ou une action lit un parametre autre que l ampleur : le
    // second etage de classification a repondu « quoi fabriquer », parmi les
    // recettes que craft.js a declarees faisables au moment de la question.
    async fabriquer (scale, params = {}) {
      const bot = host.getBot()
      // `objet` arrive en nom de cible (« batons »), mais le modele envoie
      // parfois un nom d objet (« stick ») : on traduit, jamais pris tel quel.
      let target = fabTargetName(params.objet)

      if (!target) {
        const possible = craft.options(bot).filter(o => o.possible).map(o => o.name)
        return {
          resultat: possible.length === 0
            ? 'rien de fabricable avec l inventaire actuel'
            : `aucune fabrication choisie (possibles : ${possible.join(', ')})`,
          echec: true
        }
      }

      let wanted = Number.isFinite(Number(params.quantite))
        ? Math.max(CRAFT_MIN, Math.min(CRAFT_MAX, Math.round(Number(params.quantite))))
        : scaled(scale, CRAFT_MIN, CRAFT_MAX)
      let reorientation = ''

      // Cible de fabrication fixee : seuls la cible et ses intermediaires
      // (planches, batons, etabli) sont utiles. Vu sur craft/axe : une pioche
      // fabriquee a la place de la hache, planches et batons consommes.
      // Un objet de la chaine de prerequis calculee (pioche en bois pour une
      // pioche en pierre) est utile lui aussi.
      const plan = acquisition()
      const dansLePlan = (plan?.etapes ?? []).some(e => e.op === 'fabriquer' &&
        (e.objet === target || FAMILLES_FAB[target]?.test(e.objet)))
      // Intermediaire deja en quantite suffisante : le plan du solveur,
      // recalcule sur l inventaire reel, n en demande plus. Vu sur craft/axe
      // (40ee116) : plan anticipe perime, planches et batons fabriques deux
      // fois, trois buches brulees, plus rien pour l etabli ni la hache.
      const famille = target === 'planches' || /_planks$/.test(target) ? /_planks$/
        : target === 'batons' || target === 'stick' ? /^stick$/ : null
      const familleDansLePlan = famille && (plan?.etapes ?? []).some(e => e.op === 'fabriquer' && famille.test(e.objet))
      if (plan?.ok && famille && !familleDansLePlan && !famille.test(CIBLE_ITEM[mission.fabricationCible] ?? mission.fabricationCible)) {
        // Etape suivante du plan = une fabrication (batons, ou la cible
        // elle-meme) : la faire au lieu de refuser. Vu sur craft/stone-pickaxe
        // (0a2a819) : planches redemandees cinq fois malgre « suite du plan :
        // fabriquer 4 stick » ; craft/furnace (33abea6) : planches redemandees
        // six fois, plan reduit a « fabriquer 1 furnace ».
        const suivante = plan.etapes[0]
        if (suivante?.op === 'fabriquer') {
          reorientation = `assez de ${target}, etape suivante du plan faite a la place : `
          target = suivante.objet
          wanted = Math.max(CRAFT_MIN, Math.min(CRAFT_MAX, Number(suivante.quantite) || CRAFT_MIN))
        } else if (suivante?.op === 'recolter' || suivante?.op === 'cuire') {
          // Etape suivante = une recolte ou une cuisson : la faire (craft/furnace
          // 8779070 : planches redemandees, « suite du plan : recolter 6
          // cobblestone », plan jete trois fois).
          const r = suivante.op === 'recolter'
            ? await ACTIONS.recolter(null, { quantite: suivante.quantite })
            : await ACTIONS.cuire(null, { objet: suivante.objet, quantite: suivante.quantite })
          return { ...r, resultat: `assez de ${target}, etape suivante du plan faite a la place : ${r.resultat}` }
        } else {
          return {
            resultat: `assez de ${target} pour ${mission.fabricationCible} : suite du plan : ` +
              (acquirePlan.describe(plan, 3).join(' ; ') || `fabriquer ${mission.fabricationCible}`),
            echec: true
          }
        }
      }
      // Etabli, four ou outil deja obtenu (pose tout pres ou en poche) : en
      // refaire un gaspille des ingredients (vu sur craft/axe : deux etablis,
      // plus de planches pour la hache) et le refuser comptait un echec sans
      // rien avoir casse (craft/iron-pickaxe 9ee7d81 : « un etabli est deja
      // pose » ; 6ab854b : pioche en pierre et four deja faits par une etape
      // reprise, redemandes, « pas utile pour iron_pickaxe »). On fait l etape
      // suivante du plan, ou la cible, a la place. Sauf si l objet est la cible.
      const itemDemande = CIBLE_ITEM[target] ?? target
      const itemCible = CIBLE_ITEM[mission.fabricationCible] ?? mission.fabricationCible
      const outil = OUTIL_OU_POSTE.test(itemDemande)
      if (mission.fabricationCible && itemDemande !== itemCible && !reorientation &&
        (itemDemande === 'crafting_table' || (outil && !dansLePlan))) {
        const ou = dejaObtenu(bot, itemDemande)
        if (ou) {
          const suivante = acquisition()?.etapes?.find(e => !(e.op === 'fabriquer' && (CIBLE_ITEM[e.objet] ?? e.objet) === itemDemande))
          if (suivante?.op === 'recolter' || suivante?.op === 'cuire') {
            const r = suivante.op === 'recolter'
              ? await ACTIONS.recolter(null, { quantite: suivante.quantite })
              : await ACTIONS.cuire(null, { objet: suivante.objet, quantite: suivante.quantite })
            return { ...r, resultat: `${ou}, etape suivante du plan faite a la place : ${r.resultat}` }
          }
          reorientation = `${ou}, etape suivante du plan faite a la place : `
          if (suivante?.op === 'fabriquer') {
            target = suivante.objet
            wanted = Math.max(CRAFT_MIN, Math.min(CRAFT_MAX, Number(suivante.quantite) || CRAFT_MIN))
          } else {
            target = mission.fabricationCible
            wanted = Math.max(1, (mission.fabricationQuantite ?? 1) - fabricationProduced())
          }
        }
      }
      // Une etape reprise du plan (reorientation) est utile par definition :
      // `dansLePlan` avait ete calcule sur l objet demande. Vu sur
      // craft/furnace (8d6a7b8) : batons redemandes, pioche en bois du plan
      // substituee puis refusee « pas utile pour furnace ».
      if (mission.fabricationCible && !dansLePlan && !reorientation &&
        !fabricationUtile(target, mission.fabricationCible, bot.registry)) {
        return {
          resultat: `${target} n est pas utile pour ${mission.fabricationCible} : fabrique ${mission.fabricationCible} ` +
            'ou ses ingredients (planches, batons, etabli), rien d autre',
          echec: true
        }
      }

      try {
        const made = await craft.make(bot, target, wanted, {
          // Etabli pose loin (autre bout du chantier) : rejoint par le navigateur.
          move: async stand => (await host.navigateToPosition(stand, {
            signal: mission.navigationAbort.signal, __owner: stepToken, radius: 1, timeoutMs: 20000, distanceBudget: 48
          }))?.reached === true
        })
        // Succes vers la cible du brief : efface le manque signale.
        if (mission.fabricationCible && (target === mission.fabricationCible || made.item === mission.fabricationCible)) {
          mission.fabricationLastError = null
        }
        return {
          resultat: reorientation + `${made.produced} ${made.item} fabrique(s) sur ${wanted} demande(s)` +
            (made.usedTable ? ' (a l etabli)' : '')
        }
      } catch (err) {
        // Pas de quoi faire les `wanted` demandes, mais de quoi en faire moins
        // (composite 8779070 : 16 planches demandees, 2 buches en poche, echec) :
        // fabriquer ce que l inventaire permet, en le disant.
        if (err?.code === 'missing' && wanted > 1 && err.item) {
          const registre = craft.getDataset(bot)
          const inv = craft.inventoryMap(bot)
          delete inv[err.item]
          let possible = 0
          for (let n = wanted - 1; n >= 1 && registre; n--) {
            try {
              if (planCraft({ registry: registre, target: err.item, count: n, inventory: inv }).ok) { possible = n; break }
            } catch (_) { break }
          }
          if (possible > 0) {
            try {
              const made = await craft.make(bot, err.item, possible, {
                move: async stand => (await host.navigateToPosition(stand, {
                  signal: mission.navigationAbort.signal, __owner: stepToken, radius: 1, timeoutMs: 20000, distanceBudget: 48
                }))?.reached === true
              })
              return {
                resultat: reorientation + `${made.produced} ${made.item} fabrique(s) sur ${wanted} demande(s) : ` +
                  `ingredients pour ${possible} seulement (${String(err.message).slice(0, 100)})`
              }
            } catch (_) { /* echec franc ci-dessous */ }
          }
        }
        // Manque de ressource : message generique du make (missing structuré),
        // sans recette hardcodee par phrase ; le pilote y lit quoi recolter.
        // Persiste pour finishAllowed (pourquoi du refus), borne 200 car.
        if (/aucune place libre/.test(err?.message ?? '') && (await quitterPilier('fabriquer')) > 0) return ACTIONS.fabriquer(scale, params)
        // Rien de fabricable faute de matiere premiere, et le plan du solveur
        // commence par la recolter ou la cuire : la faire, puis refabriquer une
        // fois (craft/door 93a6f04 : planches demandees sans buche, echec).
        if (err?.code === 'missing' && !params._apresPrealable) {
          const suivante = acquisition()?.etapes?.[0]
          if (suivante?.op === 'recolter' || suivante?.op === 'cuire') {
            const r = suivante.op === 'recolter'
              ? await ACTIONS.recolter(null, { quantite: suivante.quantite })
              : await ACTIONS.cuire(null, { objet: suivante.objet, quantite: suivante.quantite })
            if (r.echec) return { ...r, resultat: `${target} : il manquait la matiere, ${suivante.op} d abord : ${r.resultat}` }
            const f = await ACTIONS.fabriquer(scale, { ...params, _apresPrealable: true })
            return { ...f, resultat: `${suivante.op} d abord (${r.resultat}) ; ${f.resultat}` }
          }
        }
        mission.fabricationLastError = String(err?.message ?? 'impossible').slice(0, 200)
        return { resultat: `fabrication de ${target} impossible : ${err.message}`, echec: true }
      }
    },

    // Depot mesure aux pieds du BON joueur (D20/C0) via delivery.js (ABI
    // stable, autre agent). Succes = depot mesure (inventaire -N) + annonce,
    // jamais un ramassage suppose. Faits incertains => echec explicite, jamais
    // de recolte declaree faite ici.
    //
    // Anti-sur-don (S6) : chaque appel passe par le grand livre de l engagement
    // (objectif, destinataire, objet). Plafond = demande chiffree, jamais
    // invente ; incertain existant ou plafond atteint => AUCUN toss (refus
    // honnete, pas de retoss auto) ; quantite rabottee au restant du plafond.
    async donner (scale, params = {}) {
      const bot = host.getBot()
      const objet = String(params.objet ?? '').trim().toLowerCase()
      const quantite = Number(params.quantite)
      const destinataire = String(params.destinataire ?? mission.requester ?? '').trim()
      if (!objet || !/^[a-z0-9_]+$/.test(objet)) {
        return { resultat: 'don impossible : objet d inventaire non precise', echec: true, code: 'invalid_item' }
      }
      if (!Number.isInteger(quantite) || quantite < 1 || quantite > 64) {
        return { resultat: `don impossible : quantite invalide (${String(params.quantite)})`, echec: true, code: 'invalid_count' }
      }
      if (!destinataire || !/^[A-Za-z0-9_]{3,16}$/.test(destinataire)) {
        return { resultat: 'don impossible : destinataire non precise', echec: true, code: 'invalid_player' }
      }
      if (mission.cancelled) return { resultat: 'don interrompu (stop/pause)', echec: true, code: 'cancelled' }
      // Don jamais demande : le plan (reflexion de fond d alors) ajoutait « livrer »
      // de lui-meme, et la fabrication partait aux pieds du joueur
      // (craft/from-tree et craft/torches 4b9eb74 : 0 en inventaire, echec).
      // Seul un texte du joueur avec un verbe de don l autorise.
      if (!livraisonDemandee(mission)) {
        return { resultat: 'don refuse : le joueur n a rien demande a recevoir ; garder les objets en inventaire', echec: true, code: 'not_requested' }
      }
      const ceiling = deliveryCeiling(mission, objet)
      const ledger = engagementDon(params)
      const arbre = arbreAvantLivraison(objet)
      if (arbre) return arbre
      if (ceiling === null) {
        return { resultat: `don impossible : quantite totale indeterminee pour ${objet} vers ${destinataire} — demande une precision au joueur (dire), n invente aucun quota`,
          echec: true, code: 'no_ceiling', livraison: deliveryLedgerView(ledger) }
      }
      if (ledger.uncertain > 0) {
        return { resultat: `don bloque : ${ledger.uncertain} ${objet} sorti(s) sans preuve vers ${destinataire} — budget incertain consomme, aucun nouvel essai automatique (pause ou aide), contexte conserve`,
          echec: true, code: 'uncertain_blocked', livraison: deliveryLedgerView(ledger) }
      }
      const restant = ceiling - ledger.proven - ledger.uncertain
      if (restant <= 0) {
        return { resultat: `don deja couvert : ${ledger.proven}/${ceiling} ${objet} prouve(s) vers ${destinataire}, aucun sur-don`,
          echec: true, code: 'already_covered', livraison: deliveryLedgerView(ledger) }
      }
      const take = Math.min(quantite, restant)
      const notePlafond = take < quantite ? ` (plafonne a ${take}/${quantite}, plafond engagement ${ceiling})` : ''
      let res
      try {
        res = await delivery.giveToPlayer(bot, {
          player: destinataire,
          item: objet,
          count: take,
          signal: mission.navigationAbort.signal,
          navigator: {
            toPlayer: (u, o) => host.navigateToPlayer(u, { ...o, __owner: getStepToken() }),
            toPosition: (p, o) => host.navigateToPosition(p, { ...o, __owner: getStepToken() })
          },
          announce: (texte) => { try { host.chat(texte) } catch (_) {} },
          onActivity: (evt) => { try { mission.activity?.update('execution', evt?.text ?? 'Je dépose…', true) } catch (_) {} }
        })
      } catch (err) {
        return { resultat: `don impossible : ${err.message}`, echec: true, code: 'error', livraison: deliveryLedgerView(ledger) }
      }
      if (!res) return { resultat: 'don impossible : reponse vide', echec: true, code: 'unknown', livraison: deliveryLedgerView(ledger) }
      // Commit livre : tente/retire/prouve/incertain, invocation id. L incertain
      // ne blanchit jamais : ni la file, ni terminer/fini, ni un retoss auto.
      ledger.invocations.push(`${mission.id}#don-${ledger.invocations.length + 1}`)
      ledger.attempted += take
      if (Number.isFinite(res.inventoryRemoved)) ledger.removed += Math.max(0, res.inventoryRemoved)
      ledger.proven += Math.max(0, res.deposited)
      ledger.uncertain = Math.max(0, ledger.removed - ledger.proven)
      ledger.done = ledger.proven >= ceiling
      const vue = deliveryLedgerView(ledger)
      if (res.status === 'succeeded') {
        return { resultat: `depose ${res.deposited}/${res.requested} ${res.evidence.item} aux pieds de ${destinataire} (${res.reason})${notePlafond}`, livraison: vue }
      }
      if (res.status === 'partial') {
        return { resultat: `depot partiel ${res.deposited}/${res.requested} ${res.evidence.item} aux pieds de ${destinataire} (${res.reason})${notePlafond}`, echec: true, code: res.reason, livraison: vue }
      }
      if (res.status === 'cancelled') {
        return { resultat: `don interrompu (${res.reason})${notePlafond}`, echec: true, code: 'cancelled', livraison: vue }
      }
      return { resultat: `don impossible (${res.reason}) : ${res.deposited}/${res.requested} depose(s)${notePlafond}`, echec: true, code: res.reason, livraison: vue }
    },

    // Il y avait ici `explorer`, qui deleguait au pathfinder (GoalNearXZ sur un
    // cap des HEADINGS). Retire du catalogue : le planificateur navigue
    // desormais lui-meme avec `pivoter`/`regarder` + `avancer`, et l indice
    // `environnement.navigation` de buildState() lui dit ou aller.

    // Avec cible : trajet A* vers un poste d interaction. Sans cible : geste
    // dans le cap courant, avec budget de distance mesure.
    async avancer (scale, params = {}) {
      const distance = Number.isFinite(Number(params.distance))
        ? Math.max(1, Math.min(EXPLORE_MAX, Math.round(Number(params.distance))))
        : scaled(scale, 1, EXPLORE_MAX)

      let cible = mission.kind === 'geste'
        ? null
        : (findTargetBlock() ??
          (mission.landmarkResource ? findTargetBlock(mission.landmarkResource) : null))

      // A nearby high target is known work, not an invitation to explore blindly.
      // Explicit movement gestures keep their existing free-movement semantics.
      const high = !cible && mission.kind !== 'geste' ? highTargetHint() : null
      // Moteur d acces unique d abord (A/B acces_unifie) ; la cascade
      // historique reste le recours tant que la mesure n a pas tranche.
      const parMoteur = async (bloc, avant) => {
        if (!featureOn('acces_unifie', false) || params.__acces || !bloc || mission.cancelled) return null
        const r = await atteindre(bloc)
        const bilan = `${r.poses} pose(s), ${r.casses} casse(s)`
        console.log(`[mission] acces ${bloc.name} : ${r.code} (${bilan})`)
        if (!r.reached) return null
        return { resultat: `${avant}${bloc.name} rejoint a portee par le moteur d acces (${bilan}, trajet de ${r.travelled ?? 0} bloc(s))`,
          code: 'acces', ...(r.poses > 0 ? { reobserver: true } : {}) }
      }
      if (high) {
        const direct = await parMoteur(host.getBot()?.blockAt(high.position), `cible haute ${high.cible} : `)
        if (direct) return direct
        // Cible deja a portee horizontale, seule la hauteur manque : le code
        // monte lui-meme (trees/bent 93a6f04 : echec « piler peut aider »).
        // Stock court compris : piler prend la terre voisine lui-meme (trees/bent
        // 7b01683 : refus « stock court » a 0 dirt, un tour de plan perdu).
        // Minimum height measured with the real reach (3D distance and sight
        // line from a virtual post), not denivele - MAX_REACH_UP: a target
        // also 3 blocks away sideways needs more (revue Codex).
        const poste = host.getBot()
        const pied = poste.entity.position.floored()
        const centre = high.position.offset(0.5, 0.5, 0.5)
        const ici = perception.hauteurDePilier(poste, poste.entity.position, pied.y, centre, 1)
        const besoin = ici.hauteur ?? 0
        let montee = null
        if (!besoin) {
          const constat = ici.obstacle
            ? `montee bloquee ici : ${ici.obstacle} a +${ici.niveau} au-dessus des pieds, piler ne passerait pas`
            : `aucune hauteur de pilier (1 a ${PILER_MAX}) ne met la cible a portee d ici`
          montee = `${constat} : changer de poste (${ici.obstacle ? 'autre cote de la cible' : 'se rapprocher horizontalement'})`
          // The code looks for the post itself and walks there, instead of
          // handing « changer de poste » back to the planner, which repeated
          // avancer/recolter from the same spot (maison en pierre ~aleatoire 858ba92 :
          // perche a 2.4 blocs d une buche a +4, dix tours sans bouger).
          if (!params.__posteCherche && !mission.cancelled) {
            const deplace = await rejoindrePosteDePilier(high, centre)
            if (deplace.atteint) {
              const suite = await ACTIONS.avancer(scale, { ...params, __posteCherche: true })
              return { ...suite, resultat: `${deplace.resultat} ; ${suite.resultat}` }
            }
            if (deplace.resultat) montee = `${constat} ; ${deplace.resultat}`
          }
        }
        let tentative = ''
        // Same mission kinds as the planner's piler (skills.js): a movement goal
        // never digs terrain nor builds a pillar on its own.
        // An active chantier is never touched: piler may undo a column or dig
        // dirt next to the bot without the footprint protection.
        if (besoin >= 1 && besoin <= PILER_MAX && ['recolte', 'construction'].includes(mission.kind) &&
          !empriseChantier() && !mission.cancelled) {
          const pile = await ACTIONS.piler(null, { hauteur: besoin })
          // Reach checked from the top: gathering dirt may have moved the post.
          // En construction, findTargetBlock peut renvoyer la terre a creuser
          // (build/tower 0b1d4a3) : une buche de l'arbre commence porte la
          // decision, pas ce bloc-là (memes gardes que le plafond de piler).
          const cibleVisee = pile.echec ? null : findTargetBlock()
          const cibleBuche = cibleVisee && TREE_LOG.test(cibleVisee.name)
          const atteinte = cibleVisee && (mission.kind !== 'construction' || cibleBuche) ? cibleVisee : null
          const live = host.getBot()
          if (atteinte && live?.entity && blockInReach(live, live.entity.position, atteinte.position.offset(0.5, 0.5, 0.5), REACH)) {
            return { resultat: `cible haute ${high.cible} : ${pile.resultat}`, code: 'pilier', reobserver: true }
          }
          tentative = pile.echec ? ` Pilier tente : ${pile.resultat}.`
            : ` Pilier pose (${pile.resultat}) mais aucune cible a portee depuis le sommet : reobserver.`
        }
        // Measured after the attempt: piler may have gathered dirt or left a partial pillar.
        const stock = scaffoldingStock(host.getBot()).total
        const dirt = craft.countOf(host.getBot(), PILER_DIRT)
        const next = montee && !besoin ? montee : stock > 0
          ? 'piler peut aider si l appui et l espace au-dessus sont libres ; la pose reste a verifier'
          : 'stock court : piler recupere lui-meme la terre manquante (pilier defait puis refait, terre prise a cote)'
        return {
          resultat: `cible haute ${high.cible} a ${high.distance} bloc(s), +${high.denivele} en hauteur, ` +
            `${stock} blocs d echafaudage (${dirt} dirt) en inventaire : ${next}. Avancer au sol ne resout pas ce denivele.${tentative}`,
          echec: true,
          code: 'cible_haute'
        }
      }

      // Matiere plus bas ou plus haut que les bornes de casse : on la vise
      // quand meme pour s en approcher (en creusant au besoin, sans chute).
      if (!cible && (mission.kind === 'recolte' || arbreInacheve())) cible = findTargetBlock(undefined, { anyHeight: true })

      if (!cible) {
        // Filet minimal sans cible : meme budget que le chemin avec cible
        // (paliers de NAV_PALIER_MAX + NAV_MAX_STRAFES contournement(s) max).
        // Avant : un seul walkForward aveugle, sans strafe ni re-pivot — un
        // obstacle lateral bloquait tout. Desormais : on garde le cap initial,
        // on re-pivote dessus a chaque palier (le strafe fait deriver), et un
        // palier bloque tente un pas de cote fonde sur le relief local avant
        // d echouer proprement. Meme convention qu avec cible : echec = file
        // videe, le planificateur replanifie sur l etat reel.
        const capBot = host.getBot()
        // Perche sur son propre pilier : redescendre d abord (colonne isolee
        // seulement, jamais le sol), plutot que de marcher dans le vide.
        const porteurLibre = capBot?.entity ? capBot.blockAt(capBot.entity.position.offset(0, -0.5, 0)) : null
        if (porteurLibre && isPillarBlock(capBot, porteurLibre)) {
          const defaits = await descendScaffold(-Infinity, { pillarOnly: true })
          if (defaits) console.log(`[mission] avancer : pilier defait avant de marcher (${defaits} bloc(s))`)
        }
        const capYaw = capBot?.entity ? capBot.entity.yaw : 0
        let restantLibre = distance
        let parcouruLibre = 0
        let strafesLibres = 0
        let coteLibre = mission.lastStrafeSide === 'left' ? 'right' : 'left'
        const maxToursLibres = Math.ceil(distance / NAV_PALIER_MAX) + NAV_MAX_STRAFES + 1
        for (let tour = 0; tour < maxToursLibres && restantLibre > 0.1; tour += 1) {
          if (mission.cancelled) break
          const live = host.getBot()
          if (!live?.entity) break
          try { await live.look(capYaw, live.entity.pitch, true) } catch (_) {}
          const palier = Math.min(restantLibre, NAV_PALIER_MAX)
          const walk = await walkForward(palier)
          parcouruLibre += walk.moved
          restantLibre -= walk.moved
          if (walk.vide) {
            return {
              resultat: `arret au bord apres ${parcouruLibre.toFixed(1)} bloc(s) : vide de ${walk.vide}+ bloc(s) devant ` +
                '(chute blessante). Descendre d abord (defaire le pilier, ou avancer vers une cible) ou changer de cap.',
              echec: true
            }
          }
          if (!walk.blocked && walk.moved >= 0.5) continue
          if (parcouruLibre >= distance) break
          if (strafesLibres >= NAV_MAX_STRAFES) {
            const detour = await detourDansLeCap(capYaw, restantLibre)
            if (detour) {
              return { resultat: `avance de ${(parcouruLibre + detour).toFixed(1)} bloc(s) sur ${distance} demande(s) (detour calcule autour de l obstacle)` }
            }
            return {
              resultat: `bloque apres ${parcouruLibre.toFixed(1)} bloc(s) sur ${distance} demande(s) : ` +
                'aucun chemin dans ce cap, meme par un detour calcule : changer de cap (pivoter) ' +
                'ou viser une cible.' + conseilPilier(),
              echec: true
            }
          }
          strafesLibres += 1
          const coteChoisi = choisirCoteContournement(live.entity.yaw, null, reliefLocal())
          const cote = coteChoisi ?? coteLibre
          mission.lastStrafeSide = cote
          parcouruLibre += await strafeStep(cote)
          coteLibre = cote === 'left' ? 'right' : 'left'
          restantLibre = Math.max(0, distance - parcouruLibre)
        }
        const detourFinal = parcouruLibre < 0.5 ? await detourDansLeCap(capYaw, restantLibre) : 0
        if (detourFinal) {
          return { resultat: `avance de ${(parcouruLibre + detourFinal).toFixed(1)} bloc(s) sur ${distance} demande(s) (detour calcule autour de l obstacle)` }
        }
        if (parcouruLibre < 0.5) {
          return {
            resultat: `bloque apres ${parcouruLibre.toFixed(1)} bloc(s) sur ${distance} demande(s) : ` +
              'aucun chemin dans ce cap, meme par un detour calcule : changer de cap (pivoter) ' +
              'ou viser une cible.' + conseilPilier(),
            echec: true
          }
        }
        return {
          resultat: `avance de ${parcouruLibre.toFixed(1)} bloc(s) sur ${distance} demande(s)` +
            (strafesLibres > 0 ? ` (${strafesLibres} contournement(s))` : '')
        }
      }

      // Destination de travail : A* choisit un poste libre d ou le bloc est
      // visible et a portee. Le LLM ne pilote plus les virages/contournements.
      // Budget de trajet : la distance du modele, mais au moins 1,5 fois la
      // ligne droite jusqu a la cible (48 au plus). Le modele recopie la
      // distance HORIZONTALE de l indice navigation, le chemin reel contourne :
      // `avancer` s arretait court et le `casser` suivant echouait « trop
      // loin » (82 echecs par banc, revue de performance du 2026-09-27).
      const direct = await parMoteur(cible, '')
      if (direct) return direct
      const ligne = host.getBot()?.entity?.position?.distanceTo(cible.position.offset(0.5, 0.5, 0.5)) ?? distance
      const budget = Math.max(distance, Math.min(48, Math.ceil(ligne * 1.5) + 2))
      const approach = () => host.navigateToPosition(cible.position.offset(0.5, 0.5, 0.5), {
        signal: mission.navigationAbort.signal, __owner: stepToken,
        interaction: true, allowHighApproach: true, distanceBudget: budget
      })
      let result = await approach()
      // Perche sur son propre pilier (piler juste avant) : le navigateur ne
      // descend que de deux blocs, tout trajet repondait no_path
      // (composite/cabin-from-scratch ba7cc6f : pilier de 3, puis ~50 avancer
      // et recolter en no_path). Le pilier est defait, puis on re-tente.
      if (result.code === 'no_path' && !mission.cancelled) {
        const live = host.getBot()
        const dessous = live?.entity && live.blockAt(live.entity.position.offset(0, -0.5, 0))
        if (dessous && (PILER_DIRT.test(dessous.name) || /_planks$/.test(dessous.name)) && isPillarBlock(live, dessous)) {
          const defaits = await descendScaffold(-Infinity, { pillarOnly: true })
          if (defaits > 0) result = await approach()
        }
      }
      // Recolte, ou construction qui s approvisionne (cabane depuis rien) : memes
      // recours (montee, pont, trajet qui creuse). En construction, le trajet
      // qui creuse ne casse jamais ce qu un joueur ou le bot a construit.
      const recours = mission.kind === 'recolte' || mission.kind === 'construction'
      // Tronc enferme dans des feuilles : sans degagement, no_path en boucle et
      // aucune action ne pouvait ouvrir le passage. On casse seulement les
      // feuilles du couloir a hauteur du corps, puis on re-tente l approche.
      let feuilles = 0
      while (result.code === 'no_path' && harvestResource() === 'bois' && !mission.cancelled &&
        feuilles < LEAF_CLEAR_MAX) {
        const cleared = await clearLeavesToward(cible, LEAF_CLEAR_MAX - feuilles)
        if (cleared === 0) break
        feuilles += cleared
        result = await approach()
      }
      if (feuilles > 0) mission.leavesCleared = (mission.leavesCleared ?? 0) + feuilles
      let degage = feuilles > 0 ? ` (${feuilles} feuille(s) degagee(s) vers le tronc)` : ''
      // Toujours aucun chemin (mur de terre, trou, falaise) : trajet qui creuse
      // en escalier, sans chute de plus de deux blocs, puis re-approche.
      // Arbre sur une hauteur (falaise) : monter en pilier au pied du relief
      // avec de la terre prise dans le relief lui-meme, puis rejoindre a pied.
      // L escalier creuse par le pathfinder ne laissait pas la place de la tete
      // (sauts sur place mesures) ; le pilier maison est prouve.
      let climbed = null
      if ((result.code === 'no_path' || result.code === 'needs_height') && recours && !mission.cancelled) {
        climbed = await climbToward(cible)
        if (climbed) {
          degage += ` (${climbed})`
          result = await approach()
        }
      }
      // Eau entre le bot et l arbre (ile, fosse) : le pathfinder qui creuse y
      // entrait, et le bot ne ressort pas de l eau en 26.1 (vu sur
      // terrain/moat). Pont de terre pose a la main, sinon echec franc.
      let noye = false
      // Eau seulement : perche sur un pilier, le vide alentour n est pas un
      // fosse (vu sur trees/tall : pont pose en l air depuis le pilier, puis
      // chute de 4 blocs en le defaisant).
      if (result.code === 'no_path' && recours && !mission.cancelled && gapToward(cible.position, { liquidOnly: true })) {
        const bridged = await bridgeRounds(cible.position, stepToken, { liquidOnly: true })
        if (bridged) {
          degage += ' (pont de terre pose)'
          result = await approach()
        } else {
          noye = true
          degage += ' (eau vers la cible, pont inacheve : trouver de la terre)'
        }
      }
      const farAbove = result.code === 'needs_height' && Number(result.horizontalDistance) > REACH
      if ((result.code === 'no_path' || farAbove) && !noye && recours && !mission.cancelled &&
        typeof host.digToward === 'function') {
        const dug = await host.digToward(cible.position.offset(0.5, 0.5, 0.5), {
          signal: mission.navigationAbort.signal, protectBuilt: mission.kind === 'construction', block: cible.position
        })
        if (dug.reached) {
          mission.digPaths = (mission.digPaths ?? 0) + 1
          degage += ` (chemin creuse sur ${dug.travelled} bloc(s))`
          result = await approach()
          if (!result.reached && result.code !== 'advanced') {
            // `digToward` s arrete a 4 blocs du centre, parfois derriere un mur
            // (sable enferme dans la terre) : « rejoint a portee » etait alors
            // faux, et le modele relancait `avancer` sans fin (vu : 15 fois,
            // 0 bloc). Portee verifiee comme dans l etat ; sinon on creuse
            // jusqu a toucher la cible, et l echec reste un echec.
            const centre = cible.position.offset(0.5, 0.5, 0.5)
            const inReach = () => {
              const live = host.getBot()
              return Boolean(live?.entity && blockInReach(live, live.entity.position, centre, REACH))
            }
            let travelled = dug.travelled
            if (!inReach() && !mission.cancelled) {
              const closer = await host.digToward(centre, { signal: mission.navigationAbort.signal, range: 1, protectBuilt: mission.kind === 'construction' })
              if (closer.travelled) travelled += closer.travelled
            }
            // Le trajet creuse a pu mettre a portee un autre bloc de la meme
            // matiere : c est lui la cible (gather/sand-walled 93a6f04 : echec
            // « dug_out_of_reach », puis sable a 0.5 bloc a l etape suivante).
            if (!inReach() && !mission.cancelled) {
              const autre = findTargetBlock()
              const live = host.getBot()
              if (autre && live?.entity && blockInReach(live, live.entity.position, autre.position.offset(0.5, 0.5, 0.5), REACH)) cible = autre
            }
            const aPortee = inReach() || Boolean(cible && host.getBot()?.entity &&
              blockInReach(host.getBot(), host.getBot().entity.position, cible.position.offset(0.5, 0.5, 0.5), REACH))
            result = aPortee
              ? { reached: true, travelled, code: 'dug' }
              : { reached: false, travelled, code: 'dug_out_of_reach' }
          }
        } else {
          degage += ` (chemin creuse impossible : ${dug.code})`
        }
      }
      // Le trajet qui creuse a pu rapprocher le bot du relief sans l y faire
      // monter : on retente la montee une fois, depuis le pied de la falaise
      // (vu sur terrain/plateau : premier avancer en no_path, et seul un
      // modele qui relancait avancer de lui-meme finissait l arbre).
      if (!climbed && !result.reached && result.code !== 'advanced' && !noye &&
        recours && !mission.cancelled) {
        climbed = await climbToward(cible)
        if (climbed) {
          degage += ` (${climbed})`
          result = await approach()
        }
      }
      // Poste atteint au sol, cible trop haute : la hauteur de pilier se
      // mesure (ecart - portee), et avec l echafaudage en poche le code monte
      // lui-meme au lieu d un echec « reobserve » qui jetait le plan
      // (trees/bent e58d6cd). Sans stock : l echec dit le besoin.
      if (result.code === 'needs_height' && mission.kind === 'recolte' && !mission.cancelled) {
        const besoin = Math.ceil(Number(result.verticalGap) - MAX_REACH_UP)
        if (besoin >= 1 && besoin <= PILER_MAX && scaffoldingStock(host.getBot()).total >= besoin) {
          const pile = await ACTIONS.piler(null, { hauteur: besoin })
          const live = host.getBot()
          if (!pile.echec && live?.entity && blockInReach(live, live.entity.position, cible.position.offset(0.5, 0.5, 0.5), REACH)) {
            return { resultat: `${cible.name} rejoint a portee par un pilier de ${besoin} : ${pile.resultat}`, code: 'pilier', reobserver: true }
          }
          degage += ` (pilier de ${besoin} : ${pile.resultat})`
        }
      }
      if (!result.reached && ['no_path', 'dug_out_of_reach'].includes(result.code) && cible?.position) {
        marquerInjoignable(cible.position)
        degage += ' ; ce bloc est mis de cote, le prochain avancer en visera un autre'
      }
      return {
        resultat: (result.reached
          ? `${cible.name} rejoint a portee, trajet de ${result.travelled ?? 0} bloc(s)`
          : result.code === 'advanced'
            ? `avance de ${result.travelled} bloc(s) sur le chemin vers ${cible.name}; cible pas encore a portee`
            : result.code === 'needs_height'
              ? `poste proche de ${cible.name} rejoint a ${result.horizontalDistance} bloc(s) au sol ; ` +
                `cible encore trop haute (+${result.verticalGap}), hors portee : reobserve avant de choisir comment monter`
            : `approche de ${cible.name} impossible : ${result.code}`) + degage,
        echec: !result.reached && result.code !== 'advanced',
        code: result.code
      }
    },
    // Monter en pilier : poser de la dirt sous soi en sautant, niveau par
    // niveau, pour atteindre des blocs hors de portee verticale (le haut d un
    // tronc, que MAX_REACH_UP filtre depuis le sol). Passe par run()/outcome
    // comme toute action : un echec vide la file et fait replanifier, donc le
    // prefetch speculatif est jete avec le reste du plan.
    //
    // Survie sans cheat : la dirt vient de l inventaire REEL (aucun remplissage
    // de main, aucun /tp, aucun passage en creatif). Sans dirt, echec explicite
    // qui aiguille vers `casser` de la dirt au sol. Chaque pose est verifiee
    // dans le monde : un refus serveur n est jamais compte comme une reussite.
    async piler (scale, params = {}) {
      const bot = host.getBot()
      let hauteur = Number.isFinite(Number(params.hauteur))
        ? Math.max(PILER_MIN, Math.min(PILER_MAX, Math.round(Number(params.hauteur))))
        : scaled(scale, PILER_MIN, PILER_MAX)
      let ajuste = ''
      // Precondition (hors liquide) : CONTRATS.piler.

      // Un pilier sous une cible deja cassable gaspille de la dirt : le dire au
      // lieu de monter pour rien. Recolte seulement : en construction la cible
      // est la terre a prendre, pas la case a atteindre (build/tower 0b1d4a3 :
      // bot emmure au pied d une tour creuse, derniere case du toit a +5,
      // piler(4) refuse « grass_block deja a portee », plafond de 300 s).
      const cible = mission?.kind === 'construction' ? null : findTargetBlock()
      if (cible && blockInReach(bot, bot.entity.position, cible.position.offset(0.5, 0.5, 0.5), REACH)) {
        return { resultat: `${cible.name} deja a portee : casser directement, pas de pilier`, echec: true }
      }
      // Cible a +2 au plus au-dessus des pieds, bot au sol : elle se casse
      // depuis le sol en s approchant. Un pilier y coutait un trou dans le sol
      // (terre prise sur place) et un bloc pose pour rien (vu : trees/reachable,
      // derniere buche d un tronc de 3).
      const ecart = cible ? cible.position.y - Math.floor(bot.entity.position.y) : null
      const porteur = bot.blockAt(bot.entity.position.offset(0, -0.5, 0))
      const perche = porteur && isPillarBlock(bot, porteur)
      if (cible && bot.entity.onGround && !perche && ecart !== null && ecart <= 2) {
        return {
          resultat: `${cible.name} a +${ecart} seulement : pas de pilier, avancer plus pres (avancer vers la cible) puis casser`,
          echec: true
        }
      }
      // Hauteur trop courte pour la cible la plus basse encore hors de portee :
      // la dire au lieu de monter d un bloc pour rien (vu sur
      // chat/replace-and-join : piler(1) depuis un trou, puis encore piler(1),
      // trois minutes sans atteindre le tronc). La valeur n est pas changee.
      if (!cible) {
        const haute = findTargetBlock(undefined, { anyHeight: true })
        // Recolte sans aucune cible restante, a aucune hauteur : rien a
        // atteindre. Un plan anticipe calcule avant la derniere coupe
        // demandait encore piler(1) ; faute de terre, le bot creusait le sol
        // pour un pilier inutile (trees/reachable, 0e5dee5 : sol_intact faux).
        // Les montees internes (sortie de trou, falaise) passent `interne`.
        if (!haute && !params.interne && mission?.kind === 'recolte') {
          return { resultat: 'aucune cible restante a atteindre, a aucune hauteur : pas de pilier, reobserver', echec: true }
        }
        const ecartHaut = haute ? haute.position.y - Math.floor(bot.entity.position.y) : null
        const minimum = ecartHaut === null ? 0 : ecartHaut - MAX_REACH_UP
        // Hauteur hors de l intervalle utile mesure : ramenee dedans (le code
        // mesure la cible). Avant, un refus qui jetait le plan (« trop
        // courte », 2 fois par banc) pour un simple ecart d un bloc.
        if (haute && mission?.kind !== 'construction' && minimum > hauteur && minimum <= PILER_MAX) {
          ajuste = ` (hauteur ${hauteur} portee a ${minimum} : ${haute.name} a +${ecartHaut})`
          hauteur = minimum
        }
        // Symetrique : plus haut que le sommet du tronc vise, le bot monte dans
        // la couronne (feuilles cassees au-dessus de la tete) sans rien gagner.
        // Vu sur trees/pillar (05a529) : derniere buche a +4, piler(5), une
        // feuille cassee, « saut trop bas » au niveau 5. La valeur n est pas
        // changee : refus qui dit l intervalle utile.
        if (haute && mission?.kind === 'recolte' && !params.interne) {
          let sommet = haute.position
          while (/_(log|stem)$/.test(bot.blockAt(sommet.offset(0, 1, 0))?.name ?? '')) sommet = sommet.offset(0, 1, 0)
          const maximum = sommet.y - Math.floor(bot.entity.position.y) - 1
          if (maximum >= Math.max(1, minimum) && hauteur > maximum) {
            ajuste = ` (hauteur ${hauteur} ramenee a ${maximum} : sommet du tronc a +${maximum + 1})`
            hauteur = maximum
          }
        }
      }

      let available = scaffoldingStock(bot)
      // Stock court : aller chercher le manque soi-meme plutot que d echouer
      // en boucle (vu sur trees/tall : perche a +2 sans terre, aucune action
      // ne pouvait en obtenir depuis le haut). Defaire son propre pilier rend
      // ses blocs ; la hauteur visee reste la meme (pilier refait plus haut).
      let hauteurVisee = hauteur
      let recupere = ''
      let redescendu = 0
      if (available.total < hauteur && !mission.cancelled) {
        const yHaut = bot.entity.position.y
        const under = bot.blockAt(bot.entity.position.offset(0, -0.5, 0))
        if (under && isPillarBlock(bot, under)) {
          await descendScaffold(-Infinity, { pillarOnly: true })
          await collectScaffoldDrops(stepToken, { budgetMs: 15000 })
        }
        redescendu = Math.max(0, Math.round(yHaut - host.getBot().entity.position.y))
        hauteurVisee = Math.min(PILER_MAX, hauteur + redescendu)
        if (scaffoldingStock(bot).total < hauteurVisee) {
          // Bornes de temps : vu sur chat/replace-and-join, bot tombe dans un
          // trou qu il venait de creuser et l action ne rendait plus la main.
          // Chantier en cours : sa terre n est jamais prise (emprise +1).
          const emprise = empriseChantier()
          await gatherDirt(hauteurVisee, (x, z) => dansEmprise(emprise, { x, z }), { sol: true, budgetMs: 25000 })
          await collectScaffoldDrops(stepToken, { budgetMs: 15000 })
        }
        available = scaffoldingStock(bot)
        recupere = ` (terre obtenue sur place : ${available.total} bloc(s)` +
          (redescendu ? `, pilier de ${redescendu} defait puis refait` : '') + ')'
        if (redescendu && available.total < hauteurVisee) hauteurVisee = Math.max(redescendu, available.total)
      }
      if (available.total < hauteurVisee) {
        return { resultat: `stock d echafaudage insuffisant : ${available.total}/${hauteurVisee} blocs disponibles, obtenir le manque avant de monter`,
          echec: true, code: 'stock_echafaudage_insuffisant' }
      }

      // Au bord d un trou (souvent celui ou la terre vient d etre prise) : la
      // case sous le centre du bot est vide. Un pas vers la case voisine la
      // plus proche qui a un appui et deux blocs libres (vu sur trees/tall :
      // trois refus « plus d appui solide sous les pieds »).
      {
        const here = bot.entity.position
        const pied = here.floored()
        if (!estSolide(bot.blockAt(pied.offset(0, -1, 0)))) {
          let poste = null
          for (let dx = -1; dx <= 1; dx += 1) {
            for (let dz = -1; dz <= 1; dz += 1) {
              const c = pied.offset(dx, 0, dz)
              if (!estSolide(bot.blockAt(c.offset(0, -1, 0))) || estSolide(bot.blockAt(c)) || estSolide(bot.blockAt(c.offset(0, 1, 0)))) continue
              const d = Math.hypot(c.x + 0.5 - here.x, c.z + 0.5 - here.z)
              if (!poste || d < poste.d) poste = { c, d }
            }
          }
          if (poste) {
            await host.navigateToPosition(poste.c.offset(0.5, 0, 0.5), {
              signal: mission.navigationAbort.signal, __owner: stepToken, radius: 0.3, distanceBudget: 3, timeoutMs: 4000
            })
          }
        }
      }

      // Un objectif de pathfinder en cours se battrait avec le saut.
      host.stopPathfinding()

      const y0 = bot.entity.position.y
      let poses = 0
      let failure = null
      let cibleAtteinte = null
      // Climbed for a log: the pillar comes down once the tree is finished.
      const pourArbre = featureOn('arbre_fini') &&
        Boolean(arbreInacheve() || TREE_LOG.test(highTargetHint()?.cible ?? '') || TREE_LOG.test(findTargetBlock()?.name ?? ''))

      for (let niveau = 0; niveau < hauteurVisee; niveau += 1) {
        if (mission.cancelled) break
        const live = host.getBot()
        if (!live?.entity) {
          failure = 'bot deconnecte'
          break
        }

        // Relu a chaque niveau : le stock se vide en montant.
        const stock = scaffoldingStock(live).materiaux[0]
        if (!stock) {
          failure = 'plus de blocs d echafaudage en inventaire'
          break
        }
        // Terre posee pres de l herbe : grass_block des le tick suivant (vu sur
        // join/shaft 5f0545a, « bloc non pose au niveau 1 (case : grass_block) »).
        const poseConforme = nom => nom === stock.nom ||
          (/dirt$/.test(stock.nom) && (nom === 'grass_block' || nom === 'dirt'))

        // Center column first; after a slide the bot may stand on a
        // neighbour column of its hitbox (trees/tall 799e412 : pieds z 21.02,
        // appui en z 20, « plus d appui solide sous les pieds »).
        const centre = live.entity.position.floored()
        const ancre = [centre, ...colonnesSousHitbox(live.entity.position, centre.y)
          .filter(colonne => !colonne.equals(centre))]
          .find(colonne => estSolide(live.blockAt(colonne.offset(0, -1, 0))) && !estSolide(live.blockAt(colonne))) ?? centre
        const appui = live.blockAt(ancre.offset(0, -1, 0))
        if (!estSolide(appui)) {
          failure = 'plus d appui solide sous les pieds'
          break
        }
        const casePieds = live.blockAt(ancre)
        if (casePieds && estSolide(casePieds)) {
          failure = 'case occupee a hauteur des pieds'
          break
        }
        // Plafond : un pilier sous un toit coince la tete du bot. Des feuilles
        // (couronne d un arbre) se cassent au lieu d arreter la montee. Toutes
        // les colonnes sous la hitbox comptent : decentre, la tete touche la
        // colonne voisine (trees/tall 9e079e5 : z 19.18).
        const colonnes = colonnesSousHitbox(live.entity.position, ancre.y)
        for (const colonne of colonnes) {
          for (const dy of [2, 1]) {
            const haut = live.blockAt(colonne.offset(0, dy, 0))
            if (!haut || !/_leaves$/.test(haut.name)) continue
            try {
              await withTimeout(live.lookAt(haut.position.offset(0.5, 0.5, 0.5), true), 4000, 'visee trop longue')
              await withTimeout(live.dig(haut), 6000, 'creusage trop long')
              mission.leavesCleared = (mission.leavesCleared ?? 0) + 1
            } catch (_) {}
          }
        }
        if (colonnes.some(colonne => [1, 2].some(dy => estSolide(live.blockAt(colonne.offset(0, dy, 0)))))) {
          // Often the trunk itself (trees/tall 9e079e5 : buche voisine au-dessus
          // de la tete, « saut trop bas » au niveau 5) : if the target is
          // breakable from here, the climb is done, same rule as the preflight.
          // En construction aussi : findTargetBlock peut y renvoyer la terre a
          // creuser (build/tower 0b1d4a3), on n'accepte donc que la buche de
          // l'arbre commence (banc composite bdda929 : plafond au tronc puis
          // echafaudage demonte, la cible a +4 jamais rejoinie ni coupe).
          const cibleVisee = poses > 0 && !params.interne ? findTargetBlock() : null
          const cibleBuche = cibleVisee && TREE_LOG.test(cibleVisee.name)
          if (cibleVisee && (mission?.kind !== 'construction' || cibleBuche) &&
            blockInReach(live, live.entity.position, cibleVisee.position.offset(0.5, 0.5, 0.5), REACH)) {
            cibleAtteinte = cibleVisee.name
          } else failure = 'plafond au-dessus : impossible de monter ici'
          break
        }

        try {
          const owned = live.inventory.items().find(item => item.name === stock.nom)
          if (!owned) {
            failure = `plus de ${stock.nom} en inventaire`
            break
          }
          if (!live.heldItem || live.heldItem.name !== stock.nom) {
            await withTimeout(live.equip(owned, 'hand'), 4000, 'equipement trop long')
          }
          await withTimeout(live.lookAt(ancre.offset(0.5, 0.5, 0.5), true), 4000, 'visee trop longue')
        } catch (err) {
          failure = err.message
          break
        }

        // Saut + pose : quitter la case avant d y poser le bloc, comme le poste
        // de tir de build.js qui ne recouvre jamais le corps du bot. La pose
        // part pres du SOMMET du saut (dy >= 1,0) : plus bas, le corps recouvre
        // encore la case visee et le serveur refuse (« the block is still air »,
        // mesure en jeu au niveau 2 d un pilier). Le sommet se detecte en
        // echantillonnant : quand la montee cale deux fois de suite, on y est.
        // Deux tentatives par niveau : un refus serveur re-saute et repose, et
        // seule la seconde epuise le niveau.
        let poseOk = false
        for (let essai = 1; essai <= 2 && !poseOk; essai += 1) {
          if (mission.cancelled) break
          const yDepart = live.entity.position.y
          live.setControlState('jump', true)
          try {
            const finEnvol = Date.now() + 900
            let dernierDy = -1
            let stable = 0
            let sommet = false
            while (Date.now() < finEnvol) {
              await sleep(50)
              const dy = (host.getBot()?.entity?.position?.y ?? yDepart) - yDepart
              if (dy >= 1) {
                sommet = true
                break
              }
              if (dy <= dernierDy + 0.02) stable += 1
              else stable = 0
              dernierDy = dy
              if (stable >= 2 && dy > 0.3) {
                sommet = true
                break
              }
            }
            const dyFinal = (host.getBot()?.entity?.position?.y ?? yDepart) - yDepart
            if (!sommet && dyFinal < 0.3) {
              throw new Error('saut trop bas : plafond ou bot coince')
            }
            await withTimeout(live.placeBlock(appui, new Vec3(0, 1, 0)), 4000, 'pose trop longue')
          } catch (err) {
            failure = `pose refusee au niveau ${poses + 1} : ${err.message}` +
              (essai < 2 ? ' (nouvel essai)' : '')
            try { live.setControlState('jump', false) } catch (_) {}
            await sleep(300)
            // La case a pu se remplir entre-temps : verifier avant de resauter.
            const recheck = live.blockAt(ancre)
            if (poseConforme(recheck?.name)) {
              poseOk = true
              failure = null
            }
            continue
          }
          try { live.setControlState('jump', false) } catch (_) {}
          poseOk = true
          failure = null
        }
        if (!poseOk) break

        // Atterrissage borne sur le bloc pose : on ne reste pas suspendu.
        const finAtterrissage = Date.now() + 1500
        while (Date.now() < finAtterrissage) {
          const pieds = host.getBot()?.entity
          if (!pieds || pieds.onGround) break
          await sleep(80)
        }

        // Le serveur a le dernier mot : si la case est toujours vide, compter
        // une reussite masquerait le refus (meme regle que `casser`).
        const pose = live.blockAt(ancre)
        if (!poseConforme(pose?.name)) {
          failure = `bloc non pose au niveau ${poses + 1} (case : ${pose?.name ?? 'inconnue'})`
          break
        }
        poses += 1
        if (pourArbre) (mission.echafaudagePose ??= []).push(ancre.clone())
        // Supported at the new height by any solid block under the hitbox: the
        // bot may slide from the placed block onto a neighbour of the same
        // height (trees/bent 9f907a6 : pieds 418.10 201 17.50 sur la buche
        // voisine, bloc pose en 417 200 17), the +1 is real.
        const pieds = live.entity?.position
        const landed = live.entity?.onGround && pieds && Math.abs(pieds.y - (ancre.y + 1)) <= 0.25 &&
          Math.hypot(pieds.x - (ancre.x + 0.5), pieds.z - (ancre.z + 0.5)) <= 1.5 &&
          colonnesSousHitbox(pieds, ancre.y).some(colonne => estSolide(live.blockAt(colonne)))
        if (!landed) {
          // Where the feet are, for the next bench to tell a slide off the
          // block from a hang in the air (trees/pillar 2da82d4, three times).
          const p = live.entity?.position
          failure = 'atterrissage sur le bloc pose non prouve' +
            (p ? ` (pieds ${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)}, ${live.entity.onGround ? 'au sol' : 'en l air'}, bloc ${ancre.x} ${ancre.y} ${ancre.z})` : '')
          break
        }
        await sleep(150)
      }

      try { host.getBot()?.setControlState('jump', false) } catch (_) {}

      const gain = (host.getBot()?.entity?.position?.y ?? y0) - y0
      if (poses > 0 && Math.abs(gain - poses) > 0.25) failure ??= 'gain vertical incoherent avec les poses'
      if (poses > 0 && !host.getBot()?.entity?.onGround) failure ??= 'atterrissage final non prouve'
      if (poses === 0) {
        return { resultat: `pilier impossible : ${failure ?? 'aucun bloc pose'}`, echec: true }
      }
      // Pillar undone then rebuilt: the request is a net gain over the start.
      // Short of it, a failure that names the remedy, not « reobserver »
      // (trees/tall c6dd16e : cinq piler(3) de suite rendus « 2/2 », sans gain).
      if (!failure && !cibleAtteinte && redescendu && poses - redescendu < hauteur) {
        // Same wood pattern as craft.js plank recipes.
        const bois = craft.countOf(host.getBot(), /_log$|_wood$|_stem$|_hyphae$/)
        const net = poses - redescendu
        failure = `aucune terre de plus a portee, gain net ${Math.max(0, net)}/${hauteur} ` +
          `(pilier de ${redescendu} defait puis refait a ${poses}) : ` +
          (bois ? `fabriquer des planches (${bois} buche(s) en inventaire) pour l echafaudage` : 'prendre de la terre plus loin')
      }
      const complet = !failure && (poses === hauteurVisee || cibleAtteinte)
      return {
        resultat: `pilier de ${poses}/${hauteurVisee} bloc(s) (+${gain.toFixed(1)} blocs en hauteur)${recupere}${ajuste}` +
          (failure ? `, arret : ${failure}`
            : cibleAtteinte ? `, arret : ${cibleAtteinte} deja a portee, casser depuis le haut` : ', reobserver depuis le haut'),
        echec: !complet,
        code: complet ? 'pilier_pose' : 'pilier_partiel',
        reobserver: true
      }
    },

    async choisir_terrain () {
      const bot = host.getBot()
      const dims = mission.dimensions

      // Chantier deja commence : en ouvrir un autre recommence la maison
      // ailleurs (vu sur build/dirt-box : 23/24 poses, nouveau terrain, 23
      // blocs de plus). On continue le chantier en cours.
      if (mission.plan) {
        const progres = buildProgress()
        if (progres.done > 0) {
          return {
            // Rien n a rate : le chantier existe (plan anticipe perime).
            resultat: `chantier deja choisi (${progres.done}/${progres.total} poses) : construire la suite`
          }
        }
      }

      // Perche sur son propre pilier : le sol se mesure depuis la ou l on se
      // tient, et aucun terrain ne se trouvait a 3 blocs de haut
      // (composite ba7cc6f : 21 fois « aucun terrain plat »). Pilier defait.
      const dessous = bot.blockAt(bot.entity.position.offset(0, -0.5, 0))
      if (dessous && (PILER_DIRT.test(dessous.name) || /_planks$/.test(dessous.name)) && isPillarBlock(bot, dessous)) {
        await descendScaffold(-Infinity, { pillarOnly: true })
      }

      // Ou poser le chantier : aupres du repere demande, ou sur place.
      let near = host.getBot().entity.position
      if (mission.landmarkResource) {
        const anchor = findTargetBlock(mission.landmarkResource)
        if (!anchor) {
          return {
            resultat: `aucun repere "${mission.landmark}" en vue, impossible de placer le chantier`,
            echec: true
          }
        }
        near = anchor.position
      }

      // Forme : la boite du code, ou un plan libre concu par le modele et
      // verifie par build.compileBlueprint (deux essais, erreurs renvoyees).
      const forme = await designShape()
      const volume = forme.compiled
        ? { width: forme.compiled.width, depth: forme.compiled.depth, height: forme.compiled.height }
        : (forme.box ?? { width: dims.width, depth: dims.depth, height: dims.height })
      const selectionMission = mission
      const site = await build.findSite(bot, { near, ...volume, pied: Math.floor(host.getBot().entity.position.y + 0.01), signal: mission.navigationAbort.signal })
      if (mission !== selectionMission || mission.cancelled) return { resultat: 'choix du terrain interrompu', echec: true, code: 'cancelled' }

      if (!site) {
        return { resultat: 'aucun terrain plat et degage aux alentours', echec: true }
      }

      mission.plan = forme.compiled
        ? build.planFromBlueprint(forme.compiled, site.origin)
        : build.planHouse({ origin: site.origin, ...volume })
      mission.placed = 0

      const { x, y, z } = site.origin
      return {
        resultat: `chantier place en ${x} ${y} ${z} (${volume.width}x${volume.depth}x${volume.height}, ` +
          `${mission.plan.blocks.length} blocs, ${forme.compiled ? 'plan libre verifie' : 'boite'}, ` +
          `a ${site.distance} blocs du repere)${forme.note ? ` ; ${forme.note}` : ''}`
      }
    },

    // Preconditions (chantier place, arbre fini) : CONTRATS.construire.
    async construire (scale, params = {}) {
      await quitterPilier('construire')

      const bot = host.getBot()
      const budget = Number.isFinite(Number(params.quantite))
        ? Math.max(1, Math.min(PLACE_MAX, Math.round(Number(params.quantite))))
        : scaled(scale, PLACE_MIN, PLACE_MAX)
      // Le modele peut nommer la matiere a poser (« une maison en pierre »). On
      // ne la prend que si elle est bien en inventaire ; sinon on retombe sur la
      // matiere de la mission.
      const wanted = typeof params.objet === 'string' && params.objet ? params.objet : null
      const hasWanted = () => Boolean(wanted && bot.inventory?.items().some(i => i.name === wanted))

      // Fix 3 : plus de `setNavigation('climb')` ici. Le ralliement au poste de
      // tir est en gestes unitaires (build.moveTo), sans pathfinder : il n a
      // plus de « regles » a heriter, et toucher au pathfinder depuis une
      // mission contredirait le 100 % gestes.

      // En survie, on ne pose que ce qu on a. Echouer ici en le disant est le
      // ressort de toute la boucle : le modele enchaine alors « casser » puis
      // « fabriquer » de lui-meme, sans qu aucune sequence soit ecrite.
      let material = hasWanted() ? wanted : buildItem()
      if (!material) {
        return {
          resultat: `plus de ${wanted ?? mission.buildBlock} en inventaire, il faut en recolter ou en fabriquer`,
          echec: true
        }
      }


      const started = Date.now()
      let placed = 0
      let skipped = 0
      let failure = null
      // Fix 3 : un poste injoignable ne doit pas figer la rafale sur un seul
      // bloc. On saute le bloc et on tente le suivant, jusqu a 3 echecs de
      // ralliement — un geste rate replanifie (max 3, comme Fix 1 pour les
      // gestes). Au-dela, on rend la main avec un echec explicite.
      let rallyFails = 0
      const RALLY_MAX = 3

      // Bot au fond d un trou (pierre recoltee sous le sol mis a nu) : les
      // postes de tir se rallient a pied et deux blocs plus haut ils sont
      // injoignables (skill/stone-hut-batir ec97eb4, « trajet trop long »
      // jusqu a la fin). Rejoindre d abord le chantier par le recours commun
      // des trajets : sortie par le haut, puis trajet qui creuse.
      const sol = mission.plan?.origin?.y
      const emprise = empriseChantier()
      if (Number.isFinite(sol) && emprise && Math.floor(bot.entity.position.y + 0.01) <= sol - 2 && !mission.cancelled) {
        const profondeur = sol - Math.floor(bot.entity.position.y + 0.01)
        const chantier = new Vec3((emprise.x0 + emprise.x1 + 1) / 2, sol, (emprise.z0 + emprise.z1 + 1) / 2)
        const sortie = await navWithDescent(() => host.navigateToPosition(chantier, {
          signal: mission.navigationAbort.signal, __owner: stepToken, radius: 4, timeoutMs: 15000
        }), { target: chantier, owner: stepToken })
        console.log(`[mission] construire depuis un trou (${profondeur} sous le sol) : ${sortie?.reached ? 'chantier rejoint' : sortie?.code ?? 'echec'}`)
      }

      for (const entry of mission.plan.blocks) {
        if (mission.cancelled) break
        if (placed >= budget || Date.now() - started > PLACE_BURST_MS) break

        const existing = bot.blockAt(entry.position)
        if (existing && mission.buildMatch.test(existing.name)) {
          skipped += 1
          continue
        }

        // Le stock se vide en cours de rafale : on relit le materiau a chaque
        // bloc, ce qui permet aussi d enchainer deux essences de planches.
        material = hasWanted() ? wanted : buildItem()
        if (!material) {
          failure = 'stock epuise en cours de pose'
          break
        }

        try {
          const result = await withTimeout(
            build.placeOne(bot, entry.position, material, {
              accept: mission.buildMatch,
              sol: mission.plan?.origin?.y ?? null,
              signal: mission.navigationAbort.signal,
              move: async stand => (await host.navigateToPosition(stand, {
                signal: mission.navigationAbort.signal, __owner: stepToken, radius: 0.35, timeoutMs: 5000
              }))?.reached === true
            }),
            PLACE_ONE_TIMEOUT_MS,
            'pose trop longue'
          )
          if (result === 'pose') placed += 1
          else skipped += 1
        } catch (err) {
          const message = err?.message ?? String(err)
          // `pose trop longue` compte comme ralliement : apres 18 s sans pose,
          // le poste est injoignable ou la pose pendue — on saute le bloc
          // (borne RALLY_MAX) au lieu d avorter toute la rafale sur le premier
          // bloc lointain (« aucun bloc pose » mesure en jeu avec 101 planches
          // en stock). Meme borne que les ralliements, pas de nouveau regime.
          const isRally = /injoignable|poste de tir|trajet trop long|immobile|bloqu|pose trop longue/i.test(message)
          if (isRally) {
            rallyFails += 1
            failure = `${entry.role} en ${entry.position.x} ${entry.position.y} ${entry.position.z} : ${message} (${rallyFails}/${RALLY_MAX})`
            // Le tour suivant contourne au lieu de re-foncer au meme cap.
            mission.lastBlocked = true
            if (rallyFails >= RALLY_MAX) break
            continue
          }
          failure = `${entry.role} en ${entry.position.x} ${entry.position.y} ${entry.position.z} : ${message}`
          break
        }

        await sleep(60)
      }

      const progress = buildProgress()

      if (placed === 0) {
        return {
          resultat: `aucun bloc pose (${failure ?? 'plan deja complet'})`,
          echec: progress.left > 0
        }
      }

      return {
        resultat: `${placed}/${budget} bloc(s) pose(s), ${progress.done}/${progress.total} au total` +
          (failure ? `, arret : ${failure}` : '')
      }
    },

    // Preconditions (chantier place, arbre fini) : CONTRATS.poser_porte.
    async poser_porte () {
      if (!mission.plan.door) return { resultat: 'ce plan n a pas de porte', echec: true }
      if (doorPlaced()) return { resultat: 'la porte est deja posee' }
      await quitterPilier('poser_porte')

      let progress = buildProgress()
      // Murs pas finis : les poser d abord si le materiau est en poche
      // (composite 8779070 : porte demandee avec 16 blocs restants, refus).
      let prealable = ''
      if (progress.left > 0 && buildItem()) {
        const r = await ACTIONS.construire(null, { quantite: Math.min(40, progress.left) })
        prealable = `${r.resultat} ; `
        progress = buildProgress()
      }
      if (progress.left > 0) {
        return { resultat: `${prealable}il reste ${progress.left} bloc(s) a poser avant la porte`, echec: true }
      }

      // La porte doit avoir ete fabriquee : l essence est celle des planches
      // coupees, pas forcement du chene.
      const item = doorItem()
      if (!item) {
        return { resultat: 'aucune porte en inventaire, il faut en fabriquer une', echec: true }
      }

      try {
        await build.placeDoor(host.getBot(), mission.plan, item, {
          signal: mission.navigationAbort.signal,
          move: async stand => (await host.navigateToPosition(stand, {
            signal: mission.navigationAbort.signal, __owner: stepToken, radius: 0.6, timeoutMs: 15000, distanceBudget: 48
          }))?.reached === true
        })
      } catch (err) {
        return { resultat: `porte impossible : ${err.message}`, echec: true }
      }

      const posee = doorPlaced()
      return { resultat: posee ? 'porte posee' : 'porte refusee par le serveur', echec: !posee }
    },

    async sortir () {
      // `escalate` : sans lui, un bot encastre sur la terre ferme n etait meme
      // pas amene au sauvetage (walkToSafety), donc `sortir` ne faisait rien.
      await host.rescue('action de mission "sortir"', { escalate: true })
      const encore = host.inLiquid()
      // Un `sortir` qui n a pas sorti le bot est un echec : sinon la boucle le
      // compte comme un progres et le modele croit le probleme regle.
      return { resultat: encore ? 'toujours dans un liquide' : 'degage', echec: encore }
    },

    // La porte en bois la plus proche (8 blocs) : la rejoindre a portee de
    // main, l ouvrir, puis passer de l autre cote (face opposee au bot).
    // Le navigateur ouvre aussi les portes sur un trajet ; cette action le
    // fait a la demande, quand le modele voit qu il est enferme.
    async ouvrir_porte () {
      const bot = host.getBot()
      if (!bot?.entity) return { resultat: 'bot absent du monde', echec: true }
      const ids = Object.values(bot.registry.blocksByName).filter(b => isWoodDoor(b.name)).map(b => b.id)
      let door = ids.length ? bot.findBlock({ matching: ids, maxDistance: 8 }) : null
      if (!door) return { resultat: 'aucune porte en bois a moins de 8 blocs', echec: true }
      // Une porte = deux blocs : on agit sur la moitie basse.
      const below = bot.blockAt(door.position.offset(0, -1, 0))
      if (below && isWoodDoor(below.name)) door = below
      const centre = door.position.offset(0.5, 0.5, 0.5)
      // Chaque moitie ouvre la porte, comme en jeu. Depuis l interieur, tout
      // contre elle, le regard vers le centre de la moitie basse traverse la
      // moitie haute (fermee, pleine sur sa tranche) : la basse seule etait
      // « hors de portee » (banc 8090c3b, composite/cabin-from-scratch).
      const haut = bot.blockAt(door.position.offset(0, 1, 0))
      const moities = [door.position, ...(haut && isWoodDoor(haut.name) ? [haut.position] : [])]
      const prise = b => b?.entity && moities.find(p => blockInReach(b, b.entity.position, p.offset(0.5, 0.5, 0.5), REACH))
      let saisie = prise(bot)
      if (!saisie) {
        const r = await host.navigateToPosition(centre, {
          signal: mission.navigationAbort.signal, __owner: stepToken, interaction: true, timeoutMs: 10000, distanceBudget: 16
        })
        saisie = prise(host.getBot())
        if (!saisie) {
          return { resultat: `porte en ${door.position.x} ${door.position.y} ${door.position.z} hors de portee (${r?.code ?? 'trajet impossible'})`, echec: true }
        }
      }
      const live = host.getBot()
      if (doorClosed(live.blockAt(door.position))) {
        try {
          await withTimeout(live.activateBlock(live.blockAt(saisie)), 4000, 'ouverture trop longue')
        } catch (err) {
          return { resultat: `porte refusee : ${err.message}`, echec: true }
        }
        await sleep(200)
        if (doorClosed(live.blockAt(door.position))) return { resultat: 'porte toujours fermee apres l avoir actionnee', echec: true }
      }
      // L autre cote : la case voisine de la porte, sur son axe, la plus
      // eloignee du bot.
      const facing = String(live.blockAt(door.position)?.getProperties?.()?.facing ?? 'north')
      const axe = facing === 'east' || facing === 'west' ? [new Vec3(1, 0, 0), new Vec3(-1, 0, 0)] : [new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
      const here = live.entity.position
      let cote = axe.map(d => door.position.plus(d).offset(0.5, 0, 0.5))
        .sort((a, b) => b.distanceTo(here) - a.distanceTo(here))[0]
      // A la hauteur de la porte, cette case peut etre en l air (piece a
      // plancher : porte une marche au-dessus du sol du dehors). Le
      // navigateur n y arrive jamais (ecart vertical) : on vise la case ou
      // l on tient debout, trois blocs de chute au plus (maxDropDown).
      for (let chute = 0; chute < 3 && !estSolide(live.blockAt(cote.offset(0, -1, 0))); chute++) {
        cote = cote.offset(0, -1, 0)
      }
      const r = await host.navigateToPosition(cote, {
        signal: mission.navigationAbort.signal, __owner: stepToken, radius: 0.6, timeoutMs: 8000, distanceBudget: 12
      })
      const pos = host.getBot()?.entity?.position
      const ou = pos ? `${pos.x.toFixed(1)} ${pos.y.toFixed(1)} ${pos.z.toFixed(1)}` : '?'
      return r?.reached
        ? { resultat: `porte ouverte et franchie, maintenant en ${ou}` }
        : { resultat: `porte ouverte, passage impossible (${r?.code ?? 'trajet'}), en ${ou}`, echec: true }
    },

    // Gestes de bas niveau, attente, fin et memoire : bot/action-gestes.js.
    ...gestes,
    async poser (scale, params = {}) {
      await quitterPilier('poser')
      return poserObjet.poser(params)
    },
    async batir () { return sousButs.batir() },
    async obtenir (scale, params = {}) {
      // Objet nomme par le modele (regle immuable : l objet est un parametre),
      // sinon la cible de la mission. Deja en poche en quantite : rien a faire.
      if (params.objet) {
        const bot = host.getBot()
        const objet = resolveFabricationCible(bot, params.objet)
        if (!objet || (bot?.registry?.itemsByName && !bot.registry.itemsByName[objet] && !craft.TARGETS[objet])) {
          return { resultat: `objet inconnu : « ${params.objet} »`, echec: true, code: 'objet_inconnu' }
        }
        const voulu = Number.isFinite(Number(params.quantite)) ? Math.max(1, Math.min(64, Math.round(Number(params.quantite)))) : 1
        const enPoche = () => (host.getBot()?.inventory?.items() ?? []).filter(i => i.name === objet).reduce((n, i) => n + i.count, 0)
        if (enPoche() >= voulu) return { resultat: `${enPoche()} ${objet} deja en poche` }
        // Le temps du sous-but, l objet demande est LA cible du solveur :
        // recolte, prerequis et etat suivent le meme plan.
        mission.demandeObtenir = { objet, manque: voulu - enPoche() }
        try {
          return await sousButs.obtenir(() => {
            const manque = voulu - enPoche()
            mission.demandeObtenir = manque > 0 ? { objet, manque } : null
            return mission.demandeObtenir
          })
        } finally {
          if (mission) mission.demandeObtenir = null
        }
      }
      return sousButs.obtenir()
    },

    // Chercher la matiere hors de vue sans marcher a l aveugle : le code
    // choisit, parmi huit caps, le point debout le plus lointain et le moins
    // deja visite, y va par le navigateur partage, puis regarde. S arrete des
    // que la matiere visee (ou le repere) est en vue. Remplace les suites
    // pivoter/regarder_autour/avancer sans cible qui tournaient sur place
    // (variantes du banc de la PR #38 : « rien de cible en vue » en boucle).
    async explorer (scale, params = {}) {
      const distance = Number.isFinite(Number(params.distance))
        ? Math.max(8, Math.min(32, Math.round(Number(params.distance))))
        : scaled(scale, 8, 32)
      // Arbre commence, arbre fini : il est la seule cible bois et passe avant
      // tout ; explorer l eloignait sans retour (cabin-from-scratch bff20b0 :
      // explorer depuis le pilier, arbre jamais retrouve, plafond de 45 min).
      const arbre = arbreInacheve()
      if (arbre) {
        return { resultat: `arbre commence : ${arbre.length} buche(s) encore debout, les couper avant d explorer (piler si trop haut, ou changer de poste pres de lui)`, echec: true, code: 'arbre_inacheve' }
      }
      const suite = rienARecolter()
      if (suite) {
        return (await etapeSuivanteAuLieu('rien a chercher : tout est en poche')) ??
          { resultat: `rien a chercher : tout est en poche, etape suivante du plan : ${suite}`, code: 'plan' }
      }
      const assez = materiauSuffisant()
      if (assez) return { resultat: `rien a chercher : ${assez}` }
      const enVue = () => findTargetBlock(undefined, { anyHeight: true }) ??
        (mission.landmarkResource ? findTargetBlock(mission.landmarkResource, { anyHeight: true }) : null)
      const deja = enVue()
      if (deja) {
        const p = host.getBot()?.entity?.position
        return { resultat: `${deja.name} deja en vue a ${p ? p.distanceTo(deja.position).toFixed(1) : '?'} bloc(s) : recolter ou avancer vers lui` }
      }
      if (typeof host.navigateToPosition !== 'function') return { resultat: 'exploration impossible : navigateur absent', echec: true }
      const visites = mission.explorations = mission.explorations ?? []
      const debut = Date.now()
      let trajets = 0
      let parcouru = 0
      while (!mission.cancelled && trajets < EXPLORE_LEGS && Date.now() - debut < EXPLORE_MAX_MS) {
        const bot = host.getBot()
        if (!bot?.entity) break
        const ici = bot.entity.position
        visites.push(ici.clone())
        // Spirale autour du point de depart : parmi les caps dont l arrivee est
        // neuve (a 3/4 de trajet au moins de tout ce qui a ete visite), le plus
        // proche du depart ; la matiere est le plus souvent pres du joueur.
        // Sinon, le cap le plus neuf. On n explore jamais deux fois.
        const origine = visites[0]
        let meilleur = null
        for (let i = 0; i < 8; i += 1) {
          const point = pointDansLeCap(i * Math.PI / 4, distance)
          if (!point) continue
          const nouveaute = Math.min(...visites.map(v => Math.hypot(v.x - point.x, v.z - point.z)))
          const neuf = nouveaute >= distance * 0.75
          const eloignement = Math.hypot(point.x - origine.x, point.z - origine.z)
          const mieux = !meilleur ||
            (neuf && !meilleur.neuf) ||
            (neuf && meilleur.neuf && eloignement < meilleur.eloignement - 0.5) ||
            (!neuf && !meilleur.neuf && nouveaute > meilleur.nouveaute)
          if (mieux) meilleur = { point, nouveaute, neuf, eloignement }
        }
        if (!meilleur || meilleur.nouveaute < 4) break
        const r = await host.navigateToPosition(meilleur.point, {
          signal: mission.navigationAbort.signal, __owner: stepToken,
          radius: 2, timeoutMs: 15000, distanceBudget: Math.min(64, distance * 2)
        })
        const apres = host.getBot()?.entity?.position
        const gagne = apres ? Math.hypot(apres.x - ici.x, apres.z - ici.z) : 0
        parcouru += gagne
        trajets += 1
        console.log(`[mission] explorer : trajet ${trajets} vers ${meilleur.point.x.toFixed(1)} ${meilleur.point.y} ${meilleur.point.z.toFixed(1)} -> ${r.code}, ${gagne.toFixed(1)} bloc(s)`)
        const trouve = enVue()
        if (trouve) {
          const d = apres ? apres.distanceTo(trouve.position).toFixed(1) : '?'
          return { resultat: `${trouve.name} en vue a ${d} bloc(s) apres ${trajets} trajet(s) (${parcouru.toFixed(0)} blocs parcourus) : recolter ou avancer vers lui` }
        }
        if (gagne < 1) visites.push(meilleur.point)
      }
      return {
        resultat: `rien de la matiere visee en vue apres ${trajets} trajet(s) (${parcouru.toFixed(0)} blocs parcourus)` +
          (trajets === 0 ? ' : aucun point debout rejoignable autour' : ' : explorer encore (autres caps) ou changer de plan'),
        echec: true
      }
    },

  }

  // -------------------------------------------------------------------------
  // Contrats des actions : preconditions verifiees avant CHAQUE appel (y
  // compris les appels internes d une action a une autre) et effet mesure
  // apres une etape. Une precondition fausse rend un echec code dont les
  // remedes sont les actions qui la rendent vraie (sous-but). Un effet absent
  // sur une etape « reussie » est un geste sans effet : la garde anti-boucle
  // le compte comme un echec (« aucun bloc cible sain a casser » rejoue).
  // -------------------------------------------------------------------------

  const PRE = {
    chantierPlace: {
      vrai: () => Boolean(mission.plan),
      echec: () => ({ resultat: 'aucun emplacement choisi', echec: true, code: 'chantier_absent' })
    },
    arbreFini: { vrai: () => !arbreAvantChantier(), echec: () => arbreAvantChantier() },
    horsLiquide: {
      vrai: () => !host.inLiquid(),
      echec: () => ({ resultat: 'dans un liquide : sortir d abord, un pilier ne tient pas dans l eau', echec: true, code: 'dans_liquide' })
    }
  }

  // Mesures avant/apres une etape, pour juger son effet.
  function mesuresEffet () {
    const bot = host.getBot()
    const items = bot?.inventory?.items?.() ?? []
    return {
      position: bot?.entity?.position?.clone?.() ?? null,
      inventaire: items.map(i => `${i.name}:${i.count}`).sort().join(','),
      objets: items.reduce((n, i) => n + (i.count ?? 0), 0),
      casses: mission?.broken ?? 0,
      poses: mission?.plan ? buildProgress().done : 0,
      objetsPoses: Object.values(mission?.posesFaites ?? {}).reduce((n, k) => n + k, 0)
    }
  }
  const deplace = (a, b) => Boolean(a.position && b.position && a.position.distanceTo(b.position) >= 0.5)
  const EFFETS = {
    casser: (a, b) => b.casses > a.casses || b.inventaire !== a.inventaire,
    recolter: (a, b) => b.casses > a.casses || b.inventaire !== a.inventaire,
    ramasser: (a, b) => b.objets > a.objets,
    fabriquer: (a, b) => b.inventaire !== a.inventaire,
    cuire: (a, b) => b.inventaire !== a.inventaire,
    piler: (a, b) => Boolean(a.position && b.position && b.position.y - a.position.y >= 0.5),
    construire: (a, b) => b.poses > a.poses || deplace(a, b),
    avancer: deplace,
    explorer: deplace,
    batir: (a, b) => b.poses > a.poses || b.inventaire !== a.inventaire,
    obtenir: (a, b) => b.inventaire !== a.inventaire,
    poser: (a, b) => b.objetsPoses > a.objetsPoses
  }

  const CONTRATS = {
    construire: { pre: [PRE.chantierPlace, PRE.arbreFini], effet: EFFETS.construire },
    poser_porte: { pre: [PRE.chantierPlace, PRE.arbreFini] },
    piler: { pre: [PRE.horsLiquide], effet: EFFETS.piler },
    casser: { effet: EFFETS.casser },
    recolter: { effet: EFFETS.recolter },
    ramasser: { effet: EFFETS.ramasser },
    fabriquer: { effet: EFFETS.fabriquer },
    cuire: { effet: EFFETS.cuire },
    avancer: { effet: EFFETS.avancer },
    explorer: { effet: EFFETS.explorer },
    batir: { effet: EFFETS.batir },
    obtenir: { effet: EFFETS.obtenir },
    poser: { effet: EFFETS.poser }
  }

  for (const [nom, contrat] of Object.entries(CONTRATS)) {
    const corps = ACTIONS[nom]
    if (!contrat.pre?.length || typeof corps !== 'function') continue
    ACTIONS[nom] = async function (scale, params) {
      const manque = contrat.pre.find(pre => !pre.vrai())
      return manque ? manque.echec() : corps(scale, params)
    }
  }

  // -------------------------------------------------------------------------
  // Blocages annonces (2026-09-27, demande du proprietaire) : le bot dit son
  // probleme dans le chat et le journalise ; le banc les analyse
  // -------------------------------------------------------------------------

  // Le blocage se dit au joueur (chat court) et se journalise en une ligne
  // `[blocage] {json}` pour l analyse a posteriori de chaque banc CI.
  function signalBlocage (raison) {
    const derniere = [...mission.history].reverse().find(h => h.echec) ?? mission.history.at(-1) ?? null
    const p = host.getBot()?.entity?.position
    const entree = {
      mission: mission.id,
      objectif: mission.objective,
      type: mission.kind,
      etape: mission.steps,
      secondes: Math.round(activeDurationMs() / 1000),
      raison,
      derniere_action: derniere ? { action: derniere.action, resultat: String(derniere.resultat ?? '').slice(0, 200) } : null,
      historique: mission.history.slice(-4).map(h => `${h.action}${h.echec ? ' (echec)' : ''} : ${String(h.resultat ?? '').slice(0, 90)}`),
      position: p ? { x: Number(p.x.toFixed(1)), y: Number(p.y.toFixed(1)), z: Number(p.z.toFixed(1)) } : null
    }
    mission.blocages = (mission.blocages ?? []).concat(entree).slice(-20)
    traceDe(mission)?.push({ type: 'blocage', raison })
    console.log(`[blocage] ${JSON.stringify(entree)}`)
    // Monde reel autour du bot a cet instant, pour rejouer la perception hors
    // ligne (tmp/replay-snapshot.js). Servi a part (/api/mission/instantanes) :
    // trop gros pour l etat de mission lu a chaque rafraichissement.
    try {
      if (p) {
        mission.instantanes = (mission.instantanes ?? []).concat({ ...entree, monde: perception.instantane(host.getBot(), p) }).slice(-3)
      }
    } catch (_) {}
    const cause = derniere?.echec ? ` (${derniere.action} : ${String(derniere.resultat ?? '').slice(0, 70)})` : ''
    announce(`Bloqué : ${raison}${cause}`)
  }

  // -------------------------------------------------------------------------
  // Boucle
  // -------------------------------------------------------------------------

  function summary () {
    if (mission.fabricationCible) {
      return `${mission.steps} etape(s), ${fabricationProduced()}/${mission.fabricationQuantite ?? 1} ${mission.fabricationCible} fabrique(s), ${mission.broken} bloc(s) casse(s)` +
        ((mission.dirtSecondaire ?? 0) > 0 ? `, dirt secondaire ${mission.dirtSecondaire}` : '')
    }
    if (mission.kind === 'geste') return `${mission.steps} etape(s) de geste`

    if (mission.kind === 'construction') {
      const progress = buildProgress()
      return `${mission.steps} etape(s), ${progress.done}/${progress.total} bloc(s) pose(s)` +
        (mission.wantsDoor ? `, porte ${doorPlaced() ? 'posee' : 'absente'}` : '')
    }

    return `${mission.steps} etape(s), ${mission.broken} bloc(s) casse(s), ${collected()} objet(s) recolte(s)` +
      ((mission.dirtSecondaire ?? 0) > 0 ? `, dirt secondaire ${mission.dirtSecondaire}` : '')
  }

  // Point de fin UNIQUE de toute mission : done, stopped, failed, arret du
  // joueur (stop()) et deconnexion (la boucle finit en 'failed' sur
  // !isReady(), et index.js appelle aussi stop()). C est ici — et seulement
  // ici — que la memoire long terme est commitee : les notes `memoriser`
  // long terme de la mission quittent le tampon `a_retenir` et rejoignent la
  // couche 3 du prompt. Une seule invalidation de cache par mission, quel que
  // soit le nombre d ecritures long terme en cours de mission.
  async function finish (state, reason) {
    retirerObservateurArbre()
    if (!mission || mission.state !== 'running') return
    const completed = mission
    freezeActiveDuration(completed)

    // Un fetch anticipe en vol ne doit pas survivre a la fin : il ecrirait un
    // plan pour une mission close, et retiendrait la boucle en vie. stop()
    // passe par ici (point de fin unique), donc le cas « stop pendant await
    // decide » est couvert : l attente est aborte et la boucle sort.
    abortPrefetch('fin de mission')
    mission.navigationAbort.abort()
    mission.state = state
    mission.endedAt = new Date().toISOString()
    mission.reason = reason
    traceDe(mission)?.push({ type: 'fin', etat: state, raison: reason })
    mission.summaryText = summary()
    let message
    if (state === 'done') {
      message = completed.movementTask?.steps.at(-1)?.type === 'sous_arbre'
        ? 'Sous l arbre.'
        : `Fini : ${reason}.`
    } else if (state === 'failed') message = `Échec : ${reason}.`
    else if (!reason.startsWith('remplacee')) message = `Stop : ${reason}.`
    // Dire le resultat au moment de la transition, avant tout await/commit.
    // Sinon un ancien finish pouvait parler apres le debut du nouvel objectif.
    completed.activity?.finish(state, message)
    // Liberer les controles avant le premier await : une ancienne fin ne doit
    // pas annuler un nouveau suivi pendant le commit de memoire.
    try { host.stopPathfinding() } catch (_) {}
    try { host.getBot()?.clearControlStates() } catch (_) {}
    // Cloture durable correlee : l objectif courant (sauf divergent) est conclu
    // via le controleur. Si complete() reactive un engagement (pile pause ou
    // pending), VRAI redemarrage via resumeSuspended (objet vivant : id,
    // progression, origine, contraintes preserves, etat frais) ; si l objet
    // est perdu (restart), attente EXPLICITE (courant remis en pause, jamais
    // de mission fantome ni de faux actif). L engagement reste dans le
    // controleur dans tous les cas.
    if (state === 'done' || state === 'failed') {
      try {
        const snap = injectedObjectives?.snapshot?.()
        const oid = completed.objectiveId ?? null
        if (injectedObjectives && typeof injectedObjectives.complete === 'function' &&
            (!snap?.current || !oid || snap.current.id === oid)) {
          const out = injectedObjectives.complete({ etat: state, raison: reason, mission: completed.id })
          const after = injectedObjectives.snapshot?.()
          const activated = after?.current
          if (out && out.restaure && activated && activated.id === out.restaure.id && activated.statut === 'active') {
            const r = resumeSuspended(activated.id)
            if (r.ok) {
              completed.activity?.update?.('execution', `« ${activated.texte} » repris.`, true)
            } else {
              try { injectedObjectives.pauseWork('en attente de reprise explicite') } catch (_) {}
              completed.activity?.update?.('execution', `Fini. « ${activated.texte} » attend (« reprends » ; ${r.error}).`, true)
            }
          } else if (activated && out && (!oid || activated.id !== oid) && activated.statut === 'active') {
            // Pending auto-active sans objet suspendu : meme regle, pas de fantome.
            const r2 = resumeSuspended(activated.id)
            if (!r2.ok) {
              try { injectedObjectives.pauseWork('en attente de reprise explicite') } catch (_) {}
              completed.activity?.update?.('execution', `Fini. « ${activated.texte} » attend (« reprends »).`, true)
            }
          } else if (after && after.current && after.current.statut === 'maintaining') {
            // Permanent : but durable garde, moteur de maintenance non livrable
            // => attente explicite, jamais de boucle de recolte aveugle.
            completed.maintenance = 'waiting-maintenance'
            completed.activity?.update?.('execution', 'Fini, en entretien.', true)
          }
        }
      } catch (_) { /* fin d abord */ }
    }

    // Le commit est attendu (il ecrit le fichier) et attrape : une erreur de
    // disque ne doit pas masquer la fin de mission. Sans note en attente, le
    // commit ne change rien : pas de journal, pas d invalidation de cache.
    try {
      const enAttente = memory.snapshot().a_retenir
      const committed = await memory.commitLongTerm()
      if (enAttente) {
        console.log(`[mission] memoire long terme commitee (${committed.jetons} jeton(s), generation ${memory.generation})`)
      }
    } catch (err) {
      console.error(`[mission] commit de la memoire long terme impossible : ${err.message}`)
    }

    const verb = state === 'done' ? 'Objectif atteint' : 'Mission arretee'
    console.log(`[mission] ${verb} (${reason}) : ${completed.summaryText}`)
  }

  // -------------------------------------------------------------------------
  // Decision d un tour
  //
  // Les deux planificateurs rendent la meme chose, pour que la boucle n ait pas
  // a savoir lequel repond :
  //   { finished, done, step, scale, scaleLevel, choices, confidence, queued }
  // -------------------------------------------------------------------------

  // Ce que le modele doit savoir en plus de l etat de jeu pour parametrer une
  // action : les fabrications reellement possibles avec l inventaire du moment.
  // Calcule ici, jamais devine par le modele.
  function extraState () {
    if (mission.supply !== 'harvest') return {}
    const options = Object.keys(craft.targetCriteria(host.getBot()))
    return options.length > 0 ? { fabrications_possibles: options } : {}
  }

  // Mini-carte PNG pour le tour de planification, ou null. Trois conditions,
  // dans cet ordre : le drapeau est actif ; l etape courante tombe sur le pas de
  // capture (cooldown en etapes) ; on n a pas deja capture cette etape. Un
  // `miniCartePng` qui rend null (chunks non charges, entree invalide) donne un
  // repli texte silencieux. **Ne leve jamais** : une capture impossible ne doit
  // pas couter la mission.
  function capturePourPlan () {
    if (!SCREENSHOT_ON) return null
    if (mission.steps % SCREENSHOT_EVERY !== 0) return null
    if (mission.lastCaptureStep === mission.steps) return null

    let carte = null
    try {
      carte = screenshot.miniCartePng(host.getBot(), { rayon: SCREENSHOT_RAYON })
    } catch (_) {
      carte = null
    }
    // Une seule tentative par etape, meme si elle rend null : le pas de capture
    // reste un pas, on ne reessaie pas en boucle sur un chunk non charge.
    mission.lastCaptureStep = mission.steps
    return carte || null
  }

  // -------------------------------------------------------------------------
  // Appel anticipe : recouvrir la latence du planificateur par l execution.
  //
  // Avant, la boucle etait strictement sequentielle : planifier (0,6 a 1,4 s)
  // PUIS executer (1 a 2 s), donc un bot immobile un tiers du temps. Des que
  // la file descend a 1 etape, on lance l appel suivant SANS l attendre : il
  // tourne pendant que la derniere etape s execute, et on ne l attend que si
  // la file se vide vraiment (consomme dans decideFromPlan).
  //
  // Regles, toutes garde-fous :
  //   - un seul appel en vol (`mission.prefetch`) : startPrefetch ne fait rien
  //     s il y en a deja un ;
  //   - l etat envoye est perime d une a deux actions (la file tourne pendant
  //     l appel) : accepte, le premier echec vide la file ET annule le plan
  //     speculatif, comme aujourd hui ;
  //   - stop / echec / fin annule le fetch en vol (signal mission -> planner
  //     -> llm), jamais un second appel par-dessus.
  // -------------------------------------------------------------------------

  // Jette le plan speculatif en vol, s il y en a un. A brancher partout ou la
  // file est videe : la realite ne suit plus le plan, donc un plan calcule sur
  // l etat d avant ne vaut plus rien.
  function abortPrefetch (why) {
    if (!mission || !mission.prefetch) return
    try { mission.prefetchAbort?.abort() } catch (_) {}
    // Le rejet qui suit est attendu : sans ce catch, un abort entre le
    // lancement et la consommation donnerait un rejet non observe.
    mission.prefetch.promise.catch(() => {})
    mission.prefetch = null
    mission.prefetchAbort = null
    mission.prefetchAnnules += 1
    console.log(`[mission] plan anticipe annule (${why})`)
  }

  // Etat pour l appel anticipe, SANS les effets de bord de buildState : notes
  // a usage unique (avancer_bloque, arret_refuse, plan_ajuste), piste,
  // boussole et suivi d approche sont restaures apres le snapshot, pour que le
  // buildState du tour suivant les serve encore. Le plan speculatif les voit
  // quand meme (ils sont dans le snapshot) : servi deux fois plutot que perdu,
  // c est le prix de la speculation, pas une perte de signal.
  function snapshotForPrefetch () {
    const saved = {
      lastBlocked: mission.lastBlocked,
      refusalNote: mission.refusalNote,
      planAdjustNote: mission.planAdjustNote,
      approachKey: mission.approachKey,
      approachDist: mission.approachDist,
      approachStagnant: mission.approachStagnant,
      piste: Array.isArray(mission.piste) ? mission.piste.slice() : mission.piste,
      boussoleIdx: mission.boussoleIdx
    }
    try {
      const snap = buildState()
      if (mission.enCours?.length) snap.etapes_en_cours = mission.enCours
      return snap
    } finally {
      mission.lastBlocked = saved.lastBlocked
      mission.refusalNote = saved.refusalNote
      mission.planAdjustNote = saved.planAdjustNote
      mission.approachKey = saved.approachKey
      mission.approachDist = saved.approachDist
      mission.approachStagnant = saved.approachStagnant
      mission.piste = saved.piste
      mission.boussoleIdx = saved.boussoleIdx
    }
  }

  // Applique un resultat de planner.plan a la file. Commun au chemin bloquant
  // et au plan anticipe consomme : un seul endroit compte les plans et pose la
  // file, pour que les deux chemins restent interchangeables.
  function applyPlanResult (result, capture) {
    mission.plans += 1
    mission.planMs = result.ms
    traceDe(mission)?.push({ type: 'plan', ms: result.ms, etapes: result.steps?.length ?? 0,
      rejetees: result.rejected?.length ?? 0, fini: Boolean(result.finished) })
    mission.lastWhy = result.why || null

    if (result.rejected.length > 0) {
      console.log(`[mission] etapes rejetees du plan : ${result.rejected.join(', ')}`)
      // Reinjecte au tour suivant : le modele corrige au lieu de reproposer.
      mission.planAdjustNote = result.rejected.join(' ; ')
    }

    if (result.finished) return { finished: true, done: result.done, why: result.why }
    if (result.steps.length === 0) throw new Error('plan vide')

    mission.queue = result.steps
    mission.queueDone = result.done
    console.log(
      `[mission] plan en ${result.ms} ms (~${result.seconds} s de jeu) : ` +
      result.steps.map(s => s.action + (s.scaleLevel === null ? '' : `(${s.scaleLevel})`)).join(' -> ') +
      (result.why ? ` — ${result.why}` : '')
    )
    // Trace explicite de l image : c est la preuve lisible (avec le compteur
    // planner.stats.captures de /api/status) que l appel a bien porte la carte.
    if (capture) {
      console.log(
        `[mission] image jointe au plan (${capture.largeur}x${capture.hauteur}, ` +
        `${capture.coutMs} ms de generation, ~${Math.round(capture.dataUrl.length / 1024)} Ko)`
      )
    }
    return null
  }

  // Lance l appel anticipe, sans l attendre. Ne fait rien s il y a deja un
  // appel en vol, si la file n est pas a 1, ou si la mission ne tourne plus.
  // Pas de prefetch en `geste` : la mission s arrete des que la file est vide,
  // un appel anticipe serait un appel jete a chaque fois.
  function startPrefetch () {
    if (!isRunning() || mission.cancelled) return
    if (!brain(mission).isEnabled()) return
    if (mission.prefetch) return
    if (mission.queue.length !== 1) return
    if (mission.kind === 'geste') return

    let snap
    try {
      snap = snapshotForPrefetch()
    } catch (err) {
      console.error(`[mission] appel anticipe impossible (etat) : ${err.message}`)
      return
    }
    const capture = capturePourPlan()
    if (SCREENSHOT_ON && snap.environnement) {
      snap.environnement.capture_presente = Boolean(capture)
    }

    const controller = new AbortController()
    const promise = brain(mission).plan(
      snap, mission.kind, mission.supply, extraState(), capture ? capture.dataUrl : null,
      { signal: controller.signal, profil: profilPrompt(), relance: featureOn('relance_plan'), sansRaisonnement: featureOn('plan_sans_raisonnement', false) }
    )
    // Rejet attendu si abort avant consommation (voir abortPrefetch).
    promise.catch(() => {})
    const startedAt = Date.now()
    mission.prefetchAbort = controller
    mission.prefetch = { promise, startedAt }
    mission.prefetchLances += 1
    console.log('[mission] appel anticipe lance (planEnCours=1, file a 1, pendant l execution)')
    promise.then(
      result => console.log(
        `[mission] plan anticipe pret en ${result.ms} ms (overlap ${Date.now() - startedAt} ms)`
      ),
      () => {}
    )
  }

  // Un appel, plusieurs etapes. La file n est PAS un sequencage a l aveugle :
  // le premier echec la vide (voir la boucle), donc une etape n est executee
  // que tant que la realite suit le plan. C est le meme principe que la boucle
  // fermee d origine, a ceci pres qu on ne repaie l appel que quand ca derape.
  async function decideFromPlan (state) {
    if (mission.queue.length === 0) {
      // La file est vraiment vide : on consomme le plan anticipe s il y en a
      // un (c est la SEULE attente du chemin nominal), sinon appel bloquant
      // comme avant. Jamais deux appels en vol : consommer ne lance rien.
      if (mission.prefetch) {
        const enVol = mission.prefetch
        let result
        const attente = Date.now()
        try {
          result = await enVol.promise
        } catch (err) {
          mission.attenteModeleMs += Date.now() - attente
          mission.prefetch = null
          mission.prefetchAbort = null
          throw err
        }
        mission.attenteModeleMs += Date.now() - attente
        mission.prefetch = null
        mission.prefetchAbort = null
        mission.prefetchConsommes += 1
        console.log(
          `[mission] plan anticipe consomme (overlap ${Date.now() - enVol.startedAt} ms, planEnCours=0)`
        )
        const fin = applyPlanResult(result, null)
        if (fin) return fin
      } else {
        // L image voyage par un canal SEPARE de l etat (la mettre dans l etat
        // gonflerait le message utilisateur en base64) : l etat ne porte que le
        // booleen `capture_presente`, le planificateur recoit la data URL en 5e
        // argument. Desactive, `capture` est null et rien ne change.
        const capture = capturePourPlan()
        mission.activity?.update('planning', 'Je réfléchis…')
        if (SCREENSHOT_ON && state.environnement) {
          state.environnement.capture_presente = Boolean(capture)
        }
        const revision = mission.planRevision
        const attente = Date.now()
        let result
        try {
          result = await brain(mission).plan(
            state, mission.kind, mission.supply, extraState(), capture ? capture.dataUrl : null,
            { signal: mission.navigationAbort.signal, profil: profilPrompt(), relance: featureOn('relance_plan'), sansRaisonnement: featureOn('plan_sans_raisonnement', false) }
          )
        } finally {
          mission.attenteModeleMs += Date.now() - attente
        }

        if (mission.planRevision !== revision) throw new Error('plan annule apres precision')
        const fin = applyPlanResult(result, capture)
        if (fin) return fin
      }
    }

    const step = mission.queue.shift()

    // La file descend a 1 : on lance l appel suivant pendant que cette etape
    // tourne, sans l attendre. Le run() de la boucle recouvre la latence.
    // L appel anticipe voit les etapes pas encore faites (en cours + file) :
    // sans elles, le modele les replanifiait (choisir_terrain deux fois, 55
    // refus « chantier deja commence » sur 5 bancs ; avancer/casser en double).
    if (mission.queue.length === 1) {
      mission.enCours = [step, ...mission.queue].map(e => ({ action: e.action, ...(e.choices ?? {}) }))
      startPrefetch()
    }

    return {
      finished: false,
      done: mission.queueDone,
      step: step.action,
      scale: step.scale,
      scaleLevel: step.scaleLevel,
      choices: step.choices ?? {},
      confidence: null,
      queued: mission.queue.length,
      why: mission.lastWhy
    }
  }

  async function decide (state) {
    return brain(mission).isEnabled() ? decideFromPlan(state) : null
  }

  // Le garde-fou du « le modele classe, il ne compte pas », applique a la seule
  // decision ou une erreur coute la mission entiere : l arret.
  //
  // Un petit modele local declare volontiers l objectif atteint des qu il a vu
  // du progres — mesure ici : mission close a 6 blocs casses sur 16 demandes.
  // Le compte, lui, est sans ambiguite, et il est deja fait. On refuse donc
  // l arret tant qu il contredit les chiffres, et on renvoie le refus dans
  // l etat du tour suivant pour que le modele corrige au lieu d insister.
  //
  // Pour les quotas ordinaires, on cede apres REFUSALS_BEFORE_YIELD.
  // Un arbre commence reste ouvert : seuls stop et les plafonds globaux interrompent sa coupe. Un bot
  // qui ne peut plus rien faire d utile (plus un seul bloc a portee, matiere
  // introuvable) doit pouvoir rendre la main plutot que de tourner jusqu a la
  // limite de duree.
  const REFUSALS_BEFORE_YIELD = 3

  function finishAllowed (state) {
    if (mission.pendingJoin) return { ok: false, why: 'le demandeur n a pas ete rejoint : retente rejoindre_demandeur ou signale l echec' }
    const arbre = arbreInacheve()
    if (arbre) return { ok: false, why: `arbre commence : il reste ${arbre.length} buche(s) debout, les couper toutes avant de finir (piler si trop haut)` }
    // Les obligations du but se cumulent : un don prouve ne termine ni
    // l arbre demande, ni la fabrication, ni le chantier encore incomplet.
    if (mission.wholeTree) {
      const tree = treeStatus()
      if (!tree) return { ok: false, why: 'aucune buche de l arbre n a encore ete coupee' }
      if (tree.buches_restantes > 0) return { ok: false, why: `il reste ${tree.buches_restantes} buche(s) sur l arbre` }
      if (tree.buches_au_sol > 0) return { ok: false, why: `${tree.buches_au_sol} buche(s) au sol a ramasser` }
    }
    // Livraison (S6) : jugee sur le prouve et les obligations, jamais sur les
    // compteurs broken/collected ni le quota ressource. L incertain, l absence
    // de plafond et le manque de prouve refusent terminer/fini ; satisfaits,
    // l arret est autorise sans passer par le quota. Aucun retoss auto.
    const dons = deliveryLedgersFor(mission).filter(l => !l.cancelled)
    if (dons.length > 0) {
      for (const l of dons) {
        if (l.uncertain > 0) {
          return { ok: false, why: `don ${l.item} vers ${l.recipient} incertain : ${l.uncertain} sorti(s) sans preuve — aucun nouvel essai automatique (pause ou aide), contexte conserve` }
        }
        if (l.ceiling === null) {
          return { ok: false, why: `don ${l.item} vers ${l.recipient} sans plafond chiffre : precise la quantite, pas d invention de quota` }
        }
        if (l.proven < l.ceiling) {
          return { ok: false, why: `don ${l.item} vers ${l.recipient} : ${l.proven}/${l.ceiling} prouve(s)` }
        }
      }
    }
    // Fabrication generique : la preuve est l objet cible mesure
    // (produits vs visee), jamais le quota recolte ni un plan execute. Un
    // `terminer`/`fini` sans les objets est refuse ; un manque de ressource
    // renvoie le pilote a la recolte via le message (recettes du jeu font
    // foi, aucune recette hardcodee par phrase ici).
    if (mission.fabricationCible) {
      const visee = mission.fabricationQuantite ?? 1
      const produits = state.progression?.fabrication_produits ?? fabricationProduced()
      if (produits < visee) {
        const manque = mission.fabricationLastError
          ? ` (${mission.fabricationLastError})`
          : ''
        return {
          ok: false,
          why: `${produits} ${mission.fabricationCible} fabrique(s) sur ${visee} demande(s) : fabriquer la cible ou recolter ce qui manque (recettes du jeu font foi)${manque}`
        }
      }
      if (mission.fabricationSuite?.length) {
        return { ok: false, why: `encore a fabriquer : ${mission.fabricationSuite.map(f => f.objet).join(', ')}` }
      }
    }
    // Objets a poser (A/B `poser`) : chaque objet demande, pose et verifie
    // dans le monde, autant de fois que dit (au moins une).
    const aPoser = posesManquantes()[0]
    if (aPoser) {
      return { ok: false, why: `${aPoser.posees} ${aPoser.objet} pose(s) sur ${aPoser.voulues} : ${aPoser.enPoche > 0 ? 'poser' : 'obtenir puis poser'} le reste` }
    }
    // Un geste n a ni quota ni chantier a verifier : le planificateur decide seul
    // quand la demande est satisfaite — mais pas avant d avoir agi. Un petit
    // modele declare volontiers « fini » a 0 etape pour ne rien faire.
    if (mission.kind === 'geste') {
      if (mission.steps === 0) {
        return { ok: false, why: 'tu n as encore rien fait : execute d abord la demande' }
      }
      return { ok: true }
    }

    if (mission.kind === 'construction') {
      const progress = buildProgress()
      if (!mission.plan) return { ok: false, why: 'aucun emplacement de chantier choisi' }
      if (progress.left > 0) return { ok: false, why: `il reste ${progress.left} bloc(s) a poser` }
      if (mission.wantsDoor && !doorPlaced()) return { ok: false, why: 'la porte demandee n est pas posee' }
      return { ok: true }
    }

    if (mission.kind === 'deplacement') {
      return state.environnement?.bloc_cible_a_portee
        ? { ok: true }
        : { ok: false, why: 'le bot n est pas encore arrive aupres de sa cible' }
    }

    if (mission.wholeTree || mission.fabricationCible || dons.length > 0 || mission.poses?.length > 0) return { ok: true }

    // Quantite dite par le joueur : jugee sur l inventaire, pas sur les blocs
    // casses (des fleurs cassees mais laissees au sol ne sont pas cueillies).
    // L herbe garde ses unites (une graine pour huit touffes, piege 9).
    if (mission.quotaExplicite && !['herbe', 'graines'].includes(mission.resource)) {
      const tenus = collected()
      return tenus >= mission.quota
        ? { ok: true }
        : { ok: false, why: `${tenus} en inventaire sur ${mission.quota} demande(s) : ramasser ce qui est tombe ou recolter encore` }
    }
    const got = state.progression?.unites_recoltees ?? 0
    const quota = mission.quota ?? DEFAULT_QUOTA
    return got >= quota
      ? { ok: true }
      : { ok: false, why: `${got} unite(s) recoltee(s) sur ${quota} demandee(s)` }
  }

  async function loop () {
    // Identite de boucle : si la variable `mission` a ete remplacee entre deux
    // awaits (suspend + demarrage d un nouvel objectif), cette boucle obsolete
    // s efface sans ecrire dans le nouvel objet (ni etapes, ni historique).
    const myMission = mission
    const controller = myMission.navigationAbort
    while (isRunning() && mission === myMission && myMission.navigationAbort === controller) {
      if (mission.cancelled) {
        finish('stopped', 'interrompue')
        return
      }

      if (!host.isReady()) {
        finish('failed', 'bot deconnecte')
        return
      }

      if (mission.steps >= MAX_STEPS) {
        finish('stopped', `limite de ${MAX_STEPS} etapes atteinte`)
        return
      }

      // Un geste n a pas de quota : au-dela de quelques gestes, il tourne en
      // rond. On conclut plutot que d attendre la limite generale.
      if (mission.kind === 'geste' && mission.steps >= GESTE_MAX_STEPS) {
        finish('failed', `limite de ${GESTE_MAX_STEPS} etapes du geste atteinte`)
        return
      }

      if (activeDurationMs() >= MAX_DURATION_MS) {
        finish('stopped', `limite de ${Math.round(MAX_DURATION_MS / 60000)} min atteinte`)
        return
      }

      let decision
      const state = buildState()

      // Impasse : on la signale une fois, au moment ou elle apparait. Le drapeau
      // se rearme des que le bot re-progresse, pour pouvoir le redire plus tard.
      if (state.blocage?.detecte && !mission.stuckAnnounced) {
        mission.stuckAnnounced = true
        signalBlocage(state.blocage.raison)
      } else if (!state.blocage?.detecte) {
        mission.stuckAnnounced = false
      }

      try {
        decision = await decide(state)
        if (mission !== myMission || myMission.navigationAbort !== controller) return
        mission.plannerErrors = 0
      } catch (err) {
        // Un stop (ou une fin) pendant l attente annule le fetch en vol : le
        // rejet « appel annule » n est pas une panne, et surtout il ne doit
        // pas faire dormir la boucle — la mission est deja close.
        if (!isRunning() || mission.cancelled || mission !== myMission || myMission.navigationAbort !== controller) return
        // Un plan speculatif jete en vol alors que la mission continue (echec
        // qui a vide la file pendant que le plan anticipe arrivait) : on
        // replanifie frais au tour suivant, sans penalite d erreur.
        if (/annule/.test(err.message)) {
          await sleep(TICK_MS)
          continue
        }
        // Cerveau scripte au bout de son script (ou etape invalide) : fin dite,
        // pas une panne a rejouer.
        if (err.fin) {
          finish('failed', err.message)
          return
        }
        mission.plannerErrors += 1
        if (mission.plannerErrors === 1) mission.plannerSilenceSince = Date.now()
        const passager = err.passager === true
        const silenceMs = Date.now() - mission.plannerSilenceSince
        console.error(`[mission] planificateur indisponible (${mission.plannerErrors}/${MAX_PLANNER_ERRORS}${passager ? `, panne passagere depuis ${Math.round(silenceMs / 1000)} s sur ${Math.round(PLANNER_OUTAGE_MS / 1000)}` : ''}) : ${err.message}`)

        // Une file heritee d un plan devenu douteux ne doit pas survivre a la
        // panne qui l a interrompue.
        mission.queue = []
        abortPrefetch('panne planificateur')

        if (mission.plannerErrors >= MAX_PLANNER_ERRORS && (!passager || silenceMs >= PLANNER_OUTAGE_MS)) {
          finish('failed', 'planificateur indisponible')
          return
        }

        // Un reseau coupe echoue en un instant : une pause plus longue evite
        // de marteler le gateway pendant la panne.
        await sleep(passager && !/pas de reponse/.test(err.message) ? TICK_MS * 4 : TICK_MS * 2)
        continue
      }

      if (!decision) {
        finish('failed', 'aucun planificateur actif')
        return
      }

      // Boucle obsolete (mission remplacee pendant l attente reseau) : ne
      // jamais appliquer une decision perimee a un nouvel objet.
      if (mission !== myMission || myMission.navigationAbort !== controller) return
      if (activeDurationMs() >= MAX_DURATION_MS) {
        finish('stopped', `limite de ${Math.round(MAX_DURATION_MS / 60000)} min atteinte`)
        return
      }

      if (decision.finished) {
        // L arret se juge sur un etat FRAIS, jamais sur celui qui a servi a
        // planifier : avec l appel anticipe, ce dernier est perime d une a
        // deux actions (plan speculatif). Un « fini » speculatif ne doit ni
        // clore a tort ni etre refuse a tort.
        const frais = buildState()
        const allowed = finishAllowed(frais)

        if (!allowed.ok && !arbreInacheve() && mission.finishRefused >= REFUSALS_BEFORE_YIELD) {
          finish('failed', allowed.why)
          return
        }

        if (!allowed.ok && (arbreInacheve() || mission.finishRefused < REFUSALS_BEFORE_YIELD)) {
          mission.finishRefused += 1
          // Reinjecte au tour suivant : le modele voit pourquoi son arret a ete
          // refuse, au lieu de reproposer le meme.
          mission.refusalNote = allowed.why
          mission.queue = []
          abortPrefetch('arret refuse')
          console.log(
            `[mission] arret refuse (${mission.finishRefused}/${REFUSALS_BEFORE_YIELD}) : ${allowed.why}`
          )
          await sleep(TICK_MS)
          continue
        }

        mission.lastPlan = {
          at: new Date().toISOString(),
          done: Number(decision.done.toFixed(3)),
          step: null,
          confidence: null,
          ampleur: null,
          parametres: null,
          pourquoi: decision.why || null
        }
        finish('done', `objectif estime accompli (${(decision.done * 100).toFixed(0)}%)` +
          (decision.why ? ` : ${decision.why}` : ''))
        return
      }

      mission.lastPlan = {
        at: new Date().toISOString(),
        done: Number(decision.done.toFixed(3)),
        step: decision.step,
        confidence: decision.confidence === null ? null : Number(decision.confidence.toFixed(3)),
        ampleur: decision.scaleLevel === null ? null : Number(decision.scaleLevel.toFixed(2)),
        parametres: Object.keys(decision.choices).length > 0 ? decision.choices : null,
        en_file: decision.queued ?? 0,
        pourquoi: decision.why || null
      }

      let outcome

      const run = ACTIONS[decision.step]
      if (!run) {
        // Ne peut arriver que si skills.ACTIONS et ACTIONS divergent, ce que
        // l audit au demarrage signale deja.
        finish('failed', `action inconnue : ${decision.step}`)
        return
      }

      // Anti-boucle : la meme etape, depuis la meme case et avec le meme
      // inventaire, qui a deja rendu deux fois le meme echec n est pas rejouee.
      const garde = gardeBoucle(mission)
      const signatureEtape = outcomes.signature(decision.step, decision.choices,
        host.getBot()?.entity?.position?.floored?.(), inventaireTotal())
      const dejaVu = featureOn('anti_boucle') ? garde.refuse(signatureEtape) : null
      if (dejaVu) outcome = outcomes.refusRepetition(decision.step, dejaVu, ACTIONS)
      const effetAttendu = CONTRATS[decision.step]?.effet ?? null
      const avantEffet = effetAttendu && !outcome ? mesuresEffet() : null
      const debutEtape = Date.now()
      const departEtape = host.getBot()?.entity?.position?.clone?.() ?? null

      if (!outcome) try {
        const message = activity.ACTIONS[decision.step] ?? activity.SUBGOALS[decision.step === 'rejoindre_demandeur' ? 'rejoindre' : '']
        mission.activity?.update('execution', message || 'Je continue…', Boolean(message))
        const exec = physicalExecutor()
        if (exec) {
          // Entree physique via l executeur (kind 'work', un seul writer).
          // Refus fail-closed (paused/stopped/busy/invalid) : echec explicite,
          // jamais de succes fictif. Annulation -> echec interrompu.
          // Reentrance : l etape tient le slot ; ses sous-appels nav passent
          // leur token proprietaire (__owner) et s executent DANS le slot.
          const stepId = `mission-${mission.id}-step-${mission.steps + 1}-${decision.step}`
          const token = {}
          stepOwner = stepId
          stepToken = token
          try {
            // R03 : enveloppe deballee par l adaptateur commun. Echec ->
            // code/message d origine (jamais de no_result generique) ;
            // annulation -> echec interrompu ; seule une valeur absente sur
            // completed donne no_result (action sans resultat mesurable).
            let completedEmpty = false
            try {
              const envelope = await exec.run(
                { id: stepId, kind: 'work' },
                async () => {
                  const value = await run(decision.scale, decision.choices)
                  await reflexPass(token, decision.step)
                  await demonterEchafaudage(token)
                  return value
                })
              const value = unwrapExecutionEnvelope(envelope)
              if (value === undefined || value === null) {
                completedEmpty = true
              } else {
                outcome = value
              }
            } catch (err) {
              if (err && err.code === 'cancelled') {
                outcome = { resultat: 'action interrompue (stop/pause)', echec: true, code: 'cancelled' }
              } else if (err && ['paused', 'stopped', 'busy', 'invalid', 'unavailable', 'aborted'].includes(err.code)) {
                outcome = { resultat: `action refusee (${err.code}) : ${err.message}`, echec: true, code: err.code }
              } else if (err && err.code) {
                outcome = { resultat: `erreur : ${err.message}`, echec: true, code: err.code }
              } else {
                outcome = { resultat: `erreur : ${err.message}`, echec: true }
              }
            }
            if (!outcome && completedEmpty) {
              outcome = { resultat: 'action sans resultat mesurable (completed sans valeur)', echec: true, code: 'no_result' }
            }
          } finally {
            if (stepOwner === stepId) {
              stepOwner = null
              stepToken = null
            }
          }
        } else {
          // Repli heritage/tests sans executeur : execution directe. En prod
          // l executeur est exige (index.runPhysical fail-closed).
          outcome = await run(decision.scale, decision.choices)
          await reflexPass(null, decision.step)
          await demonterEchafaudage(null)
        }
      } catch (err) {
        outcome = { resultat: `erreur : ${err.message}`, echec: true }
      }

      // L action a pu durer plusieurs secondes : un !stop arrive entre-temps a
      // deja clos la mission, et comptabiliser l etape la ferait repartir.
      // Idem si la mission a ete remplacee (suspend + nouvel objectif).
      if (!isRunning() || mission.cancelled || mission !== myMission || myMission.navigationAbort !== controller) return

      outcome = outcomes.normaliser(decision.step, outcome, ACTIONS)
      // Etape « reussie » sans son effet mesure (rien casse, rien en poche,
      // pas bouge) : dite au modele, et comptee comme un echec par la garde.
      if (avantEffet && !outcome.echec && !effetAttendu(avantEffet, mesuresEffet())) outcome = { ...outcome, sansEffet: true }
      if (outcome?.code !== 'repetition') {
        garde.note(signatureEtape, outcome.sansEffet ? outcomes.normaliser(decision.step, { ...outcome, echec: true }, ACTIONS) : outcome)
      }

      mission.steps += 1
      if (outcome.echec) {
        mission.echecs = (mission.echecs ?? 0) + 1
        mission.echecsParAction = mission.echecsParAction ?? {}
        mission.echecsParAction[decision.step] = (mission.echecsParAction[decision.step] ?? 0) + 1
        // Detail des echecs pour le banc (objectif : 0 % d actions en echec).
        mission.echecsDetail = mission.echecsDetail ?? []
        if (mission.echecsDetail.length < 20) {
          mission.echecsDetail.push({ t: Math.round((Date.now() - mission.startedAt) / 1000), action: decision.step, resultat: String(outcome.resultat ?? '').slice(0, 160) })
        }
      }
      mission.history.push({ action: decision.step, resultat: outcome.resultat, code: outcome.code ?? null, echec: Boolean(outcome.echec),
        ...(outcome.echec && outcome.remedes?.length ? { remedes: outcome.remedes } : {}),
        ...(outcome.sansEffet ? { sans_effet: true } : {}) })
      traceDe(mission)?.push({ type: 'etape', action: decision.step, params: decision.choices, ms: Date.now() - debutEtape,
        echec: Boolean(outcome.echec), code: outcome.code ?? null, sans_effet: Boolean(outcome.sansEffet),
        remedes: outcome.remedes ?? [], de: missionTrace.arrondi(departEtape),
        a: missionTrace.arrondi(host.getBot()?.entity?.position) })
      if (mission.history.length > 8) mission.history.shift()
      reportProgressSafe()

      if (outcome.reobserver) {
        // Les etapes d une reparation sont mesurees depuis le sommet : gardees.
        mission.queue = mission.queue.filter(e => e.reparation)
        abortPrefetch('position modifiee par le pilier, reobservation requise')
      }

      // On journalise les valeurs que le modele a demandees (duree, distance,
      // quantite), pas une ampleur abstraite.
      const numeric = Object.entries(decision.choices)
        .filter(([key]) => key !== 'objet')
        .map(([key, value]) => `${key}=${value}`)
        .join(' ')
      const choice = decision.choices.objet ? ` ${decision.choices.objet}` : ''
      const queued = decision.queued > 0 ? `, ${decision.queued} en file` : ''
      console.log(
        `[mission] ${mission.steps}. ${decision.step}${choice}` +
        `${numeric ? ` (${numeric})` : ''} (fini ${(decision.done * 100).toFixed(0)}%${queued}) -> ${outcome.resultat}`
      )

      // Arbre entier demande : sa fin se mesure (0 buche debout, 0 au sol), elle
      // ne depend pas d un « fini » du modele, qui voulait parfois chercher un
      // demandeur absent ou le quota par defaut apres le dernier ramassage.
      // Quantite explicite atteinte en inventaire (recolte simple) : clore.
      // Vu sur gather/flowers : 3 fleurs en inventaire des 67 s, le modele
      // perdait le compte et cherchait encore des fleurs jusqu au plafond.
      const arbreOuvert = Boolean(arbreInacheve())
      if (mission.kind === 'recolte' && mission.quotaExplicite && !mission.wholeTree && !arbreOuvert &&
        !mission.fabricationCible && collected() >= mission.quota) {
        finish('done', `quantite demandee en inventaire (${collected()}/${mission.quota})`)
        return
      }
      // Fabrication : les objets cibles mesures en inventaire closent aussi.
      // Sinon le plan anticipe, calcule avant le craft, passait encore
      // (craft/door cabbdfcd : 3 portes faites, puis « planches » sans buche,
      // echec et 10 s de plus). Avec un don demande, le modele livre d abord.
      while (fabricationSuivante()) { /* objets deja en poche : le suivant */ }
      if (mission.kind === 'recolte' && mission.fabricationCible && !livraisonDemandee(mission) && !arbreOuvert &&
        fabricationProduced() >= (mission.fabricationQuantite ?? 1)) {
        finish('done', `${mission.fabricationCible} fabrique(s) en inventaire (${fabricationProduced()}/${mission.fabricationQuantite ?? 1})`)
        return
      }

      // Objets a poser (A/B `poser`) : tous poses et verifies dans le monde,
      // la mission se clot ; le modele ne compte pas.
      if (mission.kind === 'recolte' && mission.poses?.length > 0 && !livraisonDemandee(mission) && !arbreOuvert &&
        posesManquantes().length === 0 && finishAllowed(buildState()).ok) {
        finish('done', `objets poses : ${mission.poses.map(p => `${mission.posesFaites?.[p.objet] ?? 0} ${p.objet}`).join(', ')}`)
        return
      }

      // Bloc hors catalogue a rejoindre (buts_ouverts) : l arrivee a portee se
      // mesure et clot. Vu au banc : « Trouve une cloche pour le joueur »,
      // cloche atteinte trois fois, le modele repartait la « rapporter ».
      if (mission.kind === 'deplacement' && String(mission.resource).startsWith('libre:') && !arbreOuvert &&
        finishAllowed(buildState()).ok) {
        finish('done', `${mission.resource.slice(6)} a portee`)
        return
      }

      // « ... et rapporte moi le bois » : l arbre fini, rejoindre d abord le
      // demandeur (s il est en jeu), puis clore ; un echec de trajet laisse la
      // boucle continuer (pendingJoin). Vu sur chat/tree-then-bring : mission
      // close au pied de l arbre, bois jamais rapporte.
      // Chantier complet (mesure par le code, porte comprise si demandee) :
      // clore, comme l arbre entier ou la quantite explicite. Le modele ne
      // compte pas les blocs (vu : arche 11/11, 74 appels jusqu au plafond).
      if (mission.kind === 'construction' && mission.plan) {
        const chantier = buildProgress()
        if (chantier.total > 0 && chantier.left === 0 && !arbreOuvert && (!mission.wantsDoor || doorPlaced()) && finishAllowed(buildState()).ok) {
          finish('done', `chantier complet (${chantier.done}/${chantier.total} blocs${mission.wantsDoor ? ', porte posee' : ''})`)
          return
        }
      }

      if (mission.wholeTree && !arbreOuvert && treeStatus()?.termine) {
        // La demande vient de l objectif (revision) ou d une precision
        // ajoutee en cours de route (vu : « et rapporte moi le bois » classe
        // en precision, objectif inchange, bois jamais rapporte).
        const livrer = demandeDuJoueur(mission, /rapport|ram[eè]n|apport|livr/i) &&
          Boolean(host.getBot()?.players?.[mission.requester]?.entity)
        if (livrer && !mission.livraison) {
          mission.livraison = true
          mission.pendingJoin = true
          abortPrefetch('arbre fini, bois a rapporter au demandeur')
          mission.queue = [{ action: 'rejoindre_demandeur', scale: 0.5, scaleLevel: null, choices: {} }]
          console.log(`[mission] arbre fini : bois a rapporter a ${mission.requester}`)
          // Le geste precedent peut avoir demande la fin ou echoue avant
          // la derniere mesure : il ne doit pas effacer ce retour requis.
          continue
        } else if ((!livrer || mission.pendingJoin === false) && finishAllowed(buildState()).ok) {
          finish('done', livrer ? 'arbre entier coupe, bois rapporte au demandeur' : 'arbre entier coupe et ramasse')
          return
        }
      }

      // C est le modele qui decide quand la mission est finie : `terminer` la
      // clot, sauf quand un critere chiffre (quantite explicite, arbre
      // demande) la contredit : refus reinjecte, comme pour `fini` ; un arbre
      // commence ne peut pas etre clos par le plafond de refus
      // (docs/journal.md, piege 17).
      if (outcome.fin) {
        const allowed = finishAllowed(buildState())
        // Quantite explicite pas encore en inventaire, ou arbre demande pas
        // fini : meme refus reinjecte que pour `fini` (3 au plus), au lieu de
        // clore la mission en echec (chat/replace-and-join 73b4876 : plan
        // « ramasser -> terminer » avec 2 buches encore sur l arbre).
        if (!allowed.ok && (arbreOuvert || ((mission.quotaExplicite || mission.wholeTree || mission.poses?.length > 0 || plusieursFabrications()) && mission.finishRefused < REFUSALS_BEFORE_YIELD))) {
          mission.finishRefused += 1
          mission.refusalNote = allowed.why
          mission.queue = []
          abortPrefetch('arret refuse')
          console.log(`[mission] terminer refuse (${mission.finishRefused}/${REFUSALS_BEFORE_YIELD}) : ${allowed.why}`)
          continue
        }
        finish(allowed.ok ? 'done' : 'failed', allowed.ok ? 'le planificateur a clos la mission' : allowed.why)
        return
      }

      // Reparation par le code (A/B `reparer`) : une etape ratee, ou arretee
      // court sur une cause sure (recolter partiel stoppe par un tronc haut),
      // voit ses remedes mesures (remedesMesures) joues tout de suite puis
      // l etape rejouee, sans appel au modele. Une fois par code entre deux
      // progres mesures ; l echec reste dans l historique que le modele lit.
      // Le reste du plan suit l etape rejouee : il a ete fait pour elle.
      const remedes = featureOn('reparer', false) && outcome.code && !mission.reparesCodes?.has(outcome.code)
        ? remedesMesures(outcome.code, decision.step) : null
      if (remedes) {
        mission.reparesCodes = mission.reparesCodes ?? new Set()
        mission.reparesCodes.add(outcome.code)
        const r = mission.reparations = mission.reparations ?? { n: 0, codes: {} }
        r.n += 1
        r.codes[outcome.code] = (r.codes[outcome.code] ?? 0) + 1
        // Une etape ratee est rejouee apres ses remedes ; une etape arretee
        // court a deja fait sa part (la rejouer apres le dernier tronc rendait
        // « rien en vue ») : la suite revient au plan.
        mission.queue = [
          ...remedes.map(m => ({ action: m.action, scale: null, scaleLevel: null, choices: m.params ?? {}, reparation: true })),
          ...(outcome.echec ? [{ action: decision.step, scale: decision.scale, scaleLevel: decision.scaleLevel, choices: decision.choices, reparation: true }] : []),
          ...mission.queue
        ]
        if (!outcome.echec) abortPrefetch('reparation par le code, plan speculatif jete')
        console.log(`[mission] reparation (${outcome.code}) : ${remedes.map(m => `${m.action} (${m.pourquoi})`).join(', ')}${outcome.echec ? `, puis ${decision.step} rejoue` : ''}`)
      }

      // Repeter la meme action ratee indefiniment ne mene nulle part : mieux
      // vaut rendre la main au joueur que de bruler des appels.
      if (outcome.echec) {
        mission.activity?.update('blocked', `Raté : ${outcome.resultat}`, true)
        mission.failures += 1

        // Un deplacement qui vient d echouer sur un obstacle : le signal du
        // contournement, servi une fois dans l etat du tour suivant. Sans lui,
        // le modele reprenait pivoter+avancer au meme cap et oscillait devant
        // le meme mur.
        if (decision.step === 'avancer' || decision.step === 'appuyer' || decision.step === 'rejoindre_demandeur') {
          mission.lastBlocked = true
        }

        // Le point qui garde la boucle fermee malgre les plans multi-etapes :
        // des qu une etape rate, la realite ne suit plus le plan, donc le reste
        // du plan ne vaut plus rien. On le jette et on replanifie sur l etat
        // reel au tour suivant. Le plan anticipe en vol est jete lui aussi :
        // il a ete calcule sur un etat d avant l echec.
        if (mission.queue.length > 0 && !remedes) {
          console.log(`[mission] plan abandonne (${mission.queue.length} etape(s)) apres un echec`)
          mission.queue = []
        }
        abortPrefetch('echec, plan speculatif jete')

        if (mission.failures >= MAX_REPEATED_FAILURES) {
          finish('failed', `${MAX_REPEATED_FAILURES} actions en echec d affilee`)
          return
        }
        if (!remedes) mission.echecsAuModele += 1
      } else {
        mission.failures = 0
      }

      // Un geste tient en un seul plan : des que la file est vide, c est fini —
      // SAUF si le plan vient d echouer sans rien produire (avancer interrompue
      // a 0,1 bloc, bot encastre) : on replanifie sur l etat reel au lieu de
      // conclure sur un echec. Plafonne a GESTE_MAX_PLANS plans au total, pour
      // qu un geste irrealisable rende quand meme la main.
      if (mission.kind === 'geste' && mission.queue.length === 0) {
        if ((outcome.echec || mission.pendingJoin) && mission.gestePlans < GESTE_MAX_PLANS - 1) {
          mission.gestePlans += 1
          console.log(
            `[mission] geste echoue, replanification (${mission.gestePlans}/${GESTE_MAX_PLANS}) : ${outcome.resultat}`
          )
          await sleep(TICK_MS)
          continue
        }
        finish(outcome.echec || mission.pendingJoin ? 'failed' : 'done', outcome.echec || mission.pendingJoin
          ? `geste conduit en ${mission.steps} etapes, sans succes`
          : 'geste execute')
        return
      }

      // Une etape deja planifiee n a aucun appel a amortir.
      await sleep(mission.queue.length > 0 ? QUEUE_TICK_MS : TICK_MS)
    }
  }

  // -------------------------------------------------------------------------
  // API publique
  // -------------------------------------------------------------------------

  async function runMovementMission (current) {
    let expired = false
    const controller = current.navigationAbort
    const remaining = Math.max(0, MAX_DURATION_MS - activeDurationMs(current))
    if (remaining === 0) {
      await finish('stopped', 'delai de mission atteint')
      return
    }
    // A previous segment must never abort or finish a resumed segment.
    const timer = setTimeout(() => { expired = true; controller.abort() }, remaining)
    const clearDeadline = () => clearTimeout(timer)
    controller.signal.addEventListener('abort', clearDeadline, { once: true })
    try {
      // Parcours entier sous un seul writer (regarder/attendre/sous_arbre
      // inclus) ; seules les sous-etapes nav s executent dedans via le token
      // proprietaire. Sans executeur (tests) : execution directe heritee.
      const exec = physicalExecutor()
      const courseId = `mission-${current.id}-parcours`
      const courseToken = {}
      // Sous-hote : movement-task et tree-position appellent host.navigate*
      // SANS les modifier ; le token du parcours y est injecte ici, pour que
      // rejoindre/retour/sous_arbre (nav sous-etape) passent DANS le slot.
      const courseHost = {
        ...host,
        navigateToPlayer: (username, options = {}) => navWithDescent(() => host.navigateToPlayer(username, { ...options, __owner: courseToken }),
          { target: () => playerPosition(username), owner: courseToken }),
        navigateToPosition: (position, options = {}) => navWithDescent(() => host.navigateToPosition(position, { ...options, __owner: courseToken }),
          { target: position ? new Vec3(position.x, position.y, position.z) : null, owner: courseToken })
      }
      const runCourse = () => movementTask.executeTask(current.movementTask, courseHost, current.requester,
        controller.signal, task => {
          if (current.navigationAbort !== controller) return
          const activeStep = task.steps[task.cursor]
          if (activeStep?.state === 'running') current.activity?.update('execution', activity.SUBGOALS[activeStep.type] || 'Je continue…', true)
          current.steps = task.cursor
          const step = task.steps[task.cursor - 1]
          if (step?.state === 'done') current.lastPlan = { step: step.type, subgoal: task.cursor, total: task.steps.length }
        })
      let result
      if (exec) {
        stepOwner = courseId
        stepToken = courseToken
        try {
          // R03 : deballage commun de l enveloppe. Failed garde son
          // code/message (jamais de lecture d une valeur absente), cancelled
          // devient un arret ; sans resultat mesurable, echec explicite.
          const envelope = await exec.run({ id: courseId, kind: 'work' }, runCourse)
          if (current.navigationAbort !== controller) return
          try {
            result = unwrapExecutionEnvelope(envelope)
          } catch (err) {
            if (current.navigationAbort !== controller) return
            if (err && err.code === 'cancelled') {
              await finish('stopped', 'parcours interrompu (stop/pause)')
            } else {
              await finish('failed', `parcours en echec (${(err && err.code) || 'erreur'}) : ${err.message}`)
            }
            return
          }
          if (!result || typeof result.reached !== 'boolean') {
            await finish('failed', 'parcours sans resultat mesurable')
            return
          }
        } catch (refus) {
          if (current.navigationAbort !== controller) return
          await finish('failed', `parcours refuse (${refus.code || 'refus'}) : ${refus.message}`)
          return
        } finally {
          if (stepToken === courseToken) {
            stepOwner = null
            stepToken = null
          }
        }
      } else {
        result = await runCourse()
      }
      if (mission !== current || current.state !== 'running' || current.navigationAbort !== controller) return
      current.history = current.movementTask.steps.filter(s => s.result).map(s => ({
        action: s.type, resultat: s.result.code, code: s.result.code, echec: !s.result.reached
      }))
      await finish(result.reached ? 'done' : 'failed', expired ? 'delai de mission atteint'
        : result.reached ? `${current.steps} sous-objectifs verifies` : `parcours interrompu : ${result.detail ?? result.code}`)
    } finally {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', clearDeadline)
    }
  }

  function cancelPendingStart () {
    startGeneration++
    startAbort?.abort()
    preparation?.reporter.finish('cancelled')
    preparation = null
  }

  // Garde-fou d admission : une revision doit porter un contexte sain, sinon
  // la reprise heriterait d un objet mutile (curseur, route, id).
  function isValidRevision (r) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return false
    if (typeof r.id !== 'string' || !r.id) return false
    if (typeof r.objective !== 'string' || !r.objective) return false
    if (r.instructions !== undefined && !Array.isArray(r.instructions)) return false
    if (r.movementTask !== undefined && r.movementTask !== null && !validRouteShape(r.movementTask)) return false
    if (r.clearance !== undefined && (typeof r.clearance !== 'object' || r.clearance === null)) return false
    return true
  }

  async function start (objective, requester, opts = {}) {
    const appel = {}
    const result = await startMission(objective, requester, opts, appel)
    if (!result?.ok && appel.revision && appel.revision === revisionArbre) retirerObservateurArbre()
    return result
  }

  async function startMission (objective, requester, opts, appel) {
    if (!host.isReady()) return { ok: false, error: 'bot non connecte' }
    let cerveau = planner
    if (opts.script) {
      try {
        cerveau = createScriptBrain({ script: opts.script, brief: opts.brief })
      } catch (err) {
        return { ok: false, error: `script refuse : ${err.message}` }
      }
    }
    if (!cerveau.isEnabled()) {
      return { ok: false, error: 'aucun planificateur disponible, aucune mission possible' }
    }

    const text = String(objective || '').trim()
    if (!text) return { ok: false, error: 'objectif vide' }
    if (opts.signal?.aborted) return { ok: false, error: 'objectif annule' }
    // Revision corrompue refusee (fail-closed) : jamais de reprise sur un
    // objet memoire mutile (id, courbe de progression, route).
    if (opts.revisionOf !== undefined && opts.revisionOf !== null && !isValidRevision(opts.revisionOf)) {
      return { ok: false, error: 'revision corrompue refusee (contexte invalide, reformule l objectif)' }
    }

    const collectesRevision = opts.revisionOf ? new Map(collectesEnAttente) : null
    if (isRunning()) stop('remplacee par un nouvel objectif')
    retirerObservateurArbre()
    if (opts.revisionOf) appel.revision = observerRevisionArbre(opts.revisionOf, collectesRevision)
    cancelPendingStart()
    const generation = ++startGeneration
    const request = new AbortController()
    startAbort = request
    const abortRequest = () => request.abort()
    const preparing = { id: `brief-${generation}`, objective: text, requester,
      reporter: activity.createActivityReporter({ say: host.chat,
        isActive: () => generation === startGeneration && !request.signal.aborted }) }
    preparation = preparing
    // Lecture de l objectif (reflexion, jusqu a 60 s) : un mot au joueur des
    // qu elle depasse ~3 s, sinon le bot semble ignorer l ordre (demande du
    // proprietaire). Le heartbeat du reporter le repete ensuite.
    preparing.reporter.update('brief', 'Je réfléchis…')
    const thinkingNotice = BRIEF_NOTICE_MS > 0 ? setTimeout(() => {
      if (generation === startGeneration && !request.signal.aborted) preparing.reporter.update('brief', 'Je réfléchis…', 'important')
    }, BRIEF_NOTICE_MS) : null
    opts.signal?.addEventListener('abort', abortRequest, { once: true })
    if (loopPromise) {
      const waitStarted = Date.now()
      await loopPromise.catch(() => {})
      if (Date.now() - waitStarted > 2000) console.log(`[mission] ancienne boucle terminee apres ${Date.now() - waitStarted} ms`)
    }
    if (generation !== startGeneration || request.signal.aborted) {
      preparing.reporter.finish('cancelled')
      if (preparation === preparing) preparation = null
      opts.signal?.removeEventListener('abort', abortRequest)
      return { ok: false, error: 'objectif annule' }
    }

    // Recuperations existantes avant de juger un geste incomplet. Elles restent
    // dans le rejeu unique du BRIEF : un vrai contrat manquant est relu une fois,
    // sans bloquer une fabrication valide ni un placement deja recuperable.
    const normalizeBrief = value => {
      if (!value.route && value.kind !== 'recolte' && !value.fabrication &&
        /\bsous\s+(?:l['’ ]\s*|un\s+|cet\s+|le\s+)?arbre\b/i.test(text)) {
        console.log('[mission] « sous l arbre » sans parcours : parcours [sous_arbre] retenu')
        value = { ...value, route: [{ type: 'sous_arbre' }] }
      }
      const rawTarget = value.fabrication ?? value.fabrication_cible ?? null
      let target = null
      try { target = resolveFabricationCible(host.getBot(), rawTarget) } catch (_) {}
      if (!target) {
        try { target = resolveFabricationCible(host.getBot(), opts.revisionOf?.fabricationCible ?? opts.revisionOf?.fabrication_cible ?? null) } catch (_) {}
      }
      if (target && value.kind === 'geste' && !value.route) {
        console.log(`[mission] fabrication "${target}" detectee, type geste -> recolte (pas de cloture en un plan)`)
        value = { ...value, kind: 'recolte' }
      }
      if (featureOn('poser', false) && Array.isArray(value.pose) && value.pose.length > 0 && value.kind === 'geste' && !value.route) {
        console.log('[mission] objets a poser, type geste -> recolte (obtenir puis poser)')
        value = { ...value, kind: 'recolte', incompleteGesture: false }
      }
      if (value.incompleteGesture && value.kind === 'geste' && !value.route) {
        throw new Error('brief de geste incomplet : parcours ou geste_libre requis')
      }
      return value
    }
    const blocConnu = nom => !!skills.ressourceLibre(nom, host.getBot()?.registry)
    let brief
    const debutBrief = Date.now()
    const lireBrief = async () => normalizeBrief(await cerveau.readBrief(text, { signal: request.signal, deferGestureValidation: true, ouvert: featureOn('buts_ouverts', false), pose: featureOn('poser', false), blocConnu, relance: featureOn('relance_plan') }))
    try {
      try {
        brief = await lireBrief()
      } catch (first) {
        // Un echec isole (reponse tronquee deux fois, panne passagere) laissait
        // le bot immobile sans rien dire, surtout apres un arbitrage : un
        // nouvel essai, sauf annulation. Une panne passagere (reseau coupe,
        // qui echoue en un instant) se rejoue tant que dure le budget de deux
        // lectures muettes.
        if (request.signal.aborted) throw first
        console.log(`[mission] lecture de l objectif echouee (${first.message}), nouvel essai`)
        const budgetMs = 2 * planner.delaiAppel('readBrief') - (Date.now() - debutBrief)
        brief = planner.estPassager(first)
          ? await planner.rejouerSiPassager(lireBrief, { budgetMs, signal: request.signal, quoi: 'lecture de l objectif' })
          : await lireBrief()
      }
    } catch (err) {
      return { ok: false, error: `lecture de l objectif impossible : ${err.message}` }
    } finally {
      if (thinkingNotice) clearTimeout(thinkingNotice)
      preparing.reporter.finish('ended')
      if (preparation === preparing) preparation = null
      opts.signal?.removeEventListener('abort', abortRequest)
      if (startAbort === request) startAbort = null
    }
    if (generation !== startGeneration || request.signal.aborted || !host.isReady()) return { ok: false, error: 'objectif annule' }
    // Capacite `donner` cablee (delivery.js) : plus de refus global
    // needsTransfer. Une livraison impossible reste un echec mesure de
    // l action, jamais un succes fictif ni une recolte declaree faite.
    if (brief.needsWeb) return { ok: false, error: 'je n ai pas d outil de recherche Internet ou de meteo en direct' }
    // Mode ouvert (A/B buts_ouverts) : une capacite que la demande exige et
    // que le bot n a pas (identifiant de skills.CAPACITES_ABSENTES, jamais un
    // texte libre) se dit tout de suite, au lieu de tourner jusqu au plafond.
    const absente = featureOn('buts_ouverts', false) && brief.horsCapacites ? skills.CAPACITES_ABSENTES[brief.horsCapacites] : null
    if (absente) {
      console.log(`[mission] "${text}" : capacite absente (${brief.horsCapacites}), mission refusee`)
      return { ok: false, error: `je ne sais pas encore ${absente.split(' (')[0]}`, horsCapacites: brief.horsCapacites }
    }

    // Fix 2 : resolution insensible aux variantes (« graine », « wheat_seeds »).
    // Sans elle, « ramasse 5 graines » tombait sur 'aucune' des que le modele
    // n ecrivait pas le pluriel exact, privant la mission de toute cible.
    let resource = skills.resolveResource
      ? (skills.resolveResource(brief.resource) ?? 'aucune')
      : (skills.RESOURCES[brief.resource] ? brief.resource : 'aucune')

    // Bloc hors catalogue (A/B buts_ouverts) : nomme au registre par le
    // modele, valide par le code (skills.ressourceLibre), cle `libre:<bloc>`.
    if (resource === 'aucune' && featureOn('buts_ouverts', false) && brief.blocRegistre) {
      const libre = skills.ressourceLibre(brief.blocRegistre, host.getBot()?.registry)
      if (libre) {
        console.log(`[mission] bloc hors catalogue "${brief.blocRegistre}" -> matiere ${libre}`)
        resource = libre
      } else {
        console.log(`[mission] bloc hors catalogue "${brief.blocRegistre}" inconnu du registre, ignore`)
      }
    }

    // 'aucune' prive la mission de toute cible : le bot ne peut plus qu explorer
    // a l aveugle. Quand ce choix n est pas assure, on retient la meilleure
    // matiere proposee a la place.
    if (resource === 'aucune' && brief.resourceConfidence < cerveau.MIN_CONFIDENCE && brief.resourceProbabilities) {
      const best = Object.entries(brief.resourceProbabilities)
        .filter(([name]) => name !== 'aucune')
        .sort((a, b) => b[1] - a[1])[0]

      if (best && best[1] > 0) {
        const canonical = skills.resolveResource ? (skills.resolveResource(best[0]) ?? best[0]) : best[0]
        if (skills.RESOURCES[canonical]) {
          console.log(`[mission] matiere "aucune" peu assuree (${brief.resourceConfidence.toFixed(2)}), repli sur "${canonical}" (${best[1].toFixed(2)})`)
          resource = canonical
        }
      }
    }

    // Cible de fabrication generique (sans regex de phrase) : le brief donne le
    // brut ("hache", "minecraft:torch"...), le code normalise (alias FR) et
    // valide au registre (craft.TARGETS ou itemsByName). Quantite lue par le
    // code (brief indicatif, sinon parseQuota, sinon 1). Revision : un amend
    // qui ne restate pas la cible la conserve.
    let kind = brief.route ? 'geste' : (skills.KINDS[brief.kind] ? brief.kind : 'recolte')
    const landmark = skills.LANDMARKS[brief.landmark] ? brief.landmark : 'ici'
    const dimensions = build.parseDimensions(text)
    const briefFabRaw = brief.fabrication ?? brief.fabrication_cible ?? null
    const briefFabQty = brief.fabricationQuantite ?? brief.fabrication_quantite ?? null
    let fabricationCible = null
    try {
      fabricationCible = resolveFabricationCible(host.getBot(), briefFabRaw)
    } catch (_) {
      fabricationCible = null
    }
    // Famille seule (« pioche ») alors que l objectif nomme la matiere (« une
    // pioche en pierre ») : l objet precis du texte (vu sur craft/stone-pickaxe :
    // cible « pioche », pioche en bois fabriquee, puis errance 4 min).
    if (fabricationCible && FAMILLES_FAB[fabricationCible] && !/^(planches|batons|etabli)$/.test(fabricationCible)) {
      // La matiere qui suit l outil, pas le premier mot de matiere de la
      // phrase (« coupe du bois pour une pioche en pierre » : pierre).
      const tool = /\b(haches?|pioches?|pelles?)\s+en\s+([a-zé]+)\b/i.exec(sansCoordonnees(text))
      const precise = tool ? fabTargetName(tool[0]) : null
      if (precise && precise !== fabricationCible && FAMILLES_FAB[fabricationCible].test(precise)) {
        console.log(`[mission] cible de fabrication precisee par l objectif : ${fabricationCible} -> ${precise}`)
        fabricationCible = precise
      }
    }
    let fabricationQuantite = fabricationCible
      ? fabricationWanted(text, briefFabQty)
      : 1
    const revisionFab = opts.revisionOf?.fabricationCible ?? opts.revisionOf?.fabrication_cible ?? null
    if (!fabricationCible && revisionFab) {
      const kept = resolveFabricationCible(host.getBot(), revisionFab)
      if (kept) {
        fabricationCible = kept
        fabricationQuantite = Number.isFinite(Number(opts.revisionOf?.fabricationQuantite))
          ? Math.max(CRAFT_MIN, Math.min(CRAFT_MAX, Math.round(Number(opts.revisionOf.fabricationQuantite))))
          : fabricationWanted(text, briefFabQty)
      }
    }
    // Plusieurs objets demandes (« une pioche, une hache et une epee en
    // pierre ») : les suivants viennent apres la cible, un a la fois, chacun
    // valide au registre (vu sur composite/stone-toolkit : seule la pioche
    // etait visee, la mission close apres elle).
    const suiteBrute = Array.isArray(brief.fabricationSuite) ? brief.fabricationSuite
      : (!briefFabRaw && Array.isArray(opts.revisionOf?.fabricationSuite) ? opts.revisionOf.fabricationSuite.map(f => f?.objet) : [])
    const fabricationSuite = []
    for (const brut of suiteBrute) {
      let objet = null
      try { objet = resolveFabricationCible(host.getBot(), brut) } catch (_) {}
      if (objet && objet !== fabricationCible && !fabricationSuite.some(f => f.objet === objet)) {
        fabricationSuite.push({ objet, initial: 0 })
      }
    }
    const livraisonAnnulee = opts.revisionOf && livraisonDemandee(opts.revisionOf) &&
      !livraisonDemandee({ objective: text, requester })
    // Un objectif reformule remplace aussi ses dons : « donne-moi 2 buches »
    // devenu « ... et donne-moi 2 pommes » garde le verbe de don, mais plus
    // l ancien objet. Seul un `donner` du nouvel objectif reactive un
    // engagement (engagementDon), avec son budget et son incertain d origine.
    const objectifReformule = opts.revisionOf &&
      String(opts.revisionOf.objective ?? '').trim() !== text
    if (livraisonAnnulee || objectifReformule) {
      // Un don non tente peut etre annule par le nouvel objectif. Les preuves
      // de sorties deja tentees/incertaines restent dans le grand livre.
      for (const ledger of deliveryLedgersFor(opts.revisionOf)) {
        if (ledger.attempted === 0 && ledger.removed === 0 && ledger.proven === 0 && ledger.uncertain === 0) deliveryLedgers.delete(ledger.key)
        else ledger.cancelled = true
      }
    }
    // Objets a poser dans le monde (A/B `poser`) : noms du brief valides au
    // registre, quantite dite ou au moins un. La revision garde les siens.
    let poses = featureOn('poser', false) ? posesDuBrief(host.getBot(), brief.pose) : []
    if (poses.length === 0 && Array.isArray(opts.revisionOf?.poses)) poses = opts.revisionOf.poses
    if (poses.length > 0 && !brief.route && kind !== 'construction') kind = 'recolte'
    // Bloc ouvert qui ne lache rien (spawner) ou incassable : il se rejoint,
    // il ne se recolte pas. Une « recolte » de ce bloc devient un deplacement
    // mesure (bloc cible a portee), plutot qu un quota jamais atteignable.
    const specLibre = String(resource).startsWith('libre:') ? ressource(resource) : null
    if (specLibre && kind === 'recolte' && !fabricationCible && (!specLibre.items || specLibre.incassable)) {
      console.log(`[mission] ${resource} ne se recolte pas : type recolte -> deplacement`)
      kind = 'deplacement'
    }
    const objectiveMode = opts.mode === 'permanent' ? 'permanent' : 'temporary'
    mission = {
      id: opts.revisionOf?.id ?? `${Date.now()}-${generation}`,
      objectiveId: opts.objectiveId ?? opts.revisionOf?.objectiveId ?? null,
      // R25 : scope du contexte memoire transitoire (travail + pending).
      // Pose a l activation ci-dessous (cle normalisee), snapshotte a la
      // suspension, restaure a la reprise. Jamais persiste cote controleur.
      memoryScope: null,
      objectiveMode,
      maintenance: null,
      rehydrated: false,
      baseUnits: 0,
      revision: opts.revisionOf ? opts.revisionOf.revision + 1 : 0,
      movementTask: brief.route ? movementTask.createTask(brief.route,
        opts.revisionOf?.movementTask?.origin ?? host.getBot().entity.position) : null,
      instructions: opts.revisionOf?.instructions?.slice(-8).map(entry => ({ ...entry })) ?? [],
      planRevision: 0,
      clearance: {
        limit: [0, 1].includes(opts.clearanceBlocks) ? opts.clearanceBlocks : (opts.revisionOf?.clearance?.limit ?? brief.clearanceLimit ?? 0),
        used: opts.revisionOf?.clearance?.used ?? 0
      },
      objective: text,
      requester,

      // Le brief : etabli une fois, relu a chaque tour.
      kind,
      kindConfidence: Number(brief.kindConfidence.toFixed(3)),
      resource,
      resourceConfidence: Number(brief.resourceConfidence.toFixed(3)),
      landmark,
      landmarkResource: skills.LANDMARKS[landmark]?.resource ?? null,
      // Porte : lue par le modele (negation comprise : « sans porte »), mais
      // gardee seulement si le texte du joueur parle de porte (build/arch
      // 295e295 : « arche en pierre » lue « porte oui »).
      wantsDoor: Boolean(brief.door) && demandeDuJoueur({
        objective: text, requester, instructions: opts.revisionOf?.instructions ?? []
      }, DOOR),
      doorProbability: Number(brief.doorProbability.toFixed(3)),
      dimensions,
      // Quantite visee : lue dans la phrase (« mine dix charbons ») par le code,
      // jamais demandee au modele. `finishAllowed` s en sert pour refuser un
      // arret premature. En fabrication, le quota recolte ne sert pas : la
      // preuve est l objet cible (fabricationCible/Quantite ci-dessous).
      quota: build.parseQuota(sansCoordonnees(text), { allowBlockUnits: kind === 'recolte' && !fabricationCible }) ?? DEFAULT_QUOTA,
      // Quantite dite par le joueur (« 3 fleurs ») : sa fin se mesure, comme
      // l arbre entier. Le quota par defaut (16) ne clot rien tout seul.
      quotaExplicite: build.parseQuota(sansCoordonnees(text), { allowBlockUnits: kind === 'recolte' && !fabricationCible }) !== null,
      // « coupe (moi) un arbre » : le travail est UN arbre entier, pas le quota
      // par defaut. L arbre est fixe par la premiere buche coupee ; la fin est
      // jugee sur ses buches restantes et son bois au sol (finishAllowed).
      wholeTree: kind === 'recolte' && resource === 'bois' && !fabricationCible &&
        ((opts.revisionOf?.wholeTree === true && !!opts.revisionOf?.tree) ||
          (build.parseQuota(sansCoordonnees(text), { allowBlockUnits: true }) === null && WHOLE_TREE_TEXT.test(text))),
      tree: null,
      // A revision keeps the tree in progress (player rule, see arbreInacheve).
      ...suiviArbre(opts.revisionOf),
      // Fabrication generique : cible validee registre + quantite codee,
      // persistee et servie dans buildState (consigne.fabrication_cible).
      // Legacy recolte sans cible : null, chemin inchange.
      fabricationCible,
      fabricationQuantite,
      fabricationInitial: 0,
      fabricationLastError: null,
      fabricationSuite,
      fabricationsFaites: [],
      poses,
      posesFaites: { ...(opts.revisionOf?.posesFaites ?? {}) },

      supply: SUPPLY,
      // Cerveau de cette mission : le planificateur, ou un script (banc de
      // competences). Jamais persiste : une mission reprise replanifie.
      cerveau: cerveau === planner ? null : cerveau,
      buildBlock: ressource(resource)?.build ?? 'dirt',
      // Le motif accepte plusieurs noms : en survie le bloc pose depend de ce
      // qui est tombe (pierre -> cobblestone, bloc d herbe -> terre) et de
      // l essence coupee (chene, bouleau...).
      buildMatch: ressource(resource)?.buildMatch ?? /^dirt$/,
      doorBlock: process.env.MISSION_DOOR_BLOCK || 'oak_door',

      state: 'running',
      cancelled: false,
      navigationAbort: new AbortController(),
      pendingJoin: opts.revisionOf?.pendingJoin === true && !livraisonAnnulee,
      startedAt: opts.revisionOf?.startedAt ?? Date.now(),
      startedAtIso: opts.revisionOf?.startedAtIso ?? new Date().toISOString(),
      activeElapsedMs: opts.revisionOf ? activeDurationMs(opts.revisionOf) : 0,
      activeSince: Date.now(),
      endedAt: null,
      reason: null,
      steps: 0,
      broken: 0,
      // Attente du modele, bot immobile (indicateur de banc, a faire baisser) :
      // lecture de l objectif, puis chaque plan attendu par la boucle.
      briefMs: Date.now() - debutBrief,
      attenteModeleMs: 0,
      // Echecs rendus au modele (ni repares par le code, ni mission close).
      echecsAuModele: 0,
      // Dirt cassee en mission bois pour un pilier : hors quota bois, mais
      // progres anti-blocage (voir progressFingerprint) et preuve chiffree.
      dirtSecondaire: 0,
      failures: 0,
      plannerErrors: 0,
      plannerSilenceSince: null,

      // File d etapes servies par un seul appel au planificateur JSON.
      queue: [],
      queueDone: 0,
      plans: 0,
      planMs: null,
      lastWhy: null,
      // Appel anticipe : recouvre la latence reseau par l execution. Un seul
      // appel en vol a la fois (`prefetch`), lance quand la file descend a 1
      // etape, pendant que cette etape tourne. `prefetchAbort` relaye le
      // signal mission -> planner -> llm (stop, echec, fin).
      prefetch: null,
      prefetchAbort: null,
      prefetchLances: 0,
      prefetchConsommes: 0,
      prefetchAnnules: 0,
      // Derniere etape ou une mini-carte a ete tentee : evite deux captures au
      // meme pas quand un plan echoue et est rejoue (voir capturePourPlan).
      lastCaptureStep: -1,
      // Replanification d un geste en echec : compteur de plans consommes.
      gestePlans: 0,
      // Signal de contournement : un avancer/appuyer vient d echouer bloque.
      // Servi une fois dans l etat (avancer_bloque), puis reinitialise.
      lastBlocked: false,
      // Anti-oscillation entre gestes : distance XZ vers la meme cible au tour
      // precedent, et nombre de gestes de mouvement sans gain. Quand le compteur
      // atteint NAV_STAGNANT_MAX, buildState force lastBlocked (contournement)
      // au lieu de laisser alterner avancer bloque et casser trop loin.
      lastStrafeSide: null,
      // Piste des 3 dernieres positions >= 1 bloc (exposee dans l etat) et
      // compteur de rotation de la boussole de secours (navigation null).
      piste: [],
      boussoleIdx: 0,
      approachKey: null,
      approachDist: null,
      approachStagnant: 0,
      finishRefused: 0,
      refusalNote: null,
      planAdjustNote: null,
      // Blocage : un compteur de progres pour mesurer l avancement.
      lastProgress: 0,
      lastProgressStep: 0,
      stuck: false,
      stuckWhy: null,
      revisions: 0,
      restartAfterAction: false,
      lastSaidAt: 0,
      saidTexts: [],
      // Messages systeme et prevention d impasse : on le dit une fois quand le
      // blocage apparait, pas a chaque tour.
      lastAnnounceAt: 0,
      stuckAnnounced: false,
      history: [],
      lastPlan: null,
      summaryText: null,
      startingItems: 0,
      collected: 0,

      plan: null,
      placed: 0,
      doorPlaced: false
    }
    mission.startingItems = countResourceItems()
    // Preuve initiale de fabrication : le stock cible deja la ne compte pas
    // comme produit (production = courant - initial, mesuree, jamais annoncee).
    // Revision : conserve l initial deja prouve si la cible est gardee.
    try {
      if (mission.fabricationCible && opts.revisionOf?.fabricationCible === mission.fabricationCible &&
          Number.isFinite(Number(opts.revisionOf?.fabricationInitial))) {
        mission.fabricationInitial = Math.max(0, Math.round(Number(opts.revisionOf.fabricationInitial)))
      } else if (mission.fabricationCible) {
        mission.fabricationInitial = countFabricationItems(host.getBot(), mission.fabricationCible)
      }
      for (const f of mission.fabricationSuite) {
        const garde = opts.revisionOf?.fabricationSuite?.find?.(g => g?.objet === f.objet)
        f.initial = Number.isFinite(Number(garde?.initial)) ? Math.max(0, Math.round(Number(garde.initial)))
          : countFabricationItems(host.getBot(), f.objet)
      }
    } catch (_) {
      mission.fabricationInitial = 0
    }
    try {
      const p = host.getBot()?.entity?.position
      if (p) mission.originFixed = { x: Number(p.x.toFixed(2)), y: Number(p.y.toFixed(2)), z: Number(p.z.toFixed(2)) }
    } catch (_) {}
    const current = mission
    mission.activity = activity.createActivityReporter({ say: host.chat,
      isActive: () => mission === current && current.state === 'running' })
    mission.activity.update('preparing', 'C est parti.')
    if (mission.movementTask) mission.movementTask.clearance = mission.clearance
    // Une revision conserve le prefixe deja prouve s il a le meme contrat.
    if (collectesRevision) for (const [id, entity] of collectesRevision) collectesEnAttente.set(id, entity)
    const previousTask = opts.revisionOf?.movementTask
    if (previousTask && mission.movementTask) {
      for (let i = 0; i < previousTask.cursor && i < mission.movementTask.steps.length; i++) {
        const old = previousTask.steps[i]
        const next = mission.movementTask.steps[i]
        if (old.type !== next.type || old.secondes !== next.secondes) break
        mission.movementTask.steps[i] = { ...old }
        mission.movementTask.cursor++
      }
    }

    // Nouvel objectif : la memoire de travail repart a zero, la memoire longue
    // reste. C est toute la difference entre les deux portees (voir memory.js).
    // R25 : le contexte est active AVANT tout vidage — resetWork ne vide que
    // le NOUVEAU contexte, jamais celui d une mission suspendue. Revision :
    // meme mission, meme contexte, pas de vidage. Pas de commit a
    // l activation ni a la suspension : le pending ne part qu au finish.
    mission.memoryScope = memory.setActiveScope(scopeMemoire(opts))
    if (!opts.revisionOf) memory.resetWork()

    const known = targetBlockIds().length
    console.log(
      `[mission] "${text}" (${requester}) -> type ${kind} (${mission.kindConfidence}), ` +
      `matiere ${resource} (${mission.resourceConfidence}), repere ${landmark}, ` +
      `porte ${mission.wantsDoor ? 'oui' : (brief.door ? 'non (non demandee)' : 'non')}, ${dimensions.width}x${dimensions.depth}x${dimensions.height} ` +
      `(${dimensions.source}), ${known} bloc(s) connu(s), approvisionnement ${SUPPLY}` +
      (mission.fabricationCible ? `, fabrication ${mission.fabricationCible} x${mission.fabricationQuantite} (stock initial ${mission.fabricationInitial})` : '') +
      (mission.fabricationSuite.length ? `, puis ${mission.fabricationSuite.map(f => f.objet).join(', ')}` : '')
    )

    // Un geste ou une question n a pas d « objectif accepte » a annoncer : le
    // planificateur repondra lui-meme par "dire". On evite l echo mecanique.
    if (kind !== 'geste') host.chat(`Objectif accepte : ${text}`)
    if (kind === 'construction') {
      host.chat(
        `Chantier ${dimensions.width}x${dimensions.depth}x${dimensions.height} en ${mission.buildBlock}` +
        `${brief.door ? ' avec porte' : ''}, repere : ${landmark}` +
        ' (je recolte et fabrique tout)'
      )
    }

    if (resource !== 'aucune' && known === 0) {
      host.chat(`Aucun bloc de type "${resource}" n est connu du serveur, je fais au mieux`)
    }

    loopPromise = (mission.movementTask ? runMovementMission(mission) : loop()).catch(err => {
      console.error('[mission] boucle interrompue :', err.message)
      finish('failed', `erreur interne : ${err.message}`)
    })

    return { ok: true, mission: status() }
  }

  function stop (reason = 'arret demande') {
    retirerObservateurArbre()
    cancelPendingStart()
    if (!isRunning()) return false

    mission.cancelled = true
    // Couper le deplacement en cours fait rejeter le goto de l action courante,
    // donc la boucle reprend la main au lieu d attendre son delai.
    try { host.stopPathfinding() } catch (_) {}
    // Un coup de pioche en cours irait sinon a son terme apres l arret (vu
    // sur chat/stop-tree : une buche coupee apres « Stop »).
    try { host.getBot()?.stopDigging() } catch (_) {}
    // Passe par finish(), point de fin unique : le commit de la memoire long
    // terme est fait la, pour un arret comme pour une fin naturelle.
    // Contexte conserve : l objet mission reste lisible via status().
    finish('stopped', reason)
    return true
  }

  // Pause durable (stop du travail, D18) : suspend la boucle en conservant
  // progression et contexte ; la reprise reobserve le monde (buildState frais),
  // sans inventer d actions terminees. Distinct de stop() qui clot en 'stopped'.
  function pauseWork (reason = 'pause') {
    cancelPendingStart()
    if (!isRunning()) return false
    freezeActiveDuration()
    mission.cancelled = true
    try { host.stopPathfinding() } catch (_) {}
    try { host.getBot()?.clearControlStates() } catch (_) {}
    try { host.getBot()?.stopDigging() } catch (_) {}
    abortPrefetch('pause du travail')
    try { mission.navigationAbort.abort() } catch (_) {}
    // Observation passive et bornee des coupes deja mesurees : leurs objets
    // peuvent arriver apres la pause. Aucun controle physique n est relance.
    mission.state = 'paused'
    mission.endedAt = null
    mission.reason = reason
    mission.summaryText = summary()
    return true
  }

  function isPaused () {
    return Boolean(mission && mission.state === 'paused')
  }

  // Activation d une mission en pause : etat frais (nouveau signal, compteurs
  // d echecs remis a zero), boucle relancee selon son type. La boucle reobserve
  // le monde a chaque tour (buildState) ; le parcours reprend a son curseur
  // (executeTask saute les pas deja prouves) ; rien n est rejoue ni recompte.
  // R25 : restauration explicite du contexte memoire snapshotte a la
  // suspension : travail + pending intacts, sans contamination de la mission
  // intercalee (qui a son propre contexte).
  function activatePaused (m) {
    mission = m
    try { memory.setActiveScope(m.memoryScope ?? m.objectiveId ?? m.id) } catch (_) {}
    m.activeSince = Date.now()
    m.state = 'running'
    m.cancelled = false
    m.navigationAbort = new AbortController()
    m.failures = 0
    m.plannerErrors = 0
    loopPromise = (m.movementTask ? runMovementMission(m) : loop()).catch(err => {
      console.error('[mission] boucle interrompue :', err.message)
      finish('failed', `erreur interne : ${err.message}`)
    })
    return true
  }

  // Reprise strictement explicite apres pauseWork : relance la boucle sur
  // l etat REEL (aucune etape marquee terminee ici). Passe par activatePaused
  // (parcours vs boucle selon le type), pas par loop() en dur.
  function resumeWork () {
    if (!isPaused()) return false
    if (!host.isReady()) return false
    return activatePaused(mission)
  }

  function suspendedSummaries () {
    return suspended.map((m) => ({
      id: m.id,
      objectifId: m.objectiveId ?? null,
      objectif: m.objective,
      demandeur: m.requester,
      etat: m.state,
      etapes: m.steps
    }))
  }

  // Suspension pour arbitrage (pause_reprise) : fige la boucle en conservant
  // l objet VIVANT (progression, origine, curseur, preuves, contraintes, id).
  // Le nouvel objectif demarre ensuite via start() ; a sa cloture, complete()
  // restaure l ancien dans le controleur et resumeSuspended() le relance ici.
  // L objet `mission` reste pointe (pause) jusqu au start() suivant : les
  // continuations en vol s eteignent sur leurs gardes au lieu d ecrire dans
  // le nouvel objet.
  function suspend (reason = 'arbitrage pause_reprise') {
    if (!isRunning() && !isPaused()) return null
    reportProgressSafe()
    if (isRunning()) pauseWork(reason)
    const frozen = mission
    // R25 : snapshot explicite du contexte memoire (scope actif) : la reprise
    // reactivera exactement celui-ci, pas celui d une mission intercalee.
    // Pas de commit force : le pending suspendu attendra le finish de SA mission.
    try { frozen.memoryScope = memory.getActiveScope() } catch (_) {}
    if (!frozen || suspended.includes(frozen)) return frozen
    suspended.push(frozen)
    if (suspended.length > SUSPENDED_MAX) suspended.shift()
    return frozen
  }

  // Vrai redemarrage d un engagement restaure par complete() : progression,
  // origine, contraintes et id preserves, etat frais (reobservation monde,
  // pas de replay). Echec explicite si l objet vivant est perdu (restart) :
  // l appelant bascule alors en attente explicite (rehydrate ou reformulation),
  // jamais en mission fantome. L engagement reste dans le controleur.
  function resumeSuspended (objectiveId) {
    if (isRunning()) return { ok: false, error: 'mission en cours' }
    if (!host.isReady()) return { ok: false, error: 'bot non connecte' }
    const idx = objectiveId
      ? suspended.findIndex((m) => m.objectiveId === objectiveId || m.id === objectiveId)
      : suspended.length - 1
    if (idx < 0) return { ok: false, error: 'aucune mission suspendue correspondante' }
    const m = suspended.splice(idx, 1)[0]
    if (m.state !== 'paused') {
      suspended.splice(Math.min(idx, suspended.length), 0, m)
      return { ok: false, error: `mission suspendue dans un etat inattendu (${m.state})` }
    }
    activatePaused(m)
    return { ok: true, mission: status() }
  }

  function validRouteShape (route) {
    if (route === null || route === undefined) return true
    if (typeof route !== 'object' || !Array.isArray(route.steps)) return false
    if (!Number.isInteger(route.cursor) || route.cursor < 0 || route.cursor > route.steps.length) return false
    return true
  }

  // Rehydratation apres restart (processus neuf, pile suspendue vide) : l objet
  // mission est RECONSTRUIT depuis l objectif durable (texte, auteur, mode,
  // progression, contraintes), jamais rejoue. La persistance controller est
  // commitee AVANT toute boucle : un echec ne laisse aucun faux actif.
  // Compteurs non rejoues : broken/collecte repartent de l observation fraiche,
  // le passe est porte par baseUnits (quota et affichage), jamais recompte
  // comme des actions terminees a l instant.
  function rehydrate (obj) {
    if (!obj || typeof obj !== 'object') throw new Error('rehydrate : objectif durable invalide')
    if (isRunning()) throw new Error('rehydrate : mission en cours')
    if (!host.isReady()) throw new Error('rehydrate : bot non connecte')
    const prog = obj.progression && typeof obj.progression === 'object' ? obj.progression : {}
    const desc = prog.descripteur && typeof prog.descripteur === 'object' ? prog.descripteur : null
    if (!desc || typeof desc.kind !== 'string' || typeof desc.resource !== 'string') {
      throw new Error('rehydrate : descripteur de reprise manquant (engagement conserve, reformule l objectif)')
    }
    if (!skills.KINDS[desc.kind] || !ressource(desc.resource)) {
      throw new Error('rehydrate : descripteur obsolete (kind/resource inconnus)')
    }
    if (desc.route !== null && desc.route !== undefined && !validRouteShape(desc.route)) {
      throw new Error('rehydrate : route persistee corrompue')
    }
    // Old snapshots may omit context; a present malformed value is not lost silently.
    const instructions = Object.hasOwn(prog, 'contexte') ? cloneContext(prog.contexte) : []
    if (!injectedObjectives || typeof injectedObjectives.resume !== 'function') {
      throw new Error('rehydrate : objectifs indisponibles (fail-closed)')
    }
    // Persistance d abord : leve l arret/pause AVANT toute boucle. Un echec
    // ici ne construit rien : pas de mission fantome, pas de faux actif.
    injectedObjectives.resume()
    retirerObservateurArbre()
    const now = Date.now()
    const dims = desc.dimensions && typeof desc.dimensions === 'object'
      ? { width: desc.dimensions.width, depth: desc.dimensions.depth, height: desc.dimensions.height, source: desc.dimensions.source ?? 'rehydrate' }
      : build.parseDimensions(String(obj.texte ?? ''))
    mission = {
      id: `rehydrate-${now}`,
      objectiveId: obj.id ?? null,
      revision: 0,
      movementTask: desc.route ? JSON.parse(JSON.stringify(desc.route)) : null,
      instructions,
      planRevision: 0,
      clearance: { limit: 0, used: 0 },
      objective: String(obj.texte ?? ''),
      requester: String(obj.auteur ?? 'inconnu'),
      // kind, resource, landmark, quotas, fabrication, pendingJoin : le
      // schema de reprise, le meme que celui du descripteur.
      ...missionState.restaurer(REPRISE, desc),
      kindConfidence: 1,
      resourceConfidence: 1,
      landmarkResource: null,
      wantsDoor: false,
      doorProbability: 0,
      dimensions: dims,
      fabricationLastError: null,
      supply: SUPPLY,
      buildBlock: ressource(desc.resource)?.build ?? 'dirt',
      buildMatch: ressource(desc.resource)?.buildMatch ?? /^dirt$/,
      doorBlock: process.env.MISSION_DOOR_BLOCK || 'oak_door',
      objectiveMode: obj.mode === 'permanent' ? 'permanent' : 'temporary',
      maintenance: null,
      rehydrated: true,
      ...suiviArbre(desc),
      baseUnits: Math.max(0, Number(prog.unites_recoltees ?? prog.faits ?? 0) || 0),
      state: 'running',
      cancelled: false,
      navigationAbort: new AbortController(),
      startedAt: now,
      startedAtIso: new Date().toISOString(),
      activeElapsedMs: 0,
      activeSince: now,
      endedAt: null,
      reason: null,
      steps: 0,
      broken: 0,
      dirtSecondaire: 0,
      failures: 0,
      plannerErrors: 0,
      plannerSilenceSince: null,
      queue: [],
      queueDone: 0,
      plans: 0,
      planMs: null,
      lastWhy: null,
      prefetch: null,
      prefetchAbort: null,
      prefetchLances: 0,
      prefetchConsommes: 0,
      prefetchAnnules: 0,
      lastCaptureStep: -1,
      gestePlans: 0,
      lastBlocked: false,
      lastStrafeSide: null,
      piste: [],
      boussoleIdx: 0,
      approachKey: null,
      approachDist: null,
      approachStagnant: 0,
      finishRefused: 0,
      refusalNote: null,
      planAdjustNote: null,
      lastProgress: 0,
      lastProgressStep: 0,
      stuck: false,
      stuckWhy: null,
      revisions: 0,
      restartAfterAction: false,
      lastSaidAt: 0,
      saidTexts: [],
      lastAnnounceAt: 0,
      stuckAnnounced: false,
      history: [],
      lastPlan: null,
      summaryText: null,
      startingItems: 0,
      collected: 0,
      plan: null,
      placed: 0,
      doorPlaced: false
    }
    // Grand livre des dons : restaure les preuves persistees (jamais de retoss
    // auto du meme engagement). Entrees malformees ignorees, valides conservees
    // sous le nouveau scope ; l incertain restaure bloque comme l original.
    try {
      const scope = mission.objectiveId ?? mission.id
      const kept = Array.isArray(desc.livraison) ? desc.livraison : []
      for (const e of kept) {
        if (!e || typeof e !== 'object') continue
        const dest = String(e.destinataire ?? '')
        const item = String(e.objet ?? '')
        if (!/^[A-Za-z0-9_]{3,16}$/.test(dest) || !/^[a-z0-9_]+$/.test(item)) continue
        const num = (v) => Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0
        const ceiling = (e.plafond === null || e.plafond === undefined)
          ? null
          : (Number.isInteger(e.plafond) && e.plafond >= 1 ? e.plafond : null)
        const proven = num(e.prouve)
        const removed = Math.max(num(e.retire), proven)
        const k = deliveryLedgerKey(scope, dest, item)
        deliveryLedgers.set(k, {
          key: k,
          scope,
          recipient: dest,
          item,
          ceiling,
          attempted: num(e.tente),
          removed,
          proven,
          uncertain: Math.max(0, removed - proven),
          invocations: Array.isArray(e.invocations) ? e.invocations.map(String).slice(0, 64) : [],
          done: ceiling !== null && proven >= ceiling,
          cancelled: e.annule === true
        })
      }
    } catch (_) { /* restauration best-effort : l engagement reste decrit */ }
    mission.landmarkResource = skills.LANDMARKS[mission.landmark]?.resource ?? null
    if (desc.origine && Number.isFinite(desc.origine.x)) {
      mission.originFixed = { ...desc.origine }
    } else {
      try {
        const p = host.getBot()?.entity?.position
        if (p) mission.originFixed = { x: Number(p.x.toFixed(2)), y: Number(p.y.toFixed(2)), z: Number(p.z.toFixed(2)) }
      } catch (_) {}
    }
    try { mission.startingItems = countResourceItems() } catch (_) { mission.startingItems = 0 }
    const current = mission
    mission.activity = activity.createActivityReporter({ say: host.chat,
      isActive: () => mission === current && current.state === 'running' })
    mission.activity.update('preparing', 'Reprise après redémarrage.')
    if (mission.movementTask) mission.movementTask.clearance = mission.clearance
    // R25 : apres restart, contexte vierge scope par l objectif durable (meme
    // cle qu avant le restart : objectiveId). Pas de vidage : le contexte est
    // neuf, et un reset ecraserait une reprise concurrente en vol.
    try { mission.memoryScope = memory.setActiveScope(mission.objectiveId ?? mission.id) } catch (_) {}
    try { physicalExecutor?.resume?.() } catch (_) {}
    loopPromise = (mission.movementTask ? runMovementMission(mission) : loop()).catch(err => {
      console.error('[mission] boucle interrompue :', err.message)
      finish('failed', `erreur interne : ${err.message}`)
    })
    try { host.chat(`Mission reprise : ${mission.objective} (progression conservee, monde reobserve)`) } catch (_) {}
    return { ok: true, mission: status() }
  }

  let dernierEtatArbre = { mission: null, etat: null }
  function etatArbreSur () {
    try {
      dernierEtatArbre = { mission, etat: treeStatus() }
    } catch (_) {
      if (dernierEtatArbre.mission !== mission) dernierEtatArbre = { mission, etat: null }
    }
    return dernierEtatArbre.etat
  }
  function status () {
    if (preparation && !isRunning()) return { id: preparation.id, etat: 'preparing',
      objectif: preparation.objective, demandeur: preparation.requester, etapes: 0,
      activite: preparation.reporter.snapshot() }
    // Attente explicite : aucun objet vivant mais des engagements suspendus
    // (jamais null silencieux quand quelque chose attend).
    if (!mission) {
      if (suspended.length === 0) return null
      return { id: null, etat: 'en-attente', objectif: null, demandeur: null, etapes: 0, suspended: suspendedSummaries() }
    }

    const base = {
      id: mission.id,
      objectifId: mission.objectiveId ?? null,
      mode: mission.objectiveMode ?? 'temporary',
      maintenance: mission.maintenance ?? null,
      rehydrated: mission.rehydrated ?? false,
      suspended: suspendedSummaries(),
      activite: mission.activity?.snapshot() ?? null,
      revision: mission.revision,
      parcours: mission.movementTask,
      precisions: mission.instructions,
      autorisations: { degagement: { limite: mission.clearance.limit, consomme: mission.clearance.used } },
      objectif: mission.objective,
      demandeur: mission.requester,
      type: mission.kind,
      matiere: mission.resource,
      confiance_matiere: mission.resourceConfidence,
      repere: mission.landmark,
      porte_demandee: mission.wantsDoor,
      dimensions: `${mission.dimensions.width}x${mission.dimensions.depth}x${mission.dimensions.height}`,
      etat: mission.state,
      approvisionnement: mission.supply,
      debut: mission.startedAtIso,
      fin: mission.endedAt,
      raison: mission.reason,
      etapes: mission.steps,
      blocs_casses: mission.broken,
      objets_recoltes: collected(),
      dirt_secondaire: mission.dirtSecondaire ?? 0,
      feuilles_degagees: mission.leavesCleared ?? 0,
      // Moteur d acces unique (A/B acces_unifie) : appels, cibles atteintes,
      // blocs poses et casses en route.
      acces: mission.acces ?? null,
      // Reparations par le code (A/B reparer) : nombre et codes.
      reparations: mission.reparations ?? null,
      // Reconnexion : sans monde avant le spawn, la derniere mesure vaut.
      arbre_entier: mission.wholeTree ? (etatArbreSur() ?? { commence: false }) : null,
      echafaudage_laisse: mission.echafaudageLaisse ?? 0,
      // Grand livre des dons (S6) : tente/retire/prouve/incertain par engagement.
      livraison: deliveryLedgersFor(mission).map(deliveryLedgerView),
      fabrication_cible: mission.fabricationCible ?? null,
      fabrication_quantite: mission.fabricationCible ? (mission.fabricationQuantite ?? 1) : null,
      fabrication_produits: mission.fabricationCible ? fabricationProduced() : 0,
      memoire: memory.snapshot(),
      dernier_plan: mission.lastPlan,
      historique: mission.history.slice(-5),
      resume: mission.summaryText,
      // Preuve de chevauchement : appels anticipes lances pendant l execution,
      // consommes sans attendre, annules sur echec/stop/fin, et appel en vol.
      appel_anticipe: {
        lances: mission.prefetchLances,
        consommes: mission.prefetchConsommes,
        annules: mission.prefetchAnnules,
        en_vol: Boolean(mission.prefetch)
      },
      blocage: { detecte: mission.stuck, raison: mission.stuckWhy },
      // Indicateurs suivis d un banc a l autre (demande du proprietaire) : part
      // d actions en echec et blocages annonces (cause, derniers resultats).
      etapes_en_echec: mission.echecs ?? 0,
      echecs_au_modele: mission.echecsAuModele ?? 0,
      attente_modele_ms: (mission.briefMs ?? 0) + (mission.attenteModeleMs ?? 0),
      brief_ms: mission.briefMs ?? null,
      echecs_detail: mission.echecsDetail ?? [],
      blocages: mission.blocages ?? []
    }

    if (mission.kind === 'construction') {
      const progress = buildProgress()
      base.chantier = {
        emplacement: mission.plan
          ? `${mission.plan.origin.x} ${mission.plan.origin.y} ${mission.plan.origin.z}`
          : null,
        materiau: mission.buildBlock,
        blocs_prevus: progress.total,
        blocs_poses: progress.done,
        porte_posee: doorPlaced()
      }
    }

    return base
  }

  return {
    start,
    cancelPendingStart,
    pauseWork,
    resumeWork,
    suspend,
    resumeSuspended,
    rehydrate,
    isPaused,
    getStepOwner,
    getStepToken,
    revise: (objective, requester, opts = {}) => start(objective, requester, { ...opts,
      revisionOf: mission && ['running', 'failed', 'paused'].includes(mission.state) ? mission : null }),
    addContext: (message, username, permissions = {}) => {
      if (!isRunning()) return false
      if (typeof username !== 'string') throw new TypeError('precision refusee : auteur attendu (chaine)')
      const instructions = cloneContext([...mission.instructions.slice(-7), { de: username, message: String(message).slice(0, 300) }])
      // Commit the descriptor too: the first action may still be in flight.
      // A failed or stale write must not change RAM, permissions or queued work.
      if (injectedObjectives) {
        if (typeof injectedObjectives.recordProgress !== 'function' || !currentObjectiveId()) {
          throw new Error('precision refusee : objectif durable indisponible')
        }
        injectedObjectives.recordProgress(progressSnapshot(instructions))
      }
      mission.instructions = instructions
      if ([0, 1].includes(permissions.clearanceBlocks)) mission.clearance.limit = permissions.clearanceBlocks
      mission.planRevision++
      mission.queue = []
      abortPrefetch('nouvelle precision')
      return true
    },
    stop,
    status,
    // Instantanes du monde pris aux derniers blocages (3 au plus).
    instantanes: () => mission?.instantanes ?? [],
    // Trace structuree de la mission courante (ou derniere) et son resume.
    trace: () => {
      const tr = traceDe(mission)
      return tr ? { mission: mission.id, evenements: tr.evenements(), perdus: tr.perdus(), resume: tr.resume() } : null
    },
    isRunning,
    SUPPLY,
    ACTION_NAMES: Object.keys(ACTIONS),
    setFeatures,
    featureOn
  }
}

module.exports = { createMissionRunner, sondeAlentours, capDepuisVecteur, choisirCoteContournement, fabTargetName, countFabricationItems, fabricationWanted, resolveFabricationCible, fabricationUtile }
