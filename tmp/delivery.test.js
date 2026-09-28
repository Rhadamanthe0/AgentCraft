'use strict'
// Preuves offline de bot/delivery.js (aucun live harness, aucun cablage mission).
// Mocks : bot Mineflayer minimal (inventaire strict type+metadata, entites,
// evenements itemDrop/entitySpawn/entityMoved/playerCollect) + navigateur
// local injecte. Chaque cas verifie le retour exact
// { status, requested, deposited, remaining, evidence, reason }.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3').Vec3 // meme classe que delivery.js et le bot (le defaut est une fabrique)
const mcData26 = require('minecraft-data')('26.1') // vrai registre 26.1 (planks id 36, log 134)
const skills = require('../bot/skills')
const delivery = require('../bot/delivery')
const { giveToPlayer } = delivery

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// STRICT : Mineflayer appelle .minus (lookAt) / .floored (blockAt) sur le
// point recu : un objet plain echoue (live D1). Le mock refuse tout ce qui
// n'est pas un vrai Vec3, comme le reel.
function assertVec3 (pos, api) {
  if (!(pos instanceof Vec3) || typeof pos.minus !== 'function' || typeof pos.floor !== 'function') {
    throw new TypeError(`${api} attend un Vec3 (recu ${pos === null ? 'null' : typeof pos})`)
  }
}

// Serveur simule : le depot apparait comme une goutte aux pieds du bot.
function scheduleSpawn (bot, { itemName, count, at = null, delay = null } = {}) {
  const d = delay ?? bot._spawnDelay
  setTimeout(() => {
    const id = bot._nextEntityId++
    const entity = { id, kind: 'drop', itemName, count, position: at ? { ...at } : { ...bot.entity.position } }
    bot.entities[id] = entity
    bot.emit('itemDrop', entity)
    bot.emit('entitySpawn', entity)
  }, d)
}

function mockBot ({ username = 'TestBot', selfPos = { x: 0, y: 64, z: 0 }, players = {}, stock = [], serverDelay = 10, spawnDelay = 0, registry = null } = {}) {
  const inv = stock.map((s, i) => ({ name: s.name, count: s.count, type: s.type ?? (100 + i), metadata: s.metadata ?? 0 }))
  const bot = {
    username,
    entity: { position: { ...selfPos } },
    players: {},
    entities: {},
    registry,
    _nextEntityId: 100,
    _handlers: {},
    lookedAt: [],
    lookedAtRefs: [],
    blockAtCalls: [],
    tossCalls: [],
    clearCalls: [],
    _serverDelay: serverDelay,
    _spawnDelay: spawnDelay,
    inventory: {
      // STRICT : appariement type+metadata exacts (le mock historique
      // `e.type === type || e.name` etait toujours vrai : corrige ici).
      items: () => inv.filter(e => e.count > 0)
        .map(e => ({ name: e.name, type: e.type, metadata: e.metadata, count: e.count, _entry: e }))
    },
    on (evt, fn) { (this._handlers[evt] ??= []).push(fn) },
    removeListener (evt, fn) {
      const l = this._handlers[evt]
      if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1) }
    },
    emit (evt, ...args) { for (const fn of [...(this._handlers[evt] ?? [])]) fn(...args) },
    clearControlStates () { this.clearCalls.push({ at: Date.now() }) },
    lookAt: async (pos) => { assertVec3(pos, 'lookAt'); bot.lookedAtRefs.push(pos); bot.lookedAt.push({ x: pos.x, y: pos.y, z: pos.z }) },
    blockAt: (pos) => { assertVec3(pos, 'blockAt'); bot.blockAtCalls.push(pos); return { name: 'air', boundingBox: 'empty', shapes: [] } }
  }
  for (const [name, pos] of Object.entries(players)) bot.players[name] = { entity: { position: { ...pos } } }
  bot.tossStack = async (stack) => {
    const call = { mode: 'stack', name: stack.name, count: stack.count, startAt: Date.now() }
    bot.tossCalls.push(call)
    await sleep(bot._serverDelay)
    const entry = stack._entry ?? inv.find(e => e.name === stack.name)
    if (!entry || entry.count <= 0) { const e = new Error('stack vide'); e.code = 'empty'; throw e }
    const n = entry.count
    entry.count = 0
    call.settledAt = Date.now()
    scheduleSpawn(bot, { itemName: entry.name, count: n })
    return n
  }
  bot.toss = async (type, metadata, count) => {
    const call = { mode: 'toss', type, metadata, count, startAt: Date.now() }
    bot.tossCalls.push(call)
    await sleep(bot._serverDelay)
    const entry = inv.find(e => e.type === type && e.metadata === metadata && e.count > 0)
    if (!entry) { const e = new Error('aucun stack pour ce type/metadata'); e.code = 'no_stack'; throw e }
    if (count > entry.count) { const e = new Error('overshoot refuse par le mock'); e.code = 'overshoot_mock'; throw e }
    entry.count -= count
    call.settledAt = Date.now()
    scheduleSpawn(bot, { itemName: entry.name, count })
    return count
  }
  bot._inv = inv
  return bot
}

