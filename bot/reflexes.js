'use strict'

// Reflexes : comportements generiques qui ne passent pas par le modele,
// inspires des « modes » de Mindcraft (self_preservation, item_collecting,
// elbow_room, cowardice). Ils valent pour toute mission et toute situation,
// jamais pour un niveau du banc.
//
// Ce module ne fait que DETECTER (fonctions pures sur un objet bot) ; la
// mission execute le geste entre deux etapes, dans le slot de l etape, puis
// dit au modele ce qui s est passe (`reflexes_recents`), comme le journal de
// comportement de Mindcraft. L ordre de REFLEXES est la priorite.

const FALLING = /(^|_)(sand|gravel)$|concrete_powder$|^anvil$|^pointed_dripstone$/
const HOT = /^(lava|fire|soul_fire|magma_block|campfire|soul_campfire)$/
const HOSTILE_KIND = /hostile/i
const DROP_RADIUS = 4
const DROP_MAX_DY = 1.5
const CROWD_RADIUS = 0.7
const HOSTILE_RADIUS = 8

function at (bot, v) {
  try { return bot.blockAt(v) } catch (_) { return null }
}

function offset (pos, dx, dy, dz) {
  return pos.offset ? pos.offset(dx, dy, dz) : { x: pos.x + dx, y: pos.y + dy, z: pos.z + dz }
}

// Danger immediat : bloc qui tombe sur la tete, feu/lave au contact, tete
// prise dans un bloc plein. Rend { type, source } ou null.
function detectDanger (bot) {
  const pos = bot?.entity?.position
  if (!pos) return null
  const feet = pos.floored ? pos.floored() : { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }
  for (const dy of [2, 3]) {
    const b = at(bot, offset(feet, 0, dy, 0))
    if (b && FALLING.test(b.name)) {
      const under = at(bot, offset(feet, 0, dy - 1, 0))
      if (!under || under.boundingBox === 'empty') return { type: 'chute_de_bloc', source: b.position ?? offset(feet, 0, dy, 0), bloc: b.name }
    }
  }
  for (const [dx, dy, dz] of [[0, 0, 0], [0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
    const b = at(bot, offset(feet, dx, dy, dz))
    if (b && HOT.test(b.name)) return { type: 'brulure', source: b.position ?? offset(feet, dx, dy, dz), bloc: b.name }
  }
  const head = at(bot, offset(feet, 0, 1, 0))
  if (head && head.boundingBox === 'block' && !FALLING.test(head.name)) {
    return { type: 'etouffement', source: head.position ?? offset(feet, 0, 1, 0), bloc: head.name }
  }
  return null
}

// Monstre hostile a vue (serveur non paisible) : on s eloigne.
function detectHostile (bot, radius = HOSTILE_RADIUS) {
  const pos = bot?.entity?.position
  if (!pos || !bot.entities) return null
  let best = null
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity || !e.position) continue
    const hostile = e.type === 'hostile' || HOSTILE_KIND.test(e.kind ?? '')
    if (!hostile) continue
    const d = e.position.distanceTo(pos)
    if (d <= radius && (!best || d < best.distance)) best = { entity: e, distance: d }
  }
  return best
}

// Un joueur colle au bot (dans sa case) : il gene la pose et le passage.
function detectCrowding (bot, radius = CROWD_RADIUS) {
  const pos = bot?.entity?.position
  if (!pos || !bot.players) return null
  for (const [name, p] of Object.entries(bot.players)) {
    if (name === bot.username || !p?.entity?.position) continue
    const e = p.entity.position
    if (Math.hypot(e.x - pos.x, e.z - pos.z) < radius && Math.abs(e.y - pos.y) < 1.5) return { joueur: name, position: e }
  }
  return null
}

// Objets au sol tout pres, au meme niveau : les ramasser coute un pas.
function detectDrops (bot, radius = DROP_RADIUS) {
  const pos = bot?.entity?.position
  if (!pos || !bot.entities) return []
  if (typeof bot.inventory?.emptySlotCount === 'function' && bot.inventory.emptySlotCount() < 2) return []
  return Object.values(bot.entities)
    .filter(e => e && e.name === 'item' && e.position && e.position.distanceTo(pos) <= radius &&
      Math.abs(e.position.y - pos.y) <= DROP_MAX_DY)
    .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))
}

// Point a `distance` blocs du bot, a l oppose de `from` (au sol du bot).
function awayFrom (pos, from, distance) {
  let dx = pos.x - from.x
  let dz = pos.z - from.z
  const n = Math.hypot(dx, dz)
  if (n < 0.1) { dx = 1; dz = 0 } else { dx /= n; dz /= n }
  return offset(pos, dx * distance, 0, dz * distance)
}

module.exports = { detectDanger, detectHostile, detectCrowding, detectDrops, awayFrom, FALLING, HOT }
