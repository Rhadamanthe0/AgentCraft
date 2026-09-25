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
// mesure ou lu ici. Jev reste un repli quand aucun planificateur JSON n est
// configure.

const skills = require('./skills')
const build = require('./build')
const craft = require('./craft')
const delivery = require('./delivery')
const Vec3 = require('vec3').Vec3
const jev = require('./jev')
const planner = require('./planner')
const memory = require('./memory')
const repair = require('./repair')
const screenshot = require('./screenshot')
const { blockInReach, clearSegment, itemInPickupRange } = require('./navigation')

// Qui decide. Deux planificateurs, la meme boucle :
//   - planner : un modele local (Qwen via Ollama) ou distant qui rend un plan
//     JSON de plusieurs etapes par appel. C est le defaut des qu il est
//     configure, et c est ce qui fait chuter la latence par action.
//   - jev     : une question typee par action, le chemin d origine, garde comme
//     repli quand aucun planificateur JSON n est configure.
function brain () {
  return planner.isEnabled() ? planner : jev
}

// Pause entre deux etapes **deja planifiees** : il n y a pas d appel reseau a
// amortir, seulement le temps que le jeu prenne en compte l etape precedente.
// C est la moitie du gain de latence, l autre etant l appel economise.
const QUEUE_TICK_MS = Number(process.env.MISSION_QUEUE_TICK_MS || 250)

// Delai minimal entre deux phrases du bot dans le chat. Sans lui, le modele
// boucle sur « dire -> attendre » et inonde le chat.
const DIRE_COOLDOWN_MS = Number(process.env.MISSION_DIRE_COOLDOWN_MS || 20000)

// Delai minimal entre deux messages SYSTEME du bot (impasse, apprentissage d une
// action). Ils ne passent pas par l action `dire`, donc echappent a sa limite de
// repetition ; ce delai court les empeche de spammer a eux seuls.
const ANNOUNCE_COOLDOWN_MS = Number(process.env.MISSION_ANNOUNCE_COOLDOWN_MS || 5000)

// Un chantier est approvisionne d une seule facon : le bot casse, ramasse et
// fabrique ce qu il pose.
//
// Il y avait ici un mode 'creative' ou la main se remplissait toute seule par
// `creative.setInventorySlot()` : la maison ne coutait alors aucune ressource.
// Supprime avec le reste des pouvoirs d administration, a la demande du
// proprietaire. Le bot joue avec ce qu il a ramasse, ou il echoue.
const SUPPLY = 'harvest'

const TICK_MS = Number(process.env.MISSION_TICK_MS || 1200)
const MAX_STEPS = Number(process.env.MISSION_MAX_STEPS || 60)
// Un geste ne se mesure pas en quantite : il doit se conclure vite. Sans cette
// borne, un modele qui n ose jamais dire « fini » boucle sur regarder_autour.
const GESTE_MAX_STEPS = Number(process.env.MISSION_GESTE_MAX_STEPS || 10)
// Un geste dont le plan echoue replanifie au lieu de conclure sur un echec
// (voir la boucle). Plafond : le plan initial plus ce nombre de replanifications,
// pour qu un geste irrealisable rende quand meme la main.
const GESTE_MAX_PLANS = Number(process.env.MISSION_GESTE_MAX_PLANS || 3)
const MAX_DURATION_MS = Number(process.env.MISSION_MAX_DURATION_MS || 600000)
const SEARCH_RADIUS = Number(process.env.MISSION_SEARCH_RADIUS || 32)
const STEP_TIMEOUT_MS = Number(process.env.MISSION_STEP_TIMEOUT_MS || 20000)
// Quantite visee quand l objectif n en precise aucune ("ramasse de l herbe").
const DEFAULT_QUOTA = Number(process.env.MISSION_DEFAULT_QUOTA || 16)

// Mini-carte PNG jointe au planificateur (voir screenshot.js). DESACTIVEE par
// defaut : sans MISSION_SCREENSHOT=1, aucun pixel n est genere et l etat envoye
// est strictement celui d avant. Une seule capture toutes N etapes : l image
// coute des jetons d entree et un peu de latence, donc on ne la paie pas a
// chaque tour. `RAYON` est la demi-cote de la carte, en blocs.
const SCREENSHOT_ON = process.env.MISSION_SCREENSHOT === '1'
const SCREENSHOT_EVERY = Math.max(1, Number(process.env.MISSION_SCREENSHOT_EVERY || 5))
const SCREENSHOT_RAYON = Math.max(1, Number(process.env.MISSION_SCREENSHOT_RAYON || 16))
// Portee de casse cote serveur : ~4.5 blocs. On garde une marge.
const REACH = 4
// Degagement de feuilles vers un tronc enferme (mission bois) : feuilles
// cassees au plus par appel a `avancer`, hors quota, seulement dans le couloir
// a hauteur du corps entre le bot et la buche visee, et seulement apres un
// no_path vers cette buche. Aucune autre feuille n est touchee.
const LEAF_CLEAR_MAX = Number(process.env.MISSION_LEAF_CLEAR_MAX || 12)
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
const MAX_DIG_DEPTH = Number(process.env.MISSION_MAX_DIG_DEPTH || 1)
// Hauteur maximale au-dessus des pieds ou le bot accepte de viser un bloc.
// Le haut d un tronc est hors de portee et le bot ne grimpe pas (le
// deplacement de mission est fait de gestes, pas de pathfinder) : sans cette
// borne, la navigation pointerait sans fin vers une buche a 5 blocs de haut
// au lieu de passer a l arbre suivant.
const MAX_REACH_UP = Number(process.env.MISSION_MAX_REACH_UP || 3)
const MAX_JEV_ERRORS = 3
const MAX_REPEATED_FAILURES = 5
// Pilier : bornes de la montee en blocs. Un pilier coute sa dirt (inventaire
// reel, jamais de creatif) et expose a la chute a la descente : 6 blocs
// suffisent a rendre cassable un tronc dont le pied est hors de portee.
const PILER_MIN = 1
const PILER_MAX = Number(process.env.MISSION_PILER_MAX || 6)
// Dirt de pilier : les blocs meubles du sol, cassables a la main et reposables
// sous les pieds. Meme motif que la matiere brute `terre`.
const PILER_DIRT = /^(dirt|coarse_dirt)$/

