'use strict'
// Banc 5c22cfe (2e essai) : le serveur a tarde a envoyer deux chunks au
// harness ; le rejet de `bot.waitForChunksToLoad` n etait pas attrape, le
// processus est mort et tout le banc avec lui. L attente est rejouee.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { attendreChunks } = require('../ci/attendre-chunks')

test('un delai depasse est rejoue jusqu au chargement', async () => {
  let appels = 0
  const bot = { waitForChunksToLoad: async () => { if (++appels < 3) throw new Error('Timeout waiting for 2 chunks to load after 10000ms') } }
  const lignes = []
  assert.equal(await attendreChunks(bot, { essais: 6, log: l => lignes.push(l) }), true)
  assert.equal(appels, 3)
  assert.equal(lignes.length, 2)
})

test('apres le dernier essai : false, jamais de rejet non attrape', async () => {
  let appels = 0
  const bot = { waitForChunksToLoad: async () => { appels++; throw new Error('Timeout') } }
  assert.equal(await attendreChunks(bot, { essais: 3, log: () => {} }), false)
  assert.equal(appels, 3)
})
