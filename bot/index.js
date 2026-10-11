// Installe le plus tot possible : les erreurs de connexion et de chargement des
// modules passent ainsi par le fichier de log et, plus tard, par le chat.
const logger = require('./logger')
logger.install()

const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const skills = require('./skills')
const craft = require('./craft')
const planner = require('./planner')
const memory = require('./memory')
const { createMissionRunner } = require('./mission')
const { createApi } = require('./api')
const { createNavigator } = require('./navigation')
const { GoalBlocEnVue } = require('./but-bloc')
const { createConversation, isSoftStop: isSoftStopText, isHardStop: isHardStopText, isResume: isResumeText, parseArbitrationChoice } = require('./conversation')
const { createExecutor, awaitPhysicalWithTimeout, createControlLease, runPhysicalOrThrow } = require('./executor')
const { createStateStore } = require('./state-store')
const { createObjectiveController } = require('./objective-controller')
// R19 : parsing central des variables numeriques / enumerees (jamais de NaN
// silencieux) et affichage de la config effective au demarrage (voir
// startRuntime). Les garde-fous critiques jettent ici et refusent le demarrage.
const config = require('./config')

// Le chat est interprete par le planificateur JSON distant, seul cerveau. Pas
// de repli sur des mots-cles : un bot muet vaut mieux qu un bot qui devine.

const MC_HOST = process.env.MC_HOST || 'minecraft'
const MC_PORT = config.boundedNumberOrThrow(process.env.MC_PORT, 25565, 1, 65535, 'MC_PORT', { integer: true })
const MC_VERSION = process.env.MC_VERSION || '26.1'
const BOT_USERNAME = process.env.BOT_USERNAME || 'TestBot'
const API_PORT = config.boundedNumberOrThrow(process.env.API_PORT, 3000, 1, 65535, 'API_PORT', { integer: true })
const CMD_PREFIX = process.env.CMD_PREFIX || '!'
// Joueurs dont le chat est ignore (liste separee par des virgules, vide par
// defaut). Sert aux bancs multi-bots : un bot ne doit pas prendre les phrases
// d un autre bot (« je vais couper un arbre pour toi ») pour des ordres.
const CHAT_IGNORE_PLAYERS = new Set(String(process.env.CHAT_IGNORE_PLAYERS || '')
  .split(',').map(name => name.trim().toLowerCase()).filter(Boolean))

// Le bot n a AUCUN pouvoir d administration : ni /tp, ni /gamemode, ni
// inventaire creative. Il joue avec le mode de jeu du serveur, qui est en
// survie (MODE dans compose.yaml) pour que casser un bloc fasse tomber un
// objet. C est la difference avec l ancienne version, ou le bot etait op et se
// remettait lui-meme en survie au spawn.
//
// Delai laisse a un sauvetage pour rejoindre la terre ferme a pied.
const RESCUE_WALK_TIMEOUT_MS = config.positiveInt(process.env.RESCUE_WALK_TIMEOUT_MS, 15000, 'RESCUE_WALK_TIMEOUT_MS')

// Prismarine's water physics cannot reliably swim a bot out of a pool
// (PrismarineJS/mineflayer#2796). We therefore avoid liquids while pathfinding
// and, if the bot ends up in one anyway, rescue it instead of waiting.
const LIQUID_COST = config.finiteNumber(process.env.LIQUID_COST, 30, 'LIQUID_COST', { min: 0 })
const LIQUID_GRACE_MS = config.positiveInt(process.env.LIQUID_GRACE_MS, 5000, 'LIQUID_GRACE_MS')
const STUCK_GRACE_MS = config.positiveInt(process.env.STUCK_GRACE_MS, 7000, 'STUCK_GRACE_MS')
const STUCK_EPSILON = 0.15
// Repos apres un sauvetage sur la terre ferme. Doit rester plus long que le
// delai d une etape de mission, sinon les deux se battent.
const RESCUE_COOLDOWN_MS = config.positiveInt(process.env.RESCUE_COOLDOWN_MS, 25000, 'RESCUE_COOLDOWN_MS')


let bot = null
let spawned = false
let reconnectTimer = null
let shuttingDown = false

let lastSafePosition = null
// Trace des dernieres positions distinctes sur la terre ferme. lastSafePosition
// seule ne suffit pas : un bot coince la reecrit avec sa propre position, donc
// y retourner ne le degage pas.
const SAFE_TRAIL_MAX = 20
const SAFE_TRAIL_MIN_STEP = 1
const ESCAPE_MIN_DISTANCE = 4
let safeTrail = []
let lastPathStatus = null
// R03 : resultat final du dernier /api/goto admis (async) : l admission
// repond admitted sans attendre, le resultat (completed/failed/cancelled)
// est expose par /api/status en dernierGoto, jamais comme un ok:true.
let lastGoto = null
let lastRescue = null
let rescueCount = 0
let rescuing = false

let liquidSince = null
let stuckSince = null
let stuckAnchor = null
// Un sauvetage qui n a rien change ne doit pas repartir aussitot : sans ce
// repos, le chien de garde annulait le trajet toutes les 7 s et teleportait le
// bot en arriere, indefiniment.
let rescueCooldownUntil = 0
let lastPathLength = null
// GoalFollow keeps the bot deliberately still once it is close enough, which the
// no-progress watchdog would otherwise mistake for being stuck.
let followMode = false

let lastIntent = null

// Derniers messages du chat, joueurs et commandes compris, du plus ancien au
// plus recent. Le planificateur les relit a chaque etape : sans cela, un joueur
// qui ecrit « va au nord » pendant une mission n etait jamais entendu, et le
// bot pouvait dire une phrase sans jamais lire la reponse.
const CHAT_HISTORY_MAX = 8
let recentChat = []

function scheduleReconnect () {
  if (shuttingDown || reconnectTimer) return

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectBot()
  }, 3000)
}

function isLiquidBlock (block) {
  if (!block || !block.name) return false
  return ['water', 'flowing_water', 'lava', 'flowing_lava', 'bubble_column'].includes(block.name)
}

// Feet or eyes in a liquid is enough to consider the bot swimming.
function inLiquid () {
  if (!bot || !bot.entity) return false

  try {
    const pos = bot.entity.position
    return isLiquidBlock(bot.blockAt(pos)) || isLiquidBlock(bot.blockAt(pos.offset(0, 1, 0)))
  } catch (err) {
    return false
  }
}

function hasActiveGoal () {
  return Boolean(bot?.pathfinder?.isMoving?.())
}

// Touches connues de mineflayer, dans l ordre de `clearControlStates`. C est
// aussi la liste blanche de /api/control : une seule source pour les deux.
const CONTROL_KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']

// `bot.controlState` expose ses touches en getters NON enumerables : un
// Object.values/entries ne voit donc jamais rien (toujours vide/faux, d ou un
// diagnostic aveugle). La lecture par nom, elle, declenche le getter et rend
// l etat reel. Listes explicites ci-dessous : la seule lecture fiable.
function activeControls () {
  if (!bot?.controlState) return []
  return CONTROL_KEYS.filter(name => Boolean(bot.controlState[name]))
}

function hasActiveControl () {
  return activeControls().length > 0
}

// Point d annulation unique : tout ce qui abandonne un objectif passe par ici,
// sinon followMode reste vrai et desactive silencieusement le detecteur
// d immobilite (docs/journal.md, piege 4).
const navigator = createNavigator(() => bot)

function stopPathfinding () {
  navigator.cancel()
  followMode = false
  if (bot?.pathfinder) bot.pathfinder.setGoal(null)
}

// ---------------------------------------------------------------------------
// Cycle durable (ARCHITECTURE C0/C5, D18/D22-D23/D29/D36/D38/D42/D44-D46) :
// inbox + objectifs persistés, executeur a proprietaire unique, deux arrets
// hors LLM. Factory injectable pour les tests sans vrai bot.
// ---------------------------------------------------------------------------
const ARBITRATION_MS = config.positiveInt(process.env.ARBITRATION_MS, 60000, 'ARBITRATION_MS')
// Nouvelle demande pendant une tache : `remplacement` (defaut, demande du
// proprietaire le 2026-09-24 : la question a chaque fois etait penible) ou
// `question` (ancien comportement : pause + « pause_reprise ou remplacement ? »).
const ARBITRATION_DEFAULT = config.parseEnum(process.env.ARBITRATION_DEFAULT, ['remplacement', 'question'], 'remplacement', 'ARBITRATION_DEFAULT', { lower: true })
const OBJECTIVES_FILE = process.env.OBJECTIVES_FILE || '/data/objectives.json'
const OBJECTIVES_EVENTS_FILE = process.env.OBJECTIVES_EVENTS_FILE || '/data/objectives-events.jsonl'

let objectiveEventHandler = null
function createDurableStack (overrides = {}) {
  let corrupted = false
  let persistError = null
  const store = overrides.store ?? (() => {
    try {
      return createStateStore({ file: OBJECTIVES_FILE, eventFile: OBJECTIVES_EVENTS_FILE })
    } catch (err) {
      console.error(`[objectifs] store indisponible : ${err.message}`)
      corrupted = true
      persistError = err.message
      return null
    }
  })()
  const controller = overrides.controller ?? (() => {
    if (!store) {
      corrupted = true
      return null
    }
    try {
      const ctrl = createObjectiveController({
        store,
        arbitrationMs: overrides.arbitrationMs ?? ARBITRATION_MS,
        now: overrides.now,
        setTimer: overrides.setTimer,
        clearTimer: overrides.clearTimer,
        onEvent: overrides.onEvent ?? ((evt) => { try { objectiveEventHandler?.(evt) } catch (_) {} })
      })
      try {
        ctrl.recover()
      } catch (err) {
        // Fail-closed corruption : jamais de controleur vierge qui ecraserait
        // le snapshot corrompu a la prochaine ecriture. Admission + physique
        // refusees jusqu a reparation operateur.
        console.error(`[objectifs] snapshot corrompu, admission refusee : ${err.message}`)
        corrupted = true
        persistError = err.message
        return null
      }
      return ctrl
    } catch (err) {
      console.error(`[objectifs] controleur indisponible : ${err.message}`)
      corrupted = true
      persistError = persistError ?? err.message
      return null
    }
  })()
  const executor = overrides.executor ?? (() => {
    try {
      return createExecutor({
        stopControls: overrides.stopControls ?? ((reason) => {
          // R01 : un creusage en vol est annule lui aussi, sinon son settle
          // tardif chevaucherait l operation suivante.
          try { bot?.stopDigging?.() } catch (_) {}
          try { bot?.clearControlStates?.() } catch (_) {}
          try { navigator.cancel() } catch (_) {}
          try { bot?.pathfinder?.setGoal?.(null) } catch (_) {}
          followMode = false
        }),
        onEvent: overrides.onExecutorEvent ?? null
      })
    } catch (err) {
      console.error(`[executeur] indisponible : ${err.message}`)
      return null
    }
  })()
  return { store, controller, executor, corrupted, persistError }
}

