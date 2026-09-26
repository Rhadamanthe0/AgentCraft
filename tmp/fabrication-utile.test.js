'use strict'
// fabricationUtile (bot/mission.js) : un intermediaire n est utile que s il
// sert la cible. Vraies recettes 26.1, aucun monde.
//   NODE_PATH=bot/node_modules node --test tmp/fabrication-utile.test.js
const { test } = require('node:test')
const assert = require('node:assert/strict')
const md = require('minecraft-data')('26.1')
const { fabricationUtile } = require('../bot/mission')

test('batons refuses quand la recette de la cible n en contient pas', () => {
  assert.equal(fabricationUtile('stick', 'etabli', md), false)
  assert.equal(fabricationUtile('batons', 'porte', md), false)
  assert.equal(fabricationUtile('stick', 'crafting_table', md), false)
})

test('batons admis pour un outil ou une torche, planches toujours admises', () => {
  assert.equal(fabricationUtile('stick', 'hache', md), true)
  assert.equal(fabricationUtile('stick', 'torch', md), true)
  assert.equal(fabricationUtile('oak_planks', 'etabli', md), true)
  assert.equal(fabricationUtile('etabli', 'pioche', md), true)
})

test('sans registre : ancienne tolerance', () => {
  assert.equal(fabricationUtile('stick', 'etabli'), true)
})

test('cible du brief avec accent ou article : « établi » = etabli, batons refuses', () => {
  const skills = require('../bot/skills')
  assert.equal(skills.normalizeFabricationTarget('établi'), 'etabli')
  assert.equal(skills.normalizeFabricationTarget('un établi'), 'etabli')
  assert.equal(skills.normalizeFabricationTarget('hache en bois'), 'wooden_axe')
  const m = require('../bot/mission')
  assert.equal(m.fabricationUtile(m.fabTargetName('stick'), m.fabTargetName('établi'), md), false)
})
