'use strict'

// Rejoue la perception sur l instantane d un blocage de banc, hors ligne :
//
//   NODE_PATH=$PWD/bot/node_modules node tmp/replay-snapshot.js \
//     test-results/remote/<run>/<...>/instantanes/<niveau>-1.json [bloc]
//
// Pour chaque bloc vise (buches par defaut) qui serait une cible haute, il dit la
// hauteur de pilier utile depuis le poste du bot et les meilleurs postes au
// sol. Une regression de perception se reproduit ainsi en une seconde, et
// devient un test unitaire sur le meme monde, sans relancer le scenario.

const fs = require('node:fs')
const { Vec3 } = require('vec3')
const perception = require('../bot/perception')
const { worldFromSnapshot, createBot } = require('./sim-world')

function replay (snap, motif = /_log$|_wood$/) {
  const world = worldFromSnapshot(snap)
  const p = snap.position
  const bot = createBot(world, { position: new Vec3(p.x, p.y, p.z) })
  const pied = bot.entity.position.floored()
  const cibles = [...world.cells].filter(([, name]) => motif.test(name))
    .map(([k, name]) => ({ name, position: new Vec3(...k.split(',').map(Number)) }))
    // Same window as highTargetHint: above the ground reach, within a pillar,
    // horizontally within reach.
    .filter(c => c.position.y > pied.y + perception.MAX_REACH_UP &&
      c.position.y <= pied.y + perception.MAX_REACH_UP + perception.PILER_MAX &&
      Math.hypot(c.position.x + 0.5 - bot.entity.position.x, c.position.z + 0.5 - bot.entity.position.z) <= perception.REACH)
    .sort((a, b) => a.position.y - b.position.y)
  return cibles.map(c => {
    const centre = c.position.offset(0.5, 0.5, 0.5)
    const ici = perception.hauteurDePilier(bot, bot.entity.position, pied.y, centre, 1)
    const postes = perception.postesDePilier(bot, c.position, centre, new Set()).slice(0, 3)
    return { cible: c.name, position: c.position.toString(), ici, postes: postes.map(q => ({ poste: q.cle, hauteur: q.hauteur, distance: Number(q.distance.toFixed(1)) })) }
  })
}

if (require.main === module) {
  const [file, motif] = process.argv.slice(2)
  if (!file) {
    console.error('usage : node tmp/replay-snapshot.js <instantane.json> [motif de bloc]')
    process.exit(2)
  }
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'))
  console.log(`blocage : ${snap.raison ?? '?'} ; derniere action : ${snap.derniere_action?.resultat ?? '?'}`)
  console.log(JSON.stringify(replay(snap, motif ? new RegExp(motif) : undefined), null, 2))
}

module.exports = { replay }