function scaffoldingStock (bot) {
  const totals = new Map()
  for (const item of bot?.inventory?.items?.() ?? []) {
    const plank = /_planks$/.test(item.name) && bot.registry?.blocksByName?.[item.name]?.boundingBox === 'block'
    if ((!PILER_DIRT.test(item.name) && !plank) || !Number.isFinite(item.count) || item.count <= 0) continue
    totals.set(item.name, (totals.get(item.name) ?? 0) + item.count)
  }
  const materiaux = [...totals].map(([nom, quantite]) => ({ nom, quantite }))
    .sort((a, b) => Number(PILER_DIRT.test(b.nom)) - Number(PILER_DIRT.test(a.nom)) || b.quantite - a.quantite || a.nom.localeCompare(b.nom))
  return { total: materiaux.reduce((sum, material) => sum + material.quantite, 0), materiaux }
}
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
function fabricationUtile (target, cible) {
  if (!target || !cible || target === cible) return true
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
function resolveFabricationCible (bot, raw) {
  const norm = fabTargetName(raw)
  if (!norm) return null
  if (craft.TARGETS[norm]) return norm
  const itemsByName = bot?.registry?.itemsByName
  if (itemsByName && itemsByName[norm]) return norm
  // Sans registre (jamais en prod), le format suffit : le make tranchera
  // (unknown/missing honnetes). En prod le registre existe toujours.
  if (!itemsByName && /^[a-z0-9_]+$/.test(norm)) return norm
  return null
}

// Detecteur de blocage : quand le bot n avance plus, `demander_aide` devient la
// seule action utile. Un seuil en etapes (et non en secondes) parce que tout ce
// qui compte ici est mesure par avancement : blocs casses, objets recoltes,
// blocs poses d un chantier.
const NO_PROGRESS_STEPS = Number(process.env.MISSION_NO_PROGRESS_STEPS || 8)

// Bornes des actions parametrees. L ampleur renvoyee par Jev (0 a 1) est
// interpolee entre ces valeurs.
const HARVEST_MIN = 2
const HARVEST_MAX = Number(process.env.MISSION_HARVEST_BURST_MAX || 16)
const HARVEST_BURST_MS = Number(process.env.MISSION_HARVEST_BURST_MS || 15000)
const PICKUP_MIN = 1
const PICKUP_MAX = 6
const EXPLORE_MAX = 40
const PLACE_MIN = 4
const PLACE_MAX = 40
const PLACE_BURST_MS = Number(process.env.MISSION_PLACE_BURST_MS || 25000)
// Garde-fou par bloc : une pose qui ne rend pas la main figerait toute la
// mission, puisque la borne de rafale n est relue qu entre deux blocs.
// 18 s et non 6 : `placeOne` inclut le ralliement au poste de tir, borne lui
// a 12 s par `BUILD_MOVE_TIMEOUT_MS`. Un cap sous le trajet prevu tuait les
// poses lointaines (« pose trop longue » a 13 blocs du chantier) alors que
// la marche fonctionnait. La borne de rafale reste le vrai garde-fou global.
const PLACE_ONE_TIMEOUT_MS = Number(process.env.MISSION_PLACE_ONE_TIMEOUT_MS || 18000)
const WAIT_MIN_MS = 1000
const WAIT_MAX_MS = 5000
const CRAFT_MIN = 1
const CRAFT_MAX = Number(process.env.MISSION_CRAFT_MAX || 16)

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
const JUMP_FIRST_MS = Number(process.env.MISSION_JUMP_FIRST_MS || 600)
const JUMP_RETRY_MS = Number(process.env.MISSION_JUMP_RETRY_MS || 700)
const JUMP_MAX_ATTEMPTS = Number(process.env.MISSION_JUMP_MAX_ATTEMPTS || 3)

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

// Sonde locale des 8 cases autour (N = -Z, S = +Z, E = +X, O = -X), a 1 bloc.
// Fonction pure (aucun acces au bot) : `lire(x, y, z)` rend un bloc
// `{ name, boundingBox }` ou null si le chunk n est pas charge. Chaque case est
// classee :
//   - `libre`    : sol praticable, tete degagee (une marche d 1 bloc compte
//                  comme libre : walkForward la franchit au saut auto) ;
//   - `obstacle` : mur ou relief >= 2 blocs (la tete est bouchee) ;
//   - `vide`     : trou (pas de sol) ou liquide (sol, pieds ou tete) ;
//   - `null`     : chunk non charge, inconnu.
// Jamais d exception : un lecteur manquant ou qui leve donne `null`.
const SONDE_DIRS = [
  ['N', 0, -1], ['NE', 1, -1], ['E', 1, 0], ['SE', 1, 1],
  ['S', 0, 1], ['SO', -1, 1], ['O', -1, 0], ['NO', -1, -1]
]

function estAir (nom) {
  return nom === 'air' || nom === 'cave_air' || nom === 'void_air'
}

function estLiquide (nom) {
  return typeof nom === 'string' && /water|lava|bubble_column/.test(nom)
}

function estSolide (bloc) {
  if (!bloc || !bloc.name) return false
  if (bloc.boundingBox === 'empty') return false
  if (bloc.boundingBox === 'block') return true
  if (estAir(bloc.name) || estLiquide(bloc.name)) return false
  return true
}

// Le bot peut-il sauter ? `entity.onGround` de mineflayer passe a FAUX quand le
// bot pousse dans un obstacle (mesure en jeu : contre une marche, onGround est
// faux alors que le bot est au sol et immobile). Le saut de denivele ne se
// declenchait donc jamais une fois bloque. On retombe sur le bloc solide sous
// les pieds, en excluant la montee (velocity.y > 0 = deja en l air). Meme regle
// que `standsOnGround` de build.js, pour ne pas diverger.
function peutSauter (bot) {
  try {
    if (bot.entity.onGround) return true
    const p = bot.entity.position
    const below = bot.blockAt(p.offset(0, -1, 0).floored())
    const vy = bot.entity.velocity?.y ?? 0
    return estSolide(below) && vy <= 0.02
  } catch (_) {
    return false
  }
}

// Fenetre de saut mesuree en jeu : un `forward`+`jump` lance a plus d un bloc
// du contact retombe avant la marche ; a 0,9 bloc ou moins, il passe. On sonde
// donc court (0,9 puis 0,6) pour ne declarer la marche que quand on est deja
// dans la fenetre. `sprint` etant plus tolerant (jusqu a ~1,9 bloc), il est
// tenu en plus pendant le saut.
const JUMP_LOOKAHEAD = [0.9, 0.6]

// Detecte ce qui barre le chemin DROIT DEVANT, a hauteur des pieds, dans la
// fenetre de saut. Rend :
//   - 'step' : marche d un bloc (bloc solide aux pieds, case au-dessus libre),
//              franchissable au saut preventif ;
//   - 'wall' : obstacle de deux blocs ou plus (la tete est bouchee), a
//              contourner, jamais a sauter droit ;
//   - null   : rien devant (ou chunk inconnu).
// La direction vient du regard (meme convention que choisirCoteContournement :
// vecteur avant = (-sin yaw, -cos yaw)). Aucune exception ne remonte.
function marcheDevant (bot) {
  try {
    if (!bot?.entity || typeof bot.blockAt !== 'function') return null
    const p = bot.entity.position
    const fx = -Math.sin(bot.entity.yaw)
    const fz = -Math.cos(bot.entity.yaw)
    for (const d of JUMP_LOOKAHEAD) {
      const pieds = bot.blockAt(p.offset(fx * d, 0, fz * d).floored())
      const tete = bot.blockAt(p.offset(fx * d, 1, fz * d).floored())
      if (!pieds || !tete) continue
      if (!estSolide(pieds)) continue
      return estSolide(tete) ? 'wall' : 'step'
    }
    return null
  } catch (_) {
    return null
  }
}

function sondeAlentours (lire, baseX, piedsY, baseZ) {
  const relief = {}
  try {
    if (typeof lire !== 'function' || !Number.isFinite(baseX) || !Number.isFinite(piedsY) || !Number.isFinite(baseZ)) {
      return null
    }
    for (const [nom, dx, dz] of SONDE_DIRS) {
      let sol = null
      let pieds = null
      let tete = null
      try {
        sol = lire(baseX + dx, piedsY - 1, baseZ + dz)
        pieds = lire(baseX + dx, piedsY, baseZ + dz)
        tete = lire(baseX + dx, piedsY + 1, baseZ + dz)
      } catch (_) {
        relief[nom] = null
        continue
      }
      if (!sol || !pieds || !tete) {
        relief[nom] = null
        continue
      }
      if (estLiquide(sol.name) || estLiquide(pieds.name) || estLiquide(tete.name)) {
        relief[nom] = 'vide'
      } else if (!estSolide(sol)) {
        relief[nom] = 'vide'
      } else if (estSolide(tete)) {
        relief[nom] = 'obstacle'
      } else {
        relief[nom] = 'libre'
      }
    }
    return relief
  } catch (_) {
    return null
  }
}

// Cap cardinal (8 vents, 0 deg = nord) pour un vecteur (dx, dz) en blocs.
// Convention Minecraft : nord = -Z, sud = +Z, est = +X, ouest = -X.
function capDepuisVecteur (dx, dz) {
  const deg = (Math.atan2(dx, -dz) * 180) / Math.PI
  const norm = ((deg + 360) % 360 + 360) % 360
  const caps = ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ouest', 'ouest', 'nord-ouest']
  return caps[Math.round(norm / 45) % 8]
}

// Traduit un cap lisible (`capDepuisVecteur`) en cle de la sonde 8 cases
// (SONDE_DIRS) : le relief local est indexe N, NE, E, SE, S, SO, O, NO.
const CASE_PAR_CAP = {
  nord: 'N',
  'nord-est': 'NE',
  est: 'E',
  'sud-est': 'SE',
  sud: 'S',
  'sud-ouest': 'SO',
  ouest: 'O',
  'nord-ouest': 'NO'
}

// Decides ou strafer pour contourner un obstacle, a partir du regard et du
// relief local. FONCTION PURE : ni acces au bot, ni horloge, ni etat global.
//
// Entrees :
//   - `yaw`    : orientation du bot en radians (bot.entity.yaw ; 0 = nord,
//                +90 deg = ouest, comme `capDepuisVecteur`) ;
//   - `cible`  : vecteur horizontal { dx, dz } du bot vers la cible, ou null ;
//   - `relief` : les 8 cases de `sondeAlentours` ('libre' | 'obstacle' |
//                'vide' | null), ou null si indisponible.
// Sortie : 'left' | 'right' | null. `null` = pas de choix fonde (relief
// illisible, aucun cote libre, ou les deux libres a egalite) : l appelant
// garde alors son alternance de repli.
//
// Le cote gauche/droite, relatif au regard, est traduit en case cardinale via
// le yaw, puis lu dans le relief. Vecteur avant du bot : (-sin yaw, -cos yaw).
// Lateral gauche = (-cos yaw, sin yaw), lateral droit = son oppose.
function choisirCoteContournement (yaw, cible, relief) {
  try {
    if (!relief || typeof relief !== 'object' || !Number.isFinite(yaw)) return null

    const fx = -Math.sin(yaw)
    const fz = -Math.cos(yaw)
    const gauche = { x: fz, z: -fx }
    const droite = { x: -fz, z: fx }

    const libreGauche = relief[CASE_PAR_CAP[capDepuisVecteur(gauche.x, gauche.z)]] === 'libre'
    const libreDroite = relief[CASE_PAR_CAP[capDepuisVecteur(droite.x, droite.z)]] === 'libre'

    if (!libreGauche && !libreDroite) return null
    if (libreGauche && !libreDroite) return 'left'
    if (libreDroite && !libreGauche) return 'right'

    // Les deux cotes sont libres : celui qui rapproche de la cible. Le bot
    // etant souvent deja pivote vers elle, les deux projections sont egales
    // (produit scalaire nul) : on rend null pour laisser l alternance jouer.
    if (cible && Number.isFinite(cible.dx) && Number.isFinite(cible.dz) &&
        (cible.dx !== 0 || cible.dz !== 0)) {
      const versGauche = gauche.x * cible.dx + gauche.z * cible.dz
      const versDroite = droite.x * cible.dx + droite.z * cible.dz
      if (versGauche > versDroite) return 'left'
      if (versDroite > versGauche) return 'right'
    }
    return null
  } catch (_) {
    return null
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const movementTask = require('./movement-task')
const activity = require('./activity')

// Borne une promesse qui pourrait ne jamais se resoudre. La promesse continue
// sa vie en arriere-plan, mais l appelant reprend la main.
function withTimeout (promise, ms, label) {
  let timer = null
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms)
    })
  ])
}

