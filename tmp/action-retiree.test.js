'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const skills = require('../bot/skills')
const { createMissionRunner } = require('../bot/mission')

// Niveau « action retiree » du banc (proprietaire, 2026-10-25) : toute action
// se retire par `action_<nom>`, sauf de quoi finir et se degager.
test('action_<nom> retire une action sans interrupteur, puis la rend', () => {
  const runner = createMissionRunner({ getBot: () => null })
  runner.setFeatures({ action_casser: false })
  assert.equal(skills.actionsFor('construction', 'harvest').includes('casser'), false)
  assert.equal(skills.actionsFor('recolte', 'harvest').includes('casser'), false)
  runner.setFeatures({ reset: true })
  assert.equal(skills.actionsFor('construction', 'harvest').includes('casser'), true)
})

test('terminer, sortir et attendre ne se retirent pas', () => {
  const runner = createMissionRunner({ getBot: () => null })
  runner.setFeatures({ action_terminer: false, action_sortir: false, action_attendre: false })
  for (const action of ['terminer', 'sortir', 'attendre']) {
    assert.equal(skills.actionsFor('construction', 'harvest').includes(action), true, action)
  }
  runner.setFeatures({ reset: true })
})

test('un nom d action long reste accepte', () => {
  const runner = createMissionRunner({ getBot: () => null })
  assert.equal(runner.setFeatures({ action_rejoindre_demandeur: false }).action_rejoindre_demandeur, false)
  runner.setFeatures({ reset: true })
})