const nearNavigator = (calls = []) => ({
  toPlayer: async (username) => { calls.push(username); return { reached: true, code: 'arrived' } }
})

function stockOf (bot, name) {
  return bot._inv.filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
}

const PROOF = { proofTimeoutMs: 600 }

test('validation stricte : count non entier positif refuse, sans toss', async () => {
  const bot = mockBot({ players: { Alice: { x: 1, y: 64, z: 0 } }, stock: [{ name: 'oak_planks', count: 5 }] })
  for (const bad of [0, -2, 1.5, NaN, '2', null]) {
    const res = await giveToPlayer(bot, { player: 'Alice', item: 'oak_planks', count: bad, navigator: nearNavigator(), ...PROOF })
    assert.equal(res.status, 'failed', `count=${String(bad)}`)
    assert.equal(res.reason, 'invalid_count')
    assert.equal(res.deposited, 0)
  }
  assert.equal(bot.tossCalls.length, 0)
  assert.equal(stockOf(bot, 'oak_planks'), 5)
})

test('G2 corrige : joueur inconnu => failed player_absent, pas de TypeError', async () => {
  const bot = mockBot({ players: {}, stock: [{ name: 'oak_planks', count: 4 }] })
  const res = await giveToPlayer(bot, { player: 'Fantome99', item: 'oak_planks', count: 1, navigator: nearNavigator(), ...PROOF })
  assert.equal(res.status, 'failed')
  assert.equal(res.reason, 'player_absent')
  assert.deepEqual([res.requested, res.deposited, res.remaining], [1, 0, 1])
  assert.equal(bot.tossCalls.length, 0)
})

test('G3 : don a soi-meme refuse proprement, inventaire intact', async () => {
  const bot = mockBot({ username: 'TestBot', players: {}, stock: [{ name: 'oak_planks', count: 4 }] })
  const res = await giveToPlayer(bot, { player: 'TestBot', item: 'oak_planks', count: 2, ...PROOF })
  assert.equal(res.status, 'failed')
  assert.equal(res.reason, 'self_give_refused')
  assert.equal(stockOf(bot, 'oak_planks'), 4)
})

test('succes exact avec goutte correlee : 2 demandes sur stack de 5 => reste 3', async () => {
  const navCalls = []
  const bot = mockBot({
    selfPos: { x: 0, y: 64, z: 0 },
    players: { Alice: { x: 1.5, y: 64, z: 0 } },
    stock: [{ name: 'oak_planks', count: 5, type: 10, metadata: 0 }]
  })
  const events = []
  const res = await giveToPlayer(bot, {
    player: 'Alice', item: 'oak_planks', count: 2,
    navigator: nearNavigator(navCalls),
    onActivity: evt => { events.push(evt) },
    announce: () => { events.push({ announced: true }) },
    ...PROOF
  })
  assert.equal(res.status, 'succeeded')
  assert.equal(res.reason, 'deposited')
  assert.deepEqual([res.requested, res.deposited, res.remaining], [2, 2, 0])
  assert.equal(stockOf(bot, 'oak_planks'), 3)
  assert.deepEqual(navCalls, ['Alice'])
  // toss PARTIEL strict : 2 demandes, pas le stack de 5 (pas d'overshoot).
  assert.equal(bot.tossCalls.length, 1)
  assert.deepEqual([bot.tossCalls[0].mode, bot.tossCalls[0].count], ['toss', 2])
  assert.equal(bot.tossCalls[0].type, 10)
  // Regard vers les pieds + goutte reelle correlee (id, via, distance).
  assert.ok(bot.lookedAt.length >= 1)
  const feet = bot.lookedAt[0]
  assert.ok(Math.abs(feet.x - 1.5) < 0.01 && Math.abs(feet.z - 0) < 0.01)
  assert.equal(res.evidence.drops.length, 1)
  assert.ok(res.evidence.drops[0].id !== null)
  assert.equal(res.evidence.drops[0].qty, 2) // quantite prouvee == delta exact
  assert.ok(['itemDrop', 'entitySpawn', 'entityUpdate', 'snapshot_new'].includes(res.evidence.drops[0].via))
  // Annonce « depot », jamais « recu ».
  const texts = JSON.stringify(events)
  assert.match(texts, /dep/i)
  assert.doesNotMatch(texts, /re[cç]u/)
  assert.equal(res.evidence.tosses.length, 1)
  assert.equal(res.evidence.tosses[0].delta, 2)
  assert.equal(res.evidence.tosses[0].correlated, true)
  assert.equal(res.inventoryRemoved, 2) // API additive : sortie stock mesuree
  assert.equal(res.uncertain, false)
})

