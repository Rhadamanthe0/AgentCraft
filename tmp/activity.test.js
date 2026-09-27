'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createActivityReporter } = require('../bot/activity')

test('heartbeat pendant attente longue, sans flot de messages', () => {
  const said = []
  let now = 0
  const a = createActivityReporter({ say: text => said.push(text), now: () => now })
  try {
    a.update('brief', 'Je prepare les etapes.')
    now = 1000; a.tick()
    assert.equal(said.length, 0)
    now = 15000; a.tick()
    assert.deepEqual(said, ['Je prepare les etapes.'])
    now = 16000; a.tick()
    assert.equal(said.length, 1)
    now = 30000; a.tick()
    assert.equal(said.length, 1, 'meme message : attente doublee (30 s)')
    now = 45000; a.tick()
    assert.equal(said.length, 2)
    now = 80000; a.tick()
    assert.equal(said.length, 2, 'puis 60 s')
    now = 105000; a.tick()
    assert.equal(said.length, 3)
  } finally { a.finish('cancelled') }
})
test('resultat final immediat et aucun message apres fermeture', () => {
  const said = []
  let now = 0
  const a = createActivityReporter({ say: text => said.push(text), now: () => now })
  a.update('execution', 'Je cherche un passage.', true)
  a.finish('failed', 'Je ne trouve pas de passage.')
  now = 100000; a.tick(); a.update('execution', 'obsolete', 'important')
  assert.deepEqual(said, ['Je cherche un passage.', 'Je ne trouve pas de passage.'])
  assert.equal(a.snapshot().phase, 'failed')
})
test('demande d aide visible et tache obsolete silencieuse', () => {
  const said = []
  let active = true
  const a = createActivityReporter({ say: text => said.push(text), isActive: () => active })
  a.update('execution', 'Je cherche.', true)
  a.update('help', 'Je demande une autre approche.', 'important')
  active = false
  a.tick(); a.update('help', 'obsolete', 'important')
  a.finish('cancelled')
  assert.equal(said.length, 2)
})
test('une panne de chat ne fait pas crasher le travail ou le timer', () => {
  const a = createActivityReporter({ say: () => { throw new Error('deconnecte') } })
  assert.doesNotThrow(() => a.update('execution', 'message', true))
  assert.equal(a.snapshot().deliveryError, 'deconnecte')
  a.finish('failed')
})