const durable = createDurableStack()
const objectives = durable.controller
const physicalExecutor = durable.executor
function durableCorrupted () {
  return durable.corrupted === true
}
function durablePersistError () {
  return durable.persistError ?? null
}

function objectivesSnapshotSafe () {
  try { return objectives ? objectives.snapshot() : null } catch (_) { return null }
}

function isHardStopped () {
  const snap = objectivesSnapshotSafe()
  if (snap && snap.hardstop) return true
  try { if (physicalExecutor && physicalExecutor.status().stopped) return true } catch (_) {}
  return false
}

function isWorkPaused () {
  const snap = objectivesSnapshotSafe()
  if (snap && (snap.workPaused || (snap.current && snap.current.statut === 'paused'))) return true
  try { if (physicalExecutor && physicalExecutor.status().paused) return true } catch (_) {}
  return false
}

// Writer physique unique : tout ordre aux touches/pathfinder passe ici.
// Fail-closed strict : sans executeur, admission refusee (jamais de fallback
// direct) ; paused/stopped/busy => refus code. Duree de vie : une invocation
// nav/follow = tout le trajet ; le slot ne se libere qu a la resolution
// REELLE (executor.js), jamais sur un timeout.
function physicalRefusal (code, message, extra) {
  const err = new Error(message)
  err.code = code
  if (extra) err.details = extra
  return err
}
async function runPhysical (id, kind, fn) {
  if (!physicalExecutor || typeof physicalExecutor.run !== 'function') {
    throw physicalRefusal('unavailable', 'executeur physique indisponible (fail-closed) : aucun ordre direct', { id, kind })
  }
  return physicalExecutor.run({ id, kind }, fn)
}

// Bail de touche persistante (R23) : `!avance` et `/api/control state=true`
// n appliquent plus une touche puis ne rendent le slot ; ils ACQUIERENT ce
// lease, qui tient le slot jusqu a `release()` (state=false, meme lease :
// une touche tenue par l un se libere par l autre) ou abort. Tant que le
// lease existe, l executeur lui-meme refuse tout travail normal en 'busy' :
// aucune touche persistante ne survit a la liberation, aucune operation ne
// chevauche une touche tenue. Fail-closed : sans executeur, pas de lease.
const controlLease = createControlLease({
  run: runPhysical,
  stopNavigation: () => { try { stopPathfinding() } catch (_) {} },
  applyControl: (control, state) => { bot.setControlState(control, state) },
  clearControls: () => { try { bot.clearControlStates() } catch (_) {} }
})

// Bypass proprietaire : seule la sous-etape dont le token (identite OBJET
// opaque, reference ===) egale le token courant du detenteur s execute DANS
// le slot sans reacquerir. Jamais d exemption globale : sans token => file
// d admission normale ; token inconnu/obsolete => refus 'stale' (jamais
// reexecute ni readmis comme commande independante). Le token n est derive
// d aucune donnee publique (l id de slot visible dans /api/status ne suffit
// jamais) et n est expose par aucune API : getStepToken vit cote serveur.
// Fabrique injectable : les tests branchent VRAI executor + holder factice
// sans toucher au missionRunner de prod.
function ownerBypassCheck (holder, executor, options) {
  const token = options ? options.__owner : undefined
  if (token === undefined || token === null) return 'admit'
  if (typeof token !== 'object') return 'stale'
  let current = null
  try { current = holder && typeof holder.getStepToken === 'function' ? holder.getStepToken() : null } catch (_) { current = null }
  if (!current || token !== current) return 'stale'
  let slotId = null
  try { slotId = holder && typeof holder.getStepOwner === 'function' ? holder.getStepOwner() : null } catch (_) { slotId = null }
  let busyId = null
  try { busyId = executor && typeof executor.status === 'function' ? executor.status().current?.id ?? null : null } catch (_) { busyId = null }
  if (typeof slotId === 'string' && slotId && busyId === slotId) return 'bypass'
  return 'stale'
}

function stripOwner (options) {
  if (!options || typeof options !== 'object') return options || {}
  const { __owner, ...rest } = options
  return rest
}

function createOwnerAwareNavigator ({ executor, holder, navigator, idPrefix = 'nav' }) {
  if (!executor || typeof executor.run !== 'function') {
    throw physicalRefusal('unavailable', 'executeur physique indisponible (fail-closed)')
  }
  async function admit (id, kind, fn) {
    return executor.run({ id, kind }, fn)
  }
  async function toPlayer (username, options = {}) {
    const verdict = ownerBypassCheck(holder, executor, options)
    if (verdict === 'bypass') return navigator.toPlayer(username, stripOwner(options))
    if (verdict === 'stale') {
      throw physicalRefusal('stale', 'jeton proprietaire obsolete ou forge : sous-etape hors slot refusee (fail-closed)')
    }
    return admit(
      `${idPrefix}-player-${username}-${Date.now()}`, 'work',
      async ({ signal }) => navigator.toPlayer(username, { ...stripOwner(options), signal: signal ?? options.signal }))
  }
  async function toPosition (position, options = {}) {
    const verdict = ownerBypassCheck(holder, executor, options)
    if (verdict === 'bypass') return navigator.toPosition(position, stripOwner(options))
    if (verdict === 'stale') {
      throw physicalRefusal('stale', 'jeton proprietaire obsolete ou forge : sous-etape hors slot refusee (fail-closed)')
    }
    return admit(
      `${idPrefix}-pos-${Date.now()}`, 'work',
      async ({ signal }) => navigator.toPosition(position, { ...stripOwner(options), signal: signal ?? options.signal }))
  }
  return { toPlayer, toPosition }
}

// Compatibilite : bypass prod (missionRunner reel). Les tests utilisent la
// fabrique ci-dessus avec holder injecte.
function isOwnerBypass (options) {
  try {
    return ownerBypassCheck(
      { getStepToken: () => missionRunner?.getStepToken?.(), getStepOwner: () => missionRunner?.getStepOwner?.() },
      physicalExecutor, options) === 'bypass'
  } catch (_) {
    return false
  }
}

function pauseWorkAll (reason) {
  // Physique coupe AVANT persist (latch executor synchrone), erreurs de
  // persistance remontees (jamais swallow) : l appelant annonce.
  let firstError = null
  try { physicalExecutor?.pauseWork?.(reason) } catch (err) { firstError = firstError ?? err }
  try {
    if (!objectives) throw physicalRefusal('unavailable', 'objectifs indisponibles (fail-closed)')
    objectives.pauseWork(reason)
  } catch (err) { firstError = firstError ?? err }
  if (firstError) throw firstError
}

function totalStopAll (reason) {
  let firstError = null
  try { physicalExecutor?.totalStop?.(reason) } catch (err) { firstError = firstError ?? err }
  try {
    if (!objectives) throw physicalRefusal('unavailable', 'objectifs indisponibles (fail-closed)')
    objectives.totalStop(reason)
  } catch (err) { firstError = firstError ?? err }
  if (firstError) throw firstError
}

function resumeAll (reason) {
  // Ordre corrige : la persistance controller doit REUSSIR avant de lever la
  // pause executeur, sinon le physique repart sans objectif repris (bug).
  // R04 : arbitrage ouvert -> l ancien reste en pause, pas de reprise
  // physique (le controller rearm seulement le delai restant).
  if (!objectives) throw physicalRefusal('unavailable', 'objectifs indisponibles (fail-closed)')
  objectives.resume()
  let snap = null
  try { snap = objectivesSnapshotSafe() } catch (_) { snap = null }
  if (snap && snap.arbitration) { void reason; return }
  try { physicalExecutor?.resume?.() } catch (_) {}
  void reason
}

function resetWatchdog () {
  liquidSince = null
  stuckSince = null
  stuckAnchor = null
}

// Deux jeux de regles de deplacement, parce que le bon chemin depend de ce qu on
// demande :
//   - `strict` : pour recolter. Interdiction de creuser (`canDig`) et de se
//     construire une tour (`allow1by1towers`), sinon le pathfinder s acharne a
//     grimper vers une buche en hauteur au lieu du pied de l arbre (docs/journal.md,
//     piege 7). L eau coute cher : le bot ne sait pas nager (piege 3).
//   - `climb`  : pour venir vers un joueur ou suivre. Le bot a le
//     droit de grimper un denivele et de poser un bloc pour monter. Sans cela il
//     restait bloque au pied du relief et n arrivait jamais.
//   - `dig`    : reserve au SAUVETAGE. Autorise en plus a creuser : un bot
//     encastre dans le decor (piege 6) ne peut sortir d aucune autre facon, et
//     il n a plus la teleportation. On ne l utilise jamais pour recolter, ou il
//     transformerait le paysage en tunnel.
let strictMovements = null
let climbMovements = null
let digMovements = null
let safeDigMovements = null
let joinDigMovements = null
// Trajet vers un joueur en creusant : jamais ce qu un joueur a construit ou
// range (planches, portes, vitres, coffres, lits, escaliers, dalles...).
const BUILT_BLOCK = /(_planks|_door|_trapdoor|glass|glass_pane|chest|_bed|furnace|crafting_table|_stairs|_slab|_fence|_fence_gate|_wall|bricks|torch|lantern|_wool|_carpet|barrel|anvil|_sign|bookshelf|ladder|_log|_wood|smooth_|polished_|cut_)/
// Deplacement de mission en creusant (dernier recours apres no_path) : chute
// seche bornee a deux blocs pour ne jamais se blesser (degats au-dela de
// trois), pas de parkour, liquides evites comme ailleurs.
const DIG_NAV_TIMEOUT_MS = config.positiveInt(process.env.DIG_NAV_TIMEOUT_MS, 45000, 'DIG_NAV_TIMEOUT_MS')
// Portee du but « bloc en vue » de digToward, des yeux au centre du bloc
// (but-bloc.js), sous celle des actions (4) : marge pour le poste final.
const DIG_LOOK_REACH = 3.5
// `stuck` successifs au meme endroit avant d abandonner un trajet qui creuse.
const DIG_STUCK_MAX = 3

