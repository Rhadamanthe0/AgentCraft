'use strict'

// Positionnement mesure, pas recolte : un tronc a portee ne prouve pas que le
// corps se trouve sous la couronne. Les destinations viennent des chunks reels.
const { clearSegment } = require('./navigation')
const { awaitPhysicalWithTimeout } = require('./executor')
const leaf = b => Boolean(b && /_leaves$/.test(b.name))
const solid = b => Boolean(b?.shapes?.length || b?.boundingBox === 'block')
const liquid = b => !b || /water|lava|bubble_column/.test(b.name)
const xz = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)

function blockAt (bot, x, y, z) {
  return bot.blockAt(new bot.entity.position.constructor(Math.floor(x), Math.floor(y), Math.floor(z)))
}

function trunks (bot) {
  const ids = Object.values(bot.registry.blocksByName).filter(b => /_log$/.test(b.name)).map(b => b.id)
  return ids.length ? bot.findBlocks({ matching: ids, maxDistance: 32, count: 96 }) : []
}

function coverAt (bot, position, logs = trunks(bot)) {
  if (!logs.some(p => xz(p, position) <= 4.5 && Math.abs(p.y - position.y) <= 9)) return null
  for (let y = Math.ceil(position.y + 1.8); y <= position.y + 8; y++) {
    const b = blockAt(bot, position.x, y, position.z)
    if (!b) return null
    if (leaf(b)) return { x: b.position.x, y: b.position.y, z: b.position.z, name: b.name }
    // Un toit intermediaire n est pas une couronne d arbre accessible dessous.
    if (solid(b)) return null
  }
  return null
}

function findSites (bot) {
  const logs = trunks(bot)
  if (!logs.length) return []
  const ids = Object.values(bot.registry.blocksByName).filter(b => /_leaves$/.test(b.name)).map(b => b.id)
  const leaves = ids.length ? bot.findBlocks({ matching: ids, maxDistance: 32, count: 256 }) : []
  const columns = new Map()
  for (const p of leaves) {
    const key = `${p.x},${p.z}`
    if (!columns.has(key) || p.y > columns.get(key).y) columns.set(key, p)
  }
  const sites = []
  for (const top of columns.values()) {
    const minY = Math.max(top.y - 8, Math.floor(bot.entity.position.y) - 6)
    for (let y = top.y - 2; y >= minY; y--) {
      const floor = blockAt(bot, top.x, y - 1, top.z)
      if (liquid(floor) || !solid(floor) || /_leaves$|_log$/.test(floor.name)) continue
      // Le parcours de cette capacite vise les appuis pleins ; pas une tour.
      if (floor.shapes?.length && Math.max(...floor.shapes.map(s => s[4])) < 0.99) continue
      const point = { x: top.x + 0.5, y, z: top.z + 0.5 }
      const feet = blockAt(bot, point.x, y, point.z)
      const head = blockAt(bot, point.x, y + 1, point.z)
      if (liquid(feet) || liquid(head)) continue
      const obstacles = [feet, head].filter(solid)
      if (obstacles.some(b => !leaf(b))) continue
      const cover = coverAt(bot, point, logs)
      if (!cover) continue
      sites.push({ point, cover, obstacles,
        cost: xz(bot.entity.position, point) + 2 * Math.abs(bot.entity.position.y - y) + obstacles.length * 6 })
    }
  }
  return sites.sort((a, b) => a.cost - b.cost)
}

async function clearOne (bot, block, permission, signal) {
  if (signal.aborted) return { reached: false, code: 'cancelled' }
  if (permission.used >= permission.limit || !leaf(block)) return { reached: false, code: 'clearance_not_authorized' }
  if (!bot.canDigBlock(block)) return { reached: false, code: 'block_out_of_reach' }
  // Reservation avant l appel : meme une erreur ou un timeout ne permet pas
  // de depasser l autorisation lors d une autre tentative/revision.
  // R01 : au timeout/abort, stopDigging est appele puis le settle REEL du dig
  // est attendu avant de rendre dig_timeout/cancelled. Jamais de Promise.race
  // qui rendrait pendant que le dig vit encore (chevauchement physique).
  permission.used++
  try {
    await awaitPhysicalWithTimeout(bot.dig(block, true), 8000, 'dig_timeout', {
      signal, onTimeout: () => { try { bot.stopDigging() } catch (_) {} }
    })
    if (signal.aborted) return { reached: false, code: 'cancelled' }
    const fresh = bot.blockAt(block.position)
    return { reached: Boolean(fresh && !solid(fresh)), code: fresh && !solid(fresh) ? 'cleared' : 'dig_refused' }
  } catch (err) {
    return { reached: false, code: signal.aborted || err?.code === 'cancelled' ? 'cancelled' : err.message }
  }
}

