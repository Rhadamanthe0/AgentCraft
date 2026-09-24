// Installe le plus tot possible : les erreurs de connexion et de chargement des
// modules passent ainsi par le fichier de log et, plus tard, par le chat.
const logger = require('./logger')
logger.install()

const express = require('express')
const path = require('path')
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const skills = require('./skills')
const craft = require('./craft')
const jev = require('./jev')
const planner = require('./planner')
const memory = require('./memory')
const repair = require('./repair')
const { createMissionRunner } = require('./mission')
const { createNavigator } = require('./navigation')
const { createConversation, isSoftStop: isSoftStopText, isHardStop: isHardStopText, isResume: isResumeText, parseArbitrationChoice } = require('./conversation')
const { createExecutor } = require('./executor')
const { createStateStore } = require('./state-store')
const { createObjectiveController } = require('./objective-controller')

// Qui interprete le chat. Le planificateur JSON distant prend la main des qu il
// est configure ; Jev reste le repli. Dans les deux cas la regle est la meme :
// pas de repli sur des mots-cles, un bot muet vaut mieux qu un bot qui devine.
function brain () {
  return planner.isEnabled() ? planner : jev
}

function brainName () {
  return planner.isEnabled() ? `${planner.MODEL} (plan JSON)` : jev.MODEL
}

const MC_HOST = process.env.MC_HOST || 'minecraft'
const MC_PORT = Number(process.env.MC_PORT || 25565)
const MC_VERSION = process.env.MC_VERSION || '26.1'
const BOT_USERNAME = process.env.BOT_USERNAME || 'TestBot'
const API_PORT = Number(process.env.API_PORT || 3000)
const CMD_PREFIX = process.env.CMD_PREFIX || '!'

// Le bot n a AUCUN pouvoir d administration : ni /tp, ni /gamemode, ni
// inventaire creative. Il joue avec le mode de jeu du serveur, qui est en
// survie (MODE dans compose.yaml) pour que casser un bloc fasse tomber un
// objet. C est la difference avec l ancienne version, ou le bot etait op et se
// remettait lui-meme en survie au spawn.
//
// Delai laisse a un sauvetage pour rejoindre la terre ferme a pied.
const RESCUE_WALK_TIMEOUT_MS = Number(process.env.RESCUE_WALK_TIMEOUT_MS || 15000)

// Prismarine's water physics cannot reliably swim a bot out of a pool
// (PrismarineJS/mineflayer#2796). We therefore avoid liquids while pathfinding
// and, if the bot ends up in one anyway, rescue it instead of waiting.
const LIQUID_COST = Number(process.env.LIQUID_COST || 30)
const LIQUID_GRACE_MS = Number(process.env.LIQUID_GRACE_MS || 5000)
const STUCK_GRACE_MS = Number(process.env.STUCK_GRACE_MS || 7000)
const STUCK_EPSILON = 0.15
// Repos apres un sauvetage sur la terre ferme. Doit rester plus long que le
// delai d une etape de mission, sinon les deux se battent.
const RESCUE_COOLDOWN_MS = Number(process.env.RESCUE_COOLDOWN_MS || 25000)

