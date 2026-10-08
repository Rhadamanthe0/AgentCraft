'use strict'

// Attente des chunks autour d un bot, rejouee : `bot.waitForChunksToLoad`
// rejette apres 10 s si le serveur tarde (serveur charge en debut de banc),
// et un rejet non attrape tuait le harness, donc tout le banc.
async function attendreChunks (bot, { essais = 6, log = console.log } = {}) {
  for (let i = 1; i <= essais; i++) {
    try {
      await bot.waitForChunksToLoad()
      return true
    } catch (err) {
      log(`[harness] chunks pas encore charges (essai ${i}/${essais}) : ${err.message}`)
    }
  }
  return false
}

module.exports = { attendreChunks }
