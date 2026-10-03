'use strict'

// Gestes de bas niveau, attente, fin et memoire : les actions qui ne savent
// rien de l objectif. Elles rendent la main au planificateur avec ce qui s est
// reellement passe (le bot a-t-il bouge ? de combien ?), et c est lui qui en
// tire une conclusion au tour suivant.
//
// Premier module d actions sorti de mission.js (2026-10-01) : une famille
// d actions recoit un contexte explicite (hote, mission courante, mesures
// dont elle a besoin) au lieu de lire la fermeture de la boucle de mission.

const memory = require('./memory')
const { videDevant } = require('./perception')
// R19 : parsing central du delai (bot/config.js) : valeur invalide => repli
// 20000 + warning, jamais de NaN silencieux.
const config = require('./config')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const WAIT_MIN_MS = 1000
const WAIT_MAX_MS = 5000
const DIRE_COOLDOWN_MS = config.positiveInt(process.env.MISSION_DIRE_COOLDOWN_MS, 20000, 'MISSION_DIRE_COOLDOWN_MS')

// ctx : { host, getMission, findTargetBlock, scaled }
function createGestes ({ host, getMission, findTargetBlock, scaled }) {
  return {
    async attendre (scale, params = {}) {
      const duration = Number.isFinite(Number(params.duree))
        ? Math.max(0.2, Math.min(WAIT_MAX_MS / 1000, Number(params.duree))) * 1000
        : scaled(scale, WAIT_MIN_MS, WAIT_MAX_MS)
      await sleep(duration)
      return { resultat: `attente de ${Math.round(duration / 100) / 10} s` }
    },

    async terminer () {
      return { resultat: 'fin demandee par le planificateur', fin: true }
    },

    // -----------------------------------------------------------------------
    // Gestes de bas niveau
    //
    // Elles ne savent rien de l objectif : elles rendent la main au
    // planificateur avec ce qui s est reellement passe (le bot a-t-il bouge ?
    // de combien ?), et c est lui qui en tire une conclusion au tour suivant.
    // -----------------------------------------------------------------------

    async dire (scale, params = {}) {
      const texte = String(params.texte ?? '').trim()
      if (!texte) return { resultat: 'aucun texte a dire', echec: true }

      // Le chat est aussi la facon dont on tape une commande serveur. Sans ce
      // garde-fou, `dire` serait un trou dans le retrait des pouvoirs
      // d administration : il suffirait au modele d ecrire "/gamemode creative"
      // pour recuperer ce qu on vient de lui enlever.
      if (texte.startsWith('/')) {
        return { resultat: 'les commandes serveur sont interdites au bot', echec: true }
      }

      // Le prompt demande de parler sobrement ; mesure en jeu, le modele s en
      // moque et boucle sur « dire -> attendre », une fois toutes les deux
      // secondes. Le code compte donc a sa place : jamais deux fois la meme
      // phrase dans une mission, et pas plus d une phrase par DIRE_COOLDOWN_MS.
      // Phrase tue : pas un echec (rien n a rate dans le monde) ; en echec,
      // elle jetait la suite du plan (16 fois sur 5 bancs). Une boucle de
      // `dire` reste vue par detectStuck (meme resultat 3 fois).
      if (getMission().saidTexts.includes(texte)) {
        return { resultat: 'deja dit, non repete : continuer le travail' }
      }
      if (Date.now() - getMission().lastSaidAt < DIRE_COOLDOWN_MS) {
        const reste = Math.ceil((DIRE_COOLDOWN_MS - (Date.now() - getMission().lastSaidAt)) / 1000)
        return { resultat: `non dit : trop tot pour reparler (encore ${reste} s), continuer le travail` }
      }

      host.chat(texte)
      getMission().lastSaidAt = Date.now()
      getMission().saidTexts.push(texte)
      if (getMission().saidTexts.length > 12) getMission().saidTexts.shift()

      return { resultat: `dit dans le chat : "${texte}"` }
    },

    async regarder (scale, params = {}) {
      const bot = host.getBot()
      // Les angles arrivent deja bornes par planner.coerceParams ; on garde la
      // valeur courante quand le planificateur n en donne qu un des deux.
      const yaw = params.horizontal === undefined
        ? bot.entity.yaw
        : (params.horizontal * Math.PI) / 180
      const pitch = params.vertical === undefined
        ? bot.entity.pitch
        : (params.vertical * Math.PI) / 180

      await bot.look(yaw, pitch, true)

      const block = findTargetBlock()
      return {
        resultat: `regarde vers ${Math.round((yaw * 180) / Math.PI)} deg / ` +
          `${Math.round((pitch * 180) / Math.PI)} deg` +
          (block ? `, ${block.name} toujours en vue` : ', aucun bloc cible en vue')
      }
    },

    async sauter (scale, params = {}) {
      const bot = host.getBot()
      const duree = params.duree ?? 0.5
      const before = bot.entity.position.clone()

      // Un saut retombe a sa position de depart : mesure faite a l atterrissage,
      // un saut reussi rendrait 0 et passerait pour un blocage. On echantillonne
      // donc pendant le saut et on garde le PIC VERTICAL (y - y0), pas la
      // distance 3D : un saut sur place ne derive presque pas en XZ, et la 3D
      // melangeait un eventuel glissement horizontal au decollement reel.
      // Mesure en jeu : pic vertical ~1,25 bloc en saut libre, ~0,2 sous un
      // plafond a deux blocs au-dessus des pieds. Fenetre sprint (~1,9 bloc en
      // elan) ne concerne que walkForward, pas ce saut vertical sur place.
      bot.setControlState('jump', true)
      let pic = 0
      const y0 = before.y
      const fin = Date.now() + Math.round(duree * 1000)
      while (Date.now() < fin) {
        await sleep(50)
        const y = host.getBot()?.entity?.position?.y ?? y0
        const dy = y - y0
        if (dy > pic) pic = dy
      }
      bot.setControlState('jump', false)
      await sleep(250)

      // Meme convention que `appuyer` : un saut qui ne decolle pas est la
      // signature d un bot bloque (plafond, encastre). On le remonte comme un
      // echec pour vider la file et faire replanifier.
      //
      // Seuil 0,5 et non 0,1 comme `appuyer` : mesure en jeu, un plafond a deux
      // blocs au-dessus des pieds laisse encore grimper de 0,2 bloc (et 0,2 est
      // le plancher physique, un bot ne fait pas 1,8 de haut dans 2 blocs). Un
      // seuil de 0,1 laisserait donc passer tout saut bloque. Un saut libre
      // plafonne a ~1,25 bloc ; 0,5 separe proprement les deux.
      const bloque = pic < 0.5

      return {
        resultat: `saut de ${duree.toFixed(1)} s, pic vertical de ${pic.toFixed(2)} bloc` +
          (bloque ? ' (saut bloque : plafond ou bot coince)' : ''),
        echec: bloque
      }
    },

    async appuyer (scale, params = {}) {
      const bot = host.getBot()
      // Le modele omet parfois `touches` (observe en jeu : « aucune touche
      // indiquee » en boucle). Avancer droit est le repli le plus utile : mieux
      // vaut un pas en avant qu une action jetee sans rien tenter.
      const touches = Array.isArray(params.touches) && params.touches.length > 0
        ? params.touches
        : ['forward']

      const duree = params.duree ?? 1
      const before = bot.entity.position.clone()

      // Un objectif de pathfinder en cours se battrait avec les touches tenues.
      host.stopPathfinding()

      // Meme garde que `avancer` sans cible, a chaque tick, dans le sens du
      // mouvement reel : vu sur composite/cabin-from-scratch (f1f762d),
      // appuyer(forward, 1,5 s) sur le toit de la cabane, 10,7 blocs, chute
      // de 4, degats.
      const directions = touches.filter(t => ['forward', 'back', 'left', 'right'].includes(t))
      let videVu = null
      const surveilleBord = () => {
        if (videVu !== null || directions.length === 0) return
        const v = bot.entity?.velocity
        const dir = v && Math.hypot(v.x, v.z) > 0.02 ? { x: v.x, z: v.z } : null
        const chute = dir || directions.includes('forward') ? videDevant(bot, dir) : null
        if (chute === null) return
        videVu = chute
        try { bot.clearControlStates() } catch (_) {}
      }
      if (typeof bot.on === 'function') bot.on('physicsTick', surveilleBord)
      try {
        for (const touche of touches) bot.setControlState(touche, true)
        const fin = Date.now() + Math.round(duree * 1000)
        while (Date.now() < fin && videVu === null) await sleep(Math.min(50, Math.max(0, fin - Date.now())))
      } finally {
        if (typeof bot.removeListener === 'function') bot.removeListener('physicsTick', surveilleBord)
        for (const touche of touches) {
          try { bot.setControlState(touche, false) } catch (_) {}
        }
      }

      await sleep(150)
      const moved = host.getBot()?.entity?.position?.distanceTo(before) ?? 0

      // Un deplacement nul apres avoir tenu `forward` est un fait utile : c est
      // la signature d un bot encastre (piege 6). On le remonte comme un echec
      // pour que le plan soit jete et que le planificateur en tienne compte.
      const bloque = moved < 0.1 && touches.some(t => ['forward', 'back', 'left', 'right'].includes(t))

      return {
        resultat: `${touches.join('+')} tenu ${duree.toFixed(1)} s, deplacement de ${moved.toFixed(2)} bloc` +
          (bloque ? ' (immobile : probablement encastre)' : '') +
          (videVu !== null ? `, arret au bord d une chute de ${videVu} blocs` : ''),
        echec: bloque
      }
    },

    // Le repli quand le planificateur ne sait pas quoi faire : balayer les quatre
    // points cardinaux et rendre compte de ce qui est visible. Contrairement a
    // `attendre`, il rend de l information, donc le tour suivant n est pas
    // identique au precedent.
    async regarder_autour () {
      const bot = host.getBot()
      // Meme convention que skills.regarder : 0 rad = nord, +PI/2 = ouest,
      // PI = sud, -PI/2 = est. C est la convention reelle de mineflayer
      // (vecteur avant = -sin yaw, -cos yaw) : yaw 0 regarde vers -Z.
      const headings = [
        ['nord', 0],
        ['ouest', Math.PI * 0.5],
        ['sud', Math.PI],
        ['est', -Math.PI * 0.5]
      ]

      const vus = []
      for (const [nom, yaw] of headings) {
        try {
          await bot.look(yaw, 0, true)
        } catch (_) {}
        await sleep(120)
        // Secteur : chaque cap ne voit que son cone (demi-angle PI/4 par
        // defaut). Sans bloc dans le cone, le cap rend « rien » — jamais le
        // plus proche global, qui rendait les 4 caps identiques.
        const block = findTargetBlock(undefined, { yaw }) ?? findTargetBlock(undefined, { yaw, anyHeight: true })
        vus.push(block ? `${nom} : ${block.name}` : `${nom} : rien`)
      }

      return { resultat: `tour d horizon -> ${vus.join(' | ')}` }
    },

    // Angle relatif : le planificateur n a pas a savoir ou est le sud. Le signe
    // suit /api/turn (yaw + angle), meme convention partout.
    async pivoter (scale, params = {}) {
      const bot = host.getBot()
      const angle = Number.isFinite(Number(params.angle)) ? Number(params.angle) : 90
      const yaw = bot.entity.yaw + (angle * Math.PI) / 180

      await bot.look(yaw, bot.entity.pitch, true)

      const degres = Math.round((yaw * 180) / Math.PI)
      const block = findTargetBlock()
      return {
        resultat: `pivot de ${Math.round(angle)} deg (cap ${degres} deg)` +
          (block ? `, ${block.name} en vue` : ', rien de cible en vue')
      }
    },

    // Memoire : le seul geste qui ne touche ni au jeu ni a la documentation. Le
    // budget est tenu par memory.js, pas par le modele — il propose, le code
    // dispose, comme partout ailleurs. L ecriture est async (la compaction du
    // fil de travail peut appeler le modele), donc attendue.
    async memoriser (scale, params = {}) {
      const result = await memory.write({
        texte: params.texte,
        portee: Array.isArray(params.portee) ? params.portee[0] : params.portee
      })

      if (!result.ok) {
        return { resultat: `memoire : ${result.error}`, echec: true }
      }

      // Le plafond affiche est celui de la portee ecrite, pas un total : les
      // deux portees ont des budgets separes depuis le passage en couches.
      const snap = result.snapshot ?? memory.snapshot()
      const plafond = result.portee === 'long_terme'
        ? snap.plafonds.long_terme
        : snap.plafonds.travail

      return {
        resultat: `note enregistree en memoire ${result.portee} ` +
          `(${result.jetons}/${plafond} jetons)` +
          (result.en_attente ? ', en attente du commit de fin de mission' : '') +
          (result.compacte ? ', fil de travail compacte' : '')
      }
    },

    async oublier (scale, params = {}) {
      const result = memory.clear(Array.isArray(params.portee) ? params.portee[0] : params.portee)
      if (!result.ok) return { resultat: `memoire : ${result.error}`, echec: true }

      return {
        resultat: result.portee === 'tout'
          ? 'memoire entierement effacee'
          : `memoire ${result.portee} effacee`
      }
    }
  }
}

module.exports = { createGestes, WAIT_MIN_MS, WAIT_MAX_MS, DIRE_COOLDOWN_MS }