test('partiel honnete : 5 demandes, stock 2 => partial 2/5 stock_exhausted', async () => {
  const bot = mockBot({
    selfPos: { x: 0, y: 64, z: 0 },
    players: { Alice: { x: 1, y: 64, z: 0 } },
    stock: [{ name: 'oak_planks', count: 2, type: 10, metadata: 0 }]
  })
  const res = await giveToPlayer(bot, { player: 'Alice', item: 'oak_planks', count: 5, navigator: nearNavigator(), ...PROOF })
  assert.equal(res.status, 'partial')
  assert.equal(res.reason, 'stock_exhausted')
  assert.deepEqual([res.requested, res.deposited, res.remaining], [5, 2, 3])
  assert.equal(stockOf(bot, 'oak_planks'), 0)
  assert.equal(res.evidence.drops.length, 1)
})

test('pas de don de loin : joueur deplace au-dela de la portee => aucun toss', async () => {
  const bot = mockBot({
    selfPos: { x: 0, y: 64, z: 0 },
    players: { Alice: { x: 1, y: 64, z: 0 } },
    stock: [{ name: 'oak_planks', count: 3 }]
  })
  const nav = {
    toPlayer: async () => {
      bot.players.Alice.entity.position = { x: 40, y: 64, z: 0 }
      return { reached: true, code: 'arrived' }
    }
  }
  const res = await giveToPlayer(bot, { player: 'Alice', item: 'oak_planks', count: 1, navigator: nav, ...PROOF })
  assert.ok(['failed', 'partial'].includes(res.status))
  assert.ok(['out_of_reach', 'player_left'].includes(res.reason), `raison=${res.reason}`)
  assert.equal(res.deposited, 0)
  assert.equal(bot.tossCalls.length, 0)
  assert.equal(stockOf(bot, 'oak_planks'), 3)
})

test('aucune fausse reussite : toss sans delta => failed toss_no_delta', async () => {
  const bot = mockBot({
    players: { Alice: { x: 1, y: 64, z: 0 } },
    stock: [{ name: 'oak_planks', count: 3 }]
  })
  bot.tossStack = async () => 0 // serveur refuse : inventaire inchange, rien au sol
  bot.toss = async () => 0
  const res = await giveToPlayer(bot, { player: 'Alice', item: 'oak_planks', count: 1, navigator: nearNavigator(), ...PROOF })
  assert.equal(res.status, 'failed')
  assert.equal(res.reason, 'toss_no_delta')
  assert.equal(res.deposited, 0)
})

test('annulation avant toss => cancelled, pas d overshoot', async () => {
  const ctl = new AbortController()
  const bot = mockBot({
    players: { Alice: { x: 1, y: 64, z: 0 } },
    stock: [{ name: 'oak_planks', count: 4 }]
  })
  const nav = { toPlayer: async () => { ctl.abort(); return { reached: true, code: 'arrived' } } }
  const res = await giveToPlayer(bot, { player: 'Alice', item: 'oak_planks', count: 3, navigator: nav, signal: ctl.signal, ...PROOF })
  assert.equal(res.status, 'cancelled')
  assert.equal(res.reason, 'cancelled')
  assert.ok(res.deposited <= res.requested)
  assert.equal(bot.tossCalls.length, 0)
})

test('LATE TOSS : settle 300 ms, delai 50 ms => pas de liberation, unknown apres settle', async () => {
  const bot = mockBot({
    players: { Alice: { x: 1, y: 64, z: 0 } },
    stock: [{ name: 'oak_planks', count: 1, type: 10, metadata: 0 }]
  })
  bot.tossStack = async (stack) => {
    await sleep(300) // serveur lent : le delai de 50 ms expire avant le settle
    const entry = stack._entry
    entry.count = 0
    scheduleSpawn(bot, { itemName: entry.name, count: 1 })
    return 1
  }
  const events = []
  const t0 = Date.now()
  const res = await giveToPlayer(bot, {
    player: 'Alice', item: 'oak_planks', count: 1,
    navigator: nearNavigator(), tossTimeoutMs: 50, proofTimeoutMs: 600,
    onActivity: evt => { events.push(evt) }
  })
  const duration = Date.now() - t0
  assert.ok(duration >= 200, `rendu a ${duration} ms alors que le toss settle a ~300 ms : liberation anticipe INTERDITE`)
  assert.equal(res.status, 'unknown')
  assert.equal(res.reason, 'toss_timeout')
  assert.equal(res.deposited, 1) // relecture stock apres settle, pas de retry
  assert.equal(res.remaining, 0)
  assert.equal(res.evidence.deadlineExceeded, true)
  assert.ok(events.some(e => e.type === 'donation_timeout'), 'avertissement onActivity au latch')
  assert.ok(bot.clearCalls.length >= 1, 'controles coupes au latch')
})