async function underTree (host, permission, signal) {
  if (signal.aborted) return { reached: false, code: 'cancelled' }
  const bot = host.getBot()
  if (!bot?.entity) return { reached: false, code: 'disconnected' }
  const sites = findSites(bot)
  const witness = () => coverAt(bot, bot.entity.position)
  const grounded = () => Boolean(bot.entity?.onGround && clearSegment(bot, bot.entity.position, bot.entity.position, true))
  const already = witness()
  if (already && grounded()) {
    return { reached: true, code: 'under_tree', cover: already, cleared: 0 }
  }
  let lastCode = sites.length ? 'no_path' : 'no_tree_site'
  let attempts = 0
  let cleared = 0
  const trySite = async site => {
    if (signal.aborted) return { reached: false, code: 'cancelled' }
    const result = await host.navigateToPosition(site.point, { signal, radius: 0.4 })
    if (!result.reached) { lastCode = result.code; return null }
    const until = Date.now() + 800
    while (!signal.aborted && bot.entity && !grounded() && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (signal.aborted) return { reached: false, code: 'cancelled' }
    if (!grounded()) return { reached: false, code: 'unstable_position' }
    const cover = witness()
    return cover ? { reached: true, code: 'under_tree', position: { ...site.point }, cover, cleared }
      : { reached: false, code: 'cover_changed' }
  }
  // Un emplacement libre d abord : la permission n est jamais une obligation.
  for (const site of sites.filter(s => !s.obstacles.length).slice(0, 4)) {
    attempts++
    const result = await trySite(site)
    if (result) return result
  }
  const obstructed = sites.filter(s => s.obstacles.length === 1)
  for (const site of obstructed.slice(0, 4)) {
    if (signal.aborted) return { reached: false, code: 'cancelled' }
    if (permission.used >= permission.limit) return { reached: false, code: 'clearance_required', attempts,
      detail: 'un bloc de feuilles obstrue le placement ; aucune autorisation de degagement restante' }
    const V = bot.entity.position.constructor
    const obstacle = site.obstacles[0]
    // Poste d approche libre au meme niveau. On ne marche pas vers une case
    // encore occupee et on ne creuse pas le sol qui porte le bot.
    const approaches = []
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
      const p = new V(site.point.x + dx, site.point.y, site.point.z + dz)
      if (clearSegment(bot, p, p, true)) approaches.push(p)
    }
    approaches.sort((a, b) => xz(bot.entity.position, a) - xz(bot.entity.position, b))
    for (const p of approaches.slice(0, 3)) {
      const approach = await host.navigateToPosition(p, { signal, radius: 0.4 })
      if (signal.aborted) return { reached: false, code: 'cancelled' }
      if (!approach.reached) continue
      const fresh = bot.blockAt(obstacle.position)
      if (!leaf(fresh)) { lastCode = 'obstacle_changed'; break }
      const result = await clearOne(bot, fresh, permission, signal)
      if (!result.reached) return { ...result, cleared }
      cleared++
      return (await trySite(site)) ?? { reached: false, code: lastCode, cleared }
    }
  }
  if (sites.length && sites.every(s => s.obstacles.length > 1)) {
    return { reached: false, code: 'clearance_budget_insufficient', detail: 'les emplacements reperes demandent de degager plus d un bloc', attempts, cleared }
  }
  return { reached: false, code: lastCode, attempts, cleared,
    detail: lastCode === 'no_tree_site' ? 'aucun emplacement au sol sous une couronne d arbre repere dans les chunks charges'
      : 'je n ai pas pu atteindre un emplacement sous cet arbre' }
}

module.exports = { findSites, coverAt, clearOne, underTree }
