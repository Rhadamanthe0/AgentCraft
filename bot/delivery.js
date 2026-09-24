'use strict'

// Capacite de don mesuree, reutilisable, SANS cablage mission (etape suivante).
//
// Cible ARCHITECTURE.md C0/D20 : « Donner » = deposer la quantite aux pieds du
// BON joueur et l'en avertir, sans exiger son ramassage. Un retour sans
// exception ne suffit pas : ce module rend des faits mesures
// (reussi/partiel/echoue/interrompu/inconnu), jamais un succes suppose.
//
// Comportement eprouve repris de l'essai Mindcraft (commit upstream
// 5f3acc87b479864124173de444f31fa5538f94a6, cf.
// tmp/capability-comparison-results.json G1 : navigation + depot + annonce,
// ramassage du receveur NON exige ; G2 : TypeError sur joueur inconnu a
// corriger par une garde ; G3 : refus propre du don a soi-meme) :
// implementation clean-room avec les API Mineflayer existantes, SANS
// dependance mineflayer-collectblock ajoutee et SANS code upstream copie.
// Si du code upstream est repris plus tard, conserver sa mention MIT ici et
// renseigner la LICENCE correspondante (besoin note, sans autre ecrit).
//
// REGLES DURES (audits) :
// - VRAIS Vec3 vers Mineflayer (require('vec3'), deja dependance du bot) :
//   lookAt appelle .minus et blockAt .floored ; un objet plain echoue (live
//   D1 : look_failed en 2 ms, 0 toss — sans oublier que l'acteur etait
//   encastre, donc pas tout a la fixture). Les tests l'exigent en strict.
// - INTERDIT de liberer l'action pendant qu'une operation physique vit
//   encore : aucun Promise.race ne rend avant le vrai settle — toss, regard
//   ET navigation (cancel puis settle reel). Un depassement de delai ou un
//   abort « latch » le statut (avertit via onActivity, coupe les controles)
//   mais la fonction ATTEND le settle, relit le stock, puis rend
//   unknown/cancelled (pas de retry automatique).
// - Un regard qui echoue REFUSE avant le toss (look_failed, raison assainie
//   en evidence.lookError), jamais de depot.
// - delta > take = OVERSHOOT : unknown avec perte exposee, jamais de
//   Math.min qui blanchit en « depose ».
// - Le delta d'inventaire seul prouve une SORTIE de stock, pas un depot aux
//   pieds du bon joueur : avant chaque toss on arme l'observation
//   (itemDrop/entitySpawn/entityUpdate/entityMoved/playerCollect + snapshot
//   bot.entities), et le succes exige des quantites PROUVEES couvrant le
//   delta exact (nouveaux ids + augmentations de fusion + ramassages relies,
//   tous de type prouve) dans un rayon etroit autour des pieds, fenetre
//   bornee APRES le settle. Le type vient du slot metadata {itemId,itemCount}
//   (index LU au registre via supportFeature, jamais hardcode) resolu par
//   bot.registry.items[itemId].name — les vraies entites 4.39.0 ne portent
//   jamais itemName/item.name, et getDroppedItem jette sur slot vide.
//   Type indeterminable ou ramassage non relie => sighting note, jamais une
//   reussite. Quantite prouvee < delta => unknown (on ne declare que le
//   prouve, pas de retry) ; prouve > delta => unknown (fail closed).
// - Distance recontrolee apres toss + LOS strict au lancement ; faits exposes.
//
// API exacte pour l'integration (cablage mission non fait ici) :
//   const { giveToPlayer } = require('../bot/delivery')
//   const res = await giveToPlayer(bot, {
//     player: 'Alice', item: 'oak_planks', count: 2,
//     signal,                 // AbortSignal optionnel (annulation)
//     navigator,              // { toPlayer(username, { signal }), cancel?() } local eprouve
//     onActivity,             // fn(evt) optionnel : traces reelles (hote)
//     announce,               // fn(texte) optionnel : phrase « depose », jamais « recu »
//     reachXZ, reachY,        // bornes de depot (defauts 3 / 2)
//     tossTimeoutMs,          // delai de settle d'un toss (defaut 5000)
//     lookTimeoutMs,          // delai de settle du regard (defaut 2000)
//     proofTimeoutMs,         // fenetre bornee de preuve APRES settle (defaut 1500)
//     dropRadiusXZ, dropRadiusY, // rayon etroit de correlation (defauts 2 / 2)
//   })
// La fonction DETIENT l'action jusqu'au retour : ne lancer aucune autre
// commande physique en parallele ; un superviseur externe peut tuer apres
// retour sans overlap. Retour (toujours resolu) :
//   { status, requested, deposited, remaining, inventoryRemoved, uncertain, evidence, reason }
//   status: 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'unknown'
//   deposited ne compte QUE des depots correles (goutte ou ramassage) ;
//   inventoryRemoved = sortie stock mesuree (fait, pas une reception).
//   La preuve repose sur un LEDGER UNIQUE par id d'entite (String) : baseline
//   exclue des credits « nouveau », fusion = seule l'augmentation, pickup =
//   confirmation sans nouveau credit. Tout exces observable => unknown.

// Mineflayer exige de vrais Vec3 (lookAt appelle .minus, blockAt .floored) :
// meme require que build.js/craft.js/mission.js, dependance deja disponible.
const Vec3 = require('vec3').Vec3

const DEFAULT_REACH_XZ = 3
const DEFAULT_REACH_Y = 2
const DEFAULT_TOSS_TIMEOUT_MS = 5000
const DEFAULT_PROOF_TIMEOUT_MS = 1500
const DEFAULT_DROP_RADIUS_XZ = 2
const DEFAULT_DROP_RADIUS_Y = 2
const LOOK_TIMEOUT_MS = 2000
const PROOF_POLL_MS = 40
const PLAYER_NAME_RE = /^[A-Za-z0-9_]{3,16}$/
const ITEM_NAME_RE = /^[a-z0-9_]+$/

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function toVec3 (p) {
  return new Vec3(p.x, p.y, p.z)
}

// Raison d'exception preservee pour le diagnostic, assainie (borne, sans
// controle) : le code d'erreur reste lu separement, jamais dans ce texte.
function sanitizeReason (err, max = 200) {
  return String(err?.message ?? err ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max)
}