test('ABORT EN VOL : abort a 20 ms, settle a 150 ms => stop prompt, retour apres settle', async () => {
  const ctl = new AbortController()
  const bot = mockBot({
    players: { Alice: { x: 1, y: 64, z: 0 } },
    stock: [{ name: 'oak_planks', count: 1, type: 10, metadata: 0 }]
  })
  let settledAt = 0
  bot.tossStack = async (stack) => {
    await sleep(150)
    stack._entry.count = 0
    settledAt = Date.now()
    scheduleSpawn(bot, { itemName: 'oak_planks', count: 1 })
    return 1
  }
  const t0 = Date.now()
  const p = giveToPlayer(bot, {
    player: 'Alice', item: 'oak_planks', count: 1,
    navigator: nearNavigator(), signal: ctl.signal, tossTimeoutMs: 5000, proofTimeoutMs: 600
  })
  await sleep(20)
  const abortAt = Date.now()
  ctl.abort()
  const res = await p
  const duration = Date.now() - t0
  assert.ok(bot.clearCalls.length >= 1, 'stop controles prompt via abort')
  assert.ok(bot.clearCalls[0].at - abortAt < 100, 'stop prompt, pas tardif')
  assert.ok(settledAt > abortAt, 'settle APRES l abort')
  assert.ok(bot.clearCalls[0].at < settledAt, 'stop AVANT le settle, retour APRES')
  assert.ok(duration >= 130, `rendu a ${duration} ms : writer libere avant le settle INTERDIT`)
  assert.equal(res.status, 'cancelled')
  assert.equal(res.reason, 'cancelled')
  assert.equal(res.deposited, 0) // correlation non tentee apres abort : rien revendique
  assert.equal(res.evidence.tosses[0].delta, 1) // mais la sortie stock est exposee
})

test('LATE ENTITY dans la fenetre : goutte a +300 ms, preuve 1200 ms => succeeded', async () => {
  const bot = mockBot({
    players: { Alice: { x: 1, y: 64, z: 0 } },
    stock: [{ name: 'oak_planks', count: 1, type: 10, metadata: 0 }]
  })
  bot.tossStack = async (stack) => {
    await sleep(10)
    stack._entry.count = 0
    scheduleSpawn(bot, { itemName: 'oak_planks', count: 1, delay: 300 }) // goutte tardive
    return 1
  }
  const t0 = Date.now()
  const res = await giveToPlayer(bot, {
    player: 'Alice', item: 'oak_planks', count: 1,
    navigator: nearNavigator(), tossTimeoutMs: 2000, proofTimeoutMs: 1200
  })
  const duration = Date.now() - t0
  assert.ok(duration >= 200, 'fenetre de preuve attendue, pas de succes aveugle')
  assert.equal(res.status, 'succeeded')
  assert.equal(res.deposited, 1)
  assert.ok(res.evidence.drops[0].id !== null)
})

test('ENTITY hors fenetre : goutte a +400 ms, preuve 100 ms => unknown, pas de succes', async () => {
  const bot = mockBot({
    players: { Alice: { x: 1, y: 64, z: 0 } },
    stock: [{ name: 'oak_planks', count: 1, type: 10, metadata: 0 }]
  })
  bot.tossStack = async (stack) => {
    await sleep(10)
    stack._entry.count = 0
    scheduleSpawn(bot, { itemName: 'oak_planks', count: 1, delay: 400 }) // trop tard
    return 1
  }
  const res = await giveToPlayer(bot, {
    player: 'Alice', item: 'oak_planks', count: 1,
    navigator: nearNavigator(), tossTimeoutMs: 2000, proofTimeoutMs: 100
  })
  assert.equal(res.status, 'unknown')
  assert.equal(res.reason, 'unreconciled_drop')
  assert.equal(res.deposited, 0) // sortie stock exposee, rien attribue
  assert.equal(res.evidence.stockBefore, 1)
  assert.equal(res.evidence.stockAfter, 0)
})

test('RECIPIENT MOVED apres toss : depot correle avant le depart => succeeded, depart expose', async () => {
  const bot = mockBot({
    selfPos: { x: 0, y: 64, z: 0 },
    players: { Alice: { x: 1, y: 64, z: 0 } },
    stock: [{ name: 'oak_planks', count: 1, type: 10, metadata: 0 }]
  })
  bot.tossStack = async (stack) => {
    await sleep(10)
    stack._entry.count = 0
    scheduleSpawn(bot, { itemName: 'oak_planks', count: 1 })
    setTimeout(() => { bot.players.Alice.entity.position = { x: 40, y: 64, z: 0 } }, 30)
    return 1
  }
  const res = await giveToPlayer(bot, {
    player: 'Alice', item: 'oak_planks', count: 1,
    navigator: nearNavigator(), tossTimeoutMs: 2000, proofTimeoutMs: 600
  })
  assert.equal(res.status, 'succeeded')
  assert.equal(res.reason, 'deposited')
  assert.deepEqual([res.requested, res.deposited, res.remaining], [1, 1, 0])
  assert.equal(res.evidence.leftAfterToss, true)
  assert.ok(res.evidence.distancesPost.some(d => d.dxz === null || d.dxz > 3), 'distance post-toss exposee')
})