function buildMovements () {
  if (!bot) return

  strictMovements = new Movements(bot)
  strictMovements.canDig = false
  strictMovements.allow1by1towers = false
  strictMovements.allowParkour = false
  strictMovements.liquidCost = LIQUID_COST

  climbMovements = new Movements(bot)
  climbMovements.canDig = false
  climbMovements.allow1by1towers = true
  climbMovements.allowParkour = true
  climbMovements.liquidCost = LIQUID_COST

  digMovements = new Movements(bot)
  digMovements.canDig = true
  digMovements.allow1by1towers = true
  digMovements.allowParkour = true
  digMovements.liquidCost = LIQUID_COST

  safeDigMovements = new Movements(bot)
  safeDigMovements.canDig = true
  safeDigMovements.allow1by1towers = true
  safeDigMovements.allowParkour = false
  safeDigMovements.maxDropDown = 3
  safeDigMovements.liquidCost = LIQUID_COST

  joinDigMovements = new Movements(bot)
  joinDigMovements.canDig = true
  joinDigMovements.allow1by1towers = true
  joinDigMovements.allowParkour = false
  joinDigMovements.maxDropDown = 3
  // Sans course (trajets vers un joueur) : le pathfinder creuse sous les pieds
  // des que le bot touche le sol, elan compris ; en courant, le bot glissait
  // au-dela du rebord pendant qu il creusait la marche et tombait de 5 blocs
  // (join/cliff-down, 89fa489). PAS pour la recolte (safeDigMovements) : sans
  // course, l escalier creuse vers le haut du plateau expirait (terrain/plateau
  // a45b981, 9b5fe31, 212ccac ; 89fa489 : chemin creuse sur 6,5 blocs).
  joinDigMovements.allowSprinting = false
  // Le bot ne ressort pas de l eau en 26.1 : un pont de terre vaut mieux.
  joinDigMovements.liquidCost = 200
  for (const block of Object.values(bot.registry.blocksByName)) {
    if (BUILT_BLOCK.test(block.name)) joinDigMovements.blocksCantBreak.add(block.id)
  }

  setNavigation('strict')
}

// Rejoindre `position` a moins de `range` blocs en creusant ce qui barre le
// chemin (terre, feuilles...), en escalier pour descendre ou remonter, sans
// chute de plus de deux blocs. Toujours borne (delai + signal) et toujours
// nettoye : objectif du pathfinder annule, regles strictes remises.
//
// `block` (position entiere d un bloc a casser) : le but devient « bloc en vue
// et a portee » (GoalLookAtBlock) au lieu d un rayon autour de `position`.
// GoalNear arrondit le centre du bloc : pour un bloc du sol (y 199), un poste
// debout a cote (pieds a 200) comptait un bloc d ecart de trop, et le trajet
// creusait un trou au pied du mur (gather/sand-walled cabbdfcd).
async function digToward (position, { signal = null, range = 3, timeoutMs = DIG_NAV_TIMEOUT_MS, protectBuilt = false, block = null } = {}) {
  if (missionRunner.featureOn('nav_creuse', false)) return digTowardNavigateur(position, { signal, range, timeoutMs, protectBuilt, block })
  const movements = protectBuilt ? joinDigMovements : safeDigMovements
  if (!bot?.pathfinder || !movements || !bot.entity) return { reached: false, code: 'unavailable' }
  const start = bot.entity.position.clone()
  // R01 : le trajet qui creuse ne rend JAMAIS avant le settle reel du goto.
  // Timeout, abort et stuck appellent l annulation concrete (setGoal(null))
  // puis attendent le settle, et seulement apres rendent leur code. Sans
  // cela, le slot (etape mission ou commande) se liberait pendant que le bot
  // marchait encore, et l operation suivante chevauchait.
  let timer = null
  let onAbort = null
  let onReset = null
  let timedOut = false
  let abortFired = Boolean(signal && signal.aborted)
  let stuckFired = false
  const cancelGoto = () => { try { bot.pathfinder.setGoal(null) } catch (_) {} }
  stopPathfinding()
  bot.pathfinder.setMovements(movements)
  const goal = block
    ? new GoalBlocEnVue(block, bot.world, { reach: DIG_LOOK_REACH })
    : new goals.GoalNear(position.x, position.y, position.z, range)
  const settleGate = bot.pathfinder.goto(goal).then(
    value => ({ ok: true, value }),
    error => ({ ok: false, error })
  )
  const latchGate = new Promise(resolve => {
    if (timeoutMs > 0) {
      timer = setTimeout(() => { timedOut = true; cancelGoto(); resolve('timeout') }, timeoutMs)
    }
    if (signal) {
      if (signal.aborted) {
        abortFired = true
        cancelGoto()
        resolve('abort')
      } else if (typeof signal.addEventListener === 'function') {
        onAbort = () => { abortFired = true; cancelGoto(); resolve('abort') }
        try { signal.addEventListener('abort', onAbort, { once: true }) } catch { /* ecoute best-effort */ }
      }
    }
    // Le pathfinder replanifie sans fin le meme pas impossible (montee d un
    // bloc dans une ouverture de deux de haut : la tete touche) et le bot
    // restait sur place jusqu au delai, 45 s (gather/sand-walled cabbdfcd).
    // Plusieurs `stuck` sans bouger : echec franc, apres le settle.
    let stuck = 0
    let from = null
    onReset = reason => {
      if (reason !== 'stuck' || !bot.entity) return
      if (!from || bot.entity.position.distanceTo(from) > 0.5) {
        from = bot.entity.position.clone()
        stuck = 0
      }
      stuck += 1
      if (stuck >= DIG_STUCK_MAX && !stuckFired) {
        stuckFired = true
        cancelGoto()
        resolve('stuck')
      }
    }
    bot.on('path_reset', onReset)
  })
  try {
    await Promise.race([settleGate, latchGate])
    const settle = await settleGate // <-- jamais de retour avant ce settle
    if (abortFired || (signal && signal.aborted)) {
      return { reached: false, code: 'cancelled', travelled: Number(start.distanceTo(bot.entity.position).toFixed(2)), detail: 'annule' }
    }
    if (!settle.ok) {
      const message = String(settle.error?.message ?? settle.error)
      // « Took to long to decide path » : l A* a epuise son temps, pas les
      // chemins ; no_path a tort egarait le diagnostic (far-hedge-pit).
      const code = /annule/.test(message) ? 'cancelled' : /Took to long|timeout/i.test(message) ? 'timeout' : 'no_path'
      return { reached: false, code, travelled: Number(start.distanceTo(bot.entity.position).toFixed(2)), detail: message.slice(0, 120) }
    }
    if (timedOut) {
      return { reached: false, code: 'timeout', travelled: Number(start.distanceTo(bot.entity.position).toFixed(2)), detail: 'timeout' }
    }
    if (stuckFired) {
      return { reached: false, code: 'stuck', travelled: Number(start.distanceTo(bot.entity.position).toFixed(2)), detail: 'stuck' }
    }
    const distance = bot.entity.position.distanceTo(position)
    return { reached: block ? true : distance <= range + 1, code: 'dug', travelled: Number(start.distanceTo(bot.entity.position).toFixed(2)), distance }
  } catch (err) {
    const message = String(err?.message ?? err)
    const code = /Took to long|timeout/i.test(message) ? 'timeout' : /annule/.test(message) ? 'cancelled' : /^stuck$/.test(message) ? 'stuck' : 'no_path'
    return { reached: false, code, travelled: Number(start.distanceTo(bot.entity.position).toFixed(2)), detail: message.slice(0, 120) }
  } finally {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener?.('abort', onAbort)
    if (onReset) bot.removeListener('path_reset', onReset)
    stopPathfinding()
    setNavigation('strict')
    try { bot.clearControlStates() } catch (_) {}
  }
}

// Meme contrat que digToward, par le navigateur partage en mode creuser
// (interrupteur nav_creuse, eteint par defaut, mesure en A/B par
// avec('nav_creuse')) : A* du pathfinder pour le calcul seulement, casse et
// pas executes et mesures localement. Si l A/B le confirme, le pathfinder ne
// sert plus qu aux commandes !va/!viens et au sauvetage.
async function digTowardNavigateur (position, { signal, range, timeoutMs, protectBuilt, block }) {
  if (!bot?.entity) return { reached: false, code: 'unavailable' }
  const start = bot.entity.position.clone()
  const cantBreak = protectBuilt
    ? Object.values(bot.registry.blocksByName).filter(b => BUILT_BLOCK.test(b.name)).map(b => b.id)
    : []
  const V = bot.entity.position.constructor
  const target = block ? new V(block.x + 0.5, block.y + 0.5, block.z + 0.5) : position
  const result = await navigator.toPosition(target, {
    signal, timeoutMs, radius: range, interaction: Boolean(block),
    dig: {
      cantBreak,
      canBreak: b => !(protectBuilt && BUILT_BLOCK.test(b.name)) && b.diggable !== false &&
        Number.isFinite(b.hardness) && b.hardness >= 0,
      digBlock: async b => {
        try {
          await craft.equipForBlock(bot, b)
          await bot.dig(b, true)
        } catch (_) {
          return false
        }
        return bot.blockAt(b.position)?.boundingBox !== 'block'
      }
    }
  })
  const distance = bot.entity.position.distanceTo(position)
  return { reached: Boolean(result.reached), code: result.reached ? 'dug' : result.code,
    travelled: Number(start.distanceTo(bot.entity.position).toFixed(2)), distance }
}

// Choisit le jeu de regles courant. `strict` par defaut : tout ce qui n est pas
// explicitement un deplacement vers un joueur, des coordonnees ou un sauvetage
// recolte prudemment.
function setNavigation (mode) {
  if (!bot?.pathfinder) return
  const chosen = mode === 'climb' ? climbMovements : (mode === 'dig' ? digMovements : strictMovements)
  if (chosen) bot.pathfinder.setMovements(chosen)
}

function say (text) {
  if (bot && spawned) bot.chat(text)
}

// Destination a rejoindre a pied pour se degager : le point le plus recent de
// la trace qui soit assez loin d ici. Sans cela on ne bougerait pas d un bloc.
function escapePosition () {
  if (!bot?.entity) return null

  const here = bot.entity.position

  for (let i = safeTrail.length - 1; i >= 0; i -= 1) {
    if (safeTrail[i].distanceTo(here) >= ESCAPE_MIN_DISTANCE) return safeTrail[i]
  }

  if (lastSafePosition && lastSafePosition.distanceTo(here) >= ESCAPE_MIN_DISTANCE) {
    return lastSafePosition
  }

  // Rien d assez loin : remonter de deux blocs suffit a sortir d un coincement.
  return here.offset(0, 2, 0)
}