// Un message d excuse par fenetre : sans repli mots-cles, une panne de Jev rend
// le bot muet, autant le dire, mais pas a chaque phrase prononcee.
const CLASSIFIER_NOTICE_MS = 30000

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
let lastClassifierNotice = 0

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
// d immobilite (voir CLAUDE.md, piege 4).
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
const ARBITRATION_MS = Number(process.env.ARBITRATION_MS || 60000)
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
  if (!objectives) throw physicalRefusal('unavailable', 'objectifs indisponibles (fail-closed)')
  objectives.resume()
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
//     grimper vers une buche en hauteur au lieu du pied de l arbre (CLAUDE.md,
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

  setNavigation('strict')
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
async function walkToSafety (reason) {
  const destination = escapePosition()

  if (!destination) {
    lastRescue = { at: new Date().toISOString(), reason, action: 'none', detail: 'aucune position sure memorisee' }
    return false
  }

  const { x, y, z } = destination
  let timer = null

  try {
    // Sauvetage DANS le slot survie : le timeout borne l attente mais ne
    // libere jamais le slot (resolution reelle du callback uniquement).
    const envelope = await runPhysical(`rescue-walk-${Date.now()}`, 'survival', async ({ signal }) => {
      stopPathfinding()
      // Se degager d un trou ou d un encastrement autorise le creusage : un bot
      // coince dans le decor ne peut sortir autrement (plus de teleportation).
      setNavigation('dig')
      try {
        await Promise.race([
          bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1)),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('trajet trop long')), RESCUE_WALK_TIMEOUT_MS)
          })
        ])
      } finally {
        if (timer) { clearTimeout(timer); timer = null }
      }
      if (signal?.aborted) throw Object.assign(new Error('sauvetage annule'), { code: 'cancelled' })
      return { walked: true }
    })
    if (envelope.cancelled) {
      lastRescue = { at: new Date().toISOString(), reason, action: 'cancelled' }
      return false
    }

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
    if (err && (err.code === 'paused' || err.code === 'stopped' || err.code === 'busy' || err.code === 'unavailable')) {
      lastRescue = { at: new Date().toISOString(), reason, action: `refused-${err.code}`, detail: err.message }
      return false
    }
    lastRescue = { at: new Date().toISOString(), reason, action: 'failed', detail: err.message }
    console.error(`[rescue] ${reason} -> impossible de rejoindre la terre ferme : ${err.message}`)
    // Sans pouvoir se teleporter, le bot n a plus qu a demander de l aide.
    say(`Je suis coince (${reason}) et je ne peux pas me degager tout seul. Viens me sortir de la.`)
    return false
  } finally {
    if (timer) clearTimeout(timer)
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
  // Arret total : rescue interdit (fail-closed, D18). Slot tenu => pas de
  // chevauchement auto. On le dit une fois.
  if (isHardStopped()) {
    lastRescue = { at: new Date().toISOString(), reason, action: 'refused-hardstop' }
    return
  }
  try {
    const st = physicalExecutor ? physicalExecutor.status() : null
    if (st && st.busy) {
      lastRescue = { at: new Date().toISOString(), reason, action: 'refused-busy', detail: `executeur occupe par ${st.current?.id}` }
      return
    }
  } catch (_) {}
  rescuing = true

  try {
    console.log(`[rescue] triggered: ${reason}`)
    const wasInLiquid = inLiquid()
    const before = bot.entity.position.clone()

    stopPathfinding()
    bot.clearControlStates()

    if (wasInLiquid) {
      bot.setControlState('jump', true)
      await new Promise(resolve => setTimeout(resolve, 2500))
      bot.setControlState('jump', false)
    } else if (escalate) {
      // Un saut sur place libere la plupart des coincements, sans deplacer le
      // bot si tout allait bien.
      bot.setControlState('jump', true)
      await new Promise(resolve => setTimeout(resolve, 1200))
      bot.clearControlStates()
    }

    const moved = bot.entity ? bot.entity.position.distanceTo(before) : 0
    const stillStuck = inLiquid() || (escalate && moved < 0.5)

    if (stillStuck) {
      await walkToSafety(reason)
      await new Promise(resolve => setTimeout(resolve, 500))
    } else {
      const action = wasInLiquid ? 'swam out' : 'cleared goal and controls'
      rescueCount += 1
      lastRescue = { at: new Date().toISOString(), reason, action }
      console.log(`[rescue] ${action}, no teleport needed`)
    }
  } catch (err) {
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
  // (`mission.detectStuck` + `demander_aide`), et le chien de garde qui annulait
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
  }
}