test('LOOK qui echoue => refus AVANT toss, stock intact', async () => {
  const bot = mockBot({
    players: { Alice: { x: 1, y: 64, z: 0 } },
    stock: [{ name: 'oak_planks', count: 2 }]
  })
  bot.lookAt = async () => { throw new Error('regard impossible') }
  const res = await giveToPlayer(bot, { player: 'Alice', item: 'oak_planks', count: 1, navigator: nearNavigator(), ...PROOF })
  assert.equal(res.status, 'failed')
  assert.equal(res.reason, 'look_failed')
  assert.equal(res.evidence.look, 'look_failed')
  assert.equal(res.evidence.lookError, 'regard impossible') // raison preservee, assainie
  assert.equal(bot.tossCalls.length, 0)
  assert.equal(stockOf(bot, 'oak_planks'), 2)
})

test('OVERSHOOT : take 1 mais stock -2 => unknown, perte exposee, rien blanchi', async () => {
  const bot = mockBot({
    players: { Alice: { x: 1, y: 64, z: 0 } },
    stock: [{ name: 'oak_planks', count: 5, type: 10, metadata: 0 }]
  })
  bot.toss = async (type, metadata, count) => {
    assert.equal(count, 1)
    const entry = bot._inv.find(e => e.type === type && e.metadata === metadata)
    entry.count -= 2 // serveur retire trop : simulation d overshoot
    scheduleSpawn(bot, { itemName: entry.name, count: 2 })
    return count
  }
  const res = await giveToPlayer(bot, { player: 'Alice', item: 'oak_planks', count: 1, navigator: nearNavigator(), ...PROOF })
  assert.equal(res.status, 'unknown')
  assert.equal(res.reason, 'overshoot')
  assert.equal(res.deposited, 0)
  assert.equal(res.remaining, 1)
  assert.deepEqual(res.evidence.overshoot, { take: 1, delta: 2, loss: 1 })
})

test('sans API d observation (ni entites ni ecoutes) => failed no_observation_api', async () => {
  const bot = mockBot({
    players: { Alice: { x: 1, y: 64, z: 0 } },
    stock: [{ name: 'oak_planks', count: 2 }]
  })
  delete bot.entities
  bot.on = undefined
  bot.removeListener = undefined
  const res = await giveToPlayer(bot, { player: 'Alice', item: 'oak_planks', count: 1, navigator: nearNavigator(), ...PROOF })
  assert.equal(res.status, 'failed')
  assert.equal(res.reason, 'no_observation_api')
  assert.equal(bot.tossCalls.length, 0)
  assert.equal(stockOf(bot, 'oak_planks'), 2)
})

test('sans onActivity ni announce : reussit quand meme, announced=false, traces reelles', async () => {
  const bot = mockBot({
    selfPos: { x: 0, y: 64, z: 0 },
    players: { Alice: { x: 1, y: 64, z: 0 } },
    stock: [{ name: 'oak_planks', count: 2, type: 10, metadata: 0 }]
  })
  const res = await giveToPlayer(bot, { player: 'Alice', item: 'oak_planks', count: 1, navigator: nearNavigator(), ...PROOF })
  assert.equal(res.status, 'succeeded')
  assert.equal(res.evidence.announced, false)
  assert.ok(res.evidence.distances.length >= 1)
  assert.ok(Number.isFinite(res.evidence.distances[0].dxz))
  assert.ok(res.evidence.drops[0].id !== null)
})

test('LOS strict au lancement : mur entre bot et joueur => failed, aucun toss', async () => {
  const bot = mockBot({
    selfPos: { x: 0, y: 64, z: 0 },
    players: { Alice: { x: 2, y: 64, z: 0 } },
    stock: [{ name: 'oak_planks', count: 2 }]
  })
  bot.blockAt = (pos) => { assertVec3(pos, 'blockAt'); return { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } }
  const res = await giveToPlayer(bot, { player: 'Alice', item: 'oak_planks', count: 1, navigator: nearNavigator(), ...PROOF })
  assert.equal(res.status, 'failed')
  assert.equal(res.reason, 'no_line_of_sight')
  assert.equal(res.evidence.line, 'blocked')
  assert.equal(bot.tossCalls.length, 0)
  assert.equal(stockOf(bot, 'oak_planks'), 2)
})