// Dernier recours : **rejoindre a pied** la derniere position sure connue.
//
// C etait un `/tp`, et c est la perte la plus lourde du retrait des pouvoirs
// d administration. Le bot ne sait pas nager sur cette version (piege 3) : la
// teleportation etait le seul moyen fiable de sortir d un bassin. Desormais,
// s il tombe dans l eau profonde, il peut **y rester**. Il le dit alors dans le
// chat au lieu de s epuiser en silence, et c est au joueur de le sortir.
//
// Les bassins de test du monde (~65, 63, -100) sont donc devenus des pieges
// reels et non plus une demonstration de sauvetage.
// Attente interrompue par le signal du slot : un rescue annule (pauseWork)
// libere le slot vite au lieu de tenir jump pendant toute la duree.
function sleepAbortable (ms, signal) {
  if (!signal || typeof signal.addEventListener !== 'function') {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const cleanup = () => { try { signal.removeEventListener('abort', onAbort) } catch (_) {} }
    const onAbort = () => { clearTimeout(timer); cleanup(); resolve() }
    const timer = setTimeout(() => { cleanup(); resolve() }, ms)
    try { signal.addEventListener('abort', onAbort, { once: true }) } catch { resolve() }
  })
}

// Marche vers `destination` SANS prendre de slot : l appelant detient deja le
// slot survie (rescue en une seule prise) ou en prend un (walkToSafety).
// R01 : le timeout annule le goto (setGoal(null)) puis attend son settle reel
// avant de rendre 'trajet trop long' ; le slot reste tenu jusque-la.
async function walkToDestination (destination, signal) {
  const { x, y, z } = destination
  stopPathfinding()
  // Se degager d un trou ou d un encastrement autorise le creusage : un bot
  // coince dans le decor ne peut sortir autrement (plus de teleportation).
  setNavigation('dig')
  await awaitPhysicalWithTimeout(
    bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1)),
    RESCUE_WALK_TIMEOUT_MS,
    'trajet trop long',
    { signal, onTimeout: () => { try { bot.pathfinder.setGoal(null) } catch (_) {} } }
  )
  if (signal?.aborted) throw Object.assign(new Error('sauvetage annule'), { code: 'cancelled' })
}

async function walkToSafety (reason) {
  const destination = escapePosition()

  if (!destination) {
    lastRescue = { at: new Date().toISOString(), reason, action: 'none', detail: 'aucune position sure memorisee' }
    return false
  }

  const { x, y, z } = destination

  try {
    // Sauvetage DANS le slot survie : le timeout borne l attente mais ne
    // libere jamais le slot (resolution reelle du callback uniquement).
    // R03 : echec et annulation ne sont jamais comptes comme un succes.
    await runPhysicalOrThrow(runPhysical, `rescue-walk-${Date.now()}`, 'survival', async ({ signal }) => {
      await walkToDestination(destination, signal)
      return { walked: true }
    })
    rescueCount += 1
    lastRescue = {
      at: new Date().toISOString(),
      reason,
      action: 'walk',
      to: { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)), z: Number(z.toFixed(2)) }
    }
    console.log(`[rescue] ${reason} -> rejoint a pied ${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}`)
    return true
  } catch (err) {
    try { bot.pathfinder.setGoal(null) } catch (_) {}
    if (err && err.code === 'cancelled') {
      lastRescue = { at: new Date().toISOString(), reason, action: 'cancelled' }
      return false
    }
    if (err && (err.code === 'paused' || err.code === 'stopped' || err.code === 'busy' || err.code === 'unavailable')) {
      lastRescue = { at: new Date().toISOString(), reason, action: `refused-${err.code}`, detail: err.message }
      return false
    }
    lastRescue = { at: new Date().toISOString(), reason, action: 'failed', detail: err.message }
    console.error(`[rescue] ${reason} -> impossible de rejoindre la terre ferme : ${err.message}`)
    // Sans pouvoir se teleporter, le bot n a plus qu a demander de l aide.
    say(`Coincé (${reason}), aide-moi.`)
    return false
  }
}

// On tente d abord de nager seul ; le reste se fait a pied (voir walkToSafety).
//
// `escalate` signifie "on lui a demande de bouger et il n a pas bouge". Sur la
// terre ferme, annuler l objectif ne degage pas un bot encastre dans le decor :
// on tente un saut, puis on rejoint la derniere position sure **en creusant**
// (`setNavigation('dig')`), seul moyen restant depuis le retrait des pouvoirs
// d administration (piege 18). `!sors` et `/api/unstuck` escaladent aussi : un
// saut sur place ne deplace plus un bot qui allait tres bien.
async function rescue (reason, { escalate = false } = {}) {
  if (rescuing || !bot || !spawned) return
  // Arret total : rescue interdit (fail-closed, D18). On le dit une fois.
  if (isHardStopped()) {
    lastRescue = { at: new Date().toISOString(), reason, action: 'refused-hardstop' }
    return
  }
  // AUCUNE mutation avant l admission : le slot survie est acquis D ABORD, et
  // toutes les mutations (stop, touches, goto) vivent DEDANS. Slot tenu
  // (travail en cours, meme sourd a l abort) => refus honnete sans
  // chevauchement : preemption = pauseWork puis vraie sortie, jamais de
  // mutation simultanee. Le chien de garde reessaiera au prochain tick.
  rescuing = true

  try {
    try {
      // R03 : echec et annulation du slot survie ne sont jamais des succes.
      await runPhysicalOrThrow(runPhysical, `rescue-${Date.now()}`, 'survival', async ({ signal }) => {
        console.log(`[rescue] triggered: ${reason}`)
        const wasInLiquid = inLiquid()
        const before = bot.entity.position.clone()

        stopPathfinding()
        try { bot.clearControlStates() } catch (_) {}

        if (!signal?.aborted) {
          if (wasInLiquid) {
            bot.setControlState('jump', true)
            await sleepAbortable(2500, signal)
            try { bot.setControlState('jump', false) } catch (_) {}
          } else if (escalate) {
            // Un saut sur place libere la plupart des coincements, sans deplacer le
            // bot si tout allait bien.
            bot.setControlState('jump', true)
            await sleepAbortable(1200, signal)
            try { bot.clearControlStates() } catch (_) {}
          }
        }

        if (signal?.aborted) throw Object.assign(new Error('sauvetage annule'), { code: 'cancelled' })

        const moved = bot.entity ? bot.entity.position.distanceTo(before) : 0
        const stillStuck = inLiquid() || (escalate && moved < 0.5)

        if (stillStuck) {
          // Meme marche que walkToSafety, mais DANS ce slot (pas de run
          // imbrique, qui serait refuse busy par soi-meme).
          const destination = escapePosition()
          if (!destination) {
            lastRescue = { at: new Date().toISOString(), reason, action: 'none', detail: 'aucune position sure memorisee' }
            return { walked: false }
          }
          await walkToDestination(destination, signal)
          await sleepAbortable(500, signal)
          if (signal?.aborted) throw Object.assign(new Error('sauvetage annule'), { code: 'cancelled' })
          const { x, y, z } = destination
          rescueCount += 1
          lastRescue = {
            at: new Date().toISOString(),
            reason,
            action: 'walk',
            to: { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)), z: Number(z.toFixed(2)) }
          }
          console.log(`[rescue] ${reason} -> rejoint a pied ${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}`)
          return { walked: true }
        }
        const action = wasInLiquid ? 'swam out' : 'cleared goal and controls'
        rescueCount += 1
        lastRescue = { at: new Date().toISOString(), reason, action }
        console.log(`[rescue] ${action}, no teleport needed`)
        return { walked: false }
      })
    } catch (err) {
      if (err && (err.code === 'paused' || err.code === 'stopped' || err.code === 'busy' || err.code === 'unavailable')) {
        lastRescue = { at: new Date().toISOString(), reason, action: `refused-${err.code}`, detail: err.message }
        return
      }
      if (err && err.code === 'cancelled') {
        lastRescue = { at: new Date().toISOString(), reason, action: 'cancelled' }
        return
      }
      throw err
    }
  } catch (err) {
    lastRescue = { at: new Date().toISOString(), reason, action: 'failed', detail: err.message }
    console.error('[rescue] failed:', err.message)
  } finally {
    resetWatchdog()
    rescuing = false
  }
}

function watchdogTick () {
  if (!bot || !spawned || !bot.entity || rescuing) return
  // Arret total : aucune reprise automatique, y compris de survie (D14/D18).
  // Fail-closed : le chien de garde se tait, le rescue est interdit.
  if (isHardStopped()) {
    liquidSince = null
    stuckSince = null
    stuckAnchor = null
    return
  }

  const now = Date.now()
  const position = bot.entity.position

  if (!inLiquid() && bot.entity.onGround) {
    lastSafePosition = position.clone()

    const last = safeTrail[safeTrail.length - 1]
    if (!last || last.distanceTo(position) > SAFE_TRAIL_MIN_STEP) {
      safeTrail.push(position.clone())
      if (safeTrail.length > SAFE_TRAIL_MAX) safeTrail.shift()
    }
  }

  if (now < rescueCooldownUntil) return

  if (inLiquid()) {
    if (!liquidSince) liquidSince = now
    if (now - liquidSince >= LIQUID_GRACE_MS) {
      rescue('stuck in liquid')
      return
    }
  } else {
    liquidSince = null
  }

  // Asked to move but not actually moving: the path is a dead end. Following a
  // player is exempt, since standing next to them is the goal being satisfied.
  //
  // Une mission est exempte elle aussi : elle a son propre detecteur de blocage
  // (`mission.detectStuck`), et le chien de garde qui annulait
  // les deplacements en plein vol ne faisait que casser les trajets des qu un
  // calcul de chemin depassait 7 s (piege 15). Le sauvetage aquatique, lui,
  // reste actif : il est teste avant cette branche.
  if (followMode || navigator.isActive() || missionRunner.isRunning()) {
    stuckSince = null
    stuckAnchor = null
  } else if (hasActiveGoal() || hasActiveControl()) {
    if (!stuckAnchor || stuckAnchor.distanceTo(position) > STUCK_EPSILON) {
      stuckAnchor = position.clone()
      stuckSince = now
    } else if (now - stuckSince >= STUCK_GRACE_MS) {
      rescueCooldownUntil = now + RESCUE_COOLDOWN_MS
      rescue('no progress while moving', { escalate: true })
    }
  } else {
    stuckSince = null
    stuckAnchor = null
  }
}

// ---------------------------------------------------------------------------
// Missions : la boucle vit dans mission.js, qui accede au bot par cet objet.
// Le bot est recree a chaque reconnexion, d ou les accesseurs plutot que la
// reference.
// ---------------------------------------------------------------------------

let ownerNav = null