function startOnly (control) {
  // Touche directe gardee par le writer (admission), executee dedans.
  // Tenu indefini cote jeu : le slot couvre l admission + la pose, documente
  // comme tel dans /api/status (couverture partielle honnete).
  // Erreurs d admission dites dans le chat (jamais silencieuses) : false.
  try {
    requireAdmissionOrThrow()
  } catch (err) {
    say(`Ordre refuse (${err.code || 'refus'}) : ${err.message}`)
    return false
  }
  runPhysical(`cmd-touch-${control}-${Date.now()}`, 'work', async () => {
    stopPathfinding()
    bot.clearControlStates()
    bot.setControlState(control, true)
    return { control }
  }).catch(err => {
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
    say(`Ecris aussi en langage naturel : c est ${brainName()} qui decide de l action.`)
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
      await runPhysical(`cmd-saute-${Date.now()}`, 'work', async ({ signal }) => {
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
    } catch (err) {
      say(`Saut refuse (${err.code || 'refus'}) : ${err.message}`)
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
    } else if (!hadMission) say('Je m arrete')
    else say('Je mets le travail en pause, progression conservee.')
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
    runPhysical(`cmd-va-${Date.now()}`, 'work', async ({ signal }) => {
      if (signal?.aborted) return { code: 'cancelled', reached: false }
      stopPathfinding()
      return await navigator.toPosition(target, { signal, radius: 1 })
    }).then(envelope => {
      const result = envelope?.value
      if (!envelope?.cancelled && result && !result.reached && result.code !== 'cancelled') {
        say(`Je ne peux pas atteindre ces coordonnees : ${result.code}`)
      }
    }).catch(err => {
      if (err && (err.code === 'paused' || err.code === 'stopped' || err.code === 'busy' || err.code === 'unavailable')) {
        say(`Deplacement refuse (${err.code}) : ${err.message}`)
      } else {
        console.error(`[nav] va impossible : ${err.message}`)
      }
    })
  },

  async viens (username) {
    const target = bot.players[username]?.entity
    if (!target) {
      say(`${username}, je ne te vois pas d ici`)
      return
    }
    try {
      requireAdmissionOrThrow()
    } catch (err) {
      say(`Suivi refuse (${err.code || 'refus'}) : ${err.message}`)
      return
    }

    say(`J arrive ${username}`)
    let result
    try {
      const envelope = await runPhysical(`cmd-viens-${username}-${Date.now()}`, 'work',
        async ({ signal }) => {
          missionRunner.stop('remplacee par un suivi')
          stopPathfinding()
          return navigator.toPlayer(username, { follow: true, signal })
        })
      // Enveloppe cancelled = stop pendant le trajet : ne jamais readmettre
      // un callback tardif comme un succes.
      result = envelope && envelope.cancelled
        ? { code: 'cancelled', reached: false }
        : envelope.value
    } catch (err) {
      say(`Je ne peux pas te rejoindre (${err.code || 'refus'}) : ${err.message}`)
      return
    }
    if (result.code !== 'cancelled' && !result.reached) say(`Je ne peux pas te rejoindre : ${result.code}`)
  },

  sors (username) {
    say('Je me degage')
    rescue(`requested by ${username}`, { escalate: true })
  },

  ou () {
    const p = bot.entity.position
    say(`Je suis en ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}${inLiquid() ? ' (dans un liquide)' : ''}`)
  },

  vois (username) {
    // L entite d un joueur n existe que si elle est chargee autour du bot : sa
    // presence est exactement la reponse a « est-ce que tu me vois ».
    const target = bot.players[username]?.entity

    if (!target) {
      say(`${username}, non, je ne te vois pas d ici`)
      return
    }

    const here = bot.entity.position
    const distance = here.distanceTo(target.position)
    const dx = target.position.x - here.x
    const dz = target.position.z - here.z
    const direction = Math.abs(dx) >= Math.abs(dz)
      ? (dx >= 0 ? 'est' : 'ouest')
      : (dz >= 0 ? 'sud' : 'nord')

    say(`Oui ${username}, je te vois a ${distance.toFixed(1)} blocs vers le ${direction}`)
    // Se tourner vers le joueur : une reponse « je te vois » qui regarde ailleurs
    // se voit tout de suite en jeu.
    bot.lookAt(target.position.offset(0, 1, 0), true).catch(() => {})
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
  else say('Arret total : tout est annule, aucune reprise automatique. Dis reprends pour relancer.')
}

function handleResume () {
  // 1. Mission en pause en memoire : reprise directe (persistance d abord).
  const m0 = missionRunner.status()
  if (m0 && m0.etat === 'paused') {
    try {
      resumeAll()
    } catch (err) {
      say(`Reprise impossible : ${err.message} (pause maintenue)`)
      return
    }
    if (missionRunner.resumeWork?.()) say('Je reprends le travail ou je m etais arrete.')
    else say('Je suis pret, donne-moi un objectif.')
    return
  }
  // 2. Permanent en attente de maintenance : pas de boucle aveugle, on
  // attend une observation pertinente (moteur de maintenance non livrable).
  if (m0 && m0.maintenance === 'waiting-maintenance') {
    say('Objectif permanent en entretien : j attends une observation pertinente, sans recolte aveugle.')
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
      say(`Mission reprise apres restart : « ${cur.texte} » (progression conservee, monde reobserve).`)
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
  say('Je suis pret, donne-moi un objectif.')
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

function noticeClassifierDown (detail) {
  const now = Date.now()
  if (now - lastClassifierNotice < CLASSIFIER_NOTICE_MS) return

  lastClassifierNotice = now
  say(`Je ne peux pas interpreter le chat (${detail}). Utilise ${CMD_PREFIX}aide.`)
}

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
    say('Arret total en cours : ta demande reste en attente. Dis reprends pour relancer.')
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
    say(proposal.question)
    return { ok: true, arbitration: true, question: proposal.question, objective: proposal.objective, mode: proposalMode }
  }
  say('Je note ta demande, je la traiterai apres celle en cours.')
  return { ok: true, queued: true, status: proposal.status, objective: proposal.objective, mode: proposalMode }
}

const conversation = createConversation({
  interpret: (message, context, opts) => {
    if (planner.isEnabled()) return planner.interpretMessage(message, context, opts)
    return jev.classify(message).then(r => ({ relation: r?.command === 'stop' ? 'stop' : 'new', objective: message }))
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
  resolveArbitration: ({ choice, actor } = {}) => {
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
        say(`Je passe a « ${out.objective.texte} », l ancien attendra.`)
      } else {
        missionRunner.stop('arbitrage remplacement')
        say(`J abandonne l ancien pour « ${out.objective.texte} ».`)
      }
      missionRunner.start(out.objective.texte, out.objective.auteur, { objectiveId: out.objective.id, mode: out.objective.mode }).catch(err => {
        console.error(`[arbitrage] demarrage impossible : ${err.message}`)
      })
    }
    return out
  },
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
    say('Je n ai pas pu interpreter ta demande pour le moment. Peux-tu reessayer ?')
    return { error: err.message }
  }
}

// Evenements controleur -> mission/executeur (prod). Le timeout n a pas
// d appelant explicite : c est ici que l ancien reprend (pas d attente
// eternelle mission/executor en pause). Resolved explicite deja traite par
// l appelant : ici no-op idempotent. Complete/maintaining : annonce, jamais
// de replay automatique d effets incertains ; l ancien en pile attend un
// ordre explicite.
function handleObjectiveEvent (evt) {
  if (!evt || typeof evt.type !== 'string') return
  try {
    if (evt.type === 'arbitration-started') {
      if (missionRunner.isRunning()) {
        try { missionRunner.pauseWork('arbitrage concurrent') } catch (_) {}
      }
      try { physicalExecutor?.pauseWork?.('arbitrage concurrent') } catch (_) {}
    } else if (evt.type === 'arbitration-timeout') {
      try { physicalExecutor?.resume?.() } catch (_) {}
      const m = missionRunner.status()
      if (m && m.etat === 'paused') {
        try { missionRunner.resumeWork?.() } catch (_) {}
      }
      say('Sans reponse, je reprends l ancien objectif ; la nouvelle demande reste en attente.')
    } else if (evt.type === 'arbitration-resolved') {
      // Traite par l appelant explicite (resolveArbitration) : no-op.
    } else if (evt.type === 'complete') {
      // No-op volontaire : mission.finish() a deja tente resumeSuspended sur
      // l engagement restaure (vrai redemarrage) ou bascule en attente
      // explicite. Annoncer ici dupliquerait et contredirait la reprise.
    } else if (evt.type === 'maintaining') {
      say('Objectif permanent en entretien.')
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
      if (!spawned || username === bot.username) return

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

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '16kb' }))
app.use(express.static(path.join(__dirname, 'public')))

app.get('/api/status', (req, res) => {
  const position = bot?.entity?.position
  res.json({
    ok: true,
    connected: Boolean(bot),
    spawned,
    username: bot?.username ?? BOT_USERNAME,
    minecraftVersion: bot?.version ?? null,
    expectedMinecraftVersion: MC_VERSION,
    health: bot?.health ?? null,
    food: bot?.food ?? null,
    position: position
      ? {
          x: Number(position.x.toFixed(2)),
          y: Number(position.y.toFixed(2)),
          z: Number(position.z.toFixed(2))
        }
      : null,
    pathfinding: Boolean(bot?.pathfinder?.isMoving?.()),
    inLiquid: inLiquid(),
    pathStatus: lastPathStatus,
    // Diagnostics : un chemin trouve mais un bot immobile se voit ici.
    pathLength: lastPathLength,
    gravity: bot?.physics?.gravity ?? null,
    onGround: bot?.entity?.onGround ?? null,
    controls: activeControls(),
    followMode,
    navigation: navigator.status(),
    rescues: rescueCount,
    lastRescue,
    commandPrefix: CMD_PREFIX,
    classifier: planner.isEnabled() ? 'planner' : (jev.isEnabled() ? 'jev' : 'indisponible'),
    classifierModel: brain().isEnabled() ? brainName() : null,
    classifierMinConfidence: brain().isEnabled() ? brain().MIN_CONFIDENCE : null,
    classifierError: brain().isEnabled() ? null : (planner.lastError ?? jev.initError),
    // Latence reelle du planificateur : c est le chiffre a regarder avant de
    // changer de modele ou de taille de plan.
    planner: planner.isEnabled()
      ? { base: planner.BASE_URL, model: planner.MODEL, planMax: planner.PLAN_MAX, ...planner.stats }
      : null,
    // Nombre d actions dont la documentation/exemples a ete enrichie par l aide
    // distante (voir /api/actions). Zero au demarrage : la documentation native
    // suffit, l aide ne fait que la corriger.
    documentedActions: skills.documentedActions().filter(d => d.source === 'aide').length,
    // Memoire du modele : lisible sans entrer dans le conteneur, comme la
    // documentation des actions. C est le garde-fou humain de « le modele se souvient ».
    // Cache en couches : `travail` (memoire de mission) et `long_terme`
    // (persistante) ont des plafonds separes (`plafonds`), leurs jetons par
    // portee (`jetons`), ce qui reste (`restants`), les notes long terme en
    // attente de commit (`a_retenir`) et un compteur `generation` qui sert de
    // cle de cache a la couche 3 du prompt. Les champs historiques
    // `jetons_utilises` / `jetons_max` / `jetons_restants` restent servis.
    memory: memory.snapshot(),
    // Auto-reparation : actif seulement si une cle distante est fournie. Sans
    // elle, `demander_aide` est refuse et le dit, la mission continue.
    repair: repair.isEnabled()
      ? { base: repair.BASE_URL, model: repair.MODEL, maxParMission: repair.MAX_PER_MISSION, ...repair.stats }
      : { actif: false, raison: repair.why() },
    lastIntent,
    recentChat,
    missionRunning: missionRunner.isRunning(),
    mission: missionRunner.status(),
    // Cycle durable (additif) : objectifs/inbox + executeur, sans changer
    // les champs historiques. `physicalWriter` dit honnetement ce qui passe
    // Couverture honnete du writer : jamais singleWriter:true tant qu une
    // exception subsiste (touches directes tenue indefinite, regards).
    objectifs: objectivesSnapshotSafe(),
    durableCorrompu: durableCorrupted(),
    durableErreur: durablePersistError(),
    executor: (() => { try { return physicalExecutor ? physicalExecutor.status() : null } catch (_) { return null } })(),
    physicalWriter: {
      singleWriter: false,
      couverture: 'partielle',
      viaExecuteur: ['mission-steps', 'mission-parcours', 'nav-commands', 'rescue-walk', 'api-control', 'api-goto', 'api-jump', 'api-turn', 'api-look', 'touches-commandes', 'saut-commande'],
      exceptions: ['touches-tenues-indefini-apres-admission', 'regards-lookAt-hors-slot'],
      profilPilote: (() => { try { return planner.profileStatus?.() ?? null } catch (_) { return null } })()
    },
    // L inventaire decide de tout en survie : le voir sans entrer en jeu evite
    // de deviner pourquoi un chantier n avance pas.
    supply: missionRunner.SUPPLY,
    inventory: bot?.inventory ? craft.snapshot(bot) : null,
    heldItem: bot?.heldItem?.name ?? null
  })
})

// La table des commandes et le resultat de l audit, pour verifier sans lire le
// code que chat, Jev et handlers parlent bien de la meme chose.
app.get('/api/commands', (req, res) => {
  res.json({
    ok: true,
    prefix: CMD_PREFIX,
    audit: commandAudit,
    commands: Object.entries(skills.COMMANDS).map(([name, spec]) => ({
      name,
      aliases: spec.aliases,
      usage: spec.usage.replace(/^!/, CMD_PREFIX),
      summary: spec.summary,
      routableParJev: Boolean(spec.chat)
    })),
    supply: missionRunner.SUPPLY,
    actions: Object.entries(skills.ACTIONS).map(([name, spec]) => ({
      name,
      summary: spec.summary,
      // Ce que l ampleur renvoyee par Jev change pour cette action.
      parametre: spec.scale,
      // Le second etage de classification : les questions posees a Jev une fois
      // cette action choisie, et elles seules. Vide = un seul appel suffit.
      questions: Object.entries(spec.params ?? {}).map(([param, descriptor]) => ({
        nom: param,
        type: descriptor.type,
        question: descriptor.question,
        options: descriptor.dynamic ? `calculees a l execution (${descriptor.dynamic})` : undefined
      })),
      types: spec.kinds
    })),
    crafts: Object.entries(craft.TARGETS).map(([name, spec]) => ({
      name,
      summary: spec.summary
    })),
    missionKinds: Object.keys(skills.KINDS),
    scaleRubric: skills.SCALE_RUBRIC,
    landmarks: Object.keys(skills.LANDMARKS),
    resources: Object.keys(skills.RESOURCES).filter(name => name !== 'aucune'),
    // La documentation et les exemples des actions natives. L aide distante peut
    // les enrichir (source "aide") ; elle ne peut pas creer d action.
    documentation: skills.documentedActions()
  })
})

// La documentation et les exemples des actions natives, lisibles et remis a la
// valeur native sans entrer dans le conteneur. C est le garde-fou humain du
// « l aide distante a change ce que le modele lit » : on voit ce qui a ete
// ajoute, et on le retire si ca l egare.
app.get('/api/actions', (req, res) => {
  res.json({
    ok: true,
    fichier: skills.DOC_FILE,
    erreurEcriture: skills.docPersistError,
    maxExemples: skills.DOC_EXEMPLES_MAX,
    actions: skills.documentedActions()
  })
})

app.delete('/api/actions/:name', (req, res) => {
  const result = skills.forgetActionDoc(req.params.name)
  if (!result.ok) return res.status(404).json({ ok: false, error: result.error })
  console.log(`[skills] documentation ajoutee de "${req.params.name}" retiree par l API`)
  res.json({ ok: true, doc: result.doc })
})

app.delete('/api/actions', (req, res) => {
  const result = skills.clearActionDocs()
  console.log(`[skills] documentation d action remise a la native par l API (${result.supprimees})`)
  res.json({ ok: true, supprimees: result.supprimees })
})

// La memoire du modele, lisible et effacable sans entrer dans le conteneur.
// Meme garde-fou humain que pour les actions apprises : on voit ce qu il retient,
// et on efface si ca l egare. `portee` vaut travail, long_terme ou tout.
// Le snapshot expose les champs par couche (jetons, plafonds, restants,
// a_retenir, generation) ; effacer la memoire long terme increment
// `generation`, donc invalide la couche 3 du prompt au tour suivant.
app.get('/api/memory', (req, res) => {
  res.json({
    ok: true,
    fichier: memory.FILE,
    erreurEcriture: memory.persistError,
    ...memory.snapshot()
  })
})

app.delete('/api/memory', (req, res) => {
  const portee = String(req.query.portee ?? req.body?.portee ?? 'tout')
  const result = memory.clear(portee)
  if (!result.ok) return res.status(400).json({ ok: false, error: result.error })
  console.log(`[memoire] portee "${result.portee}" effacee par l API`)
  res.json({ ok: true, portee: result.portee, ...result.snapshot })
})

app.post('/api/control', requireBot, async (req, res) => {
  const control = String(req.body.control || '')
  const state = Boolean(req.body.state)

  const allowed = new Set(CONTROL_KEYS)

  if (!allowed.has(control)) {
    return res.status(400).json({ ok: false, error: 'Invalid control' })
  }
  // Garde executeur : arret total ou slot tenu => refus fail-closed, jamais
  // de chevauchement avec une mission/nav en cours.
  if (isHardStopped()) {
    return res.status(409).json({ ok: false, error: 'arret total : reprends d abord', code: 'stopped' })
  }
  try {
    const st = physicalExecutor ? physicalExecutor.status() : null
    if (st && st.busy) {
      return res.status(409).json({ ok: false, error: `executeur occupe par ${st.current?.id}`, code: 'busy' })
    }
    if (st && st.paused) {
      return res.status(409).json({ ok: false, error: 'travail en pause', code: 'paused' })
    }
  } catch (_) {}

  // Controle manuel DANS le writer (admission fail-closed busy/stop d abord,
  // jamais de chevauchement). Tenu indefini cote jeu : documente comme tel.
  try {
    requireAdmissionOrThrow()
  } catch (err) {
    return res.status(409).json({ ok: false, error: err.message, code: err.code || 'refus' })
  }
  try {
    await runPhysical(`api-control-${control}-${Date.now()}`, 'work', async () => {
      const held = state ? activeControls() : []
      if (state && bot?.pathfinder?.goal) stopPathfinding()
      bot.setControlState(control, state)
      for (const name of held) {
        if (name !== control) bot.setControlState(name, true)
      }
      return { control, state }
    })
  } catch (err) {
    return res.status(409).json({ ok: false, error: err.message, code: err.code || 'refus' })
  }
  res.json({ ok: true, control, state, controls: activeControls() })
})

app.post('/api/jump', requireBot, async (req, res) => {
  try {
    requireAdmissionOrThrow()
  } catch (err) {
    return res.status(409).json({ ok: false, error: err.message, code: err.code || 'refus' })
  }
  try {
    await runPhysical(`api-jump-${Date.now()}`, 'work', async () => {
      stopPathfinding()
      bot.setControlState('jump', true)
      await new Promise(resolve => setTimeout(resolve, 300))
      if (bot && spawned) bot.setControlState('jump', false)
      return { jumped: true }
    })
  } catch (err) {
    return res.status(409).json({ ok: false, error: err.message, code: err.code || 'refus' })
  }
  res.json({ ok: true })
})

app.post('/api/turn', requireBot, async (req, res) => {
  const degrees = Number(req.body.degrees)

  if (!Number.isFinite(degrees) || Math.abs(degrees) > 360) {
    return res.status(400).json({ ok: false, error: 'degrees must be between -360 and 360' })
  }
  try {
    requireAdmissionOrThrow()
  } catch (err) {
    return res.status(409).json({ ok: false, error: err.message, code: err.code || 'refus' })
  }

  try {
    await runPhysical(`api-turn-${Date.now()}`, 'work', async () => {
      stopPathfinding()
      const radians = degrees * Math.PI / 180
      await bot.look(bot.entity.yaw + radians, bot.entity.pitch, true)
      return { degrees }
    })
    res.json({ ok: true })
  } catch (err) {
    if (err && (err.code === 'paused' || err.code === 'stopped' || err.code === 'busy' || err.code === 'unavailable')) {
      return res.status(409).json({ ok: false, error: err.message, code: err.code })
    }
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/api/look', requireBot, async (req, res) => {
  const yaw = Number(req.body.yaw)
  const pitch = Number(req.body.pitch)

  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
    return res.status(400).json({ ok: false, error: 'yaw and pitch must be numbers in degrees' })
  }
  try {
    requireAdmissionOrThrow()
  } catch (err) {
    return res.status(409).json({ ok: false, error: err.message, code: err.code || 'refus' })
  }

  try {
    await runPhysical(`api-look-${Date.now()}`, 'work', async () => {
      stopPathfinding()
      await bot.look(yaw * Math.PI / 180, pitch * Math.PI / 180, true)
      return { yaw, pitch }
    })
    res.json({ ok: true })
  } catch (err) {
    if (err && (err.code === 'paused' || err.code === 'stopped' || err.code === 'busy' || err.code === 'unavailable')) {
      return res.status(409).json({ ok: false, error: err.message, code: err.code })
    }
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/api/chat', requireBot, (req, res) => {
  const message = String(req.body.message || '').trim()

  if (!message || message.length > 240) {
    return res.status(400).json({ ok: false, error: 'Message must contain 1 to 240 characters' })
  }

  bot.chat(message)
  res.json({ ok: true })
})

app.post('/api/goto', requireBot, (req, res) => {
  const x = Number(req.body.x)
  const y = Number(req.body.y)
  const z = Number(req.body.z)
  const rangeInput = Number(req.body.range ?? 1)
  const range = Math.max(1, Math.min(8, Number.isFinite(rangeInput) ? rangeInput : 1))

  if (![x, y, z].every(Number.isFinite)) {
    return res.status(400).json({ ok: false, error: 'x, y and z must be numbers' })
  }
  // Admission AVANT tout ordre (fail-closed) : un refus ne detruit rien.
  try {
    requireAdmissionOrThrow()
  } catch (err) {
    return res.status(409).json({ ok: false, error: err.message, code: err.code || 'refus' })
  }

  const target = { x, y, z, range: Math.floor(range) }
  // Une invocation = tout le trajet, en tache de fond (reponse immediate
  // d admission, slot tenu jusqu a resolution reelle).
  runPhysical(`api-goto-${Date.now()}`, 'work', async ({ signal }) => {
    if (signal?.aborted) return { code: 'cancelled', reached: false }
    stopPathfinding()
    lastPathStatus = null
    return await navigator.toPosition({ x, y, z }, { signal, radius: target.range })
  }).catch(err => {
    console.error(`[nav] goto refuse/interrompu (${err.code || 'erreur'}) : ${err.message}`)
  })
  res.json({ ok: true, admitted: true, target })
})

// Vrais flux /api/instruction : inbox persistee + immediats hors LLM.
// stop / arret total / reprends bypassent le modele ; le reste passe par la
// conversation (question/context conservent, concurrent => arbitrage).
app.post('/api/instruction', validateModeFirst, requireBot, async (req, res) => {
  const message = String(req.body.message ?? '').trim()
  const requester = String(req.body.requester ?? '').trim()
  if (!message || message.length > 1000 || !requester) return res.status(400).json({ ok: false, error: 'message et requester requis' })
  // Inbox persistee best-effort AVANT interpret (sans perte sur annulation).
  // Le terminal (propose/addContext) persiste aussi : en cas de doublon futur,
  // c est l inbox qui fait foi, jamais une perte.
  recentChat.push({ de: requester, message: message.slice(0, 160), a: new Date().toISOString() })
  if (recentChat.length > CHAT_HISTORY_MAX) recentChat.shift()
  if (isHardStopText(message)) {
    handleHardStop()
    return res.json({ ok: true, relation: 'stop', kind: 'hardstop' })
  }
  if (isResumeText(message)) {
    handleResume()
    return res.json({ ok: true, relation: 'resume' })
  }
  if (isSoftStopText(message)) {
    HANDLERS.stop()
    return res.json({ ok: true, relation: 'stop' })
  }
  const result = await resolveIntent(requester, message, req.directMode ? { mode: req.directMode } : undefined)
  res.json({ ok: !result?.error, ...result })
})

app.post('/api/mission', validateModeFirst, requireBot, async (req, res) => {
  conversation.cancel(false)
  const objective = String(req.body.objective || '').trim()
  const requester = String(req.body.requester || 'api').slice(0, 32)

  if (!objective || objective.length > 240) {
    return res.status(400).json({ ok: false, error: 'objective must contain 1 to 240 characters' })
  }
  // Meme intake durable que le chat (hardstop + arbitrage), jamais direct.
  const result = await startObjectiveDurable(objective, requester, req.directMode ? { mode: req.directMode } : undefined)
  if (!result.ok && !result.arbitration && !result.queued) return res.status(409).json(result)

  res.json(result)
})

app.get('/api/mission', (req, res) => {
  res.json({ ok: true, running: missionRunner.isRunning(), mission: missionRunner.status() })
})

app.get('/api/navigation/trace', (req, res) => res.json(req.query.history === '1'
  ? { ok: true, traces: navigator.traces(), active: navigator.isActive() ? navigator.trace() : null }
  : { ok: true, trace: navigator.trace() }))

app.delete('/api/mission', (req, res) => {
  // Vraie pause (contexte conserve, reprise possible), pas de stop destructeur.
  // Forme compatible : cles historiques gardees, `paused` additif.
  conversation.cancel()
  const wasRunning = missionRunner.isRunning()
  const paused = wasRunning ? missionRunner.pauseWork('arret demande via l API') : false
  res.json({ ok: true, stopped: false, paused, mission: missionRunner.status() })
})

app.post('/api/unstuck', requireBot, async (req, res) => {
  if (isHardStopped()) {
    return res.status(409).json({ ok: false, error: 'arret total : rescue interdit, reprends d abord', code: 'stopped', rescues: rescueCount, lastRescue })
  }
  await rescue('requested via API', { escalate: true })
  res.json({ ok: true, rescues: rescueCount, lastRescue })
})

app.post('/api/stop', requireBot, (req, res) => {
  HANDLERS.stop()
  res.json({ ok: true, missionStopped: true })
})

app.post('/api/arret-total', requireBot, (req, res) => {
  handleHardStop()
  res.json({ ok: true, hardstop: true })
})

app.post('/api/resume', requireBot, (req, res) => {
  handleResume()
  res.json({ ok: true, resumed: true })
})

app.get('/api/objectifs', (req, res) => {
  res.json({ ok: true, objectifs: objectivesSnapshotSafe() })
})

// Filet des handlers async : une route qui leve (Express 5 propage le rejet)
// doit rendre un 500 lisible au lieu de laisser la requete pendre.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err)

  // Corps de requete illisible (JSON malforme : `entity.parse.failed`, ou corps
  // trop volumineux : `entity.too.large`) : c'est la faute du client, pas une
  // panne interne. Le 500 + le message dans le chat etaient trompeurs et
  // polluaient le jeu ; on rend le vrai code d'erreur sans journaliser.
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    return res.status(err.statusCode || err.status || 400).json({ ok: false, error: err.message })
  }

  console.error('[api] erreur non geree :', err.message)
  res.status(500).json({ ok: false, error: err.message })
})