test('RAMASSAGE correle (branche OU) : entite retiree avant snapshot => succeeded via playerCollect', async () => {
  const bot = mockBot({
    players: { Alice: { x: 1, y: 64, z: 0 } },
    stock: [{ name: 'oak_planks', count: 1, type: 10, metadata: 0 }]
  })
  bot.tossStack = async (stack) => {
    await sleep(10)
    stack._entry.count = 0
    const id = bot._nextEntityId++
    const entity = { id, kind: 'drop', itemName: 'oak_planks', count: 1, position: { ...bot.entity.position } }
    bot.entities[id] = entity
    bot.emit('itemDrop', entity)
    bot.emit('entitySpawn', entity)
    // Ramassage immediat par la destinataire : l'entite disparait avant polls.
    bot.emit('playerCollect', { username: 'Alice' }, { id })
    delete bot.entities[id]
    return 1
  }
  const res = await giveToPlayer(bot, {
    player: 'Alice', item: 'oak_planks', count: 1,
    navigator: nearNavigator(), tossTimeoutMs: 2000, proofTimeoutMs: 800
  })
  assert.equal(res.status, 'succeeded')
  assert.equal(res.deposited, 1)
  assert.equal(res.evidence.drops[0].via, 'playerCollect')
  assert.equal(res.evidence.pickups.length, 1)
})

test('FUSION : goutte existante qui grossit pres des pieds => succeeded via fusion', async () => {
  const bot = mockBot({
    selfPos: { x: 0, y: 64, z: 0 },
    players: { Alice: { x: 1, y: 64, z: 0 } },
    stock: [{ name: 'oak_planks', count: 1, type: 10, metadata: 0 }]
  })
  bot.entities[7] = { id: 7, kind: 'drop', itemName: 'oak_planks', count: 1, position: { x: 0.5, y: 64, z: 0 } }
  bot.tossStack = async (stack) => {
    await sleep(10)
    stack._entry.count = 0
    bot.entities[7].count += 1 // le serveur fusionne : aucun nouvel objet
    return 1
  }
  const res = await giveToPlayer(bot, {
    player: 'Alice', item: 'oak_planks', count: 1,
    navigator: nearNavigator(), tossTimeoutMs: 2000, proofTimeoutMs: 600
  })
  assert.equal(res.status, 'succeeded')
  assert.equal(res.deposited, 1)
  assert.equal(res.evidence.drops[0].via, 'fusion')
})

test('VEC3 REEL : lookAt et blockAt recoivent des Vec3, plain refuse comme le reel', async () => {
  const bot = mockBot({
    selfPos: { x: 0, y: 64, z: 0 },
    players: { Alice: { x: 1, y: 64, z: 0 } },
    stock: [{ name: 'oak_planks', count: 1, type: 10, metadata: 0 }]
  })
  // Controle negatif : le mock strict refuse un objet plain, comme Mineflayer.
  await assert.rejects(bot.lookAt({ x: 1, y: 64, z: 0 }), /Vec3/)
  assert.throws(() => bot.blockAt({ x: 0, y: 64, z: 0 }), /Vec3/)
  const res = await giveToPlayer(bot, { player: 'Alice', item: 'oak_planks', count: 1, navigator: nearNavigator(), ...PROOF })
  assert.equal(res.status, 'succeeded')
  assert.ok(bot.lookedAtRefs.length >= 1)
  assert.ok(bot.lookedAtRefs[0] instanceof Vec3, 'lookAt a recu un vrai Vec3')
  assert.ok(bot.blockAtCalls.length >= 1)
  assert.ok(bot.blockAtCalls.every(p => p instanceof Vec3), 'blockAt n a recu que des Vec3')
  const feet = bot.lookedAt[0]
  assert.ok(Math.abs(feet.x - 1) < 0.01 && Math.abs(feet.y - 64.4) < 0.01)
})

test('LOOK LATCH : regard lent 300 ms, delai 50 ms => settle attendu, feet_late, depot', async () => {
  const bot = mockBot({
    players: { Alice: { x: 1, y: 64, z: 0 } },
    stock: [{ name: 'oak_planks', count: 1, type: 10, metadata: 0 }]
  })
  bot.lookAt = async (pos) => { assertVec3(pos, 'lookAt'); await sleep(300); bot.lookedAt.push({ x: pos.x, y: pos.y, z: pos.z }) }
  const events = []
  const t0 = Date.now()
  const res = await giveToPlayer(bot, {
    player: 'Alice', item: 'oak_planks', count: 1,
    navigator: nearNavigator(), lookTimeoutMs: 50, tossTimeoutMs: 2000, proofTimeoutMs: 600,
    onActivity: evt => { events.push(evt) }
  })
  const duration = Date.now() - t0
  assert.ok(duration >= 200, `rendu a ${duration} ms : retour avant le settle du regard INTERDIT`)
  assert.equal(res.status, 'succeeded') // visee tardive mais reussie : les pieds etaient vises
  assert.equal(res.evidence.look, 'feet_late')
  assert.ok(events.some(e => e.type === 'donation_look_timeout'), 'latch averti via onActivity')
})

