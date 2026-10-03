'use strict'

// Gestes de pose partages : monter d un bloc en posant sous soi (tour), et
// poser contre la face d un bloc voisin (pont, marche). Ils reprennent les
// gestes prouves de `piler` et du pont de terre (mission.js) pour que le
// moteur d acces (navigation.js, option `place`) les execute a son tour.
//
// Regles communes, jamais relachees :
//   - survie : le bloc vient de l inventaire reel, aucune commande serveur ;
//   - le serveur a le dernier mot : une pose n est comptee que si la case
//     visee est pleine APRES coup (« the block is still air » = refus) ;
//   - la pose sous soi part pres du sommet du saut (dy >= 1,0, ou montee qui
//     cale) : plus bas, le corps recouvre encore la case et le serveur refuse.

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const { awaitPhysicalWithTimeout } = require('./executor')

// Borne une promesse physique SANS jamais rendre avant son settle reel
// (R01) : au timeout, le settle reel est attendu puis seulement l erreur de
// delai est levee. Ici aucune annulation concrete (equip/lookAt/placeBlock
// n en offrent pas) : un `opts.onTimeout` explicite peut en fournir une, et
// `opts.signal` fait rendre cancelled apres settle. Le jump de poserSousSoi
// est ainsi relache (finally) APRES la fin reelle de la pose, jamais pendant.
function withTimeout (promise, ms, label, opts = {}) {
  const signal = opts && typeof opts.signal === 'object' && opts.signal !== null ? opts.signal : null
  const onTimeout = opts && typeof opts.onTimeout === 'function' ? opts.onTimeout : null
  return awaitPhysicalWithTimeout(promise, ms, label, { signal, onTimeout })
}

const plein = block => Boolean(block && block.boundingBox === 'block')

async function equiper (bot, item, opts) {
  if (bot.heldItem?.name === item.name) return
  await withTimeout(bot.equip(item, 'hand'), 4000, 'equipement trop long', opts)
}

// Saut puis pose sur `appui` (le bloc sous les pieds), face du dessus. Rend
// { ok, detail }. Deux essais : un refus serveur re-saute et repose.
async function poserSousSoi (bot, appui, item, opts) {
  const V = bot.entity.position.constructor
  const cellule = appui.position.offset(0, 1, 0)
  let detail = null
  for (let essai = 1; essai <= 2; essai += 1) {
    try {
      await equiper(bot, item, opts)
      await withTimeout(bot.lookAt(new V(appui.position.x + 0.5, appui.position.y + 1, appui.position.z + 0.5), true), 3000, 'visee trop longue', opts)
    } catch (err) {
      return { ok: false, detail: err.message }
    }
    const yDepart = bot.entity.position.y
    bot.setControlState('jump', true)
    try {
      const fin = Date.now() + 900
      let dernier = -1
      let stable = 0
      let sommet = false
      while (Date.now() < fin) {
        await sleep(50)
        const dy = bot.entity.position.y - yDepart
        if (dy >= 1) { sommet = true; break }
        stable = dy <= dernier + 0.02 ? stable + 1 : 0
        dernier = dy
        if (stable >= 2 && dy > 0.3) { sommet = true; break }
      }
      if (!sommet && bot.entity.position.y - yDepart < 0.3) throw new Error('saut trop bas : plafond ou bot coince')
      await withTimeout(bot.placeBlock(appui, new V(0, 1, 0)), 4000, 'pose trop longue', opts)
    } catch (err) {
      detail = err.message
    } finally {
      bot.setControlState('jump', false)
    }
    // Atterrissage borne : on ne reste pas suspendu.
    const finAtterrissage = Date.now() + 1500
    while (Date.now() < finAtterrissage && !bot.entity.onGround) await sleep(50)
    if (plein(bot.blockAt(cellule))) return { ok: true }
    detail = detail ?? `case ${cellule.x} ${cellule.y} ${cellule.z} encore vide`
    await sleep(200)
  }
  return { ok: false, detail }
}

// Pose contre la face `face` (vecteur unite) de `ref`. Rend { ok, detail }.
async function poserContre (bot, ref, face, item, opts) {
  const V = bot.entity.position.constructor
  const cellule = ref.position.plus(face)
  try {
    await equiper(bot, item, opts)
    await withTimeout(bot.lookAt(new V(ref.position.x + 0.5 + face.x * 0.5, ref.position.y + 0.5 + face.y * 0.5,
      ref.position.z + 0.5 + face.z * 0.5), true), 3000, 'visee trop longue', opts)
    await withTimeout(bot.placeBlock(ref, face), 5000, 'pose trop longue', opts)
  } catch (err) {
    if (!plein(bot.blockAt(cellule))) return { ok: false, detail: err.message }
  }
  return plein(bot.blockAt(cellule)) ? { ok: true } : { ok: false, detail: `case ${cellule.x} ${cellule.y} ${cellule.z} encore vide` }
}

module.exports = { poserSousSoi, poserContre, equiper, withTimeout }
