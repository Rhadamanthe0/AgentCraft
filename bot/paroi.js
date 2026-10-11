'use strict'
// Jamais au contact exact d une paroi (piege 20, 2026-10-11).
//
// La physique de mineflayer arrete le joueur pile contre la face d un bloc
// (bord de la boite a 26.000 pour une feuille en z = 26). Le serveur Paper
// 26.1 refuse ce pas et renvoie le bot a sa derniere position acceptee, a
// quelques centiemes de la paroi : au coin d une haie, chaque pas en
// glissant le long de la face etait refuse (skill/hedge-pit 2837a81 et
// 366449e : client 125.79,25.70 renvoye a 125.70,25.69, ~200 recalages par
// trajet, blocs identiques cote client et serveur, aucune casse refusee).
//
// Apres chaque pas de physique, et avant l envoi de la position au serveur,
// un bot en contact horizontal exact avec un bloc plein est ecarte de
// PAROI_ECART (1 mm), invisible pour le jeu.
const { Vec3 } = require('vec3')
const config = require('./config')

const ECART = config.finiteNumber(process.env.PAROI_ECART, 0.001, 'PAROI_ECART', { min: 0 })
const DEMI_LARGEUR = 0.3
const HAUTEUR = 1.8
const CONTACT = 1e-7

function plein (bot, x, y, z) {
  const b = bot.blockAt?.(new Vec3(x, y, z), false) ?? null
  return b?.boundingBox === 'block'
}

// Ecart a appliquer sur un axe ('x' ou 'z') : negatif si une paroi touche le
// bord haut de la boite, positif si elle touche le bord bas, 0 sinon.
function ecartAxe (bot, p, axe, ecart = ECART) {
  const autre = axe === 'x' ? 'z' : 'x'
  const lo = Math.floor(p[autre] - DEMI_LARGEUR + CONTACT)
  const hi = Math.floor(p[autre] + DEMI_LARGEUR - CONTACT)
  const y0 = Math.floor(p.y + CONTACT)
  const y1 = Math.floor(p.y + HAUTEUR - CONTACT)
  const touche = face => {
    for (let a = lo; a <= hi; a++) {
      for (let y = y0; y <= y1; y++) {
        const cell = axe === 'x' ? plein(bot, face, y, a) : plein(bot, a, y, face)
        if (cell) return true
      }
    }
    return false
  }
  const haut = p[axe] + DEMI_LARGEUR
  if (Math.abs(haut - Math.round(haut)) < CONTACT && touche(Math.round(haut))) return -ecart
  const bas = p[axe] - DEMI_LARGEUR
  if (Math.abs(bas - Math.round(bas)) < CONTACT && touche(Math.round(bas) - 1)) return ecart
  return 0
}

function brancherParoi (bot, { ecart = ECART } = {}) {
  if (bot.paroi || ecart <= 0) return
  bot.paroi = { ecartes: 0 }
  bot.on('physicsTick', () => {
    const p = bot.entity?.position
    if (!p || !bot.entity.isCollidedHorizontally) return
    for (const axe of ['x', 'z']) {
      const d = ecartAxe(bot, p, axe, ecart)
      if (d) {
        p[axe] += d
        bot.paroi.ecartes += 1
      }
    }
  })
}

module.exports = { brancherParoi, ecartAxe, ECART }