// Traduit l ampleur 0..1 de Jev dans l unite de l action.
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
      termine: l.done
    }
  }
  // Plafond d engagement : la demande chiffree du texte courant, lue par le
  // code (meme expression que mission.quota), jamais inventee. null = budget
  // indeterminable (clarification au lieu de sur-don).
  function deliveryCeiling (m) {
    try {
      const q = build.parseQuota(String(m?.objective ?? ''),
        { allowBlockUnits: m?.kind === 'recolte' && !m?.fabricationCible })
      return Number.isInteger(q) && q >= 1 ? q : null
    } catch (_) {
      return null
    }
  }
  function deliveryProvenFor (m) {
    let n = 0
    for (const l of deliveryLedgersFor(m)) n += l.proven
    return n
  }
  // Premier blocage don a servir dans l etat (l incertain prime : il interdit
  // tout nouvel essai du meme engagement).
  function deliveryBlockReason (m) {
    for (const l of deliveryLedgersFor(m)) {
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
        kind: mission.kind,
        resource: mission.resource,
        landmark: mission.landmark,
        quota: mission.quota,
        fabricationCible: mission.fabricationCible ?? null,
        fabricationQuantite: mission.fabricationQuantite ?? null,
        fabricationInitial: mission.fabricationInitial ?? 0,
        // Grand livre des dons (S6) : preuves persistantes pour rehydrate.
        livraison: deliveryLedgersFor(mission).map(deliveryLedgerView),
        dimensions: mission.dimensions ? { ...mission.dimensions } : null,
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
  // Mesures : tout ce que Jev recoit comme etat est calcule ici
  // -------------------------------------------------------------------------

  function blockIdsFor (resource) {
    const bot = host.getBot()
    if (!bot?.registry || !resource) return []

    const names = skills.RESOURCES[resource]?.blocks ?? []
    const ids = []
    for (const name of names) {
      const block = bot.registry.blocksByName[name]
      if (block) ids.push(block.id)
    }
    return ids
  }

  function targetBlockIds () {
    return mission ? blockIdsFor(mission.resource) : []
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
    if (mission?.resource !== 'bois' || !bot?.entity) return false
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
  const CLIMB_MAX = Number(process.env.MISSION_CLIMB_MAX || 12)
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
      let pile = await ACTIONS.piler(null, { hauteur: 1 })
      if (pile?.echec && /atterrissage/.test(pile.resultat || '')) {
        await sleep(400)
        pile = await ACTIONS.piler(null, { hauteur: 1 })
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

  // Monte d une hauteur H vers une cible posee sur un relief plus haut :
  // obtient H blocs de terre dans le relief voisin (jamais sous les pieds),
  // pile de H, puis laisse l approche normale finir a pied. Rend un resume ou
  // null si ce n est pas le cas (cible pas plus haute, pas assez de terre).
  async function climbToward (cible) {
    const bot = host.getBot()
    if (!bot?.entity || !cible) return null
    const feetY = Math.floor(bot.entity.position.y + 0.01)
    const pied = standingLevel(cible)
    const hauteur = pied - feetY
    if (hauteur < 2 || hauteur > PILER_MAX) return null
    // Seulement pour un arbre pose sur un relief : sous son pied, un vrai sol.
    // Une buche restee en l air (tronc coupe par le bas) n est pas une falaise
    // (vu sur trees/pillar : pilier de 5 construit sous elle, chute, degats).
    const sol = bot.blockAt(new Vec3(cible.position.x, pied - 1, cible.position.z))
    if (!sol || sol.boundingBox !== 'block' || /_leaves$|_log$|_wood$/.test(sol.name)) return null
    const creuses = await gatherDirt(hauteur)
    if (scaffoldingStock(bot).total < hauteur) return null
    const pile = await ACTIONS.piler(null, { hauteur })
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

    let positions
    try {
      positions = bot.findBlocks({ matching: ids, maxDistance: SEARCH_RADIUS, count: 32 })
    } catch (err) {
      return null
    }

    const here = bot.entity.position
    const feetY = Math.floor(here.y)
    // anyHeight : pour SE DEPLACER vers la matiere (fond de trou, haut de
    // falaise), pas pour la casser d ici. Les bornes verticales ci-dessous
    // restent celles de `casser`.
    const anyHeight = opts.anyHeight === true

    const candidates = []
    for (const position of positions) {
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

      const block = bot.blockAt(position)
      if (!block) continue

      candidates.push({
        block,
        interactable: blockInReach(bot, here, position.offset(0.5, 0.5, 0.5), REACH),
        // Distance 3D centre a centre : celle que le serveur applique a la casse.
        reach: here.distanceTo(position.offset(0.5, 0.5, 0.5))
      })
    }

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
    if (!mission || mission.resource !== 'bois') return null
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
    if (!mission || mission.resource !== 'bois') return false
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
    if (!mission || mission.resource !== 'bois') return false
    if (!bot?.inventory) return false
    if (!cibleHaute) return false
    return scaffoldingStock(bot).total < PILER_MAX
  }

  // Arbre demande : buches encore en place et buches tombees non ramassees.
  // null tant qu aucune buche n a ete coupee (arbre pas encore choisi).
  function treeStatus () {
    const bot = host.getBot()
    const t = mission?.tree
    if (!mission?.wholeTree || !t || !bot?.entity) return null
    let standing = 0
    for (let dx = -TREE_RADIUS; dx <= TREE_RADIUS; dx += 1) {
      for (let dz = -TREE_RADIUS; dz <= TREE_RADIUS; dz += 1) {
        for (let dy = -1; dy <= TREE_HEIGHT; dy += 1) {
          const block = bot.blockAt(new Vec3(t.x + dx, t.y + dy, t.z + dz))
          if (block && TREE_LOG.test(block.name)) standing += 1
        }
      }
    }
    const anchor = new Vec3(t.x + 0.5, t.y, t.z + 0.5)
    const onGround = Object.values(bot.entities ?? {})
      .filter(e => e && e.name === 'item' && e.position &&
        e.position.distanceTo(anchor) <= TREE_RADIUS + TREE_HEIGHT)
      .reduce((sum, e) => {
        let item = null
        try { item = e.getDroppedItem?.() } catch (_) {}
        return sum + (item && TREE_LOG.test(item.name) ? item.count : 0)
      }, 0)
    return { buches_restantes: standing, buches_au_sol: onGround, termine: standing === 0 && onGround === 0 }
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

  // L inventaire est la verite terrain : on compte ce qui y est entre depuis le
  // debut de la mission plutot que de faire confiance aux evenements de ramassage.
  function countResourceItems () {
    const bot = host.getBot()
    const pattern = mission && skills.RESOURCES[mission.resource]?.items
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

  // Avancement du chantier, relu dans le monde plutot que compte a l aveugle :
  // un bloc pose puis casse doit redevenir « a faire ».
  function buildProgress () {
    if (!mission?.plan) return { total: 0, done: 0, left: 0 }

    const bot = host.getBot()
    const total = mission.plan.blocks.length
    if (!bot) return { total, done: mission.placed, left: total - mission.placed }

    let done = 0
    for (const entry of mission.plan.blocks) {
      const block = bot.blockAt(entry.position)
      // Le motif, pas le nom exact : en survie l essence du bois depend de
      // l arbre coupe, et un mur en `birch_planks` est aussi fini qu un mur en
      // `oak_planks`.
      if (block && mission.buildMatch.test(block.name)) done += 1
    }

    mission.placed = done
    return { total, done, left: total - done }
  }

  function doorPlaced () {
    if (!mission?.plan) return false

    const bot = host.getBot()
    if (!bot) return mission.doorPlaced

    const block = bot.blockAt(mission.plan.door.position)
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

  // Ce que Jev voit de l inventaire. Sans ces champs il ne pourrait pas choisir
  // « fabriquer » au bon moment : rien dans l etat ne dirait qu il y a des
  // buches mais pas encore de planches.
  function stocks () {
    const bot = host.getBot()
    if (!bot?.inventory || !mission) return null

    const snapshot = craft.snapshot(bot)
    const material = buildItem()
    const raw = skills.RESOURCES[mission.resource]?.raw

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

    let positions
    try {
      positions = bot.findBlocks({ matching: ids, maxDistance: SEARCH_RADIUS, count: 32 })
    } catch (_) {
      return null
    }

    const here = bot.entity.position
    const feetY = Math.floor(here.y)
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
    return {
      cible: best.block.name,
      denivele: best.dy,
      distance: Number(best.horizontal.toFixed(1))
    }
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
      if (!mission || mission.resource !== 'bois') return ''
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

  function buildState () {
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
          raison: mission.pendingJoin ? 'demandeur non rejoint' : detectStuck().raison,
          reparations_restantes: 0,
          reparateur_disponible: repair.isEnabled()
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
        dimensions: `${dims.width} x ${dims.depth} x ${dims.height}`,
        fabrication_cible: mission.fabricationCible ?? null,
        fabrication_quantite: mission.fabricationCible ? (mission.fabricationQuantite ?? 1) : null
      },
      quota_par_defaut: DEFAULT_QUOTA,
      // La quantite reellement visee (lue dans la consigne, sinon le defaut).
      // Le modele la lit ; c est `finishAllowed` qui s en sert pour juger.
      quota_vise: mission.wholeTree ? null : mission.quota,
      // Un arbre entier demande : le code compte ses buches, le modele decide.
      arbre_demande: mission.wholeTree
        ? (treeStatus() ?? { commence: false, consigne: 'coupe une premiere buche : elle fixe l arbre' })
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
      }
    }

    // Le progres est reevalue a chaque tour : c est lui qui dit si le bot
    // avance, et donc si `demander_aide` a un sens.
    const fingerprint = progressFingerprint()
    if (fingerprint > mission.lastProgress) {
      mission.lastProgress = fingerprint
      mission.lastProgressStep = mission.steps
    }

    const stuck = detectStuck()
    mission.stuck = stuck.detecte
    mission.stuckWhy = stuck.raison

    // Ce que le modele voit du blocage. Sans ces trois champs il ne peut pas
    // decider d appeler `demander_aide` au bon moment — et le code refuserait
    // l appel de toute facon si `detecte` etait faux.
    state.blocage = {
      detecte: stuck.detecte,
      raison: stuck.raison,
      reparations_restantes: Math.max(0, repair.MAX_PER_MISSION - mission.repairs),
      reparateur_disponible: repair.isEnabled()
    }

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

  // Applique une operation rendue par l aide distante sur la DOCUMENTATION des
  // actions (voir skills.documentAction). Le code reste seul juge : une action
  // inconnue, un texte hors bornes ou une operation mal formee est refusee ici,
  // apres l avoir deja ete dans repair.js. Rien de ce qui vient du reseau ne
  // peut ajouter une action executable — seule la documentation change.
  function applyDocOperation (operation) {
    const op = String(operation?.op ?? '').toLowerCase()

    if (op === 'documenter') {
      const result = skills.documentAction(operation.action, {
        quand: operation.quand ?? null,
        exemples: operation.exemples ?? []
      })
      return result.ok
        ? { ok: true, texte: `documentation de "${result.doc.action}" mise a jour` }
        : { ok: false, texte: `documentation refusee (${result.error})` }
    }

    if (op === 'oublier' || op === 'supprimer') {
      const result = skills.forgetActionDoc(operation.action)
      return result.ok
        ? { ok: true, texte: `documentation ajoutee de "${operation.action}" retiree` }
        : { ok: false, texte: `suppression refusee (${result.error})` }
    }

    if (op === 'fusionner') {
      const result = skills.mergeActionDocs(operation.source, operation.cible)
      return result.ok
        ? { ok: true, texte: `documentation de "${operation.source}" fusionnee dans "${operation.cible}"` }
        : { ok: false, texte: `fusion refusee (${result.error})` }
    }

    return { ok: false, texte: `operation inconnue : ${op || '?'}` }
  }

  const ACTIONS = {
    // Il y avait ici `approcher`, qui deleguait au pathfinder (GoalNearXZ). Le
    // pathfinder est casse au-dela de quelques blocs sur cette version (arret a
    // distance en annoncant success, ou timeout) : le deplacement de mission est
    // desormais compose par le planificateur avec les gestes unitaires
    // `regarder`/`pivoter` + `avancer`, guides par l indice de navigation
    // (environnement.navigation) mesure dans buildState().

    // Meme navigateur que !viens : A* pour le chemin, execution locale verifiee.
    // Le modele choisit la destination, jamais les touches du trajet.
    async rejoindre_demandeur () {
      mission.pendingJoin = true
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
      // Le planificateur dit COMBIEN DE TEMPS casser. Le repli Jev ne sait
      // repondre qu en blocs (echelle 0-4) : on garde ce chemin pour lui.
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
      const secondaireAutorise = mission.resource === 'bois' &&
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
      const reach = bot.entity.position.distanceTo(first.position.offset(0.5, 0.5, 0.5))
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

      // On enchaine sans relacher : relacher entre chaque bloc pour redemander
      // son avis a Jev fait perdre du temps et donne en jeu l impression d un
      // bot qui tapote.
      while (!mission.cancelled && broken < budget && Date.now() - started < deadline) {
        const block = findBloc(secondaire)
        if (!block) break
        // Meme metrique que le premier bloc : centre a centre, portee serveur.
        // findTargetBlock rend le plus bas des blocs a portee ; s il n y en a
        // plus, on arrete la rafale au lieu de viser un bloc haut injoignable.
        if (bot.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5)) > REACH) break

        try {
          // L outil peut changer en cours de rafale (une touffe d herbe, puis
          // la terre en dessous). equipForBlock rend la main tout de suite si
          // le bon outil est deja en main.
          if (mission.supply === 'harvest') await craft.equipForBlock(bot, block)
          // Viser avant de creuser : le serveur refuse un bloc que le joueur ne
          // regarde pas, et l animation part quand meme cote client.
          //
          // Chaque operation est bornee : un `lookAt` ou un `dig` qui ne rend pas
          // la main figeait la mission entiere, car la deadline de rafale n est
          // relue qu entre deux blocs (voir piege 12).
          await withTimeout(
            bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true), 4000, 'visee trop longue')
          await withTimeout(bot.dig(block), 6000, 'creusage trop long')
        } catch (err) {
          refusal = err.message
          break
        }

        // Le serveur a le dernier mot : si le bloc est toujours la, le creusage
        // a ete refuse et compter une reussite masquerait la panne.
        const after = bot.blockAt(block.position)
        if (after && after.name === block.name) {
          refusal = `${block.name} toujours en place apres le creusage`
          break
        }

        broken += 1
        // Dirt secondaire : carburant de pilier, hors quota bois. Le bois seul
        // fait avancer `blocs_casses`/`unites_recoltees` (voir `finishAllowed`).
        if (secondaire) mission.dirtSecondaire = (mission.dirtSecondaire ?? 0) + 1
        else mission.broken += 1
        if (!secondaire && mission.wholeTree && !mission.tree) {
          mission.tree = { x: block.position.x, y: block.position.y, z: block.position.z }
        }
        await sleep(120)
      }

      if (broken === 0) {
        return { resultat: `casse impossible : ${refusal ?? 'aucun bloc a portee'}`, echec: true }
      }

      // Laisse les objets tomber et entrer dans l inventaire avant l etat suivant.
      await sleep(400)
      // Hors bois (dont le ramassage est deja pilote par l arbre) : l objet
      // casse a distance reste au sol ; le prendre aussitot (vu sur
      // gather/flowers : 4 fleurs cassees, 2 en inventaire, mission close).
      let ramasses = 0
      if (!secondaire && mission.resource !== 'bois') {
        const avant = countResourceItems()
        await collectScaffoldDrops(stepToken, { budgetMs: 8000, pattern: skills.RESOURCES[mission.resource]?.items })
        ramasses = Math.max(0, countResourceItems() - avant)
      }

      const ecoule = Math.round((Date.now() - started) / 100) / 10
      return {
        resultat: secondaire
          ? `${broken} bloc(s) de dirt secondaire casse(s) en ${ecoule} s (total dirt ${mission.dirtSecondaire})` +
            (dureeSec === null ? '' : ` sur ${dureeSec} s demandee`) +
            (refusal ? `, arret : ${refusal}` : '') + ' — quota bois inchange'
          : `${broken} bloc(s) casse(s) en ${ecoule} s (total ${mission.broken})` +
            (dureeSec === null ? '' : ` sur ${dureeSec} s demandee`) +
            (refusal ? `, arret : ${refusal}` : '') +
            (ramasses ? `, ${ramasses} objet(s) ramasse(s) aussitot` : '')
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
      const items = nearbyItems()
      if (items.length === 0) return { resultat: 'aucun objet au sol a proximite', echec: true }

      const before = countResourceItems()
      // Dirt secondaire (mission bois) : le carburant du pilier. `ramasser`
      // ne creditait que la matiere visee : une dirt cassee pour un pilier
      // puis ramasee rendait un faux echec (« rien de la matiere visee ») qui
      // vidait la file et apprenait au modele que la dirt ne se ramasse pas —
      // le pilier restait a sec malgre la dirt cassee. La dirt compte ici
      // comme un succes, sans jamais entrer dans le quota bois (collecte
      // et `countResourceItems` restent bois seul).
      const dirtVisee = mission?.resource === 'bois'
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
        // Objet deja « proche » mais pas ramasse : un pas droit dessus, sur sol
        // plat seulement (meme niveau, appui solide), jamais vers un vide.
        if (pasCourt) await stepOnto(item)
        // Meme navigateur que l approche de ressource, mais jusqu au rayon
        // de collecte. Pas de succes sans gain d inventaire plus bas.
        const walk = await host.navigateToPosition(item.position, {
          signal: mission.navigationAbort.signal, __owner: stepToken,
          radius: ITEM_AUTO_PICKUP, pickup: true, timeoutMs: 10000
        })
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

    // Le seul endroit ou une action lit un parametre autre que l ampleur : le
    // second etage de classification a repondu « quoi fabriquer », parmi les
    // recettes que craft.js a declarees faisables au moment de la question.
    async fabriquer (scale, params = {}) {
      const bot = host.getBot()
      // `objet` arrive en nom de cible (« batons »), mais le modele envoie
      // parfois un nom d objet (« stick ») : on traduit, jamais pris tel quel.
      const target = fabTargetName(params.objet)

      if (!target) {
        const possible = craft.options(bot).filter(o => o.possible).map(o => o.name)
        return {
          resultat: possible.length === 0
            ? 'rien de fabricable avec l inventaire actuel'
            : `aucune fabrication choisie (possibles : ${possible.join(', ')})`,
          echec: true
        }
      }

      const wanted = Number.isFinite(Number(params.quantite))
        ? Math.max(CRAFT_MIN, Math.min(CRAFT_MAX, Math.round(Number(params.quantite))))
        : scaled(scale, CRAFT_MIN, CRAFT_MAX)

      // Cible de fabrication fixee : seuls la cible et ses intermediaires
      // (planches, batons, etabli) sont utiles. Vu sur craft/axe : une pioche
      // fabriquee a la place de la hache, planches et batons consommes.
      if (mission.fabricationCible && !fabricationUtile(target, mission.fabricationCible)) {
        return {
          resultat: `${target} n est pas utile pour ${mission.fabricationCible} : fabrique ${mission.fabricationCible} ` +
            'ou ses ingredients (planches, batons, etabli), rien d autre',
          echec: true
        }
      }

      // Un etabli deja pose tout pres suffit : en refaire un pour une autre
      // cible gaspille 4 planches (vu sur craft/axe : deux etablis, plus de
      // planches pour la hache). Sauf si l etabli est lui-meme demande.
      if (target === 'etabli' && mission.fabricationCible && mission.fabricationCible !== 'etabli') {
        const tableId = bot.registry?.blocksByName?.crafting_table?.id
        const posee = tableId ? bot.findBlock({ matching: tableId, maxDistance: 6 }) : null
        if (posee) {
          return {
            resultat: `un etabli est deja pose a ${bot.entity.position.distanceTo(posee.position).toFixed(1)} bloc(s) : ` +
              `fabrique directement ${mission.fabricationCible}, l etabli pose sera utilise`,
            echec: true
          }
        }
      }

      try {
        const made = await craft.make(bot, target, wanted)
        // Succes vers la cible du brief : efface le manque signale.
        if (mission.fabricationCible && (target === mission.fabricationCible || made.item === mission.fabricationCible)) {
          mission.fabricationLastError = null
        }
        return {
          resultat: `${made.produced} ${made.item} fabrique(s) sur ${wanted} demande(s)` +
            (made.usedTable ? ' (a l etabli)' : '')
        }
      } catch (err) {
        // Manque de ressource : message generique du make (missing structuré),
        // sans recette hardcodee par phrase ; le pilote y lit quoi recolter.
        // Persiste pour finishAllowed (pourquoi du refus), borne 200 car.
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
      const ceiling = deliveryCeiling(mission)
      const key = deliveryLedgerKey(deliveryScope(mission), destinataire, objet)
      let ledger = deliveryLedgers.get(key)
      if (!ledger) {
        ledger = { key, scope: deliveryScope(mission), recipient: destinataire, item: objet,
          ceiling, attempted: 0, removed: 0, proven: 0, uncertain: 0, invocations: [], done: false }
        deliveryLedgers.set(key, ledger)
      } else {
        ledger.ceiling = ceiling
      }
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
          onActivity: (evt) => { try { mission.activity?.update('execution', evt?.text ?? 'Je depose les objets demandes.', true) } catch (_) {} }
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
      if (high) {
        const stock = scaffoldingStock(host.getBot()).total
        const dirt = craft.countOf(host.getBot(), PILER_DIRT)
        const next = stock > 0
          ? 'piler peut aider si l appui et l espace au-dessus sont libres ; la pose reste a verifier'
          : 'stock court : piler recupere lui-meme la terre manquante (pilier defait puis refait, terre prise a cote)'
        return {
          resultat: `cible haute ${high.cible} a ${high.distance} bloc(s), +${high.denivele} en hauteur, ` +
            `${stock} blocs d echafaudage (${dirt} dirt) en inventaire : ${next}. Avancer au sol ne resout pas ce denivele.`,
          echec: true,
          code: 'cible_haute'
        }
      }

      // Matiere plus bas ou plus haut que les bornes de casse : on la vise
      // quand meme pour s en approcher (en creusant au besoin, sans chute).
      if (!cible && mission.kind === 'recolte') cible = findTargetBlock(undefined, { anyHeight: true })

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
          if (!walk.blocked && walk.moved >= 0.5) continue
          if (parcouruLibre >= distance) break
          if (strafesLibres >= NAV_MAX_STRAFES) {
            return {
              resultat: `bloque apres ${parcouruLibre.toFixed(1)} bloc(s) sur ${distance} demande(s) : ` +
                'obstacle trop haut, contourne (appuyer left ou right + forward + jump) ' +
                'puis re-pivote vers la cible.' + conseilPilier(),
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
        if (parcouruLibre < 0.5) {
          return {
            resultat: `bloque apres ${parcouruLibre.toFixed(1)} bloc(s) sur ${distance} demande(s) : ` +
              'obstacle trop haut, contourne (appuyer left ou right + forward + jump) ' +
              'puis re-pivote vers la cible.' + conseilPilier(),
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
      const approach = () => host.navigateToPosition(cible.position.offset(0.5, 0.5, 0.5), {
        signal: mission.navigationAbort.signal, __owner: stepToken,
        interaction: true, allowHighApproach: true, distanceBudget: distance
      })
      let result = await approach()
      // Tronc enferme dans des feuilles : sans degagement, no_path en boucle et
      // aucune action ne pouvait ouvrir le passage. On casse seulement les
      // feuilles du couloir a hauteur du corps, puis on re-tente l approche.
      let feuilles = 0
      while (result.code === 'no_path' && mission.resource === 'bois' && !mission.cancelled &&
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
      if ((result.code === 'no_path' || result.code === 'needs_height') && mission.kind === 'recolte' && !mission.cancelled) {
        const climbed = await climbToward(cible)
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
      if (result.code === 'no_path' && mission.kind === 'recolte' && !mission.cancelled && gapToward(cible.position, { liquidOnly: true })) {
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
      if ((result.code === 'no_path' || farAbove) && !noye && mission.kind === 'recolte' && !mission.cancelled &&
        typeof host.digToward === 'function') {
        const dug = await host.digToward(cible.position.offset(0.5, 0.5, 0.5), {
          signal: mission.navigationAbort.signal
        })
        if (dug.reached) {
          mission.digPaths = (mission.digPaths ?? 0) + 1
          degage += ` (chemin creuse sur ${dug.travelled} bloc(s))`
          result = await approach()
          if (!result.reached && result.code !== 'advanced') {
            result = { reached: true, travelled: dug.travelled, code: 'dug' }
          }
        } else {
          degage += ` (chemin creuse impossible : ${dug.code})`
        }
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
      const hauteur = Number.isFinite(Number(params.hauteur))
        ? Math.max(PILER_MIN, Math.min(PILER_MAX, Math.round(Number(params.hauteur))))
        : scaled(scale, PILER_MIN, PILER_MAX)

      if (host.inLiquid()) {
        return { resultat: 'dans un liquide : sortir d abord, un pilier ne tient pas dans l eau', echec: true }
      }

      // Un pilier sous une cible deja cassable gaspille de la dirt : le dire au
      // lieu de monter pour rien.
      const cible = findTargetBlock()
      if (cible && blockInReach(bot, bot.entity.position, cible.position.offset(0.5, 0.5, 0.5), REACH)) {
        return { resultat: `${cible.name} deja a portee : casser directement, pas de pilier`, echec: true }
      }

      let available = scaffoldingStock(bot)
      // Stock court : aller chercher le manque soi-meme plutot que d echouer
      // en boucle (vu sur trees/tall : perche a +2 sans terre, aucune action
      // ne pouvait en obtenir depuis le haut). Defaire son propre pilier rend
      // ses blocs ; la hauteur visee reste la meme (pilier refait plus haut).
      let hauteurVisee = hauteur
      let recupere = ''
      if (available.total < hauteur && !mission.cancelled) {
        const yHaut = bot.entity.position.y
        const under = bot.blockAt(bot.entity.position.offset(0, -0.5, 0))
        if (under && isPillarBlock(bot, under)) {
          await descendScaffold(-Infinity, { pillarOnly: true })
          await collectScaffoldDrops(stepToken, { budgetMs: 15000 })
        }
        const redescendu = Math.max(0, Math.round(yHaut - host.getBot().entity.position.y))
        hauteurVisee = Math.min(PILER_MAX, hauteur + redescendu)
        if (scaffoldingStock(bot).total < hauteurVisee) {
          // Bornes de temps : vu sur chat/replace-and-join, bot tombe dans un
          // trou qu il venait de creuser et l action ne rendait plus la main.
          await gatherDirt(hauteurVisee, () => false, { sol: true, budgetMs: 25000 })
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

        const ancre = live.entity.position.floored()
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
        // (couronne d un arbre) se cassent au lieu d arreter la montee.
        for (const dy of [2, 1]) {
          const haut = live.blockAt(ancre.offset(0, dy, 0))
          if (!haut || !/_leaves$/.test(haut.name)) continue
          try {
            await withTimeout(live.lookAt(haut.position.offset(0.5, 0.5, 0.5), true), 4000, 'visee trop longue')
            await withTimeout(live.dig(haut), 6000, 'creusage trop long')
            mission.leavesCleared = (mission.leavesCleared ?? 0) + 1
          } catch (_) {}
        }
        const dessus1 = live.blockAt(ancre.offset(0, 1, 0))
        const dessus2 = live.blockAt(ancre.offset(0, 2, 0))
        if ((dessus1 && estSolide(dessus1)) || (dessus2 && estSolide(dessus2))) {
          failure = 'plafond au-dessus : impossible de monter ici'
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
            if (recheck?.name === stock.nom) {
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
        if (pose?.name !== stock.nom) {
          failure = `bloc non pose au niveau ${poses + 1} (case : ${pose?.name ?? 'inconnue'})`
          break
        }
        poses += 1
        const landed = live.entity?.onGround && Math.abs(live.entity.position.y - (ancre.y + 1)) <= 0.25 &&
          Math.floor(live.entity.position.x) === ancre.x && Math.floor(live.entity.position.z) === ancre.z
        if (!landed) {
          failure = 'atterrissage sur le bloc pose non prouve'
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
      return {
        resultat: `pilier de ${poses}/${hauteurVisee} bloc(s) (+${gain.toFixed(1)} blocs en hauteur)${recupere}` +
          (failure ? `, arret : ${failure}` : ', reobserver depuis le haut'),
        echec: poses !== hauteurVisee || Boolean(failure),
        code: poses === hauteurVisee && !failure ? 'pilier_pose' : 'pilier_partiel',
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
            resultat: `chantier deja commence (${progres.done}/${progres.total} poses) : construire la suite, pas de nouveau terrain`,
            echec: true
          }
        }
      }

      // Ou poser le chantier : aupres du repere demande, ou sur place.
      let near = bot.entity.position
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

      const site = build.findSite(bot, {
        near,
        width: dims.width,
        depth: dims.depth,
        height: dims.height
      })

      if (!site) {
        return { resultat: 'aucun terrain plat et degage aux alentours', echec: true }
      }

      mission.plan = build.planHouse({
        origin: site.origin,
        width: dims.width,
        depth: dims.depth,
        height: dims.height
      })
      mission.placed = 0

      const { x, y, z } = site.origin
      return {
        resultat: `chantier place en ${x} ${y} ${z} (${dims.width}x${dims.depth}x${dims.height}, ` +
          `${mission.plan.blocks.length} blocs, a ${site.distance} blocs du repere)`
      }
    },

    async construire (scale, params = {}) {
      if (!mission.plan) return { resultat: 'aucun emplacement choisi', echec: true }

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
      // ressort de toute la boucle : Jev enchaine alors « casser » puis
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
              move: async stand => (await host.navigateToPosition(stand, {
                signal: mission.navigationAbort.signal, __owner: stepToken, radius: 0.35, timeoutMs: 10000
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

    async poser_porte () {
      if (!mission.plan) return { resultat: 'aucun emplacement choisi', echec: true }
      if (doorPlaced()) return { resultat: 'la porte est deja posee' }

      const progress = buildProgress()
      if (progress.left > 0) {
        return { resultat: `il reste ${progress.left} bloc(s) a poser avant la porte`, echec: true }
      }

      // La porte doit avoir ete fabriquee : l essence est celle des planches
      // coupees, pas forcement du chene.
      const item = doorItem()
      if (!item) {
        return { resultat: 'aucune porte en inventaire, il faut en fabriquer une', echec: true }
      }

      try {
        await build.placeDoor(host.getBot(), mission.plan, item)
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

    async attendre (scale, params = {}) {
      const duration = Number.isFinite(Number(params.duree))
        ? Math.max(0.2, Math.min(WAIT_MAX_MS / 1000, Number(params.duree))) * 1000
        : scaled(scale, WAIT_MIN_MS, WAIT_MAX_MS)
      await sleep(duration)
      return { resultat: `attente de ${Math.round(duration / 100) / 10} s` }
    },

    async terminer () {
      return { resultat: 'fin demandee par le planificateur', fin: true }
    },

    // -----------------------------------------------------------------------
    // Gestes de bas niveau
    //
    // Elles ne savent rien de l objectif : elles rendent la main au
    // planificateur avec ce qui s est reellement passe (le bot a-t-il bouge ?
    // de combien ?), et c est lui qui en tire une conclusion au tour suivant.
    // -----------------------------------------------------------------------

    async dire (scale, params = {}) {
      const texte = String(params.texte ?? '').trim()
      if (!texte) return { resultat: 'aucun texte a dire', echec: true }

      // Le chat est aussi la facon dont on tape une commande serveur. Sans ce
      // garde-fou, `dire` serait un trou dans le retrait des pouvoirs
      // d administration : il suffirait au modele d ecrire "/gamemode creative"
      // pour recuperer ce qu on vient de lui enlever.
      if (texte.startsWith('/')) {
        return { resultat: 'les commandes serveur sont interdites au bot', echec: true }
      }

      // Le prompt demande de parler sobrement ; mesure en jeu, le modele s en
      // moque et boucle sur « dire -> attendre », une fois toutes les deux
      // secondes. Le code compte donc a sa place : jamais deux fois la meme
      // phrase dans une mission, et pas plus d une phrase par DIRE_COOLDOWN_MS.
      if (mission.saidTexts.includes(texte)) {
        return { resultat: 'deja dit, le bot ne se repete pas', echec: true }
      }
      if (Date.now() - mission.lastSaidAt < DIRE_COOLDOWN_MS) {
        const reste = Math.ceil((DIRE_COOLDOWN_MS - (Date.now() - mission.lastSaidAt)) / 1000)
        return { resultat: `trop tot pour reparler (encore ${reste} s)`, echec: true }
      }

      host.chat(texte)
      mission.lastSaidAt = Date.now()
      mission.saidTexts.push(texte)
      if (mission.saidTexts.length > 12) mission.saidTexts.shift()

      return { resultat: `dit dans le chat : "${texte}"` }
    },

    async regarder (scale, params = {}) {
      const bot = host.getBot()
      // Les angles arrivent deja bornes par planner.coerceParams ; on garde la
      // valeur courante quand le planificateur n en donne qu un des deux.
      const yaw = params.horizontal === undefined
        ? bot.entity.yaw
        : (params.horizontal * Math.PI) / 180
      const pitch = params.vertical === undefined
        ? bot.entity.pitch
        : (params.vertical * Math.PI) / 180

      await bot.look(yaw, pitch, true)

      const block = findTargetBlock()
      return {
        resultat: `regarde vers ${Math.round((yaw * 180) / Math.PI)} deg / ` +
          `${Math.round((pitch * 180) / Math.PI)} deg` +
          (block ? `, ${block.name} toujours en vue` : ', aucun bloc cible en vue')
      }
    },

    async sauter (scale, params = {}) {
      const bot = host.getBot()
      const duree = params.duree ?? 0.5
      const before = bot.entity.position.clone()

      // Un saut retombe a sa position de depart : mesure faite a l atterrissage,
      // un saut reussi rendrait 0 et passerait pour un blocage. On echantillonne
      // donc pendant le saut et on garde le PIC VERTICAL (y - y0), pas la
      // distance 3D : un saut sur place ne derive presque pas en XZ, et la 3D
      // melangeait un eventuel glissement horizontal au decollement reel.
      // Mesure en jeu : pic vertical ~1,25 bloc en saut libre, ~0,2 sous un
      // plafond a deux blocs au-dessus des pieds. Fenetre sprint (~1,9 bloc en
      // elan) ne concerne que walkForward, pas ce saut vertical sur place.
      bot.setControlState('jump', true)
      let pic = 0
      const y0 = before.y
      const fin = Date.now() + Math.round(duree * 1000)
      while (Date.now() < fin) {
        await sleep(50)
        const y = host.getBot()?.entity?.position?.y ?? y0
        const dy = y - y0
        if (dy > pic) pic = dy
      }
      bot.setControlState('jump', false)
      await sleep(250)

      // Meme convention que `appuyer` : un saut qui ne decolle pas est la
      // signature d un bot bloque (plafond, encastre). On le remonte comme un
      // echec pour vider la file et faire replanifier.
      //
      // Seuil 0,5 et non 0,1 comme `appuyer` : mesure en jeu, un plafond a deux
      // blocs au-dessus des pieds laisse encore grimper de 0,2 bloc (et 0,2 est
      // le plancher physique, un bot ne fait pas 1,8 de haut dans 2 blocs). Un
      // seuil de 0,1 laisserait donc passer tout saut bloque. Un saut libre
      // plafonne a ~1,25 bloc ; 0,5 separe proprement les deux.
      const bloque = pic < 0.5

      return {
        resultat: `saut de ${duree.toFixed(1)} s, pic vertical de ${pic.toFixed(2)} bloc` +
          (bloque ? ' (saut bloque : plafond ou bot coince)' : ''),
        echec: bloque
      }
    },

    async appuyer (scale, params = {}) {
      const bot = host.getBot()
      // Le modele omet parfois `touches` (observe en jeu : « aucune touche
      // indiquee » en boucle). Avancer droit est le repli le plus utile : mieux
      // vaut un pas en avant qu une action jetee sans rien tenter.
      const touches = Array.isArray(params.touches) && params.touches.length > 0
        ? params.touches
        : ['forward']

      const duree = params.duree ?? 1
      const before = bot.entity.position.clone()

      // Un objectif de pathfinder en cours se battrait avec les touches tenues.
      host.stopPathfinding()

      try {
        for (const touche of touches) bot.setControlState(touche, true)
        await sleep(Math.round(duree * 1000))
      } finally {
        for (const touche of touches) {
          try { bot.setControlState(touche, false) } catch (_) {}
        }
      }

      await sleep(150)
      const moved = host.getBot()?.entity?.position?.distanceTo(before) ?? 0

      // Un deplacement nul apres avoir tenu `forward` est un fait utile : c est
      // la signature d un bot encastre (piege 6). On le remonte comme un echec
      // pour que le plan soit jete et que le planificateur en tienne compte.
      const bloque = moved < 0.1 && touches.some(t => ['forward', 'back', 'left', 'right'].includes(t))

      return {
        resultat: `${touches.join('+')} tenu ${duree.toFixed(1)} s, deplacement de ${moved.toFixed(2)} bloc` +
          (bloque ? ' (immobile : probablement encastre)' : ''),
        echec: bloque
      }
    },

    // Le repli quand le planificateur ne sait pas quoi faire : balayer les quatre
    // points cardinaux et rendre compte de ce qui est visible. Contrairement a
    // `attendre`, il rend de l information, donc le tour suivant n est pas
    // identique au precedent.
    async regarder_autour () {
      const bot = host.getBot()
      // Meme convention que skills.regarder : 0 rad = nord, +PI/2 = ouest,
      // PI = sud, -PI/2 = est. C est la convention reelle de mineflayer
      // (vecteur avant = -sin yaw, -cos yaw) : yaw 0 regarde vers -Z.
      const headings = [
        ['nord', 0],
        ['ouest', Math.PI * 0.5],
        ['sud', Math.PI],
        ['est', -Math.PI * 0.5]
      ]

      const vus = []
      for (const [nom, yaw] of headings) {
        try {
          await bot.look(yaw, 0, true)
        } catch (_) {}
        await sleep(120)
        // Secteur : chaque cap ne voit que son cone (demi-angle PI/4 par
        // defaut). Sans bloc dans le cone, le cap rend « rien » — jamais le
        // plus proche global, qui rendait les 4 caps identiques.
        const block = findTargetBlock(undefined, { yaw }) ?? findTargetBlock(undefined, { yaw, anyHeight: true })
        vus.push(block ? `${nom} : ${block.name}` : `${nom} : rien`)
      }

      return { resultat: `tour d horizon -> ${vus.join(' | ')}` }
    },

    // Angle relatif : le planificateur n a pas a savoir ou est le sud. Le signe
    // suit /api/turn (yaw + angle), meme convention partout.
    async pivoter (scale, params = {}) {
      const bot = host.getBot()
      const angle = Number.isFinite(Number(params.angle)) ? Number(params.angle) : 90
      const yaw = bot.entity.yaw + (angle * Math.PI) / 180

      await bot.look(yaw, bot.entity.pitch, true)

      const degres = Math.round((yaw * 180) / Math.PI)
      const block = findTargetBlock()
      return {
        resultat: `pivot de ${Math.round(angle)} deg (cap ${degres} deg)` +
          (block ? `, ${block.name} en vue` : ', rien de cible en vue')
      }
    },

    // Memoire : le seul geste qui ne touche ni au jeu ni a la documentation. Le
    // budget est tenu par memory.js, pas par le modele — il propose, le code
    // dispose, comme partout ailleurs. L ecriture est async (la compaction du
    // fil de travail peut appeler le modele), donc attendue.
    async memoriser (scale, params = {}) {
      const result = await memory.write({
        texte: params.texte,
        portee: Array.isArray(params.portee) ? params.portee[0] : params.portee
      })

      if (!result.ok) {
        return { resultat: `memoire : ${result.error}`, echec: true }
      }

      // Le plafond affiche est celui de la portee ecrite, pas un total : les
      // deux portees ont des budgets separes depuis le passage en couches.
      const snap = result.snapshot ?? memory.snapshot()
      const plafond = result.portee === 'long_terme'
        ? snap.plafonds.long_terme
        : snap.plafonds.travail

      return {
        resultat: `note enregistree en memoire ${result.portee} ` +
          `(${result.jetons}/${plafond} jetons)` +
          (result.en_attente ? ', en attente du commit de fin de mission' : '') +
          (result.compacte ? ', fil de travail compacte' : '')
      }
    },

    async oublier (scale, params = {}) {
      const result = memory.clear(Array.isArray(params.portee) ? params.portee[0] : params.portee)
      if (!result.ok) return { resultat: `memoire : ${result.error}`, echec: true }

      return {
        resultat: result.portee === 'tout'
          ? 'memoire entierement effacee'
          : `memoire ${result.portee} effacee`
      }
    },

    // Auto-reparation : decrire l impasse a une aide distante, recevoir une
    // operation sur la documentation d une action native, puis relancer la
    // mission. Le refus quand le detecteur n a rien vu est le coeur du
    // garde-fou : le modele ne peut pas appeler une API payante a chaque tour
    // sous pretexte qu il s ennuie.
    async demander_aide () {
      if (!repair.isEnabled()) {
        return { resultat: `aucun reparateur distant (${repair.why()})`, echec: true }
      }
      if (!mission.stuck) {
        return { resultat: 'aucun blocage detecte : demander_aide est inutile', echec: true }
      }
      if (mission.repairs >= repair.MAX_PER_MISSION) {
        return { resultat: `budget de ${repair.MAX_PER_MISSION} reparation(s) epuise`, echec: true }
      }

      const bot = host.getBot()
      const block = findTargetBlock()
      const etat = {
        position: {
          x: Number(bot.entity.position.x.toFixed(1)),
          y: Number(bot.entity.position.y.toFixed(1)),
          z: Number(bot.entity.position.z.toFixed(1))
        },
        dans_liquide: host.inLiquid(),
        bloc_cible_en_vue: block ? block.name : null,
        inventaire: mission.supply === 'harvest' ? stocks() : null
      }

      mission.activity?.update('help', activity.ACTIONS.demander_aide, 'important')
      const result = await repair.askForAction({
        signal: mission.navigationAbort.signal,
        probleme: mission.stuckWhy,
        kind: mission.kind,
        supply: mission.supply,
        etat,
        historique: mission.history.slice(-6)
      })

      if (!result.ok) {
        return { resultat: `reparation impossible : ${result.error}`, echec: true }
      }

      const applied = applyDocOperation(result.operation)
      if (!applied.ok) {
        return { resultat: `reparation impossible : ${applied.texte}`, echec: true }
      }

      mission.repairs += 1
      mission.restartAfterAction = true
      mission.activity?.update('replanning', 'J ai obtenu de nouveaux conseils pour mes actions ; je vais les essayer.', 'important')

      console.log(
        `[mission] reparation ${mission.repairs}/${repair.MAX_PER_MISSION} : ` +
        `${applied.texte} pour ${result.diagnostic || mission.stuckWhy}`
      )

      return {
        resultat: `aide obtenue de ${repair.MODEL} : ${applied.texte}, mission relancee`,
        reparation: true
      }
    },

    // La tache de fond : faire le point sur la documentation des actions. L aide
    // distante propose des operations, chacune revalidee par skills.js — le code
    // dispose, et rien ne peut ajouter d action executable.
    async reviser_actions () {
      if (!repair.isEnabled()) {
        return { resultat: `aucun reparateur distant (${repair.why()})`, echec: true }
      }
      if (mission.revisions >= repair.MAX_REVISIONS) {
        return { resultat: `budget de ${repair.MAX_REVISIONS} revision(s) epuise`, echec: true }
      }

      const bot = host.getBot()
      mission.activity?.update('help', activity.ACTIONS.reviser_actions, 'important')
      const result = await repair.reflect({
        signal: mission.navigationAbort.signal,
        kind: mission.kind,
        supply: mission.supply,
        probleme: mission.stuckWhy,
        historique: mission.history.slice(-6),
        etat: {
          position: {
            x: Number(bot.entity.position.x.toFixed(1)),
            y: Number(bot.entity.position.y.toFixed(1)),
            z: Number(bot.entity.position.z.toFixed(1))
          },
          dans_liquide: host.inLiquid(),
          inventaire: mission.supply === 'harvest' ? stocks() : null
        }
      })

      if (!result.ok) {
        return { resultat: `reflexion impossible : ${result.error}`, echec: true }
      }

      mission.revisions += 1

      // Chaque operation repasse par skills.documentAction / forgetActionDoc /
      // mergeActionDocs : action inconnue, texte hors bornes ou operation mal
      // formee est refusee, et jamais une action native n est creee ou supprimee.
      const applied = []
      let accepted = 0
      for (const operation of result.operations) {
        const outcome = applyDocOperation(operation)
        if (outcome.ok) accepted++
        applied.push(outcome.ok ? `+${operation.action ?? operation.cible}` : `${operation.action ?? operation.cible ?? '?'} refuse (${outcome.texte})`)
      }
      mission.activity?.update('replanning', accepted
        ? 'J ai ajuste les conseils de mes actions ; je refais le point.'
        : 'Cette revue n a pas apporte de nouveaux conseils utilisables.', 'important')

      // La documentation a change (generation), donc le prompt systeme sera
      // reconstruit : on repart sur une ardoise propre pour que la mission
      // essaie les exemples enrichis.
      if (accepted > 0) {
        mission.failures = 0
        mission.queue = []
        abortPrefetch('documentation revisee')
        mission.history = []
      }

      console.log(
        `[mission] revision ${mission.revisions}/${repair.MAX_REVISIONS} : ` +
        `${result.diagnostic || 'sans diagnostic'} -> ${applied.join(', ') || 'aucune operation'}` +
        (result.rejected.length ? ` (rejete : ${result.rejected.join(', ')})` : '')
      )

      return {
        resultat: `reflexion sur la documentation des actions : ` +
          `${applied.join(', ') || 'rien a changer'}` +
          (result.rejected.length ? `, rejete : ${result.rejected.join(', ')}` : ''),
        revision: accepted > 0,
        echec: result.operations.length > 0 && accepted === 0
      }
    }
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
    mission.summaryText = summary()
    let message
    if (state === 'done') {
      message = completed.movementTask?.steps.at(-1)?.type === 'sous_arbre'
        ? 'Je suis sous la couronne d un arbre, au sol.'
        : `J ai termine : ${reason}. ${completed.summaryText}`
    } else if (state === 'failed') message = `Je n ai pas pu terminer : ${reason}.`
    else if (!reason.startsWith('remplacee')) message = `Je m arrete : ${reason}.`
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
              completed.activity?.update?.('execution', `« ${activated.texte} » repris (progression conservee, monde reobserve).`, true)
            } else {
              try { injectedObjectives.pauseWork('en attente de reprise explicite') } catch (_) {}
              completed.activity?.update?.('execution', `Objectif clos ; « ${activated.texte} » attend (dis reprends pour le relancer, reprise : ${r.error}).`, true)
            }
          } else if (activated && out && (!oid || activated.id !== oid) && activated.statut === 'active') {
            // Pending auto-active sans objet suspendu : meme regle, pas de fantome.
            const r2 = resumeSuspended(activated.id)
            if (!r2.ok) {
              try { injectedObjectives.pauseWork('en attente de reprise explicite') } catch (_) {}
              completed.activity?.update?.('execution', `Objectif clos ; « ${activated.texte} » attend (dis reprends pour le relancer).`, true)
            }
          } else if (after && after.current && after.current.statut === 'maintaining') {
            // Permanent : but durable garde, moteur de maintenance non livrable
            // => attente explicite, jamais de boucle de recolte aveugle.
            completed.maintenance = 'waiting-maintenance'
            completed.activity?.update?.('execution', 'Objectif permanent atteint : en attente de maintenance (observation pertinente, pas de recolte aveugle).', true)
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
      return buildState()
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
    if (!planner.isEnabled()) return
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
    if (planner.selectPlanRoute?.(snap)?.role === 'strategy') return
    const capture = capturePourPlan()
    if (SCREENSHOT_ON && snap.environnement) {
      snap.environnement.capture_presente = Boolean(capture)
    }

    const controller = new AbortController()
    const promise = planner.plan(
      snap, mission.kind, mission.supply, extraState(), capture ? capture.dataUrl : null,
      { signal: controller.signal }
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
      if (mission.prefetch && planner.selectPlanRoute?.(state)?.role === 'strategy') {
        abortPrefetch('etat frais exige la strategie, ancien plan nominal jete')
      }
      // La file est vraiment vide : on consomme le plan anticipe s il y en a
      // un (c est la SEULE attente du chemin nominal), sinon appel bloquant
      // comme avant. Jamais deux appels en vol : consommer ne lance rien.
      if (mission.prefetch) {
        const enVol = mission.prefetch
        let result
        try {
          result = await enVol.promise
        } catch (err) {
          mission.prefetch = null
          mission.prefetchAbort = null
          throw err
        }
        if (planner.selectPlanRoute?.(state)) {
          const fresh = snapshotForPrefetch()
          if (planner.selectPlanRoute(fresh)?.role === 'strategy') {
            abortPrefetch('etat modifie pendant attente, strategie requise')
            return decideFromPlan(fresh)
          }
        }
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
        mission.activity?.update('planning', 'Je prepare la suite a partir de ce que je vois dans le jeu.')
        if (SCREENSHOT_ON && state.environnement) {
          state.environnement.capture_presente = Boolean(capture)
        }
        const revision = mission.planRevision
        const result = await planner.plan(
          state, mission.kind, mission.supply, extraState(), capture ? capture.dataUrl : null,
          { signal: mission.navigationAbort.signal }
        )

        if (mission.planRevision !== revision) throw new Error('plan annule apres precision')
        const fin = applyPlanResult(result, capture)
        if (fin) return fin
      }
    }

    const step = mission.queue.shift()

    // La file descend a 1 : on lance l appel suivant pendant que cette etape
    // tourne, sans l attendre. Le run() de la boucle recouvre la latence.
    if (mission.queue.length === 1) startPrefetch()

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

  // Le chemin d origine : deux appels au plus, une action a la fois.
  async function decideFromJev (state) {
    const plan = await jev.planMission(state, mission.kind, mission.supply)
    if (!plan) return null

    if (plan.finished) return { finished: true, done: plan.done, why: null }

    let params = { scale: 0.5, scaleLevel: null, choices: {}, asked: false }
    try {
      params = await jev.planParams(state, plan.step, {
        fabrications: craft.targetCriteria(host.getBot())
      }) ?? params
    } catch (err) {
      // Un second etage rate ne doit pas couter la mission : on execute
      // l action avec une ampleur moyenne, ce qui vaut mieux que rien.
      console.error(`[mission] parametres indisponibles pour ${plan.step} : ${err.message}`)
    }

    return {
      finished: false,
      done: plan.done,
      step: plan.step,
      scale: params.scale,
      scaleLevel: params.scaleLevel,
      choices: params.asked ? params.choices : {},
      confidence: plan.confidence,
      queued: 0,
      why: null
    }
  }

  async function decide (state) {
    return planner.isEnabled() ? decideFromPlan(state) : decideFromJev(state)
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
  // Le refus n est pas eternel : apres REFUSALS_BEFORE_YIELD, on cede. Un bot
  // qui ne peut plus rien faire d utile (plus un seul bloc a portee, matiere
  // introuvable) doit pouvoir rendre la main plutot que de tourner jusqu a la
  // limite de duree.
  const REFUSALS_BEFORE_YIELD = 3

  function finishAllowed (state) {
    if (mission.pendingJoin) return { ok: false, why: 'le demandeur n a pas ete rejoint : retente rejoindre_demandeur ou signale l echec' }
    // Livraison (S6) : jugee sur le prouve et les obligations, jamais sur les
    // compteurs broken/collected ni le quota ressource. L incertain, l absence
    // de plafond et le manque de prouve refusent terminer/fini ; satisfaits,
    // l arret est autorise sans passer par le quota. Aucun retoss auto.
    const dons = deliveryLedgersFor(mission)
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
      return { ok: true }
    }
    // Fabrication generique : la preuve est l objet cible mesure
    // (produits vs visee), jamais le quota recolte ni un plan execute. Un
    // `terminer`/`fini` sans les objets est refuse ; un manque de ressource
    // renvoie le pilote a la recolte via le message (recettes du jeu font
    // foi, aucune recette hardcodee par phrase ici).
    if (mission.fabricationCible) {
      const visee = mission.fabricationQuantite ?? 1
      const produits = state.progression?.fabrication_produits ?? fabricationProduced()
      if (produits >= visee) return { ok: true }
      const manque = mission.fabricationLastError
        ? ` (${mission.fabricationLastError})`
        : ''
      return {
        ok: false,
        why: `${produits} ${mission.fabricationCible} fabrique(s) sur ${visee} demande(s) : fabriquer la cible ou recolter ce qui manque (recettes du jeu font foi)${manque}`
      }
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

    if (mission.wholeTree) {
      const tree = treeStatus()
      if (!tree) return { ok: false, why: 'aucune buche de l arbre n a encore ete coupee' }
      if (tree.buches_restantes > 0) return { ok: false, why: `il reste ${tree.buches_restantes} buche(s) sur l arbre` }
      if (tree.buches_au_sol > 0) return { ok: false, why: `${tree.buches_au_sol} buche(s) au sol a ramasser` }
      return { ok: true }
    }

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
        announce(`je suis bloque : ${state.blocage.raison}`)
      } else if (!state.blocage?.detecte) {
        mission.stuckAnnounced = false
      }

      try {
        decision = await decide(state)
        if (mission !== myMission || myMission.navigationAbort !== controller) return
        mission.jevErrors = 0
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
        mission.jevErrors += 1
        console.error(`[mission] planificateur indisponible (${mission.jevErrors}/${MAX_JEV_ERRORS}) : ${err.message}`)

        // Une file heritee d un plan devenu douteux ne doit pas survivre a la
        // panne qui l a interrompue.
        mission.queue = []
        abortPrefetch('panne planificateur')

        if (mission.jevErrors >= MAX_JEV_ERRORS) {
          finish('failed', 'planificateur indisponible')
          return
        }

        await sleep(TICK_MS * 2)
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

        if (!allowed.ok && mission.finishRefused >= REFUSALS_BEFORE_YIELD) {
          finish('failed', allowed.why)
          return
        }

        if (!allowed.ok && mission.finishRefused < REFUSALS_BEFORE_YIELD) {
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

      try {
        const message = activity.ACTIONS[decision.step] ?? activity.SUBGOALS[decision.step === 'rejoindre_demandeur' ? 'rejoindre' : '']
        mission.activity?.update('execution', message || 'Je poursuis les gestes demandes.', Boolean(message))
        const exec = physicalExecutor()
        if (exec) {
          // Entree physique via l executeur (kind 'work', un seul writer).
          // Refus fail-closed (paused/stopped/busy/invalid) : echec explicite,
          // jamais de succes fictif. Annulation -> echec interrompu.
          // Reentrance : l etape tient le slot ; ses sous-appels nav passent
          // leur token proprietaire (__owner) et s executent DANS le slot.
          const stepId = `mission-${mission.id}-step-${mission.steps + 1}-${decision.step}`
          let envelope = null
          const token = {}
          stepOwner = stepId
          stepToken = token
          try {
            try {
              envelope = await exec.run(
                { id: stepId, kind: 'work' },
                async () => run(decision.scale, decision.choices))
            } catch (refus) {
              outcome = { resultat: `action refusee (${refus.code || 'refus'}) : ${refus.message}`, echec: true, code: refus.code || 'refused' }
            }
            if (!outcome) {
              if (envelope && envelope.cancelled) {
                outcome = { resultat: 'action interrompue (stop/pause)', echec: true, code: 'cancelled' }
              } else if (envelope && envelope.value !== undefined && envelope.value !== null) {
                outcome = envelope.value
              } else {
                outcome = { resultat: `action sans resultat mesurable (${envelope ? envelope.outcome : 'refus'})`, echec: true, code: 'no_result' }
              }
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
        }
      } catch (err) {
        outcome = { resultat: `erreur : ${err.message}`, echec: true }
      }

      // L action a pu durer plusieurs secondes : un !stop arrive entre-temps a
      // deja clos la mission, et comptabiliser l etape la ferait repartir.
      // Idem si la mission a ete remplacee (suspend + nouvel objectif).
      if (!isRunning() || mission.cancelled || mission !== myMission || myMission.navigationAbort !== controller) return

      mission.steps += 1
      mission.history.push({ action: decision.step, resultat: outcome.resultat, code: outcome.code ?? null, echec: Boolean(outcome.echec) })
      if (mission.history.length > 8) mission.history.shift()
      reportProgressSafe()

      if (outcome.reobserver) {
        mission.queue = []
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
      if (mission.kind === 'recolte' && mission.quotaExplicite && !mission.wholeTree &&
        !mission.fabricationCible && collected() >= mission.quota) {
        finish('done', `quantite demandee en inventaire (${collected()}/${mission.quota})`)
        return
      }

      // « ... et rapporte moi le bois » : l arbre fini, rejoindre d abord le
      // demandeur (s il est en jeu), puis clore ; un echec de trajet laisse la
      // boucle continuer (pendingJoin). Vu sur chat/tree-then-bring : mission
      // close au pied de l arbre, bois jamais rapporte.
      if (mission.wholeTree && treeStatus()?.termine) {
        // La demande vient de l objectif (revision) ou d une precision
        // ajoutee en cours de route (vu : « et rapporte moi le bois » classe
        // en precision, objectif inchange, bois jamais rapporte).
        const textes = [mission.objective ?? '', ...(mission.instructions ?? [])
          .filter(entry => entry?.de === mission.requester).map(entry => entry.message ?? '')]
        const livrer = textes.some(texte => /rapport|ram[eè]n|apport|livr/i.test(texte)) &&
          Boolean(host.getBot()?.players?.[mission.requester]?.entity)
        if (livrer && !mission.livraison) {
          mission.livraison = true
          abortPrefetch('arbre fini, bois a rapporter au demandeur')
          mission.queue = [{ action: 'rejoindre_demandeur', scale: 0.5, scaleLevel: null, choices: {} }]
          console.log(`[mission] arbre fini : bois a rapporter a ${mission.requester}`)
        } else if (!livrer || mission.pendingJoin === false) {
          finish('done', livrer ? 'arbre entier coupe, bois rapporte au demandeur' : 'arbre entier coupe et ramasse')
          return
        }
      }

      // Une aide obtenue enrichit la documentation des actions : la generation
      // a bouge, donc le prompt systeme est reconstruit. On repart d une
      // ardoise propre plutot que de trainer l historique et les echecs qui ont
      // mene au blocage.
      if (outcome.reparation && mission.restartAfterAction) {
        mission.restartAfterAction = false
        mission.failures = 0
        mission.finishRefused = 0
        mission.history = []
        mission.queue = []
        abortPrefetch('mission relancee apres reparation')
        mission.stuck = false
        mission.lastProgress = progressFingerprint()
        mission.lastProgressStep = mission.steps
        console.log(`[mission] mission relancee apres ${mission.repairs} reparation(s)`)
      }

      // C est le modele qui decide quand la mission est finie : `terminer` la
      // clos directement. Le garde-fou numerique (`finishAllowed`) reste sur le
      // signal `fini`, ou l erreur de classification coute la mission entiere
      // (voir CLAUDE.md, piege 17).
      if (outcome.fin) {
        const allowed = finishAllowed(buildState())
        // Quantite explicite pas encore en inventaire : meme refus reinjecte
        // que pour `fini` (3 au plus), au lieu de clore la mission en echec.
        if (!allowed.ok && mission.quotaExplicite && mission.finishRefused < REFUSALS_BEFORE_YIELD) {
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

      // Repeter la meme action ratee indefiniment ne mene nulle part : mieux
      // vaut rendre la main au joueur que de bruler des appels.
      if (outcome.echec) {
        mission.activity?.update('blocked', `Cette tentative a echoue : ${outcome.resultat}`, true)
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
        if (mission.queue.length > 0) {
          console.log(`[mission] plan abandonne (${mission.queue.length} etape(s)) apres un echec`)
          mission.queue = []
        }
        abortPrefetch('echec, plan speculatif jete')

        if (mission.failures >= MAX_REPEATED_FAILURES) {
          finish('failed', `${MAX_REPEATED_FAILURES} actions en echec d affilee`)
          return
        }
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
          if (activeStep?.state === 'running') current.activity?.update('execution', activity.SUBGOALS[activeStep.type] || 'Je poursuis le parcours.', true)
          current.steps = task.cursor
          const step = task.steps[task.cursor - 1]
          if (step?.state === 'done') current.lastPlan = { step: step.type, subgoal: task.cursor, total: task.steps.length }
        })
      let result
      if (exec) {
        stepOwner = courseId
        stepToken = courseToken
        try {
          const envelope = await exec.run({ id: courseId, kind: 'work' }, runCourse)
          if (current.navigationAbort !== controller) return
          if (envelope.cancelled) {
            await finish('stopped', 'parcours interrompu (stop/pause)')
            return
          }
          result = envelope.value
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
    if (!host.isReady()) return { ok: false, error: 'bot non connecte' }
    if (!brain().isEnabled()) {
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

    if (isRunning()) stop('remplacee par un nouvel objectif')
    cancelPendingStart()
    const generation = ++startGeneration
    const request = new AbortController()
    startAbort = request
    const abortRequest = () => request.abort()
    const preparing = { id: `brief-${generation}`, objective: text, requester,
      reporter: activity.createActivityReporter({ say: host.chat,
        isActive: () => generation === startGeneration && !request.signal.aborted }) }
    preparation = preparing
    preparing.reporter.update('brief', 'Je verifie les etapes et les capacites necessaires pour ta demande.')
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

    let brief
    try {
      try {
        brief = await brain().readBrief(text, { signal: request.signal })
      } catch (first) {
        // Un echec isole (reponse tronquee deux fois, panne passagere) laissait
        // le bot immobile sans rien dire, surtout apres un arbitrage : un
        // nouvel essai, sauf annulation.
        if (request.signal.aborted) throw first
        console.log(`[mission] lecture de l objectif echouee (${first.message}), nouvel essai`)
        brief = await brain().readBrief(text, { signal: request.signal })
      }
    } catch (err) {
      return { ok: false, error: `lecture de l objectif impossible : ${err.message}` }
    } finally {
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

    // Fix 2 : resolution insensible aux variantes (« graine », « wheat_seeds »).
    // Sans elle, « ramasse 5 graines » tombait sur 'aucune' des que le modele
    // n ecrivait pas le pluriel exact, privant la mission de toute cible.
    let resource = skills.resolveResource
      ? (skills.resolveResource(brief.resource) ?? 'aucune')
      : (skills.RESOURCES[brief.resource] ? brief.resource : 'aucune')

    // 'aucune' prive la mission de toute cible : le bot ne peut plus qu explorer
    // a l aveugle. Quand ce choix n est pas assure, on retient la meilleure
    // matiere proposee a la place.
    if (resource === 'aucune' && brief.resourceConfidence < brain().MIN_CONFIDENCE && brief.resourceProbabilities) {
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
    // « Va sous l arbre » lu en simple deplacement vers un repere arbre (vu sur
    // route/under-tree : le bot cherchait l arbre sans jamais s y placer) :
    // c est le parcours sous_arbre, que le code sait verifier.
    if (!brief.route && brief.kind !== 'recolte' && !brief.fabrication &&
      /\bsous\s+(?:l['’ ]\s*|un\s+|cet\s+|le\s+)?arbre\b/i.test(text)) {
      console.log('[mission] « sous l arbre » sans parcours : parcours [sous_arbre] retenu')
      brief = { ...brief, route: [{ type: 'sous_arbre' }] }
    }
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
    // Une fabrication valide n est jamais un geste a clore en un plan : le
    // type compatible existant est `recolte` (fabriquer + casser/ramasser).
    // Requalification explicite (journalisee), pas de nouveau type en silence.
    if (fabricationCible && kind === 'geste' && !brief.route) {
      console.log(`[mission] fabrication "${fabricationCible}" detectee, type geste -> recolte (pas de cloture en un plan)`)
      kind = 'recolte'
    }

    const objectiveMode = opts.mode === 'permanent' ? 'permanent' : 'temporary'
    mission = {
      id: opts.revisionOf?.id ?? `${Date.now()}-${generation}`,
      objectiveId: opts.objectiveId ?? opts.revisionOf?.objectiveId ?? null,
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
      wantsDoor: brief.door,
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
        build.parseQuota(sansCoordonnees(text), { allowBlockUnits: true }) === null && WHOLE_TREE_TEXT.test(text),
      tree: null,
      // Fabrication generique : cible validee registre + quantite codee,
      // persistee et servie dans buildState (consigne.fabrication_cible).
      // Legacy recolte sans cible : null, chemin inchange.
      fabricationCible,
      fabricationQuantite,
      fabricationInitial: 0,
      fabricationLastError: null,

      supply: SUPPLY,
      buildBlock: skills.RESOURCES[resource]?.build ?? 'dirt',
      // Le motif accepte plusieurs noms : en survie le bloc pose depend de ce
      // qui est tombe (pierre -> cobblestone, bloc d herbe -> terre) et de
      // l essence coupee (chene, bouleau...).
      buildMatch: skills.RESOURCES[resource]?.buildMatch ?? /^dirt$/,
      doorBlock: process.env.MISSION_DOOR_BLOCK || 'oak_door',

      state: 'running',
      cancelled: false,
      navigationAbort: new AbortController(),
      pendingJoin: false,
      startedAt: opts.revisionOf?.startedAt ?? Date.now(),
      startedAtIso: opts.revisionOf?.startedAtIso ?? new Date().toISOString(),
      activeElapsedMs: opts.revisionOf ? activeDurationMs(opts.revisionOf) : 0,
      activeSince: Date.now(),
      endedAt: null,
      reason: null,
      steps: 0,
      broken: 0,
      // Dirt cassee en mission bois pour un pilier : hors quota bois, mais
      // progres anti-blocage (voir progressFingerprint) et preuve chiffree.
      dirtSecondaire: 0,
      failures: 0,
      jevErrors: 0,

      // File d etapes servies par un seul appel au planificateur JSON. Vide
      // avec Jev, qui rend une action a la fois.
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
      // Blocage et auto-reparation : un compteur de progres pour mesurer l
      // avancement, et un budget d appels au reparateur distant.
      lastProgress: 0,
      lastProgressStep: 0,
      stuck: false,
      stuckWhy: null,
      repairs: 0,
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
    mission.activity.update('preparing', 'J ai prepare les etapes, je commence leur execution.')
    if (mission.movementTask) mission.movementTask.clearance = mission.clearance
    // Une revision conserve le prefixe deja prouve s il a le meme contrat.
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
    if (!opts.revisionOf) memory.resetWork()

    const known = targetBlockIds().length
    console.log(
      `[mission] "${text}" (${requester}) -> type ${kind} (${mission.kindConfidence}), ` +
      `matiere ${resource} (${mission.resourceConfidence}), repere ${landmark}, ` +
      `porte ${brief.door ? 'oui' : 'non'}, ${dimensions.width}x${dimensions.depth}x${dimensions.height} ` +
      `(${dimensions.source}), ${known} bloc(s) connu(s), approvisionnement ${SUPPLY}` +
      (mission.fabricationCible ? `, fabrication ${mission.fabricationCible} x${mission.fabricationQuantite} (stock initial ${mission.fabricationInitial})` : '')
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
  function activatePaused (m) {
    mission = m
    m.activeSince = Date.now()
    m.state = 'running'
    m.cancelled = false
    m.navigationAbort = new AbortController()
    m.failures = 0
    m.jevErrors = 0
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
    if (!skills.KINDS[desc.kind] || !skills.RESOURCES[desc.resource]) {
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
      kind: desc.kind,
      kindConfidence: 1,
      resource: desc.resource,
      resourceConfidence: 1,
      landmark: (desc.landmark && skills.LANDMARKS[desc.landmark]) ? desc.landmark : 'ici',
      landmarkResource: null,
      wantsDoor: false,
      doorProbability: 0,
      dimensions: dims,
      quota: Number.isFinite(Number(desc.quota)) ? Number(desc.quota) : DEFAULT_QUOTA,
      fabricationCible: typeof desc.fabricationCible === 'string' ? desc.fabricationCible : null,
      fabricationQuantite: Number.isFinite(Number(desc.fabricationQuantite))
        ? Math.max(CRAFT_MIN, Math.min(CRAFT_MAX, Math.round(Number(desc.fabricationQuantite))))
        : 1,
      fabricationInitial: Number.isFinite(Number(desc.fabricationInitial))
        ? Math.max(0, Math.round(Number(desc.fabricationInitial)))
        : 0,
      fabricationLastError: null,
      supply: SUPPLY,
      buildBlock: skills.RESOURCES[desc.resource]?.build ?? 'dirt',
      buildMatch: skills.RESOURCES[desc.resource]?.buildMatch ?? /^dirt$/,
      doorBlock: process.env.MISSION_DOOR_BLOCK || 'oak_door',
      objectiveMode: obj.mode === 'permanent' ? 'permanent' : 'temporary',
      maintenance: null,
      rehydrated: true,
      baseUnits: Math.max(0, Number(prog.unites_recoltees ?? prog.faits ?? 0) || 0),
      state: 'running',
      cancelled: false,
      navigationAbort: new AbortController(),
      pendingJoin: false,
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
      jevErrors: 0,
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
      repairs: 0,
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
          done: ceiling !== null && proven >= ceiling
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
    mission.activity.update('preparing', 'Mission reprise apres restart : monde reobserve, compteurs non rejoues.')
    if (mission.movementTask) mission.movementTask.clearance = mission.clearance
    try { physicalExecutor?.resume?.() } catch (_) {}
    loopPromise = (mission.movementTask ? runMovementMission(mission) : loop()).catch(err => {
      console.error('[mission] boucle interrompue :', err.message)
      finish('failed', `erreur interne : ${err.message}`)
    })
    try { host.chat(`Mission reprise : ${mission.objective} (progression conservee, monde reobserve)`) } catch (_) {}
    return { ok: true, mission: status() }
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
      arbre_entier: mission.wholeTree ? (treeStatus() ?? { commence: false }) : null,
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
      blocage: {
        detecte: mission.stuck,
        raison: mission.stuckWhy,
        reparations: mission.repairs,
        reparations_max: repair.MAX_PER_MISSION,
        revisions: mission.revisions,
        revisions_max: repair.MAX_REVISIONS
      }
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
    isRunning,
    SUPPLY,
    ACTION_NAMES: Object.keys(ACTIONS)
  }
}

module.exports = { createMissionRunner, sondeAlentours, capDepuisVecteur, choisirCoteContournement, fabTargetName, countFabricationItems, fabricationWanted, resolveFabricationCible }