function ownerAwareNavigateToPlayer (username, options = {}) {
  if (!ownerNav) {
    throw physicalRefusal('unavailable', 'navigateur proprietaire non initialise (fail-closed)')
  }
  return ownerNav.toPlayer(username, options)
}

function ownerAwareNavigateToPosition (position, options = {}) {
  if (!ownerNav) {
    throw physicalRefusal('unavailable', 'navigateur proprietaire non initialise (fail-closed)')
  }
  return ownerNav.toPosition(position, options)
}

const missionRunner = createMissionRunner({
  getBot: () => bot,
  isReady: () => Boolean(bot && spawned && bot.entity),
  // Ecrire dans le chat du serveur. C est aussi une action de mission a part
  // entiere (`dire`) : le bot rend compte de ce qu il fait au lieu de
  // travailler en silence.
  chat: say,
  rescue,
  stopPathfinding,
  inLiquid,
  // Executeur + objectifs durables (cycle C0/C5) : la boucle mission enveloppe
  // chaque etape dans l executeur (kind 'work') et reporte la progression.
  executor: physicalExecutor,
  objectives,
  // La mission recolte en mode `strict` (pas de grimpe, pas de creusage) ; elle
  // rappelle ce mode au debut de chaque deplacement pour ne pas heriter de
  // `climb` laisse par un `!viens` juste avant.
  setNavigation,
  // Navigation via l executeur : UNE invocation = TOUT le trajet (lifetime).
  // Le slot ne se libere qu a la resolution reelle ; un stop n y readmet aucun
  // callback tardif (enveloppe cancelled ignoree par l appelant mission).
  // Reentrance proprietaire : l etape mission qui tient le slot y fait passer
  // ses sous-etapes nav (token __owner), sans reacquerir.
  navigateToPlayer: (username, options = {}) => ownerAwareNavigateToPlayer(username, options),
  navigateToPosition: (position, options = {}) => ownerAwareNavigateToPosition(position, options),
  // Dernier recours de la recolte apres no_path : trajet qui creuse.
  digToward: (position, options = {}) => digToward(position, options),
  // Les cinq derniers messages du chat, reinjectes dans l etat a chaque etape.
  recentChat: () => recentChat.slice(-5)
})

// Navigateur proprietaire prod : holder = missionRunner reel (token opaque
// interne), executor reel. Initialise apres le runner (closures tardives).
// Echec fail-closed : ownerNav null => wrappers refusent 'unavailable'.
try {
  ownerNav = createOwnerAwareNavigator({
    executor: physicalExecutor,
    holder: {
      getStepToken: () => missionRunner.getStepToken(),
      getStepOwner: () => missionRunner.getStepOwner()
    },
    navigator
  })
} catch (err) {
  console.error(`[nav] navigateur proprietaire indisponible : ${err.message}`)
  ownerNav = null
}

// ---------------------------------------------------------------------------
// Commandes : un handler par nom canonique de skills.COMMANDS.
// skills.audit() compare les deux listes au demarrage.
// ---------------------------------------------------------------------------

// Admission physique d abord (fail-closed busy/stop), jamais d annulation
// avant admission : le slot decide, pas l appelant.
function requireAdmissionOrThrow () {
  if (durableCorrupted() || !objectives) {
    throw physicalRefusal('unavailable', `objectifs indisponibles${durablePersistError() ? ` : ${durablePersistError()}` : ''} (fail-closed)`)
  }
  if (isHardStopped()) throw physicalRefusal('stopped', 'arret total : reprends d abord')
  try {
    const st = physicalExecutor ? physicalExecutor.status() : null
    if (st && st.stopped) throw physicalRefusal('stopped', 'arret total : reprends d abord')
    if (st && st.paused) throw physicalRefusal('paused', 'travail en pause')
    if (st && st.busy) throw physicalRefusal('busy', `executeur occupe par ${st.current?.id}`)
  } catch (err) {
    if (err && err.code) throw err
    throw physicalRefusal('unavailable', 'admission indisponible (fail-closed)')
  }
}

function startOnly (control) {
  // Touche directe en LEASE explicite (R23) : acquire applique la touche DANS
  // le slot et le TIENT jusqu a release (state=false, meme lease, via
  // /api/control ou une autre touche). Tant que le lease existe, l executeur
  // refuse tout travail normal en 'busy' : pas de chevauche, pas de touche
  // persistante hors propriete. Erreurs d admission dites dans le chat : false.
  try {
    requireAdmissionOrThrow()
  } catch (err) {
    say(`Ordre refuse (${err.code || 'refus'}) : ${err.message}`)
    return false
  }
  if (controlLease.status().held) {
    say(`Ordre refuse (busy) : touche ${controlLease.status().control} tenue`)
    return false
  }
  controlLease.acquire(control, `cmd-touch-${control}-${Date.now()}`).catch(err => {
    say(`Ordre refuse (${err.code || 'refus'}) : ${err.message}`)
  })
  return true
}

// « saute 3 fois » : le classificateur a reconnu l action, pas le nombre. Le
// compte se lit donc dans le texte de la meme facon que build.parseDimensions
// lit les dimensions d une maison, et jamais dans la reponse du modele. C est la
// regle du projet : le modele classe, le code compte.
const FRENCH_NUMBERS = {
  un: 1, deux: 2, trois: 3, quatre: 4, cinq: 5,
  six: 6, sept: 7, huit: 8, neuf: 9, dix: 10
}
const REPEAT_PATTERN = /(\d{1,2}|un|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*(?:fois|reprises?|x)\b/i
const MAX_REPEAT = 10

function repeatCount (text) {
  const match = REPEAT_PATTERN.exec(String(text || ''))
  if (!match) return 1

  const token = match[1].toLowerCase()
  const value = FRENCH_NUMBERS[token] ?? Number(token)
  if (!Number.isFinite(value) || value < 1) return 1

  return Math.min(MAX_REPEAT, Math.round(value))
}

const HANDLERS = {
  aide () {
    for (const line of skills.helpLines(CMD_PREFIX)) say(line)
    say(`Ecris aussi en langage naturel : c est ${planner.MODEL} qui decide de l action.`)
  },

  avance () {
    if (startOnly('forward')) say('J avance')
  },

  recule () {
    if (startOnly('back')) say('Je recule')
  },

  gauche () {
    if (startOnly('left')) say('Je vais a gauche')
  },

  droite () {
    if (startOnly('right')) say('Je vais a droite')
  },

  async saute (username, args, raw) {
    // Le nombre vient du texte, pas du modele (voir repeatCount).
    const count = repeatCount(args.join(' ') || raw)

    say(count > 1 ? `Je saute ${count} fois` : 'Je saute')

    try {
      requireAdmissionOrThrow()
    } catch (err) {
      say(`Saut refuse (${err.code || 'refus'}) : ${err.message}`)
      return
    }
    try {
      // R03 : echec et annulation ne sont jamais des succes silencieux.
      const outcome = await runPhysicalOrThrow(runPhysical, `cmd-saute-${Date.now()}`, 'work', async ({ signal }) => {
        for (let i = 0; i < count; i += 1) {
          if (!bot || !spawned || signal?.aborted) return { cancelled: Boolean(signal?.aborted) }
          bot.setControlState('jump', true)
          await new Promise(resolve => setTimeout(resolve, 300))
          bot.setControlState('jump', false)
          // Retomber avant de redecoller : sans cette pause les sauts se chevauchent
          // et le serveur n en compte qu un.
          await new Promise(resolve => setTimeout(resolve, 350))
        }
        return { count }
      })
      if (outcome && outcome.cancelled) say('Saut interrompu.')
    } catch (err) {
      if (err && (err.code === 'paused' || err.code === 'stopped' || err.code === 'busy' || err.code === 'unavailable')) {
        say(`Saut refuse (${err.code || 'refus'}) : ${err.message}`)
      } else if (err && err.code === 'cancelled') {
        say('Saut interrompu.')
      } else {
        say(`Saut impossible (${(err && err.code) || 'erreur'}) : ${err.message}`)
      }
    }
  },

  stop () {
    // Stop du travail (D18) : pause durable, contexte conserve, hors LLM.
    // Physique coupe AVANT persist ; erreurs de persistance remontees au chat
    // (jamais swallow) : en cas d echec disque, le physique reste coupe.
    conversation.cancel()
    const errors = []
    try { physicalExecutor?.pauseWork?.('stop demande par le joueur') } catch (err) { errors.push(err) }
    stopPathfinding()
    try { bot.clearControlStates() } catch (_) {}
    resetWatchdog()
    const hadMission = missionRunner.isRunning() || missionRunner.isPaused?.()
    if (missionRunner.isRunning()) missionRunner.pauseWork('stop demande par le joueur')
    try {
      if (!objectives) throw physicalRefusal('unavailable', 'objectifs indisponibles (fail-closed)')
      objectives.pauseWork('stop demande par le joueur')
    } catch (err) { errors.push(err) }
    if (errors.length > 0) {
      say(`Pause exige : ${errors.map(e => e.message).join(' ; ')} (physique coupe, a verifier)`)
    } else if (!hadMission) say('Stop.')
    else say('Pause.')
  },

  va (username, args) {
    const [x, y, z] = args.map(Number)
    if (![x, y, z].every(Number.isFinite)) {
      say(`Usage: ${CMD_PREFIX}va <x> <y> <z>`)
      return
    }
    // Admission AVANT toute annulation : un refus busy/stop ne detruit rien.
    try {
      requireAdmissionOrThrow()
    } catch (err) {
      say(`Deplacement refuse (${err.code || 'refus'}) : ${err.message}`)
      return
    }
    // Meme navigation mesuree que rejoindre/suivre ; le writer reste detenu
    // jusqu au resultat physique, meme si le calcul A* a deja termine.
    say(`Je vais en ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)}`)
    const target = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }
    // R03 : echec et annulation ne sont jamais des succes silencieux : le
    // resultat final est dit, avec son code (slot libere dans tous les cas).
    runPhysicalOrThrow(runPhysical, `cmd-va-${Date.now()}`, 'work', async ({ signal }) => {
      if (signal?.aborted) {
        const err = new Error('deplacement annule')
        err.code = 'cancelled'
        throw err
      }
      stopPathfinding()
      return await navigator.toPosition(target, { signal, radius: 1 })
    }).then(result => {
      if (result && !result.reached && result.code !== 'cancelled') {
        say(`Je ne peux pas atteindre ces coordonnees : ${result.code}`)
      } else if (!result) {
        say('Je ne peux pas atteindre ces coordonnees : sans_resultat')
      }
    }).catch(err => {
      if (err && (err.code === 'paused' || err.code === 'stopped' || err.code === 'busy' || err.code === 'unavailable')) {
        say(`Deplacement refuse (${err.code}) : ${err.message}`)
      } else if (err && err.code === 'cancelled') {
        // Stop pendant le trajet : silence, jamais un succes.
      } else {
        say(`Je ne peux pas atteindre ces coordonnees : ${(err && err.code) || 'erreur'}`)
        console.error(`[nav] va impossible : ${err.message}`)
      }
    })
  },

  async viens (username) {
    const target = bot.players[username]?.entity
    if (!target) {
      say('Je ne te vois pas.')
      return
    }
    try {
      requireAdmissionOrThrow()
    } catch (err) {
      say(`Suivi refuse (${err.code || 'refus'}) : ${err.message}`)
      return
    }

    say('J arrive.')
    let result
    try {
      // R03 : enveloppe deballee ; echec et annulation ne sont jamais lus
      // comme un succes, et une valeur absente n est jamais dereferencee.
      result = await runPhysicalOrThrow(runPhysical, `cmd-viens-${username}-${Date.now()}`, 'work',
        async ({ signal }) => {
          missionRunner.stop('remplacee par un suivi')
          stopPathfinding()
          return navigator.toPlayer(username, { follow: true, signal })
        })
    } catch (err) {
      // Enveloppe cancelled = stop pendant le trajet : silence, jamais un succes.
      if (err && err.code === 'cancelled') return
      say(`Rejoindre impossible (${(err && err.code) || 'refus'}) : ${err.message}`)
      return
    }
    if (!result || (result.code !== 'cancelled' && !result.reached)) say(`Rejoindre impossible : ${result?.code ?? 'sans_resultat'}`)
  },

  sors (username) {
    say('Je me dégage…')
    rescue(`requested by ${username}`, { escalate: true })
  },

  ou () {
    const p = bot.entity.position
    say(`Je suis en ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}${inLiquid() ? ' (dans un liquide)' : ''}`)
  },

  async vois (username) {
    // L entite d un joueur n existe que si elle est chargee autour du bot : sa
    // presence est exactement la reponse a « est-ce que tu me vois ».
    const target = bot.players[username]?.entity

    if (!target) {
      say('Je ne te vois pas.')
      return
    }

    const here = bot.entity.position
    const distance = here.distanceTo(target.position)
    const dx = target.position.x - here.x
    const dz = target.position.z - here.z
    const direction = Math.abs(dx) >= Math.abs(dz)
      ? (dx >= 0 ? 'est' : 'ouest')
      : (dz >= 0 ? 'sud' : 'nord')

    say(`Vu : ${distance.toFixed(1)} blocs, ${direction}.`)
    // Se tourner vers le joueur, mais JAMAIS hors-slot : slot tenu (mission,
    // touche en lease, trajet) => purement observationnel, yaw/pitch
    // intacts. Sinon le regard passe par le writer, borne comme ailleurs.
    try {
      requireAdmissionOrThrow()
    } catch {
      return
    }
    try {
      // R03 : deballe, jamais de succes sur echec/annulation. La reponse
      // observationnelle a deja ete dite : un echec reste silencieux ici.
      await runPhysicalOrThrow(runPhysical, `cmd-vois-${Date.now()}`, 'work', async () => {
        stopPathfinding()
        await awaitPhysicalWithTimeout(
          bot.lookAt(target.position.offset(0, 1, 0), true),
          3000,
          'visee trop longue'
        )
        return { looked: true }
      })
    } catch {
      // Admission perdue entre-temps ou visee trop longue : la reponse
      // observationnelle a deja ete dite, rien a ajouter.
    }
  },

  async mission (username, args, raw) {
    // Meme intake durable que le chat et /api (hardstop + arbitrage), jamais
    // de demarrage direct contournant le controleur.
    const objective = args.length > 0 ? args.join(' ') : raw
    conversation.cancel(false)
    const result = await startObjectiveDurable(objective, username)
    if (!result.ok && !result.arbitration && !result.queued) say(`Mission impossible : ${result.error}`)
  }
}

