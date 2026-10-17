'use strict'
// Mort du bot (idee reprise de Mindcraft, 2026-10-16) : la mort est mesuree
// ici, la mission en tire la suite (mission.signalerMort, repriseApresMort).
//
// `death` : lieu et nombre d objets en poche, lus avant que la reapparition
// ne vide l inventaire. Message de mort du serveur (traduction `death.*` qui
// nomme le bot) : la cause. `spawn` qui suit une mort : la reapparition,
// avec la cause si elle est arrivee entre-temps.

function brancherMort (bot, { onMort, onReapparition } = {}) {
  let enAttente = null
  bot.on('death', () => {
    const p = bot.entity?.position
    const objets = (bot.inventory?.items?.() ?? []).reduce((n, item) => n + (item.count || 0), 0)
    enAttente = { position: p ? p.clone?.() ?? { x: p.x, y: p.y, z: p.z } : null, objets, cause: null }
    try { onMort?.(enAttente) } catch (err) { console.error('[mort] signalement impossible :', err.message) }
  })
  bot.on('messagestr', (message, _position, json) => {
    if (!enAttente || enAttente.cause) return
    const cle = json?.translate ?? json?.json?.translate
    if (typeof cle === 'string' && cle.startsWith('death.') && String(message).startsWith(bot.username)) {
      enAttente.cause = String(message)
    }
  })
  bot.on('spawn', () => {
    if (!enAttente) return
    const mort = enAttente
    enAttente = null
    try { onReapparition?.(mort) } catch (err) { console.error('[mort] reprise impossible :', err.message) }
  })
}

module.exports = { brancherMort }
