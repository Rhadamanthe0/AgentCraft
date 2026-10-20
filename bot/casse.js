'use strict'
// Casse confirmee par le serveur (piege 19, 2026-10-11).
//
// `bot.dig` de mineflayer 4.39 met le bloc a l air DANS LE MONDE DU CLIENT des
// qu il envoie « fin de casse », sans attendre le serveur. Depuis 1.19 un
// serveur qui refuse la casse ne renvoie pas le bloc : il acquitte la sequence
// et compte sur le client pour annuler sa prediction, ce que mineflayer ne
// fait pas. Le client croit alors la case vide, le serveur y voit toujours le
// bloc : chaque pas a travers est refuse (skill/hedge-pit 58c0689 : 210
// recalages `forcedMove` en 12 s, trois `stuck` au premier noeud, feuilles de
// la haie « degagees » cote client seulement).
//
// Ce plugin enveloppe `bot.dig` : une casse n est tenue pour faite que si le
// serveur envoie l etat de la case (block_change) ; sans nouvelle apres
// CASSE_CONFIRMATION_MS, l etat d avant est remis dans le monde du client et
// la casse echoue (« casse refusee par le serveur »), ce que chaque appelant
// traite deja comme un echec de casse.
const config = require('./config')

const CONFIRMATION_MS = config.finiteNumber(process.env.CASSE_CONFIRMATION_MS, 1500, 'CASSE_CONFIRMATION_MS', { min: 0 })

function brancherCasse (bot, { attenteMs = CONFIRMATION_MS } = {}) {
  if (bot.casse || typeof bot.dig !== 'function') return
  bot.casse = { confirmees: 0, refusees: 0 }
  const digOriginal = bot.dig
  bot.dig = async function (block, ...reste) {
    const pos = block?.position
    const majOriginale = bot._updateBlockState
    if (!pos || typeof majOriginale !== 'function' || attenteMs <= 0) return digOriginal.call(bot, block, ...reste)
    const avant = bot.blockAt(pos, false)?.stateId ?? block.stateId
    let local = false
    let confirme = false
    let reveil = null
    // Les paquets du serveur passent par la fonction interne de blocks.js,
    // jamais par `bot._updateBlockState` : seule la prediction de dig y passe.
    bot._updateBlockState = function (p, etat) {
      if (!p?.equals?.(pos)) return majOriginale.call(bot, p, etat)
      local = true
      try { return majOriginale.call(bot, p, etat) } finally { local = false }
    }
    const evenement = `blockUpdate:${pos}`
    // Etat envoye par le serveur : l etat d avant = casse refusee (bloc
    // renvoye), tout autre etat = casse faite (air, eau d une glace...).
    let etatServeur = null
    const ecoute = (_ancien, neuf) => {
      if (local) return
      confirme = true
      etatServeur = neuf?.stateId ?? null
      reveil?.()
    }
    bot.on(evenement, ecoute)
    try {
      await digOriginal.call(bot, block, ...reste)
      bot._updateBlockState = majOriginale
      if (!confirme) {
        await new Promise(resolve => {
          const minuterie = setTimeout(resolve, attenteMs)
          reveil = () => { clearTimeout(minuterie); resolve() }
        })
      }
      const renvoye = confirme && Number.isInteger(avant) && avant !== 0 && etatServeur === avant
      if (confirme && !renvoye) {
        bot.casse.confirmees += 1
        return
      }
      bot.casse.refusees += 1
      const actuel = bot.blockAt(pos, false)
      if (!confirme && Number.isInteger(avant) && avant !== 0 && actuel?.stateId !== avant) majOriginale.call(bot, pos, avant)
      const e = bot.entity
      const yeux = e?.position?.offset?.(0, e.eyeHeight ?? 1.62, 0)
      const distance = yeux ? yeux.distanceTo(pos.offset(0.5, 0.5, 0.5)).toFixed(2) : '?'
      console.log(`[casse] refusee par le serveur : ${block.name ?? '?'} ${pos} a ${distance} des yeux, ` +
        `${e?.onGround ? 'au sol' : 'en l air'} ; ${renvoye ? 'bloc renvoye par le serveur' : 'serveur muet, bloc remis dans le monde du client'} (${bot.casse.refusees} refus)`)
      throw new Error(`casse refusee par le serveur : ${block.name ?? 'bloc'} ${pos}`)
    } finally {
      if (bot._updateBlockState !== majOriginale) bot._updateBlockState = majOriginale
      bot.removeListener(evenement, ecoute)
    }
  }
}

module.exports = { brancherCasse }
