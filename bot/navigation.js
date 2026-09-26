'use strict'

const { Movements, goals } = require('mineflayer-pathfinder')
const { createMotionTrace } = require('./motion-trace')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const distanceXZ = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)

// getMoveDiagonal accepte un seul cote degage. Depuis le bord d une case,
// cela coupe un coin de collision (observe sous des feuilles en 26.1).
// Les points cardinaux donnent au corps de 0,6 bloc la place de contourner.
class WalkingMovements extends Movements {
  getMoveDiagonal () {}

  getLandingBlock (node, dir) {
    const landing = super.getLandingBlock(node, dir)
    if (!landing?.position || landing.liquid || !landing.safe) return null
    const current = this.getBlock(node, 0, 0, 0)
    const from = current.shapes?.length ? current : this.getBlock(node, 0, -1, 0)
    const support = this.getBlock(landing.position, 0, -1, 0)
    // Node levels alone would admit a 2.5-block fall onto a bottom slab.
    // Bound the physical drop between support surfaces, with no liquid/unknown landing.
    if (!from.physical || !support.physical || from.height - support.height > 2) return null
    return landing
  }
}

// Une arrivee est une mesure, jamais un evenement goal_reached ni un trajet
// partiellement execute. La hauteur empeche de confondre deux etages.
function arrived (a, b, radius = 2) {
  return Boolean(a && b && [a.x, a.y, a.z, b.x, b.y, b.z].every(Number.isFinite) && distanceXZ(a, b) <= radius && Math.abs(a.y - b.y) <= 0.75)
}

// Verification du volume du corps, y compris les coins. Le rayon seul peut
// annoncer une arrivee de l autre cote d un mur. Inconnu = non traversable.
function clearSegment (bot, from, to, requireFloor = false) {
  if (!bot.blockAt) return false
  const n = Math.max(1, Math.ceil(distanceXZ(from, to) / 0.2))
  const V = bot.entity.position.constructor
  for (let i = 0; i <= n; i++) {
    const p = { x: from.x + (to.x - from.x) * i / n,
      y: from.y + (to.y - from.y) * i / n, z: from.z + (to.z - from.z) * i / n }
    const min = { x: p.x - 0.29, y: p.y + 0.02, z: p.z - 0.29 }
    const max = { x: p.x + 0.29, y: p.y + 1.78, z: p.z + 0.29 }
    if (requireFloor) {
      const y = Math.floor(p.y - 0.01)
      const floor = bot.blockAt(new V(Math.floor(p.x), y, Math.floor(p.z)))
      const shapes = floor?.shapes ?? []
      if (!floor || /water|lava|bubble_column/.test(floor.name) || !shapes.length ||
        Math.abs(y + Math.max(...shapes.map(s => s[4])) - p.y) > 0.3) return false
    }
    for (let x = Math.floor(min.x); x <= Math.floor(max.x); x++) {
      for (let y = Math.floor(min.y); y <= Math.floor(max.y); y++) {
        for (let z = Math.floor(min.z); z <= Math.floor(max.z); z++) {
          const b = bot.blockAt(new V(x, y, z))
          if (!b || /water|lava|bubble_column/.test(b.name)) return false
          const shapes = b.shapes ?? (b.boundingBox === 'block' ? [[0, 0, 0, 1, 1, 1]] : [])
          if (shapes.some(s => min.x < x + s[3] && max.x > x + s[0] && min.y < y + s[4] && max.y > y + s[1] && min.z < z + s[5] && max.z > z + s[2])) return false
        }
      }
    }
  }
  return true
}

// An item is collected from a nearby supported post, not by fitting the
// player's entire body at the item's sub-block coordinates.
function itemInPickupRange (bot, feet, item, radius = 1.6) {
  return arrived(feet, item, radius) && clearSegment(bot, feet, feet, true)
}