function handleHardStop () {
  conversation.cancel(true)
  const errors = []
  try { totalStopAll('arret total demande') } catch (err) { errors.push(err) }
  stopPathfinding()
  try { bot.clearControlStates() } catch (_) {}
  resetWatchdog()
  if (missionRunner.isRunning()) missionRunner.pauseWork('arret total')
  if (errors.length > 0) say(`Arret total partiel : ${errors.map(e => e.message).join(' ; ')} (physique coupe, a verifier)`)
  else say('Arrêt total. « reprends » pour relancer.')
}

function handleResume () {
  // R04 : arbitrage ouvert -> l ancien reste en pause, on rearm seulement le
  // delai restant (controller), jamais de reprise mission/physique.
  let preSnap = null
  try { preSnap = objectivesSnapshotSafe() } catch (_) { preSnap = null }
  if (preSnap && preSnap.arbitration) {
    try {
      resumeAll()
    } catch (err) {
      say(`Reprise impossible : ${err.message} (pause maintenue)`)
      return
    }
    let post = null
    try { post = objectivesSnapshotSafe() } catch (_) { post = null }
    // Expiration survenue au resume (echeance depassee) : poursuivre le
    // parcours normal ci-dessous ; sinon garder la pause d arbitrage.
    if (post && post.arbitration) {
      say('Arbitrage en cours : je garde la pause, « remplace » ou « reprends après » ?')
      return
    }
  }
  // 1. Mission en pause en memoire : reprise directe (persistance d abord).
  const m0 = missionRunner.status()
  if (m0 && m0.etat === 'paused') {
    try {
      resumeAll()
    } catch (err) {
      say(`Reprise impossible : ${err.message} (pause maintenue)`)
      return
    }
    if (missionRunner.resumeWork?.()) say('Je reprends.')
    else say('Prêt.')
    return
  }
  // 2. Permanent en attente de maintenance : pas de boucle aveugle, on
  // attend une observation pertinente (moteur de maintenance non livrable).
  if (m0 && m0.maintenance === 'waiting-maintenance') {
    say('En entretien, j observe.')
    return
  }
  // 3. Apres restart : aucun objet vivant, mais un engagement durable.
  // D18 : la reprise explicite leve D'ABORD le verrou durable (la persistance
  // doit reussir) + l'executor, independamment de la capacite a rejouer la
  // mission. Panne persist -> verrou maintenu, executor stoppe (fail-closed).
  // Si l'objectif n'est pas rehydratable (descripteur manquant) : on
  // n'invente rien, on n'efface rien (evidence + objectif conserves) ;
  // attente honnete via l'outil existant, commandes explicites et nouveaux
  // objectifs (arbitrage) restant permis — rien n'est demarre seul.
  let snap = null
  try { snap = objectivesSnapshotSafe() } catch (_) { snap = null }
  if (snap && snap.arbitration) {
    try { resumeAll() } catch (err) {
      say(`Reprise impossible : ${err.message} (pause maintenue)`)
      return
    }
    try { snap = objectivesSnapshotSafe() } catch (_) { snap = null }
    if (snap && snap.arbitration) {
      say('Arbitrage en cours : je garde la pause, « remplace » ou « reprends après » ?')
      return
    }
  }
  const cur = snap?.current
  if (cur && (cur.statut === 'paused' || cur.statut === 'stopped' || cur.statut === 'active')) {
    try {
      resumeAll()
    } catch (err) {
      say(`Reprise impossible : ${err.message} (arret maintenu)`)
      return
    }
    let out = null
    try {
      out = missionRunner.rehydrate?.(cur)
    } catch (err) {
      try { objectives.pauseWork('en attente de reprise explicite') } catch (_) {}
      say(`Verrou leve, reprise en attente : ${err.message} (nouvel objectif possible)`)
      return
    }
    if (out && out.ok) {
      say(`Reprise : « ${cur.texte} ».`)
    } else {
      try { objectives.pauseWork('en attente de reprise explicite') } catch (_) {}
      say(`Reprise impossible : ${out?.error ?? 'inconnu'} (engagement conserve, nouvel objectif possible)`)
    }
    return
  }
  // 4. Rien a reprendre : lever un eventuel arret, rester disponible.
  if (snap?.hardstop || snap?.workPaused) {
    try {
      resumeAll()
    } catch (err) {
      say(`Reprise impossible : ${err.message} (pause maintenue)`)
      return
    }
  }
  say('Prêt.')
}

async function runCommand (username, cmd, args, raw) {
  const name = skills.resolve(cmd)

  if (!name) {
    say(`Commande inconnue. ${CMD_PREFIX}aide pour la liste`)
    return
  }

  await HANDLERS[name](username, args, raw)
}

// ---------------------------------------------------------------------------
// Routage du chat : en langage naturel, le bot ne choisit pas une commande, il
// ouvre une MISSION. Le classificateur ne repond qu a deux questions : le
// message s adresse-t-il au bot (mission), est-ce un ordre d arret (stop) ? Le
// reste est du bavardage (aucune). Le planificateur decompose ensuite les gestes.
//
// Les commandes ponctuelles (avancer, sauter, venir...) restent accessibles par
// le prefixe explicite. C est ce qui evite qu une phrase floue declenche la
// mauvaise commande, qui etait le defaut recurrent.
// ---------------------------------------------------------------------------

// Mode d objectif valide pour l admission directe (chat passe par
// l interpretation ; le controleur revalide de toute facon a l admission).
const DIRECT_MODES = new Set(['temporary', 'permanent', 'ponctuel', 'temporaire', 'temporairement', 'autonome', 'permanente'])
function readDirectMode (body) {
  const raw = body?.mode
  // Defaut coherent : mode absent = objet vide (temporary par defaut en
  // aval), jamais undefined. Les appelants dereferencent .error/.mode sans
  // garde : un undefined rendait 500 (incident live S1/readDirectMode_1087).
  if (raw === undefined || raw === null || raw === '') return {}
  if (typeof raw !== 'string' || !DIRECT_MODES.has(raw.trim().toLowerCase())) {
    return { error: `mode invalide (recu ${JSON.stringify(raw)}, attendu temporary|permanent)` }
  }
  return { mode: raw.trim().toLowerCase() }
}

// Validation d'entree AVANT garde de disponibilite : un mode malforme rend
// 400 meme sans bot connecte ; un mode absent passe (defaut coherent) et
// requireBot tranche ensuite (503). Sans cela, le 500 devenait invisible
// aux tests (masque par 503) et le 400 exigeait un bot.
function validateModeFirst (req, res, next) {
  const modeCheck = readDirectMode(req.body)
  if (modeCheck.error) return res.status(400).json({ ok: false, error: modeCheck.error })
  req.directMode = modeCheck.mode
  next()
}