// Verification de coherence au demarrage : les commandes declarees, les
// handlers branches et les etapes de mission doivent former le meme ensemble.
const commandAudit = skills.audit(Object.keys(HANDLERS), missionRunner.ACTION_NAMES)

if (commandAudit.ok) {
  console.log(
    `[commandes] ${commandAudit.counts.commandes} commandes ` +
    `(${commandAudit.counts.routables_par_jev} routables par Jev, ${commandAudit.counts.prefixe_uniquement} sur prefixe seul), ` +
    `${commandAudit.counts.actions} actions dont ${commandAudit.counts.actions_parametrees} a deux etages, ` +
    `sur ${commandAudit.counts.types_de_mission} types de mission, ` +
    `${commandAudit.counts.ressources} matieres, ${commandAudit.counts.reperes} reperes, ` +
    `${Object.keys(craft.TARGETS).length} fabrications, approvisionnement ${missionRunner.SUPPLY} : coherent`
  )
} else {
  console.error('[commandes] INCOHERENCES :')
  for (const problem of commandAudit.problems) console.error(`  - ${problem}`)
}

skills.loadDocs()
memory.load()

if (planner.isEnabled()) {
  console.log(
    `[planner] ${planner.MODEL} sur ${planner.BASE_URL} : plans de ${planner.PLAN_MAX} etapes, ` +
    `${skills.documentedActions().filter(d => d.source === 'aide').length} action(s) documentee(s) par l aide, ` +
    `seuil de fin ${planner.DONE_THRESHOLD}`
  )
  if (jev.init()) console.log('[jev] disponible mais inutilise : le planificateur JSON a la main')
  // En arriere-plan : le bot peut se connecter et obeir aux commandes prefixees
  // pendant que le modele monte en VRAM.
  planner.warmup()
} else if (jev.init()) {
  console.log(`[jev] seul classificateur (modele ${jev.MODEL}, confiance mini ${jev.MIN_CONFIDENCE}, seuil de fin ${jev.DONE_THRESHOLD})`)
} else {
  console.log(`[planner] INACTIF et [jev] INACTIF (${jev.initError}) - le bot n obeira qu aux commandes ${CMD_PREFIX}`)
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
  watchdogTimer = setInterval(watchdogTick, 1000)
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
  getNavigator: () => navigator,
  readDirectMode
}