// Une ressource est un bloc a toucher, pas une position ou mettre les pieds.
// A* cherche n importe quel poste avec appui, corps libre et ligne de vue.
function blockInReach (bot, feet, target, reach = 4) {
  if (!clearSegment(bot, feet, feet, true)) return false
  const V = bot.entity.position.constructor
  const eye = new V(feet.x, feet.y + 1.62, feet.z)
  const length = eye.distanceTo(target)
  // Garder aussi la limite conservatrice de l action casser (pieds-centre).
  if (length > reach || Math.hypot(feet.x - target.x, feet.y - target.y, feet.z - target.z) > reach) return false
  const n = Math.max(1, Math.ceil(length / 0.1))
  for (let i = 0; i <= n; i++) {
    const p = new V(eye.x + (target.x - eye.x) * i / n,
      eye.y + (target.y - eye.y) * i / n, eye.z + (target.z - eye.z) * i / n)
    const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
    if (x === Math.floor(target.x) && y === Math.floor(target.y) && z === Math.floor(target.z)) return true
    const block = bot.blockAt(new V(x, y, z))
    if (!block || /water|lava|bubble_column/.test(block.name)) return false
    const shapes = block.shapes ?? (block.boundingBox === 'block' ? [[0, 0, 0, 1, 1, 1]] : [])
    if (shapes.some(s => p.x >= x + s[0] && p.x <= x + s[3] && p.y >= y + s[1] && p.y <= y + s[4] && p.z >= z + s[2] && p.z <= z + s[5])) return false
  }
  return false
}