// `startOpts` : options de demarrage de la demande qui remplace (script et
// brief d une mission scriptee) ; sans elles, le remplacement automatique
// relancait l objectif sans son script et le modele le planifiait (banc 25603d5).
function resolveArbitrationNow ({ choice, actor, startOpts = null, pour = null } = {}) {
  if (!objectives) throw Object.assign(new Error('arbitrage indisponible'), { code: 'stale' })
  const out = objectives.resolveArbitration({ choice, actor })
  // Reprise strictement explicite : pause_reprise demarre le NOUVEL objectif,
  // l ancien reste en pile (pause, jamais stop destructeur) ; remplacement
  // archive l ancien. Persistance d abord, physique ensuite.
  if (out.status === 'resumed-new' || out.status === 'replaced') {
    try {
      resumeAll()
    } catch (err) {
      say(`Arbitrage tranche mais reprise impossible : ${err.message} (pause maintenue)`)
      return out
    }
    stopPathfinding()
    if (out.status === 'resumed-new') {
      // Suspension vraie (objet vivant preserve) au lieu d un pauseWork
      // ecrase par le start suivant : a la cloture, resumeSuspended relance.
      try { missionRunner.suspend?.('arbitrage pause_reprise') } catch (_) {}
      say(`OK : « ${out.objective.texte} » (l ancien attend).`)
    } else {
      missionRunner.stop('arbitrage remplacement')
      say(`OK : « ${out.objective.texte} ».`)
    }
    // Le resultat {ok:false} n etait jamais lu : un echec de lecture laissait
    // le bot immobile et muet apres « remplace ». On le dit au joueur.
    missionRunner.start(out.objective.texte, out.objective.auteur, { ...(startOpts && pour && out.objective.id === pour ? startOpts : {}), objectiveId: out.objective.id, mode: out.objective.mode })
      .then(result => {
        if (result && result.ok === false && !/annule/.test(String(result.error))) {
          say(`« ${out.objective.texte} » impossible : ${result.error}`)
        }
      })
      .catch(err => {
        console.error(`[arbitrage] demarrage impossible : ${err.message}`)
        say(`« ${out.objective.texte} » impossible : ${err.message}`)
      })
  }
  return out
}

// Demande concurrente (D22/D38/D44-D46) : pause + question explicite
// pause_reprise / remplacement, 60 s puis reprise ancien + pending garde.
// Fail-closed : sans controleur (corruption), admission refusee, jamais de
// demarrage direct contournant l inbox durable.
async function startObjectiveDurable (objective, requester, opts = {}) {
  if (durableCorrupted() || !objectives) {
    const detail = durablePersistError() ? ` : ${durablePersistError()}` : ''
    return { ok: false, error: `objectifs indisponibles (fail-closed)${detail}` }
  }
  if (isHardStopped()) {
    try { objectives.proposeObjective({ auteur: requester, texte: objective }) } catch (err) {
      return { ok: false, error: `mise en attente impossible : ${err.message}`, pending: true }
    }
    say('Arrêt total : demande en attente, « reprends » pour relancer.')
    return { ok: false, error: 'arret total, demande en attente', pending: true }
  }
  let proposal
  try {
    proposal = objectives.proposeObjective({ auteur: requester, texte: objective, mode: opts.mode })
  } catch (err) {
    return { ok: false, error: `objectif refuse : ${err.message}` }
  }
  const proposalMode = proposal.objective?.mode ?? opts.mode ?? 'temporary'
  if (proposal.status === 'started') {
    stopPathfinding()
    try { physicalExecutor?.resume?.() } catch (_) {}
    return missionRunner.start(objective, requester, { ...opts, objectiveId: proposal.objective?.id, mode: proposalMode })
  }
  if (proposal.status === 'arbitration') {
    // Pause du travail pendant l arbitrage humain (D23), survie conservee.
    // Brief en vol annule : sinon il demarrerait pendant l arbitrage.
    try { missionRunner.cancelPendingStart?.() } catch (_) {}
    try { missionRunner.pauseWork?.('arbitrage concurrent') } catch (_) {}
    try { physicalExecutor?.pauseWork?.('arbitrage concurrent') } catch (_) {}
    stopPathfinding()
    // Par defaut, la nouvelle demande remplace l ancienne sans question : le
    // demandeur est l auteur du candidat, donc autorise a trancher (D44).
    if (ARBITRATION_DEFAULT !== 'question') {
      try {
        // Le candidat tranche est cette demande : ses options la suivent.
        const { mode: _mode, ...startOpts } = opts
        const out = resolveArbitrationNow({ choice: 'remplacement', actor: requester, startOpts, pour: proposal.objective?.id })
        return { ok: true, replaced: true, status: out?.status, objective: proposal.objective, mode: proposalMode }
      } catch (err) {
        console.error(`[arbitrage] remplacement automatique impossible : ${err.message}`)
      }
    }
    say(proposal.question)
    return { ok: true, arbitration: true, question: proposal.question, objective: proposal.objective, mode: proposalMode }
  }
  // Une question d arbitrage attend encore sa reponse : la reposer clairement
  // plutot que d annoncer une file que le joueur ne comprend pas.
  if (proposal.question) say('« remplace » ou « reprends après » ?')
  else say('Noté, après la tâche en cours.')
  return { ok: true, queued: true, status: proposal.status, objective: proposal.objective, mode: proposalMode }
}

const conversation = createConversation({
  interpret: (message, context, opts) => {
    if (planner.isEnabled()) return planner.interpretMessage(message, context, opts)
    return Promise.reject(new Error('planificateur non configure (PLANNER_BASE_URL)'))
  },
  status: () => {
    const m = missionRunner.status()
    // La conversation ne replanifie qu une mission : ni boucle sur pending,
    // ni replanification de toutes les instructions apres chaque message.
    return m
  },
  cancelPendingStart: () => missionRunner.cancelPendingStart(),
  start: async (objective, requester, opts) => startObjectiveDurable(objective, requester, opts),
  revise: async (objective, requester, opts) => {
    // Admission durable d abord : persistance corrompue/indisponible => refus,
    // jamais d ecriture fantome avalee en silence.
    if (durableCorrupted() || !objectives) {
      return { ok: false, error: 'objectifs indisponibles (fail-closed) : revision refusee' }
    }
    try {
      objectives.addContext({ auteur: requester, texte: `revision: ${objective}` })
    } catch (err) {
      return { ok: false, error: `revision refusee : ${err.message}` }
    }
    const result = await missionRunner.revise(objective, requester, opts)
    return result
  },
  context: (message, username, permissions) => {
    if (durableCorrupted() || !objectives) throw new Error('stockage durable indisponible')
    objectives.addContext({ auteur: username, texte: message })
    return missionRunner.addContext(message, username, permissions)
  },
  stop: () => HANDLERS.stop(),
  totalStop: () => handleHardStop(),
  resume: () => handleResume(),
  arbitrationPending: () => {
    const snap = objectivesSnapshotSafe()
    if (!snap || !snap.arbitration) return null
    return { candidateAuteur: snap.arbitration.candidate?.auteur ?? null, question: snap.arbitration.question }
  },
  resolveArbitration: (input = {}) => resolveArbitrationNow(input),
  noteIgnored: (username, message) => {
    // Sans perte : une interpretation annulee par un stop reste en inbox,
    // texte ORIGINAL entier (jamais tronque).
    try { objectives?.recordMessage?.({ auteur: username, texte: String(message) }) } catch (_) {}
  },
  say: text => { if (text && !text.trim().startsWith('/')) say(String(text).replace(/[\r\n]+/g, ' ').slice(0, 230)) },
  observation: () => ({ position: bot?.entity?.position, navigation: navigator.status(), derniere_demande: lastIntent,
    joueurs: Object.values(bot?.players ?? {}).filter(p => p.entity).map(p => ({ nom: p.username, position: p.entity.position })) })
})

async function resolveIntent (username, raw, opts) {
  try {
    const result = await conversation.receive(username, raw, opts)
    if (result.ignored) return result
    lastIntent = { at: new Date().toISOString(), from: username, message: raw,
      command: result.relation, objective: result.objective, response: result.response, error: result.error ?? null, source: 'conversation' }
    console.log(`[chat] "${raw}" -> ${result.relation}`)
    return result
  } catch (err) {
    if (err.name === 'AbortError' || /annule|abort/i.test(err.message)) return { ignored: true }
    console.error(`[chat] ${err.message}`)
    // Modele muet (delai) : le dire tel quel, ce n est pas une incomprehension.
    say(/pas de reponse/i.test(err.message) ? 'Modèle trop lent, répète ?' : 'Pas compris, réessaie ?')
    return { error: err.message }
  }
}

// Evenements controleur -> mission/executeur (prod). Le timeout n a pas
// d appelant explicite : c est ici que l ancien reprend (pas d attente
// eternelle mission/executor en pause). Resolved explicite deja traite par
// l appelant : ici no-op idempotent. Complete/maintaining : annonce, jamais
// de replay automatique d effets incertains ; l ancien en pile attend un
// ordre explicite.
// R02 : seuls les lives (transition validee) arrivent ici ; le flush journal
// ne callback jamais le runtime. R04 : reprise physique seulement si le
// snapshot courant confirme (arbitration fermee, ni hardstop ni pause) ;
// un rejeu ou callback tardif ne reprend jamais.
function handleObjectiveEvent (evt) {
  if (!evt || typeof evt.type !== 'string') return
  try {
    if (evt.type === 'arbitration-started') {
      if (missionRunner.isRunning()) {
        try { missionRunner.pauseWork('arbitrage concurrent') } catch (_) {}
      }
      try { physicalExecutor?.pauseWork?.('arbitrage concurrent') } catch (_) {}
    } else if (evt.type === 'arbitration-timeout') {
      let snap = null
      try { snap = objectivesSnapshotSafe() } catch (_) { snap = null }
      const stale = !snap || snap.hardstop || snap.workPaused || snap.arbitration != null
      if (stale) return
      try { physicalExecutor?.resume?.() } catch (_) {}
      const m = missionRunner.status()
      if (m && m.etat === 'paused') {
        try { missionRunner.resumeWork?.() } catch (_) {}
      }
      say('Sans réponse : je reprends l ancien, ta demande attend.')
    } else if (evt.type === 'arbitration-resolved') {
      // Traite par l appelant explicite (resolveArbitration) : no-op.
    } else if (evt.type === 'complete') {
      // No-op volontaire : mission.finish() a deja tente resumeSuspended sur
      // l engagement restaure (vrai redemarrage) ou bascule en attente
      // explicite. Annoncer ici dupliquerait et contredirait la reprise.
    } else if (evt.type === 'maintaining') {
      say('En entretien.')
    }
  } catch (_) {}
}
objectiveEventHandler = handleObjectiveEvent