test('TYPE INDETERMINE : goutte sans nom lisible => unknown, sighting expose, pas de succes', async () => {
  const bot = mockBot({
    players: { Alice: { x: 1, y: 64, z: 0 } },
    stock: [{ name: 'oak_planks', count: 1, type: 10, metadata: 0 }]
  })
  bot.tossStack = async (stack) => {
    await sleep(10)
    stack._entry.count = 0
    // Goutte de forme item reelle (name 'item') mais sans nom d'objet lisible.
    const id = bot._nextEntityId++
    const entity = { id, name: 'item', count: 1, position: { ...bot.entity.position } }
    bot.entities[id] = entity
    bot.emit('itemDrop', entity)
    bot.emit('entitySpawn', entity)
    return 1
  }
  const res = await giveToPlayer(bot, {
    player: 'Alice', item: 'oak_planks', count: 1,
    navigator: nearNavigator(), tossTimeoutMs: 2000, proofTimeoutMs: 200
  })
  assert.equal(res.status, 'unknown')
  assert.equal(res.reason, 'unreconciled_drop')
  assert.equal(res.deposited, 0)
  assert.ok(res.evidence.sightings.length >= 1, 'observation non prouvante exposee, pas jetee')
})

test('METADATA REELLE COPIEE D1 : slot {itemId:36,itemCount:2} + vrai registre 26.1 => succeeded', async () => {
  assert.equal(mcData26.items[36].name, 'oak_planks') // registre reel, coherent live
  assert.equal(mcData26.supportFeature('metadataIxOfItem'), 8)
  const bot = mockBot({
    players: { Alice: { x: 1, y: 64, z: 0 } },
    stock: [{ name: 'oak_planks', count: 5, type: 36, metadata: 0 }],
    registry: mcData26
  })
  bot.toss = async (type, metadata, count) => {
    assert.equal(type, 36)
    const entry = bot._inv.find(e => e.type === type && e.metadata === metadata)
    entry.count -= count
    const id = bot._nextEntityId++
    // Forme live D1 : name 'item', metadata slot reel, SANS itemName ni getDroppedItem.
    const entity = { id, name: 'item', position: { ...bot.entity.position }, metadata: { 8: { itemId: 36, itemCount: count } } }
    assert.equal(typeof entity.getDroppedItem, 'undefined')
    bot.entities[id] = entity
    bot.emit('entityUpdate', entity)
    bot.emit('itemDrop', entity)
    return count
  }
  const res = await giveToPlayer(bot, {
    player: 'Alice', item: 'oak_planks', count: 2,
    navigator: nearNavigator(), tossTimeoutMs: 2000, proofTimeoutMs: 600
  })
  assert.equal(res.status, 'succeeded')
  assert.deepEqual([res.requested, res.deposited, res.remaining], [2, 2, 0])
  assert.equal(res.evidence.drops[0].qty, 2)
})

test('METADATA ARRIVE LATE : slot pose 150 ms apres spawn, index non-8 => succeeded', async () => {
  const bot = mockBot({
    players: { Alice: { x: 1, y: 64, z: 0 } },
    stock: [{ name: 'oak_planks', count: 1, type: 36, metadata: 0 }],
    registry: mcData26
  })
  bot.tossStack = async (stack) => {
    await sleep(10)
    stack._entry.count = 0
    const id = bot._nextEntityId++
    const entity = { id, name: 'item', position: { ...bot.entity.position }, metadata: [] }
    bot.entities[id] = entity
    bot.emit('entitySpawn', entity)
    setTimeout(() => {
      entity.metadata[3] = { itemId: 36, itemCount: 1 } // tardif + hors index 8 : lecture schema
      bot.emit('entityUpdate', entity)
    }, 150)
    return 1
  }
  const res = await giveToPlayer(bot, {
    player: 'Alice', item: 'oak_planks', count: 1,
    navigator: nearNavigator(), tossTimeoutMs: 2000, proofTimeoutMs: 800
  })
  assert.equal(res.status, 'succeeded')
  assert.equal(res.deposited, 1)
  assert.equal(res.evidence.drops[0].qty, 1)
})

test('TYPE INCONNU AU REGISTRE : itemId 999999 => unknown, pas de succes', async () => {
  const bot = mockBot({
    players: { Alice: { x: 1, y: 64, z: 0 } },
    stock: [{ name: 'oak_planks', count: 1, type: 36, metadata: 0 }],
    registry: mcData26
  })
  bot.tossStack = async (stack) => {
    await sleep(10)
    stack._entry.count = 0
    const id = bot._nextEntityId++
    const entity = { id, name: 'item', position: { ...bot.entity.position }, metadata: { 8: { itemId: 999999, itemCount: 1 } } }
    bot.entities[id] = entity
    bot.emit('itemDrop', entity)
    return 1
  }
  const res = await giveToPlayer(bot, {
    player: 'Alice', item: 'oak_planks', count: 1,
    navigator: nearNavigator(), tossTimeoutMs: 2000, proofTimeoutMs: 200
  })
  assert.equal(res.status, 'unknown')
  assert.equal(res.reason, 'unreconciled_drop')
  assert.equal(res.deposited, 0)
  assert.ok(res.evidence.sightings.length >= 1)
})

