'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { validateRoute, createTask, executeTask } = require('../bot/movement-task')

test('deux allers-retours = quatre arrivees verifiees, meme depart', async () => {
  const task = createTask(validateRoute([{ type: 'aller_retour', repetitions: 2 }]), { x: 5, y: 65, z: 8 })
  const calls = []
  const host = {
    navigateToPlayer: async who => { calls.push(who); return { reached: true, code: 'arrived' } },
    navigateToPosition: async point => { calls.push(point); return { reached: true, code: 'arrived' } }
  }
  const result = await executeTask(task, host, 'Alice', new AbortController().signal)
  assert.equal(result.reached, true)
  assert.equal(task.cursor, 4)
  assert.deepEqual(calls, ['Alice', { x: 5, y: 65, z: 8 }, 'Alice', { x: 5, y: 65, z: 8 }])
})
test('echec intermediaire : suite non executee et aucun succes fictif', async () => {
  const task = createTask(validateRoute([{ type: 'aller_retour', repetitions: 2 }]), { x: 0, y: 0, z: 0 })
  let calls = 0
  const host = { navigateToPlayer: async () => { calls++; return { reached: true } },
    navigateToPosition: async () => ({ reached: false, code: 'no_path' }) }
  assert.equal((await executeTask(task, host, 'A', new AbortController().signal)).code, 'no_path')
  assert.equal(task.cursor, 1)
  assert.equal(calls, 1)
  assert.equal(task.steps[2].state, 'pending')
})
test('annulation pendant attente : pas de prochain sous-objectif', async () => {
  const task = createTask(validateRoute([{ type: 'attendre', secondes: 20 }, { type: 'rejoindre' }]), { x: 0, y: 0, z: 0 })
  const c = new AbortController()
  const pending = executeTask(task, {}, 'A', c.signal)
  c.abort()
  assert.equal((await pending).code, 'cancelled')
  assert.equal(task.cursor, 0)
})
test('validation rejette objectifs inconnus, nombres invalides et suites inatteignables', () => {
  for (const raw of [[{ type: 'teleporter' }], [{ type: 'aller_retour', repetitions: 2.5 }],
    [{ type: 'attendre', secondes: -1 }], [{ type: 'suivre' }, { type: 'retour' }]]) {
    assert.throws(() => validateRoute(raw))
  }
})