function createNavigator (getBot, options = {}) {
  let active = null
  let last = null
  let trace = null
  const traceHistory = []
  const timeoutMs = options.timeoutMs ?? 30000

  function cancel () {
    if (!active) return
    const job = active
    active = null
    job.cancelled = true
    last = { username: job.username, code: 'cancelled' }
    job.bot.clearControlStates()
    job.trace.stop('cancelled')
  }

  async function navigate (resolveTarget, { signal, follow = false, durationMs = null, radius = 2, username = null,
    interaction = false, allowHighApproach = false, pickup = false, distanceBudget = Infinity, timeoutMs: journeyTimeoutMs = timeoutMs } = {}) {
    if (signal?.aborted) return { code: 'cancelled', reached: false }
    cancel()
    const bot = getBot()
    if (!bot?.entity || !bot.pathfinder) return { code: 'disconnected', reached: false }
    bot.pathfinder.setGoal(null)
    bot.clearControlStates()
    const recording = createMotionTrace(bot, { label: username ?? 'position' })
    trace = recording
    const report = value => { recording.event(value); options.trace?.(value) }
    const job = { bot, cancelled: false, username, trace: recording }
    active = job
    const abort = () => { if (active === job) cancel() }
    signal?.addEventListener('abort', abort, { once: true })
    const stopped = () => job.cancelled || signal?.aborted || getBot() !== bot || !bot.entity
    const movements = new WalkingMovements(bot)
    movements.canDig = false
    movements.allow1by1towers = false
    movements.allowParkour = false
    // Ce navigateur ne pose rien : sans cela, un bot porteur de terre recevait
    // des chemins a poser (pont sur l eau) refuses en unsupported_move, en
    // boucle (vu sur terrain/moat apres le pont de terre).
    movements.scafoldingBlocks = []
    // Pathfinder 2.4.5 compte jusqu au BLOC d appui, pas jusqu aux pieds :
    // 3 permits two blocks down; WalkingMovements also checks actual surfaces.
    movements.maxDropDown = 3
    const blockedNodes = new Set()
    movements.exclusionAreasStep ??= []
    movements.exclusionAreasStep.push(block => !block.position || blockedNodes.has(`${block.position.x},${block.position.y},${block.position.z}`) ? 100 : 0)
    // La nage 26.1 n est pas fiable : un chemin dans l eau n est pas executable.
    for (const name of ['water', 'lava', 'bubble_column']) {
      const block = bot.registry.blocksByName[name]
      if (block) movements.blocksToAvoid.add(block.id)
    }
    let deadline = Date.now() + journeyTimeoutMs
    let route = []
    let plannedTarget = null
    let anchor = bot.entity.position.clone()
    let progressAt = Date.now()
    let recoveries = 0
    let jumpUntil = 0
    let touchedPoint = null
    let settlingSince = null
    let code = 'timeout'
    let remaining = null
    let lostAt = null
    let travelled = 0
    let approachingHigh = false
    let emptyReplans = 0
    let heightEvidence = null
    let measuredAt = bot.entity.position.clone()
    const startedAt = Date.now()
    const isArrived = (p, t) => interaction ? blockInReach(bot, p, t)
      : pickup ? itemInPickupRange(bot, p, t, radius) : arrived(p, t, radius) && clearSegment(bot, p, t)
    const isHighPost = (p, t) => interaction && allowHighApproach && distanceXZ(p, t) <= 2 &&
      t.y - p.y > 4 && clearSegment(bot, p, p, true)
    const waypoint = node => {
      const V = bot.entity.position.constructor
      let y = node.y
      for (const offset of [0, -1]) {
        const block = bot.blockAt(new V(node.x, node.y + offset, node.z))
        if (block?.shapes?.length) {
          y = node.y + offset + Math.max(...block.shapes.map(s => s[4]))
          break
        }
      }
      return { ...node, x: Math.floor(node.x) + 0.5, y, z: Math.floor(node.z) + 0.5 }
    }

    // Borner chaque tranche A* et rendre la main a la physique entre tranches.
    // Le pathfinder calcule seulement : il ne possede jamais les touches.
    async function plan (target, highApproach = false) {
      const start = bot.entity.position.clone()
      const goal = new goals.GoalNear(target.x, target.y, target.z, interaction ? 4 : 1)
      // Le but du calcul et le test d arrivee utilisent la meme geometrie.
      goal.isEnd = node => highApproach ? isHighPost(waypoint(node), target) : isArrived(waypoint(node), target)
      if (highApproach) goal.heuristic = node => Math.max(0, distanceXZ(waypoint(node), target) - 2)
      const generator = bot.pathfinder.getPathFromTo(movements, start, goal, {
        timeout: 1000, tickTimeout: 20, searchRadius: 64, optimizePath: false
      })
      for (const { result } of generator) {
        if (stopped() || Date.now() >= deadline) return null
        if (result.status === 'success') {
          // 2.4.5 : postProcessPath modifie les objets partages avec A* lors
          // des resultats PARTIAL. Ne jamais l appeler entre deux tranches.
          // Convertir des COPIES en points physiques apres success seulement.
          const path = result.path.map(waypoint)
          const center = waypoint({ x: Math.floor(start.x), y: Math.floor(start.y), z: Math.floor(start.z) })
          // A* part du centre de la case. Rejoindre physiquement ce centre
          // avant le premier virage evite de couper un coin depuis son bord.
          // Seulement si utile et avec un vrai appui : sur une levre, revenir
          // au centre pouvait faire tomber d un bloc puis tourner de 360 deg.
          const direct = path.length && clearSegment(bot, bot.entity.position, path[0], true)
          if (path.length && !direct && distanceXZ(bot.entity.position, center) > 0.15 && clearSegment(bot, bot.entity.position, center, true)) path.unshift(center)
          report({ event: 'path', highApproach, path: path.map(p => ({ x: p.x, y: p.y, z: p.z })) })
          // A* raisonne au centre des cases : chemin vide peut signifier que
          // CE centre satisfait le but alors que le corps est encore au bord.
          const p = bot.entity.position
          return path.length ? path : (highApproach || pickup) ? [center] : [clearSegment(bot, p, target)
            ? { x: target.x, y: target.y, z: target.z }
            : { x: Math.floor(p.x) + 0.5, y: Math.floor(p.y), z: Math.floor(p.z) + 0.5 }]
        }
        if (result.status !== 'partial') {
          report({ event: 'search_failed', highApproach, status: result.status, visited: result.visitedNodes,
            target, goalAtTarget: goal.isEnd({ x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z) }) })
          return null
        }
        report({ event: 'search_slice', status: 'partial', visited: result.visitedNodes })
        await sleep(0)
      }
      return null
    }

    try {
      while (!stopped() && Date.now() < deadline) {
        const target = resolveTarget(bot)
        if (!target) {
          bot.clearControlStates()
          lostAt ??= Date.now()
          if (Date.now() - lostAt >= (options.targetLostMs ?? 2000)) { code = 'target_lost'; break }
          await sleep(50)
          continue
        }
        lostAt = null
        const here = bot.entity.position
        travelled += distanceXZ(measuredAt, here)
        measuredAt = here.clone()
        remaining = Number(here.distanceTo(target).toFixed(2))
        if (follow && durationMs != null && Date.now() - startedAt >= durationMs) {
          code = isArrived(here, target) ? 'followed' : 'follow_incomplete'
          break
        }
        if (isArrived(here, target) && bot.entity.onGround) {
          bot.clearControlStates()
          if (!follow) { code = 'arrived'; break }
          // Suivi : immobile a proximite est un succes, pas un blocage.
          deadline = Date.now() + journeyTimeoutMs
          route = []
          recoveries = 0
          progressAt = Date.now()
          anchor = here.clone()
          await sleep(100)
          continue
        }
        if (approachingHigh && isHighPost(here, target) && bot.entity.onGround) {
          code = 'needs_height'
          heightEvidence = { position: { x: here.x, y: here.y, z: here.z },
            horizontalDistance: Number(distanceXZ(here, target).toFixed(2)),
            verticalGap: Number((target.y - here.y).toFixed(2)) }
          break
        }
        if (travelled >= distanceBudget) { code = 'advanced'; break }

        if (!plannedTarget || plannedTarget.distanceTo(target) > 1.5 || route.length === 0) {
          bot.clearControlStates()
          // Ne pas lancer A* depuis une case solide pendant une montee :
          // attendre la retombee, en laissant tourner la physique et stop.
          for (let i = 0; i < 12 && !stopped(); i++) {
            const velocity = bot.entity.velocity
            if (bot.entity.onGround && Math.hypot(velocity?.x ?? 0, velocity?.z ?? 0) < 0.02) break
            await sleep(50)
          }
          if (stopped()) break
          if (isArrived(bot.entity.position, target)) continue
          plannedTarget = target.clone()
          approachingHigh = false
          route = await plan(plannedTarget)
          if (stopped()) break
          // An interaction post always wins. Only resource callers can opt into
          // approaching a dry supported post below a target that remains too high.
          if (!route?.length && interaction && allowHighApproach && Date.now() < deadline) {
            route = await plan(plannedTarget, true)
            approachingHigh = Boolean(route?.length)
          }
          if (stopped()) break
          if (Date.now() >= deadline) { code = 'timeout'; break }
          if (!route?.length) { code = bot.entity.onGround && isArrived(bot.entity.position, target) ? 'arrived' : 'no_path'; break }
          progressAt = Date.now()
          anchor = bot.entity.position.clone()
        }
        while (route.length) {
          const p = bot.entity.position
          const point = route[0]
          const next = route[1]
          const near = distanceXZ(p, point) <= 0.2
          let passed = false
          if (next && touchedPoint === point && distanceXZ(p, point) <= 0.85) {
            const dx = next.x - point.x
            const dz = next.z - point.z
            const length = Math.hypot(dx, dz)
            const projection = length ? ((p.x - point.x) * dx + (p.z - point.z) * dz) / length : -1
            const lateral = length ? Math.abs((p.x - point.x) * dz - (p.z - point.z) * dx) / length : Infinity
            const step = Math.abs(next.y - point.y)
            passed = clearSegment(bot, p, next, true) ||
              (step > 0.1 && step <= 1.25 && projection >= 0 && lateral <= 0.2)
          }
          if (Math.abs(p.y - point.y) > 0.2 || (!near && !passed)) break
          route.shift()
          touchedPoint = null
        }
        if (!route.length) {
          // Chemin deja consomme sans bouger (le bot est sur la seule case du
          // chemin mais pas arrive) : replanifier donnait le meme chemin, en
          // boucle synchrone, jusqu a la deconnexion par le serveur (vu sur
          // trees/pillar). Rendre la main, et abandonner apres trois fois.
          emptyReplans += 1
          if (emptyReplans >= 3) { code = 'no_path'; break }
          await sleep(50)
          continue
        }
        emptyReplans = 0
        const point = route[0]
        recording.target(point)
        if (point.toBreak?.length || point.toPlace?.length || point.parkour) {
          code = 'unsupported_move'; break
        }
        const p = bot.entity.position
        if (distanceXZ(p, point) < 0.35) touchedPoint = point
        // Pendant la retombee, ne pas poursuivre/contourner un point deja
        // atteint en XZ : c etait la source des demi-tours en plein saut.
        if (touchedPoint === point && (p.y - point.y > 0.2 || (!bot.entity.onGround && Math.abs(p.y - point.y) > 0.2))) {
          bot.setControlState('forward', false)
          bot.setControlState('jump', false)
          settlingSince ??= Date.now()
          if (Date.now() - settlingSince > 1000) {
            route = []
            touchedPoint = null
            settlingSince = null
          }
          await sleep(50)
          continue
        }
        settlingSince = null
        await bot.look(Math.atan2(-(point.x - p.x), -(point.z - p.z)), 0, true)
        if (stopped()) break

        // Decoller AVANT de pousser contre une marche. Aucune modification de
        // position, de gravite ni de onGround : seulement les controles normaux.
        const stalled = Date.now() - progressAt > 1800
        const stepUp = point.y - p.y > 0.5 && distanceXZ(p, point) < 1.2
        if (stalled) {
          if (++recoveries > 3) { code = 'stuck'; break }
          // Un trajet physiquement refuse ne doit pas etre recalcule identique.
          // Le graphe exclut cette case pour les tentatives de CE trajet.
          blockedNodes.add(`${Math.floor(point.x)},${Math.floor(point.y)},${Math.floor(point.z)}`)
          report({ event: 'blocked_waypoint', point })
          bot.clearControlStates()
          route = []
          progressAt = Date.now()
          continue
        }
        if (stepUp && (!bot.entity.onGround || Date.now() < jumpUntil)) {
          // Escalier continu : finir d atterrir avant la marche suivante,
          // plutot que pousser son rebord et perdre onGround.
          bot.setControlState('forward', false)
          await sleep(50)
          continue
        }
        if (stepUp && bot.entity.onGround && Date.now() >= jumpUntil) {
          // Pauses courtes (50 ms d arret, 400 ms de garde apres le saut) :
          // meme geste arret-saut-atterrissage, marche 17 % plus rapide au
          // banc tmp/stairs-bench.js (4,53 -> 3,77 s). Un suivi dans un
          // escalier decrochait a 8,15 blocs (follow/stairs, arene tournee).
          bot.clearControlStates()
          await sleep(50)
          if (stopped()) break
          report({ event: 'jump', onGround: bot.entity.onGround, point, position: bot.entity.position.clone() })
          if (bot.entity.onGround) {
            bot.setControlState('jump', true)
            await sleep(100)
            if (stopped()) break
            bot.setControlState('jump', false)
            report({ event: 'jumped', onGround: bot.entity.onGround, position: bot.entity.position.clone() })
          }
          jumpUntil = Date.now() + 400
          progressAt = Date.now()
        }
        bot.setControlState('forward', true)
        bot.setControlState('sprint', false)
        if (Date.now() >= jumpUntil) bot.setControlState('jump', false)
        if (bot.entity.position.distanceTo(anchor) > 0.4) {
          anchor = bot.entity.position.clone()
          progressAt = Date.now()
          if (follow) deadline = Date.now() + journeyTimeoutMs
        }
        await sleep(50)
      }
      if (stopped()) code = 'cancelled'
    } catch (err) {
      code = stopped() ? 'cancelled' : 'navigation_error'
      return { reached: false, code, detail: err.message, remaining, travelled: Number(travelled.toFixed(2)) }
    } finally {
      signal?.removeEventListener('abort', abort)
      // Une ancienne execution ne doit pas relacher les touches du successeur.
      if (active === job) {
        bot.clearControlStates()
        active = null
        last = { username, code, remaining }
      }
      recording.stop(code)
      traceHistory.push(recording)
      if (traceHistory.length > 8) traceHistory.shift()
    }
    return { reached: code === 'arrived' || code === 'followed', code, remaining, travelled: Number(travelled.toFixed(2)), ...heightEvidence }
  }

  const toPlayer = (username, opts = {}) => navigate(bot => bot.players[username]?.entity?.position, { ...opts, username })
  const toPosition = (point, opts = {}) => {
    const bot = getBot()
    if (!bot?.entity || ![point?.x, point?.y, point?.z].every(Number.isFinite)) return Promise.resolve({ reached: false, code: 'invalid_target' })
    const target = new bot.entity.position.constructor(point.x, point.y, point.z)
    return navigate(() => target, opts)
  }
  return { toPlayer, toPosition, cancel, isActive: () => active !== null,
    trace: () => trace?.snapshot() ?? null,
    traces: () => traceHistory.map(t => t.snapshot()),
    status: () => active ? { username: active.username, code: 'running' } : last }
}

module.exports = { createNavigator, arrived, clearSegment, blockInReach, itemInPickupRange }