function connectBot () {
  if (shuttingDown) return

  console.log(`[bot] Connecting to ${MC_HOST}:${MC_PORT} as ${BOT_USERNAME} (Minecraft ${MC_VERSION})`)

  try {
    bot = mineflayer.createBot({
      host: MC_HOST,
      port: MC_PORT,
      username: BOT_USERNAME,
      auth: 'offline',
      version: MC_VERSION
    })

    bot.loadPlugin(pathfinder)
    craft.trackWindowStateIds(bot)
    // Le logger publie dans le chat des qu une instance est joignable.
    logger.attach(bot)

    bot.once('spawn', () => {
      spawned = true
      // Apres restart, le hardstop persiste : respecte AVANT tout auto.
      if (isHardStopped()) {
        console.log('[bot] Spawn avec arret total persistant : aucune reprise automatique')
        try { bot.clearControlStates() } catch (_) {}
        try { bot.pathfinder?.setGoal?.(null) } catch (_) {}
      }
      lastSafePosition = bot.entity.position.clone()
      resetWatchdog()
      buildMovements()

      console.log(`[bot] Spawned on Minecraft ${bot.version} (liquidCost=${LIQUID_COST}, aucun pouvoir d administration)`)
    })

    // Without these the bot stalls silently when the pathfinder finds no route.
    bot.on('path_update', result => {
      lastPathStatus = result.status
      lastPathLength = Array.isArray(result.path) ? result.path.length : null

      if (process.env.PATH_DEBUG) {
        console.log(
          `[path] ${result.status} | ${lastPathLength} noeud(s) | cout ${result.cost?.toFixed?.(1) ?? '?'}` +
          ` | visites ${result.visitedNodes} | temps ${result.time?.toFixed?.(0) ?? '?'} ms`
        )
      }
      if (result.status === 'noPath' || result.status === 'timeout') {
        console.log(`[path] ${result.status} - giving up on this goal`)
        stopPathfinding()
        if (inLiquid()) rescue(`pathfinder ${result.status} in liquid`)
      }
    })

    bot.on('goal_reached', () => {
      lastPathStatus = 'goal_reached'
      resetWatchdog()
    })

    bot.on('chat', (username, message) => {
      if (!spawned || username === bot.username || CHAT_IGNORE_PLAYERS.has(String(username).toLowerCase())) return

      try {
        const raw = String(message || '').trim()
        if (!raw) return

        recentChat.push({ de: username, message: raw.slice(0, 160), a: new Date().toISOString() })
        if (recentChat.length > CHAT_HISTORY_MAX) recentChat.shift()

        if (raw.startsWith(CMD_PREFIX)) {
          conversation.cancel()
          const [command, ...args] = raw.slice(CMD_PREFIX.length).trim().split(/\s+/)
          runCommand(username, (command || '').toLowerCase(), args, raw)
            .catch(err => console.error('[chat] command failed:', err.message))
          return
        }

        // Arrets et reprise immediats hors LLM (variations + accents conserves).
        if (isHardStopText(raw)) {
          handleHardStop()
          return
        }
        if (isResumeText(raw)) {
          handleResume()
          return
        }
        if (isSoftStopText(raw)) {
          HANDLERS.stop()
          return
        }

        resolveIntent(username, raw)
      } catch (err) {
        console.error('[chat] command failed:', err.message)
      }
    })

    bot.on('kicked', reason => {
      console.log('[bot] Kicked:', reason)
    })

    bot.on('error', err => {
      console.error('[bot] Error:', err.message)
    })

    bot.on('end', reason => {
      console.log('[bot] Disconnected:', reason)
      spawned = false
      conversation.cancel()
      bot = null
      logger.attach(null)
      safeTrail = []
      recentChat = []
      resetWatchdog()
      // La boucle de mission verifie isReady() a chaque tour et se clot d
      // elle-meme ; l appel explicite evite d attendre le tour suivant.
      missionRunner.stop('bot deconnecte')
      scheduleReconnect()
    })
  } catch (err) {
    console.error('[bot] Connection creation failed:', err.message)
    bot = null
    spawned = false
    scheduleReconnect()
  }
}

function requireBot (req, res, next) {
  if (!bot || !spawned || !bot.entity) {
    return res.status(503).json({
      ok: false,
      error: 'Bot not connected/spawned yet'
    })
  }
  next()
}

// API HTTP et interface web : bot/api.js. L etat vivant passe par des
// accesseurs, lus a chaque requete.
const app = createApi({
  get bot () { return bot },
  get spawned () { return spawned },
  get followMode () { return followMode },
  get lastIntent () { return lastIntent },
  get lastPathLength () { return lastPathLength },
  get lastPathStatus () { return lastPathStatus },
  set lastPathStatus (value) { lastPathStatus = value },
  get lastGoto () { return lastGoto },
  set lastGoto (value) { lastGoto = value },
  get lastRescue () { return lastRescue },
  get rescueCount () { return rescueCount },
  get commandAudit () { return commandAudit }
}, {
  BOT_USERNAME,
  CHAT_HISTORY_MAX,
  CMD_PREFIX,
  CONTROL_KEYS,
  HANDLERS,
  MC_VERSION,
  activeControls,
  conversation,
  craft,
  controlLease,
  durableCorrupted,
  durablePersistError,
  handleHardStop,
  handleResume,
  inLiquid,
  isHardStopText,
  isHardStopped,
  isResumeText,
  isSoftStopText,
  memory,
  missionRunner,
  navigator,
  objectivesSnapshotSafe,
  physicalExecutor,
  planner,
  recentChat,
  requireAdmissionOrThrow,
  requireBot,
  rescue,
  resolveIntent,
  runPhysical,
  skills,
  startObjectiveDurable,
  stopPathfinding,
  validateModeFirst
})

// Verification de coherence au demarrage : les commandes declarees, les
// handlers branches et les etapes de mission doivent former le meme ensemble.
const commandAudit = skills.audit(Object.keys(HANDLERS), missionRunner.ACTION_NAMES)

if (commandAudit.ok) {
  console.log(
    `[commandes] ${commandAudit.counts.commandes} commandes ` +
    `(${commandAudit.counts.routables_par_le_chat} routables par le chat, ${commandAudit.counts.prefixe_uniquement} sur prefixe seul), ` +
    `${commandAudit.counts.actions} actions dont ${commandAudit.counts.actions_parametrees} parametrees, ` +
    `sur ${commandAudit.counts.types_de_mission} types de mission, ` +
    `${commandAudit.counts.ressources} matieres, ${commandAudit.counts.reperes} reperes, ` +
    `${Object.keys(craft.TARGETS).length} fabrications, approvisionnement ${missionRunner.SUPPLY} : coherent`
  )
} else {
  console.error('[commandes] INCOHERENCES :')
  for (const problem of commandAudit.problems) console.error(`  - ${problem}`)
}

memory.load()

if (planner.isEnabled()) {
  console.log(
    `[planner] ${planner.MODEL} sur ${planner.BASE_URL} : plans de ${planner.PLAN_MAX} etapes, ` +
    `seuil de fin ${planner.DONE_THRESHOLD}`
  )
  // En arriere-plan : le bot peut se connecter et obeir aux commandes prefixees
  // pendant que le modele monte en VRAM.
  planner.warmup()
} else {
  console.log(`[planner] INACTIF (PLANNER_BASE_URL vide) - le bot n obeira qu aux commandes ${CMD_PREFIX}`)
}

// Annonce vraie degradation/recovery du profil pilote (D49) : uniquement sur
// transition reelle, jamais a chaque plan. Fail-closed : l observateur ne casse
// jamais un plan.
let lastProfileDegraded = false
try {
  if (planner && typeof planner.onProfileEvent === 'function') {
    planner.onProfileEvent((evt) => {
      try {
        if (!evt || typeof evt.type !== 'string') return
        if (evt.type === 'fallback' && !lastProfileDegraded) {
          lastProfileDegraded = true
          say(`Mode degrade : pilote ${evt.from} indisponible (${evt.reason || 'panne'}), repli ${evt.to}.`)
        } else if ((evt.type === 'recovered' || evt.type === 'recovery') && lastProfileDegraded) {
          lastProfileDegraded = false
          say('Pilote retabli, retour au profil normal.')
        }
      } catch (_) {}
    })
  }
} catch (_) {}

let watchdogTimer = null
let server = null

function startRuntime () {
  if (watchdogTimer) return { app, server }
  config.logEffectiveConfig()
  watchdogTimer = setInterval(watchdogTick, 1000)
  // Boucle d evenements bloquee : le serveur expulse le bot (« Timed out »)
  // au-dela de ~30 s sans keep-alive. Le journal dit quand et combien.
  let tic = Date.now()
  setInterval(() => {
    const retard = Date.now() - tic - 1000
    tic = Date.now()
    if (retard >= 3000) console.log(`[lent] boucle d evenements bloquee ${(retard / 1000).toFixed(1)} s`)
  }, 1000).unref()
  server = app.listen(API_PORT, '0.0.0.0', () => {
    console.log(`[api] Web controller listening on port ${API_PORT}`)
  })
  connectBot()
  return { app, server }
}

if (require.main === module) {
  startRuntime()
}

function shutdown (signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[app] ${signal} received, shutting down`)

  if (reconnectTimer) clearTimeout(reconnectTimer)
  clearInterval(watchdogTimer)
  missionRunner.stop('arret du conteneur')

  try {
    if (bot) {
      bot.clearControlStates()
      bot.pathfinder?.setGoal(null)
      bot.quit('Container stopping')
    }
  } catch (err) {
    console.error('[app] Bot shutdown error:', err.message)
  }

  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// Bootstrap injectable pour tests sans vrai bot (aucun rebuild/config).
module.exports = {
  app,
  createDurableStack,
  createOwnerAwareNavigator,
  ownerBypassCheck,
  startObjectiveDurable,
  runPhysical,
  isOwnerBypass,
  requireAdmissionOrThrow,
  pauseWorkAll,
  totalStopAll,
  resumeAll,
  objectivesSnapshotSafe,
  durableCorrupted,
  durablePersistError,
  isHardStopped,
  isWorkPaused,
  startRuntime,
  HANDLERS,
  handleHardStop,
  handleResume,
  commandAudit,
  missionRunner,
  conversation,
  resolveIntent,
  handleObjectiveEvent,
  getController: () => objectives,
  getExecutor: () => physicalExecutor,
  getControlLease: () => controlLease,
  getNavigator: () => navigator,
  readDirectMode
}
