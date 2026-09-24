'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '../bot/index.js'), 'utf8')

// Execute les vrais handlers, avec un trajet volontairement non resolu :
// l admission HTTP ne doit jamais etre confondue avec la fin du deplacement.
function fixture ({ refused = false, aborted = false } = {}) {
  const controller = new AbortController()
  if (aborted) controller.abort()
  const state = { calls: [], messages: [], stops: 0, settled: false }
  let resolveNavigation
  const navigation = new Promise(resolve => { resolveNavigation = resolve })
  const context = {
    Date, console, CMD_PREFIX: '!', requireBot: () => {}, lastPathStatus: 'old',
    say: text => state.messages.push(text),
    requireAdmissionOrThrow: () => { if (refused) throw Object.assign(new Error('occupe'), { code: 'busy' }) },
    stopPathfinding: () => { state.stops++ },
    navigator: { toPosition: (target, opts) => { state.calls.push({ target, opts }); return navigation } },
    runPhysical: (id, kind, execute) => {
      state.id = id
      state.kind = kind
      state.pending = Promise.resolve(execute({ signal: controller.signal })).then(value => {
        state.settled = true
        return { value }
      })
      return state.pending
    },
    app: { post: (url, middleware, handler) => { state.goto = handler } }
  }
  vm.createContext(context)
  const command = source.slice(source.indexOf('  va (username, args) {'), source.indexOf('  async viens (username) {'))
  vm.runInContext(`handlers = ({${command}})`, context)
  const endpoint = source.slice(source.indexOf("app.post('/api/goto',"), source.indexOf('// Vrais flux /api/instruction'))
  vm.runInContext(endpoint, context)
  state.va = context.handlers.va
  state.signal = controller.signal
  state.resolve = resolveNavigation
  state.response = { status (code) { state.httpStatus = code; return this }, json (body) { state.body = body; return this } }
  return state
}

test('!va conserve le writer jusqu au resultat et transmet les echecs physiques', async () => {
  const f = fixture()
  f.va('human', ['12', '65', '-4'])
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].opts.signal, f.signal)
  assert.equal(f.calls[0].opts.radius, 1)
  assert.equal(f.settled, false)
  const result = { code: 'stuck', reached: false }
  f.resolve(result)
  assert.equal((await f.pending).value, result)
  await Promise.resolve()
  assert.ok(f.messages.some(text => text.includes('stuck')))
})

test('/api/goto admet immediatement, conserve coordonnees et ne conclut pas avant navigation', async () => {
  const f = fixture()
  f.goto({ body: { x: 12.4, y: 65.5, z: -4.2, range: 2 } }, f.response)
  assert.equal(f.body.admitted, true)
  assert.equal(f.settled, false)
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].target)), { x: 12.4, y: 65.5, z: -4.2 })
  assert.equal(f.calls[0].opts.signal, f.signal)
  assert.equal(f.calls[0].opts.radius, 2)
  const result = { code: 'no_path', reached: false }
  f.resolve(result)
  assert.equal((await f.pending).value, result)
})

test('refus admission et signal deja annule ne touchent pas au trajet courant', async () => {
  for (const entry of ['command', 'api']) {
    for (const scenario of [{ refused: true }, { aborted: true }]) {
      const f = fixture(scenario)
      if (entry === 'command') f.va('human', ['12', '65', '-4'])
      else f.goto({ body: { x: 12, y: 65, z: -4 } }, f.response)
      if (f.pending) assert.equal((await f.pending).value.code, 'cancelled')
      assert.equal(f.stops, 0)
      assert.equal(f.calls.length, 0)
      if (entry === 'api' && scenario.refused) assert.equal(f.httpStatus, 409)
    }
  }
})
