'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { findSites, coverAt, clearOne, underTree } = require('../bot/tree-position')

function fixture (obstacles = 0) {
  const blocks = new Map()
  const put = (x, y, z, name) => blocks.set(`${x},${y},${z}`, name)
  const definitions = { air: { id: 0, name: 'air' }, stone: { id: 1, name: 'stone' },
    oak_log: { id: 2, name: 'oak_log' }, oak_leaves: { id: 3, name: 'oak_leaves' }, water: { id: 4, name: 'water' } }
  for (let y = 1; y <= 4; y++) put(4, y, 0, 'oak_log')
  put(2, 3, 0, 'oak_leaves')
  if (obstacles >= 1) put(2, 2, 0, 'oak_leaves')
  if (obstacles >= 2) put(2, 1, 0, 'oak_leaves')
  let digs = 0
  let walks = 0
  const bot = {
    entity: { position: new Vec3(0.5, 1, 0.5), onGround: true }, registry: { blocksByName: definitions },
    blockAt: p => {
      const q = p.floored()
      const name = blocks.get(`${q.x},${q.y},${q.z}`) ?? (q.y === 0 ? 'stone' : 'air')
      const shapes = ['air', 'water'].includes(name) ? [] : [[0, 0, 0, 1, 1, 1]]
      return { name, type: definitions[name].id, shapes, position: q, boundingBox: shapes.length ? 'block' : 'empty' }
    },
    findBlocks: ({ matching }) => [...blocks.entries()].filter(([, name]) => matching.includes(definitions[name].id))
      .map(([key]) => new Vec3(...key.split(',').map(Number))),
    canDigBlock: () => true, stopDigging: () => {},
    dig: async b => { digs++; blocks.delete(`${b.position.x},${b.position.y},${b.position.z}`) }
  }
  const host = { getBot: () => bot, navigateToPosition: async p => {
    walks++; bot.entity.position = new Vec3(p.x, p.y, p.z); return { reached: true, code: 'arrived' }
  } }
  return { bot, host, put, blocks, get digs () { return digs }, get walks () { return walks } }
}
test('proximite du tronc ne vaut pas sous un arbre', () => {
  const f = fixture()
  assert.equal(coverAt(f.bot, new Vec3(3.5, 1, 0.5)), null)
  assert.ok(coverAt(f.bot, new Vec3(2.5, 1, 0.5)))
})
test('emplacement libre : navigation sans recolte ni casse meme autorisee', async () => {
  const f = fixture()
  const permission = { limit: 1, used: 0 }
  const result = await underTree(f.host, permission, new AbortController().signal)
  assert.equal(result.reached, true)
  assert.equal(result.cover.name, 'oak_leaves')
  assert.equal(f.digs, 0)
  assert.equal(permission.used, 0)
})
test('aucune casse sans permission', async () => {
  const f = fixture(1)
  const result = await underTree(f.host, { limit: 0, used: 0 }, new AbortController().signal)
  assert.equal(result.code, 'clearance_required')
  assert.equal(f.digs, 0)
})
test('un seul bloc de feuilles degage puis couvert verifie', async () => {
  const f = fixture(1)
  const permission = { limit: 1, used: 0 }
  const result = await underTree(f.host, permission, new AbortController().signal)
  assert.equal(result.reached, true)
  assert.equal(result.cleared, 1)
  assert.equal(permission.used, 1)
  assert.equal(f.digs, 1)
  assert.equal(f.blocks.get('4,1,0'), 'oak_log')
  assert.ok(coverAt(f.bot, f.bot.entity.position))
})
test('deux obstacles : ne depasse pas le budget unitaire', async () => {
  const f = fixture(2)
  const result = await underTree(f.host, { limit: 1, used: 0 }, new AbortController().signal)
  assert.equal(result.code, 'clearance_budget_insufficient')
  assert.equal(f.digs, 0)
})
test('refus serveur consomme la reservation et empeche une deuxieme casse', async () => {
  const f = fixture(1)
  let calls = 0
  f.bot.dig = async () => { calls++ }
  const permission = { limit: 1, used: 0 }
  const block = f.bot.blockAt(new Vec3(2, 2, 0))
  assert.equal((await clearOne(f.bot, block, permission, new AbortController().signal)).code, 'dig_refused')
  assert.equal((await clearOne(f.bot, block, permission, new AbortController().signal)).code, 'clearance_not_authorized')
  assert.equal(calls, 1)
})
test('annulation avant degagement : aucune casse', async () => {
  const f = fixture(1)
  const c = new AbortController()
  c.abort()
  assert.equal((await underTree(f.host, { limit: 1, used: 0 }, c.signal)).code, 'cancelled')
  assert.equal(f.digs, 0)
})
test('pas de destination sur eau ou sans couvert restant', () => {
  const f = fixture(1)
  f.put(2, 0, 0, 'water')
  assert.equal(findSites(f.bot).length, 0)
})
test('une position en l air ne valide pas le placement', async () => {
  const f = fixture()
  f.bot.entity.onGround = false
  assert.equal((await underTree(f.host, { limit: 0, used: 0 }, new AbortController().signal)).code, 'unstable_position')
})
test('annulation pendant la casse : stopDigging et budget non rembourse', async () => {
  const f = fixture(1)
  let stopped = false
  f.bot.dig = () => new Promise(() => {})
  f.bot.stopDigging = () => { stopped = true }
  const permission = { limit: 1, used: 0 }
  const c = new AbortController()
  const pending = clearOne(f.bot, f.bot.blockAt(new Vec3(2, 2, 0)), permission, c.signal)
  c.abort()
  assert.equal((await pending).code, 'cancelled')
  assert.equal(stopped, true)
  assert.equal(permission.used, 1)
})