test('COMPTE INADEQUAT : take 4, seule goutte connue compte 1 => unknown, 1 declare pas 4', async () => {
  const bot = mockBot({
    players: { Alice: { x: 1, y: 64, z: 0 } },
    stock: [{ name: 'oak_planks', count: 4, type: 36, metadata: 0 }],
    registry: mcData26
  })
  bot.tossStack = async (stack) => {
    await sleep(10)
    stack._entry.count = 0
    const id = bot._nextEntityId++
    const entity = { id, name: 'item', position: { ...bot.entity.position }, metadata: { 8: { itemId: 36, itemCount: 1 } } }
    bot.entities[id] = entity
    bot.emit('itemDrop', entity)
    return 4
  }
  const res = await giveToPlayer(bot, {
    player: 'Alice', item: 'oak_planks', count: 4,
    navigator: nearNavigator(), tossTimeoutMs: 2000, proofTimeoutMs: 600
  })
  assert.equal(res.status, 'unknown')
  assert.equal(res.reason, 'drop_count_shortfall')
  assert.equal(res.deposited, 1) // seul le prouve est declare
  assert.equal(res.remaining, 3)
  assert.deepEqual(res.evidence.shortfall, { delta: 4, proven: 1, missing: 3 })
  assert.equal(res.inventoryRemoved, 4)
  assert.equal(res.uncertain, true)
})

test('REPRO AUDITEUR : baseline id 7 + entityUpdate + itemDrop + fusion meme id => UN seul credit', async () => {
  const bot = mockBot({
    selfPos: { x: 0, y: 64, z: 0 },
    players: { Alice: { x: 1, y: 64, z: 0 } },
    stock: [{ name: 'oak_planks', count: 1, type: 10, metadata: 0 }]
  })
  // Goutte preexistante (baseline), id NUMERIQUE comme en live.
  bot.entities[7] = { id: 7, kind: 'drop', itemName: 'oak_planks', count: 1, position: { x: 0.5, y: 64, z: 0 } }
  bot.tossStack = async (stack) => {
    await sleep(10)
    stack._entry.count = 0
    bot.entities[7].count = 2 // fusion 7 : 1 -> 2
    bot.emit('entityUpdate', bot.entities[7])
    bot.emit('itemDrop', bot.entities[7])
    return 1
  }
  const res = await giveToPlayer(bot, {
    player: 'Alice', item: 'oak_planks', count: 1,
    navigator: nearNavigator(), tossTimeoutMs: 2000, proofTimeoutMs: 600
  })
  assert.equal(res.status, 'succeeded')
  assert.equal(res.deposited, 1)
  assert.equal(res.inventoryRemoved, 1)
  assert.equal(res.uncertain, false)
  assert.equal(res.evidence.drops.length, 1)
  assert.deepEqual(
    [res.evidence.drops[0].id, res.evidence.drops[0].via, res.evidence.drops[0].qty],
    ['7', 'fusion', 1]
  )
  assert.equal(res.evidence.tosses[0].correlated, true)
})

test('skills : declaration donner inchangee et coherente, comptes derives', async () => {
  const { ACTIONS, KINDS } = skills
  assert.ok(ACTIONS.donner, 'ACTIONS.donner declaree')
  for (const kind of ACTIONS.donner.kinds) assert.ok(KINDS[kind], `kind connu : ${kind}`)
  const params = ACTIONS.donner.params
  for (const key of ['objet', 'quantite', 'destinataire']) {
    assert.ok(params[key], `param ${key}`)
    assert.ok(params[key].question, `question ${key}`)
    assert.ok(params[key].json, `descripteur json ${key}`)
  }
  assert.deepEqual(params.quantite.json, { kind: 'number', min: 1, max: 64 })
  assert.deepEqual(params.objet.json, { kind: 'text', max: 40 })
  assert.deepEqual(params.destinataire.json, { kind: 'text', max: 16 })
  const secs = skills.estimatedSecondsFromParams('donner', { quantite: 2 })
  assert.ok(Number.isFinite(secs) && secs > 0)
  const derived = Object.keys(ACTIONS).length
  assert.equal(skills.audit([], []).counts.actions, derived)
  const fakeMissionActions = Object.keys(ACTIONS).filter(n => n !== 'donner')
  const audit = skills.audit([], fakeMissionActions)
  const missing = audit.problems.filter(p => p.includes('donner'))
  assert.equal(missing.length, 1)
  assert.match(missing[0], /declaree sans handler/)
})