function isUsableSignal (s) {
  return Boolean(s) && typeof s.aborted === 'boolean' &&
    typeof s.addEventListener === 'function' &&
    typeof s.removeEventListener === 'function'
}

function aborted (signal) {
  return Boolean(signal) && signal.aborted === true
}

function distanceXZ (a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

// Garde anti-G2 : bot.players[nom]?.entity sans garde levait
// "Cannot read properties of undefined (reading 'entity')". Ici : null propre.
function resolvePlayerPos (bot, playerName) {
  try {
    const entry = bot?.players?.[playerName]
    const p = entry?.entity?.position
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null
    return { x: p.x, y: p.y, z: p.z }
  } catch (_) {
    return null
  }
}

function botPosOf (bot) {
  try {
    const p = bot?.entity?.position
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null
    return { x: p.x, y: p.y, z: p.z }
  } catch (_) {
    return null
  }
}

function countInventory (bot, itemName) {
  try {
    const list = bot?.inventory?.items?.()
    if (!Array.isArray(list)) return null
    let n = 0
    for (const it of list) {
      if (it && it.name === itemName && Number.isFinite(it.count)) n += it.count
    }
    return n
  } catch (_) {
    return null
  }
}

function findStack (bot, itemName) {
  try {
    const list = bot?.inventory?.items?.() ?? []
    return list.find(it => it && it.name === itemName && it.count > 0) ?? null
  } catch (_) {
    return null
  }
}

// Ligne libre oeil -> joueur : echantillonnage simple sur bot.blockAt.
// null = inverifiable (pas de blockAt) => note 'unchecked', l'appelant tranche.
// false = obstacle ou chunk non charge (pas de don a l'aveugle).
function lineClear (bot, from, to) {
  if (typeof bot?.blockAt !== 'function') return null
  try {
    const eye = { x: from.x, y: from.y + 1.62, z: from.z }
    const chest = { x: to.x, y: to.y + 1.0, z: to.z }
    const N = 12
    for (let i = 1; i < N; i++) {
      const x = eye.x + (chest.x - eye.x) * i / N
      const y = eye.y + (chest.y - eye.y) * i / N
      const z = eye.z + (chest.z - eye.z) * i / N
      const block = bot.blockAt(toVec3({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }))
      if (!block) return false
      if (block.boundingBox === 'block' && block.name !== 'air' && block.name !== 'cave_air') return false
    }
    return true
  } catch (_) {
    return null
  }
}

// Le bot possede-t-il de quoi prouver un depot (entites et/ou evenements) ?
// Sans les deux, aucune reconciliation n'est possible : echec rapide.
function hasObservationApi (bot) {
  if (!bot || typeof bot !== 'object') return false
  if (bot.entities && typeof bot.entities === 'object') return true
  return typeof bot.on === 'function'
}

// Entite « objet au sol » (goutte) : mocks (kind 'drop') + formes Mineflayer
// reelles (item/item, entityType minecraft:item, object 2). Le reste (joueurs,
// mobs, projectiles) est ignore.
function isItemEntity (e) {
  if (!e || typeof e !== 'object') return false
  if (e.kind === 'drop') return true
  const n = e.name ?? e.displayName
  if (n === 'item' || n === 'Item') return true
  if (typeof e.entityType === 'string' && e.entityType.toLowerCase().includes('item')) return true
  if (e.type === 'object' && e.objectType === 2) return true
  return false
}

// Slot de stack {itemId, itemCount} dans entity.metadata, SANS index hardcode :
// d'abord l'index schema du registre (26.1 -> 8, LU via supportFeature, jamais
// ecrit en dur), puis balayage position-independant. Les vraies entites
// mineflayer ne portent JAMAIS itemName/item.name (live D1) ; seul ce slot,
// resolu par le registre, donne le type et le compte.
function metadataStack (meta, registry) {
  if (!meta || typeof meta !== 'object') return null
  const slots = Array.isArray(meta) ? meta : Object.values(meta)
  const shapeOf = (slot) => {
    if (!slot || typeof slot !== 'object') return null
    const cand = (Number.isInteger(slot.itemId) || Number.isInteger(slot.itemID))
      ? slot
      : (slot.value && typeof slot.value === 'object' &&
        (Number.isInteger(slot.value.itemId) || Number.isInteger(slot.value.itemID)) ? slot.value : null)
    if (!cand) return null
    return {
      itemId: Number.isInteger(cand.itemId) ? cand.itemId : cand.itemID,
      itemCount: Number.isFinite(cand.itemCount) ? cand.itemCount : (Number.isFinite(cand.count) ? cand.count : null)
    }
  }
  try {
    const ix = registry?.supportFeature?.('metadataIxOfItem')
    if (Number.isInteger(ix) && slots[ix] && typeof slots[ix] === 'object') {
      const hit = shapeOf(slots[ix])
      if (hit) return hit
    }
  } catch (_) { /* repli balayage */ }
  for (const slot of slots) {
    const hit = shapeOf(slot)
    if (hit) return hit
  }
  return null
}

// Nom d'objet porte par la goutte, ou null si indeterminable. Ordre :
// 1) champs directs (compat mocks : itemName/item.name) ;
// 2) slot metadata {itemId} -> registre (reel 4.39.0/26.1).
// On n'appelle JAMAIS entity.getDroppedItem : fragile sur slot vide
// (Item.fromNotch(null) jette) et absent des snapshots harness.
function dropItemName (e, registry) {
  if (!e || typeof e !== 'object') return null
  const direct = e.itemName ?? e?.item?.name ?? null
  if (typeof direct === 'string' && direct.length > 0) return direct
  try {
    const stack = metadataStack(e.metadata, registry)
    const name = stack && registry?.items ? registry.items[stack.itemId]?.name : null
    if (typeof name === 'string' && name.length > 0) return name
  } catch (_) { /* nom illisible => indeterminable */ }
  return null
}

// Compte NUMERIQUE porte par la goutte, ou null si illisible : direct
// (mocks) puis slot metadata {itemCount}. Jamais de defaut invente.
function dropCount (e) {
  if (!e || typeof e !== 'object') return null
  const direct = e.count ?? e?.item?.count ?? null
  if (Number.isFinite(direct)) return direct
  try {
    const stack = metadataStack(e.metadata, null)
    if (stack && Number.isFinite(stack.itemCount)) return stack.itemCount
  } catch (_) { /* compte illisible */ }
  return null
}

function entityPosOf (e) {
  try {
    const p = e?.position
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null
    return p
  } catch (_) {
    return null
  }
}

function snapshotDrops (bot) {
  const out = new Map()
  try {
    const entities = bot?.entities ?? {}
    const registry = bot?.registry ?? null
    for (const [id, e] of Object.entries(entities)) {
      if (!isItemEntity(e)) continue
      out.set(String(id), { id: String(id), name: dropItemName(e, registry), count: dropCount(e), ref: e })
    }
  } catch (_) { /* snapshot best-effort */ }
  return out
}

// Arme l'observation AVANT le toss : baseline + ecoutes itemDrop /
// entitySpawn / entityUpdate / entityMoved / playerCollect (noms reels
// mineflayer 4.39.0 verifies dans l'image). Les ecoutes vivent jusqu'a
// observer.detach(), appele APRES la fenetre de preuve (pas avant le settle).
function attachDropObserver (bot) {
  const baseline = snapshotDrops(bot)
  const spawnEvents = [] // { id, at, via, ref }
  const pickups = [] // { collector, collectedId, at }
  const handlers = []
  const pushSpawn = (via, entity) => {
    if (!isItemEntity(entity)) return
    spawnEvents.push({ id: entity?.id ?? null, at: Date.now(), via, ref: entity })
  }
  if (bot && typeof bot.on === 'function' && typeof bot.removeListener === 'function') {
    const subs = [
      ['itemDrop', entity => pushSpawn('itemDrop', entity)],
      ['entitySpawn', entity => pushSpawn('entitySpawn', entity)],
      ['entityUpdate', entity => pushSpawn('entityUpdate', entity)],
      ['entityMoved', entity => pushSpawn('entityMoved', entity)],
      ['playerCollect', (collector, collected) => {
        const c = collector?.username ?? (typeof collector === 'string' ? collector : (collector?.name ?? null))
        const id = collected?.id ?? collected ?? null
        pickups.push({ collector: c, collectedId: id, at: Date.now() })
      }]
    ]
    for (const [evt, fn] of subs) {
      try { bot.on(evt, fn); handlers.push([evt, fn]) } catch (_) { /* ecoute best-effort */ }
    }
  }
  return {
    baseline,
    spawnEvents,
    pickups,
    detach () {
      for (const [evt, fn] of handlers) {
        try { bot.removeListener(evt, fn) } catch (_) { /* nettoyage best-effort */ }
      }
    }
  }
}

function candidateMatches (ref, { itemName, registry, feet, radiusXZ, radiusY }) {
  if (!isItemEntity(ref)) return { ok: false }
  const n = dropItemName(ref, registry)
  if (n !== null && n !== itemName) return { ok: false }
  const p = entityPosOf(ref)
  if (!p) return { ok: false }
  const dxz = distanceXZ(p, feet)
  const dy = Math.abs(p.y - feet.y)
  if (dxz > radiusXZ || dy > radiusY) return { ok: false }
  return { ok: true, typeUndetermined: n === null, dxz: Number(dxz.toFixed(2)), dy: Number(dy.toFixed(2)) }
}

// Fenetre de preuve BORNEE apres le settle physique : on CUMULE les quantites
// prouvees (nouveaux ids + augmentations de fusion + ramassages relies, tous
// de type prouve) jusqu'a couvrir `needed` (= delta exact du toss).
// REGLE DE TYPE : un candidat de type INDETERMINE (goutte sans nom d'objet
// lisible, ni direct ni via registre) ne prouve jamais le type demande : il
// est note en sighting (diagnostic) et ne compte pas.
// REGLE DE QUANTITE : on ne declare jamais plus que le prouve (pas de depot
// 4 pour une seule goutte connue de 1) ; un exces observable (prouve > delta)
// est ambigu => fail closed. Ne retient jamais d'effet futur au-dela de
// proofTimeoutMs ; sur abort, rend aussitot sans liberer le toss (deja settle).
async function awaitDropCorrelation (bot, observer, { itemName, registry, feet, tossStartAt, proofTimeoutMs, radiusXZ, radiusY, player, signal, needed }) {
  const crit = { itemName, registry, feet, radiusXZ, radiusY }
  const sightings = []
  const seenSighting = new Set()
  const noteSighting = (via, id, m) => {
    const key = `${via}:${id ?? '?'}:${m?.dxz ?? '?'}:${m?.dy ?? '?'}`
    if (seenSighting.has(key)) return
    seenSighting.add(key)
    sightings.push({ via, id: id ?? null, dxz: m?.dxz ?? null, dy: m?.dy ?? null, typeUndetermined: true })
  }
  const spawnById = new Map() // gouttes observees apres armement, par id
  // LEDGER UNIQUE (ids String) : UN SEUL credit par entite, tous vias
  // confondus. Corrige le double-compte auditeur (baseline 7 + entityUpdate
  // plein + fusion) : la baseline est exclue des credits « nouveau », seule
  // l'augmentation de fusion compte pour elle, et un pickup n'est qu'une
  // confirmation, jamais un nouveau credit du meme id.
  const ledger = new Map() // key String(id) -> { qty, vias: [] }
  const drops = [] // { id, via, qty, fused?, pickup?, dxz?, dy? }
  const confirmations = [] // pickups confirmant un id deja credite/connus
  const confirmed = new Set()
  let proven = 0
  const credit = (id, via, qty, extra) => {
    const key = String(id)
    const cur = ledger.get(key) ?? { qty: 0, vias: [] }
    cur.qty += qty
    cur.vias.push(via)
    ledger.set(key, cur)
    proven += qty
    drops.push({ id: key, via, qty, ...(extra ?? {}) })
    return true
  }
  const start = Date.now()
  for (;;) {
    if (aborted(signal)) return { correlated: false, aborted: true, proven, drops, confirmations, sightings }
    for (const ev of observer.spawnEvents) {
      if (ev.at < tossStartAt - 250) continue
      if (ev.id !== null && ev.id !== undefined) spawnById.set(String(ev.id), ev.ref)
    }
    for (const pk of observer.pickups) {
      if (pk.collector !== player || pk.at < tossStartAt - 250) continue
      if (pk.collectedId === null || pk.collectedId === undefined) {
        noteSighting('playerCollect_unlinked', null, null)
        continue
      }
      const key = String(pk.collectedId)
      if (observer.baseline.has(key) || ledger.has(key)) {
        // Confirmation d'un id deja connu/credite : jamais un nouveau credit.
        if (!confirmed.has(key)) { confirmed.add(key); confirmations.push({ id: key, via: 'playerCollect' }) }
        continue
      }
      const ref = spawnById.get(key)
      if (ref !== undefined) {
        const m = candidateMatches(ref, crit)
        const q = dropCount(ref)
        if (m.ok && !m.typeUndetermined && Number.isFinite(q) && q > 0) {
          credit(key, 'playerCollect', q, { pickup: true, dxz: m.dxz, dy: m.dy })
        } else if (m.ok) {
          noteSighting('playerCollect', key, m)
        }
      } else {
        // Ramassage non relie a une goutte observee de type prouve : pas une preuve.
        noteSighting('playerCollect_unlinked', key, null)
      }
    }
    const considerNew = (id, ref, via) => {
      if (id === null || id === undefined) return
      const key = String(id)
      // Baseline et deja-credites exclus : un nouveau credit exige un id neuf.
      if (observer.baseline.has(key) || ledger.has(key)) return
      const m = candidateMatches(ref, crit)
      if (!m.ok) return
      const q = dropCount(ref)
      if (!m.typeUndetermined && Number.isFinite(q) && q > 0) {
        credit(key, via, q, { dxz: m.dxz, dy: m.dy })
      } else {
        noteSighting(via, key, m)
      }
    }
    for (const ev of observer.spawnEvents) {
      if (ev.at < tossStartAt - 250) continue
      considerNew(ev.id, ev.ref, ev.via)
    }
    const now = snapshotDrops(bot)
    for (const [id, snap] of now) {
      if (observer.baseline.has(id)) continue
      considerNew(id, snap.ref, 'snapshot_new')
    }
    for (const [id, snap] of now) {
      const base = observer.baseline.get(id)
      if (!base) continue
      const after = dropCount(snap.ref)
      if (base.count === null || after === null) {
        const m = candidateMatches(snap.ref, crit)
        if (m.ok) noteSighting('fusion', id, m)
        continue
      }
      // Seule l'augmentation au-dela du deja-credite compte (ledger unique).
      const inc = after - base.count - (ledger.get(id)?.qty ?? 0)
      if (inc <= 0) continue
      const m = candidateMatches(snap.ref, crit)
      if (m.ok && !m.typeUndetermined) {
        credit(id, 'fusion', inc, { fused: inc, dxz: m.dxz, dy: m.dy })
      } else if (m.ok) {
        noteSighting('fusion', id, m)
      }
    }
    if (proven >= needed) return { correlated: true, proven, drops, confirmations, sightings }
    if (Date.now() - start >= Math.max(0, proofTimeoutMs)) return { correlated: false, proven, drops, confirmations, sightings }
    await sleep(PROOF_POLL_MS)
  }
}

// Regard SANS liberation anticipee : comme le toss, le delai ou l'abort ne
// font que « latch » (avertir + couper les controles) ; le retour attend le
// vrai settle du lookAt. Un regard tardif mais reussi vise encore les pieds
// (feet_late) ; un regard en echec refuse avant tout toss.
async function lookAwaitSettle (bot, point, { timeoutMs, signal, onActivity, note }) {
  const startAt = Date.now()
  let lookPromise
  try {
    lookPromise = Promise.resolve().then(() => bot.lookAt(point))
  } catch (err) {
    return { started: false, ok: false, error: err, late: false, aborted: aborted(signal), waitedMs: Date.now() - startAt }
  }
  let timedOut = false
  let abortFired = aborted(signal)
  const stopNow = (type) => {
    try { bot?.clearControlStates?.() } catch (_) { /* stop best-effort */ }
    safeNotify(onActivity, { type, ...(note ?? {}), at: Date.now() })
  }
  let timer = null
  const timeoutGate = new Promise(resolve => {
    timer = setTimeout(() => { timedOut = true; stopNow('donation_look_timeout'); resolve('timeout') }, Math.max(1, timeoutMs))
    if (timer.unref) timer.unref()
  })
  let onAbort = null
  const abortGate = new Promise(resolve => {
    if (!isUsableSignal(signal)) return
    if (signal.aborted) { abortFired = true; resolve('abort'); return }
    onAbort = () => { abortFired = true; stopNow('donation_aborted'); resolve('abort') }
    try { signal.addEventListener('abort', onAbort, { once: true }) } catch (_) { /* ecoute best-effort */ }
  })
  if (abortFired) stopNow('donation_aborted')
  const settleGate = lookPromise.then(
    value => ({ ok: true, value }),
    error => ({ ok: false, error })
  )
  await Promise.race([settleGate, timeoutGate, abortGate])
  const settle = await settleGate // <-- jamais de retour avant ce settle
  if (timer) clearTimeout(timer)
  if (onAbort && isUsableSignal(signal)) {
    try { signal.removeEventListener('abort', onAbort) } catch (_) { /* nettoyage best-effort */ }
  }
  return { started: true, ...settle, late: timedOut, aborted: abortFired || aborted(signal), waitedMs: Date.now() - startAt }
}

// Toss SANS liberation anticipee : le premier latch (settle / delai / abort)
// avertit et coupe les controles, mais le retour n'a lieu qu'APRES le vrai
// settle. Audit : un Promise.race qui rend pendant que le toss vit encore est
// INTERDIT (il libererait la physique pour un chevauchement).
async function tossAwaitSettle (bot, tossFn, { tossTimeoutMs, signal, onActivity, note }) {
  const startAt = Date.now()
  let tossPromise
  try {
    tossPromise = Promise.resolve().then(tossFn)
  } catch (err) {
    return { started: false, ok: false, error: err, deadlineFired: false, abortFired: aborted(signal), waitedMs: Date.now() - startAt }
  }
  let deadlineFired = false
  let abortFired = aborted(signal)
  const stopNow = (type) => {
    try { bot?.clearControlStates?.() } catch (_) { /* stop best-effort */ }
    safeNotify(onActivity, { type, ...(note ?? {}), at: Date.now() })
  }
  let timer = null
  const deadlineGate = new Promise(resolve => {
    timer = setTimeout(() => { deadlineFired = true; stopNow('donation_timeout'); resolve('deadline') }, Math.max(1, tossTimeoutMs))
    if (timer.unref) timer.unref()
  })
  let onAbort = null
  const abortGate = new Promise(resolve => {
    if (!isUsableSignal(signal)) return
    if (signal.aborted) { abortFired = true; resolve('abort'); return }
    onAbort = () => { abortFired = true; stopNow('donation_aborted'); resolve('abort') }
    try { signal.addEventListener('abort', onAbort, { once: true }) } catch (_) { /* ecoute best-effort */ }
  })
  if (abortFired) stopNow('donation_aborted')
  const settleGate = tossPromise.then(
    value => ({ ok: true, value }),
    error => ({ ok: false, error })
  )
  await Promise.race([settleGate, deadlineGate, abortGate])
  const settle = await settleGate // <-- jamais de retour avant ce settle
  if (timer) clearTimeout(timer)
  if (onAbort && isUsableSignal(signal)) {
    try { signal.removeEventListener('abort', onAbort) } catch (_) { /* nettoyage best-effort */ }
  }
  return { started: true, ...settle, deadlineFired, abortFired: abortFired || aborted(signal), waitedMs: Date.now() - startAt }
}

function safeNotify (fn, value) {
  if (typeof fn !== 'function') return false
  try { fn(value); return true } catch (_) { return false }
}

function terminal (fields) {
  const evidence = fields.evidence ?? {}
  const before = evidence.stockBefore
  const after = evidence.stockAfter
  return {
    status: fields.status,
    requested: fields.requested,
    deposited: fields.deposited,
    remaining: Math.max(0, fields.requested - fields.deposited),
    // Additif (S6) : sortie stock mesuree sur l'appel et drapeau incertain.
    // Aucune assertion de reception : seul le delta stock est un fait.
    inventoryRemoved: (Number.isFinite(before) && Number.isFinite(after)) ? before - after : null,
    uncertain: Boolean(evidence.uncertain),
    evidence,
    reason: fields.reason
  }
}

// Navigation SANS liberation anticipee : en cas de delai, on demande
// navigator.cancel() PUIS on attend son settle reel avant de rendre la main.
// Le job annule ne conduit jamais un toss : l'appelant tranche sur la mesure
// fraiche suivante.
async function boundedNavigate (navigator, method, arg, { signal, timeoutMs, onActivity, note }) {
  let navPromise
  try {
    navPromise = Promise.resolve().then(() => method === 'player' ? navigator.toPlayer(arg, { signal }) : navigator.toPosition(arg, { signal }))
  } catch (err) {
    throw err
  }
  let timer = null
  let timedOut = false
  const timeoutGate = new Promise(resolve => {
    timer = setTimeout(() => {
      timedOut = true
      try { navigator?.cancel?.() } catch (_) { /* job borne, jamais laisse actif */ }
      safeNotify(onActivity, { type: 'navigation_timeout', ...(note ?? {}), at: Date.now() })
      resolve('timeout')
    }, Math.max(1, timeoutMs))
    if (timer.unref) timer.unref()
  })
  const settleGate = navPromise.then(
    value => ({ ok: true, value }),
    error => ({ ok: false, error })
  )
  await Promise.race([settleGate, timeoutGate])
  const settle = await settleGate // <-- settle reel apres cancel, jamais avant
  if (timer) clearTimeout(timer)
  if (!settle.ok) throw (settle.error ?? new Error('navigation : echec'))
  if (timedOut) {
    const err = new Error('navigation : delai depasse (settle apres cancel)')
    err.code = 'timeout'
    err.navResult = settle.value
    throw err
  }
  return settle.value
}

async function giveToPlayer (bot, opts = {}) {
  const rawPlayer = opts.player
  const rawItem = opts.item
  const rawCount = opts.count
  const signal = opts.signal ?? null
  const navigator = opts.navigator ?? null
  const onActivity = opts.onActivity ?? null
  const announce = opts.announce ?? null
  const reachXZ = Number.isFinite(opts.reachXZ) ? opts.reachXZ : DEFAULT_REACH_XZ
  const reachY = Number.isFinite(opts.reachY) ? opts.reachY : DEFAULT_REACH_Y
  const tossTimeoutMs = Number.isFinite(opts.tossTimeoutMs) ? opts.tossTimeoutMs : DEFAULT_TOSS_TIMEOUT_MS
  const proofTimeoutMs = Number.isFinite(opts.proofTimeoutMs) ? opts.proofTimeoutMs : DEFAULT_PROOF_TIMEOUT_MS
  const dropRadiusXZ = Number.isFinite(opts.dropRadiusXZ) ? opts.dropRadiusXZ : DEFAULT_DROP_RADIUS_XZ
  const dropRadiusY = Number.isFinite(opts.dropRadiusY) ? opts.dropRadiusY : DEFAULT_DROP_RADIUS_Y
  const lookTimeoutMs = Number.isFinite(opts.lookTimeoutMs) ? opts.lookTimeoutMs : LOOK_TIMEOUT_MS

  const evidence = {
    item: typeof rawItem === 'string' ? rawItem.trim().toLowerCase() : String(rawItem ?? ''),
    stockBefore: null,
    stockAfter: null,
    tosses: [],
    drops: [],
    pickups: [],
    navigation: { code: 'skipped', reached: false },
    distances: [],
    distancesPost: [],
    line: 'unchecked',
    look: null,
    lookError: null,
    sightings: [],
    uncertain: false,
    deadlineExceeded: false,
    abortLatched: false,
    uncorrelatedLoss: false,
    overshoot: null,
    leftAfterToss: false,
    announced: false,
    note: 'ramassage du receveur non exige : succes = goutte correlee aux pieds OU ramassage correle du bon joueur'
  }

  const fail = (reason) => {
    const requested = Number.isInteger(rawCount) && rawCount >= 1 ? rawCount : 0
    return terminal({ status: 'failed', requested, deposited: 0, evidence, reason })
  }

  if (!bot || typeof bot !== 'object') return fail('invalid_bot')
  if (signal !== null && signal !== undefined && !isUsableSignal(signal) && signal.aborted !== false && signal.aborted !== true) {
    return fail('invalid_signal')
  }
  if (aborted(signal)) {
    return terminal({ status: 'cancelled', requested: Number.isInteger(rawCount) ? rawCount : 0, deposited: 0, evidence, reason: 'cancelled' })
  }

  const player = typeof rawPlayer === 'string' ? rawPlayer.trim() : ''
  if (!player || !PLAYER_NAME_RE.test(player)) return fail('invalid_player')
  const item = typeof rawItem === 'string' ? rawItem.trim().toLowerCase() : ''
  if (!item || !ITEM_NAME_RE.test(item)) return fail('invalid_item')
  evidence.item = item
  if (!Number.isInteger(rawCount) || rawCount < 1) return fail('invalid_count')
  const requested = rawCount

  if (bot.username && player === bot.username) {
    evidence.stockBefore = countInventory(bot, item)
    evidence.stockAfter = evidence.stockBefore
    return terminal({ status: 'failed', requested, deposited: 0, evidence, reason: 'self_give_refused' })
  }

  const stockBefore = countInventory(bot, item)
  evidence.stockBefore = stockBefore
  if (stockBefore === null) {
    evidence.uncertain = true
  } else if (stockBefore <= 0) {
    evidence.stockAfter = stockBefore
    return terminal({ status: 'failed', requested, deposited: 0, evidence, reason: 'insufficient_stock' })
  }

  // Pas d'API d'observation => aucune preuve de depot possible : echec rapide,
  // avant toute navigation.
  if (!hasObservationApi(bot)) {
    evidence.stockAfter = countInventory(bot, item)
    return terminal({ status: 'failed', requested, deposited: 0, evidence, reason: 'no_observation_api' })
  }

  // Stop controles prompt sur abort pendant toute l'operation (sans liberer).
  let onAbortGlobal = null
  if (isUsableSignal(signal) && !signal.aborted) {
    onAbortGlobal = () => { try { bot?.clearControlStates?.() } catch (_) { /* stop best-effort */ } }
    try { signal.addEventListener('abort', onAbortGlobal, { once: true }) } catch (_) { onAbortGlobal = null }
  }

  try {
    // Joueur frais AVANT d'approcher (garde G2 : jamais de .entity sans chaine).
    const target = resolvePlayerPos(bot, player)
    if (!target) {
      evidence.stockAfter = countInventory(bot, item)
      return terminal({ status: 'failed', requested, deposited: 0, evidence, reason: 'player_absent' })
    }

    // Approche avec le navigateur local eprouve (injecte, jamais importe en dur).
    if (navigator && typeof navigator.toPlayer === 'function') {
      try {
        const nav = await boundedNavigate(navigator, 'player', player, { signal, timeoutMs: 30000 })
        evidence.navigation = { code: String(nav?.code ?? 'unknown'), reached: Boolean(nav?.reached) }
      } catch (err) {
        evidence.navigation = { code: aborted(signal) ? 'cancelled' : (err?.code === 'timeout' ? 'nav_timeout' : 'nav_error'), reached: false }
        if (aborted(signal)) {
          evidence.stockAfter = countInventory(bot, item)
          return terminal({ status: 'cancelled', requested, deposited: 0, evidence, reason: 'cancelled' })
        }
      }
    } else if (navigator && typeof navigator.toPosition === 'function') {
      try {
        const nav = await boundedNavigate(navigator, 'position', target, { signal, timeoutMs: 30000 })
        evidence.navigation = { code: String(nav?.code ?? 'unknown'), reached: Boolean(nav?.reached) }
      } catch (err) {
        evidence.navigation = { code: aborted(signal) ? 'cancelled' : 'nav_error', reached: false }
        if (aborted(signal)) {
          evidence.stockAfter = countInventory(bot, item)
          return terminal({ status: 'cancelled', requested, deposited: 0, evidence, reason: 'cancelled' })
        }
      }
    } else {
      evidence.navigation = { code: 'skipped_no_navigator', reached: false }
    }
    if (aborted(signal)) {
      evidence.stockAfter = countInventory(bot, item)
      return terminal({ status: 'cancelled', requested, deposited: 0, evidence, reason: 'cancelled' })
    }

    const canToss = typeof bot.tossStack === 'function' || typeof bot.toss === 'function'
    if (!canToss) {
      evidence.stockAfter = countInventory(bot, item)
      return terminal({ status: 'failed', requested, deposited: 0, evidence, reason: 'no_toss_api' })
    }

    let deposited = 0
    let reason = 'deposited'
    let reapproaches = 0
    let deadlineFlag = false
    let abortFlag = aborted(signal)
    let overshootFlag = false
    let excessFlag = false
    let shortfallFlag = false
    let tossErrorWithDelta = false
    let deltaNullFlag = false
    let uncorrelatedFlag = false

    while (deposited < requested) {
      if (aborted(signal)) { abortFlag = true; reason = 'cancelled'; break }

      // Mesure FRAICHE avant chaque toss : absent/deplace => pas de don de loin.
      const fresh = resolvePlayerPos(bot, player)
      const here = botPosOf(bot)
      if (!here) { reason = 'bot_disconnected'; break }
      if (!fresh) { reason = deposited > 0 ? 'player_left' : 'player_absent'; break }
      const dxz = distanceXZ(here, fresh)
      const dy = Math.abs(here.y - fresh.y)
      evidence.distances.push({ dxz: Number(dxz.toFixed(2)), dy: Number(dy.toFixed(2)) })

      if (dxz > reachXZ || dy > reachY) {
        if (reapproaches < 1 && navigator && typeof navigator.toPlayer === 'function' && !aborted(signal)) {
          reapproaches += 1
          try {
            const nav = await boundedNavigate(navigator, 'player', player, { signal, timeoutMs: 30000 })
            evidence.navigation = { code: `reapproach:${String(nav?.code ?? 'unknown')}`, reached: Boolean(nav?.reached) }
          } catch (_) { /* la mesure suivante tranche */ }
          const again = resolvePlayerPos(bot, player)
          const hereAgain = botPosOf(bot)
          if (again && hereAgain && distanceXZ(hereAgain, again) <= reachXZ && Math.abs(hereAgain.y - again.y) <= reachY) continue
        }
        reason = deposited > 0 ? 'player_left' : 'out_of_reach'
        break
      }

      // LOS STRICT au lancement (quand l'API existe ; sinon 'unchecked' expose).
      const line = lineClear(bot, here, fresh)
      evidence.line = line === null ? 'unchecked' : (line ? 'clear' : 'blocked')
      if (line === false) { reason = 'no_line_of_sight'; break }

      const stack = findStack(bot, item)
      if (!stack) { reason = deposited > 0 ? 'stock_exhausted' : 'insufficient_stock'; break }
      const need = requested - deposited
      const take = Math.min(need, stack.count)
      if (!Number.isInteger(take) || take < 1) { reason = 'toss_failed'; break }

      // Regard vers les PIEDS du joueur en vrai Vec3 (Mineflayer appelle
      // .minus dessus : un objet plain echoue comme en live D1). Un echec
      // REFUSE avant le toss ; le latch attend le settle, jamais de retour
      // anticipe.
      let look
      try {
        if (typeof bot.lookAt !== 'function') throw new Error('regard indisponible (pas de lookAt)')
        look = await lookAwaitSettle(bot, toVec3({ x: fresh.x, y: fresh.y + 0.4, z: fresh.z }), {
          timeoutMs: lookTimeoutMs, signal, onActivity, note: { player, item, take }
        })
      } catch (err) {
        look = { started: false, ok: false, error: err, late: false, aborted: aborted(signal), waitedMs: 0 }
      }
      if (!look.started || !look.ok) {
        evidence.look = 'look_failed'
        evidence.lookError = sanitizeReason(look.error)
        reason = 'look_failed'
        safeNotify(onActivity, { type: 'donation_look_failed', player, item, take, error: evidence.lookError })
        break
      }
      evidence.look = look.late ? 'feet_late' : 'feet'
      if (look.aborted || aborted(signal)) { abortFlag = true; evidence.abortLatched = true; reason = 'cancelled'; break }

      const invBefore = countInventory(bot, item)
      const tossStartAt = Date.now()
      const observer = attachDropObserver(bot)
      let tw
      try {
        tw = await tossAwaitSettle(bot, () => {
          if (take >= stack.count && typeof bot.tossStack === 'function') return bot.tossStack(stack)
          if (typeof bot.toss === 'function') return bot.toss(stack.type, stack.metadata, take)
          throw Object.assign(new Error('toss partiel indisponible (overshoot refuse)'), { code: 'no_partial_toss' })
        }, { tossTimeoutMs, signal, onActivity, note: { player, item, take } })

        const invAfter = countInventory(bot, item)
        const delta = (Number.isFinite(invBefore) && Number.isFinite(invAfter)) ? invBefore - invAfter : null
        if (tw.deadlineFired) { deadlineFlag = true; evidence.deadlineExceeded = true }
        if (tw.abortFired) { abortFlag = true; evidence.abortLatched = true }

        const entry = {
          take, invBefore, invAfter, delta,
          dxz: Number(dxz.toFixed(2)), dy: Number(dy.toFixed(2)),
          dxzPost: null, dyPost: null,
          error: tw.started ? (tw.ok ? null : sanitizeReason(tw.error?.code === 'timeout' ? 'toss_timeout' : tw.error)) : sanitizeReason(tw.error),
          deadlineExceeded: tw.deadlineFired,
          abortLatched: tw.abortFired,
          waitedMs: tw.waitedMs,
          correlated: false,
          via: null,
          dropId: null
        }

        if (delta !== null && delta > take) {
          // OVERSHOOT : perte exposee, RIEN revendique (pas de Math.min).
          entry.overshoot = { take, delta, loss: delta - take }
          evidence.overshoot = { take, delta, loss: delta - take }
          evidence.uncertain = true
          evidence.tosses.push(entry)
          overshootFlag = true
          reason = 'overshoot'
          safeNotify(onActivity, { type: 'donation_overshoot', player, item, take, delta, loss: delta - take })
          break
        }
        if (!tw.started || !tw.ok) {
          evidence.tosses.push(entry)
          if (delta !== null && delta > 0) {
            // Toss en echec mais stock diminue : effet non attribuable.
            evidence.uncertain = true
            tossErrorWithDelta = true
            reason = 'toss_failed'
            safeNotify(onActivity, { type: 'donation_unattributed', player, item, take, delta })
          } else {
            reason = 'toss_failed'
          }
          break // pas de retry automatique
        }
        if (delta === null) {
          evidence.tosses.push(entry)
          evidence.uncertain = true
          deltaNullFlag = true
          reason = 'unattributable_delta'
          break
        }
        if (delta <= 0) {
          evidence.tosses.push(entry)
          reason = 'toss_no_delta'
          break
        }

        // 0 < delta <= take : preuve exigee, fenetre bornee APRES le settle.
        // `needed` = delta exact : on cumule les quantites prouvees jusqu'a le
        // couvrir, jamais plus declare que prouve.
        const corr = await awaitDropCorrelation(bot, observer, {
          itemName: item, registry: bot?.registry ?? null, feet: fresh, tossStartAt, proofTimeoutMs,
          radiusXZ: dropRadiusXZ, radiusY: dropRadiusY, player, signal, needed: delta
        })
        // Distance RECONTROLEE apres toss (faits, pas condition de preuve).
        const post = resolvePlayerPos(bot, player)
        const here2 = botPosOf(bot)
        const postDxz = (post && here2) ? distanceXZ(here2, post) : null
        const postDy = (post && here2) ? Math.abs(here2.y - post.y) : null
        entry.dxzPost = postDxz === null ? null : Number(postDxz.toFixed(2))
        entry.dyPost = postDy === null ? null : Number(postDy.toFixed(2))
        evidence.distancesPost.push({ dxz: entry.dxzPost, dy: entry.dyPost, playerSeen: Boolean(post) })
        const leftAfter = !post || postDxz === null || postDxz > reachXZ || postDy > reachY
        if (leftAfter) evidence.leftAfterToss = true

        if (corr.aborted) {
          evidence.tosses.push(entry)
          abortFlag = true
          evidence.abortLatched = true
          reason = 'cancelled'
          break
        }
        entry.correlated = corr.correlated
        entry.via = corr.correlated && corr.drops.length > 0 ? corr.drops[0].via : null
        entry.dropId = corr.correlated && corr.drops.length > 0 ? corr.drops[0].id : null
        entry.proven = corr.proven ?? 0
        entry.dropQtys = (corr.drops ?? []).map(d => ({ id: d.id, via: d.via, qty: d.qty }))
        entry.sightings = (corr.sightings ?? []).length
        for (const s of corr.sightings ?? []) evidence.sightings.push({ toss: evidence.tosses.length, ...s })
        for (const c of corr.confirmations ?? []) evidence.pickups.push({ id: c.id ?? null, collector: player })
        evidence.tosses.push(entry)

        if (!corr.correlated && corr.proven > delta) {
          // Exces observable > sortie stock : attribution ambigue, fail closed.
          // Pas de blanchiment : correlated reste faux malgre la preuve partielle.
          entry.correlated = false
          entry.excess = { delta, proven: corr.proven }
          evidence.uncertain = true
          excessFlag = true
          reason = 'drop_count_excess'
          safeNotify(onActivity, { type: 'donation_unreconciled', player, item, take, delta, proven: corr.proven })
          break
        }
        if (!corr.correlated && corr.proven > 0) {
          // Manquant : on ne declare que le prouve, unknown, pas de retry.
          deposited += corr.proven
          for (const d of corr.drops ?? []) {
            evidence.drops.push({ id: d.id ?? null, via: d.via, take, delta, qty: d.qty, fused: d.fused ?? null, pickup: d.pickup ?? false })
            if (d.pickup) evidence.pickups.push({ id: d.id ?? null, collector: player })
          }
          evidence.uncertain = true
          shortfallFlag = true
          evidence.shortfall = { delta, proven: corr.proven, missing: delta - corr.proven }
          reason = 'drop_count_shortfall'
          safeNotify(onActivity, { type: 'donation_unreconciled', player, item, take, delta, proven: corr.proven })
          break
        }
        if (!corr.correlated) {
          // Stock sorti mais goutte non prouvee : unknown honnete.
          evidence.uncertain = true
          uncorrelatedFlag = true
          evidence.uncorrelatedLoss = true
          reason = 'unreconciled_drop'
          safeNotify(onActivity, { type: 'donation_unreconciled', player, item, take, delta })
          break
        }
        deposited += delta
        for (const d of corr.drops ?? []) {
          evidence.drops.push({ id: d.id ?? null, via: d.via, take, delta, qty: d.qty, fused: d.fused ?? null, pickup: d.pickup ?? false })
          if (d.pickup) evidence.pickups.push({ id: d.id ?? null, collector: player })
        }
        safeNotify(onActivity, { type: 'donation_progress', player, item, requested, deposited, remaining: requested - deposited, via: corr.via })
        if (leftAfter) { reason = 'player_left'; break }
        // delta < take correle : la boucle complete le reliquat au tour suivant.
      } finally {
        observer.detach()
      }
    }

    evidence.stockAfter = countInventory(bot, item)
    const remaining = Math.max(0, requested - deposited)

    let status
    if (abortFlag && deposited < requested) {
      status = 'cancelled'
      reason = 'cancelled'
    } else if (deadlineFlag) {
      // Delai depasse : unknown APRES settle + relecture stock, pas de retry.
      status = 'unknown'
      evidence.uncertain = true
      if (reason === 'deposited') reason = 'toss_timeout'
    } else if (overshootFlag) {
      status = 'unknown'
      reason = 'overshoot'
    } else if (excessFlag) {
      status = 'unknown'
      reason = 'drop_count_excess'
    } else if (shortfallFlag) {
      status = 'unknown'
      reason = 'drop_count_shortfall'
    } else if (tossErrorWithDelta || deltaNullFlag) {
      status = 'unknown'
      if (reason === 'deposited') reason = 'unattributable_delta'
    } else if (uncorrelatedFlag) {
      status = 'unknown'
      reason = 'unreconciled_drop'
    } else if (deposited >= requested) {
      status = 'succeeded'
      reason = 'deposited'
    } else if (deposited > 0) {
      status = 'partial'
    } else {
      status = aborted(signal) ? 'cancelled' : 'failed'
      if (status === 'cancelled') reason = 'cancelled'
    }

    // Annonce hote : « depose », JAMAIS « recu » (D20). Best-effort, jamais jetant.
    const summary = `depot: ${deposited}/${requested} ${item} aux pieds de ${player} (${status})`
    let announced = false
    if (typeof announce === 'function') {
      try { announce(summary); announced = true } catch (_) { announced = false }
    }
    if (!announced && typeof onActivity === 'function') {
      announced = safeNotify(onActivity, { type: 'donation', player, item, requested, deposited, remaining, status, reason, text: summary })
    } else if (announced) {
      safeNotify(onActivity, { type: 'donation', player, item, requested, deposited, remaining, status, reason, text: summary })
    }
    evidence.announced = announced

    return terminal({ status, requested, deposited, evidence, reason })
  } finally {
    if (onAbortGlobal && isUsableSignal(signal)) {
      try { signal.removeEventListener('abort', onAbortGlobal) } catch (_) { /* nettoyage best-effort */ }
    }
  }
}

module.exports = {
  giveToPlayer,
  countInventory,
  resolvePlayerPos,
  lineClear,
  hasObservationApi,
  isItemEntity,
  metadataStack,
  dropItemName,
  dropCount,
  DEFAULT_REACH_XZ,
  DEFAULT_REACH_Y,
  DEFAULT_TOSS_TIMEOUT_MS,
  DEFAULT_PROOF_TIMEOUT_MS,
  DEFAULT_DROP_RADIUS_XZ,
  DEFAULT_DROP_RADIUS_Y
}
