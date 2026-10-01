'use strict'

// Perception : ce que le bot peut savoir du monde sans y toucher. Fonctions
// pures sur `bot.blockAt` (ou un lecteur equivalent) : nature d un bloc, cases
// sous la hitbox, relief autour, portee d un pilier, postes au sol. Aucune
// n agit, n attend ni ne lit l etat d une mission : elles se testent sur un
// monde fictif et servent aussi au rejeu hors ligne d un instantane de banc.
//
// Extraites de mission.js (2026-10-01) : la meme mesure y existait en trois
// copies (avancer, piler, climbAccessHint) qui avaient diverge.

const Vec3 = require('vec3').Vec3
const build = require('./build')
const { blockInReach } = require('./navigation')

const REACH = 4
const PILER_MAX = Number(process.env.MISSION_PILER_MAX || 6)
// Plus haut casse depuis le sol, en blocs au-dessus des pieds.
const MAX_REACH_UP = Number(process.env.MISSION_MAX_REACH_UP || 3)

// Dirt de pilier : les blocs meubles du sol, cassables a la main et reposables
// sous les pieds. Meme motif que la matiere brute `terre`.
const PILER_DIRT = /^(dirt|coarse_dirt)$/

function scaffoldingStock (bot) {
  const totals = new Map()
  for (const item of bot?.inventory?.items?.() ?? []) {
    const plank = /_planks$/.test(item.name) && bot.registry?.blocksByName?.[item.name]?.boundingBox === 'block'
    if ((!PILER_DIRT.test(item.name) && !plank) || !Number.isFinite(item.count) || item.count <= 0) continue
    totals.set(item.name, (totals.get(item.name) ?? 0) + item.count)
  }
  const materiaux = [...totals].map(([nom, quantite]) => ({ nom, quantite }))
    .sort((a, b) => Number(PILER_DIRT.test(b.nom)) - Number(PILER_DIRT.test(a.nom)) || b.quantite - a.quantite || a.nom.localeCompare(b.nom))
  return { total: materiaux.reduce((sum, material) => sum + material.quantite, 0), materiaux }
}

// Sonde locale des 8 cases autour (N = -Z, S = +Z, E = +X, O = -X), a 1 bloc.
// Fonction pure (aucun acces au bot) : `lire(x, y, z)` rend un bloc
// `{ name, boundingBox }` ou null si le chunk n est pas charge. Chaque case est
// classee :
//   - `libre`    : sol praticable, tete degagee (une marche d 1 bloc compte
//                  comme libre : walkForward la franchit au saut auto) ;
//   - `obstacle` : mur ou relief >= 2 blocs (la tete est bouchee) ;
//   - `vide`     : trou (pas de sol) ou liquide (sol, pieds ou tete) ;
//   - `null`     : chunk non charge, inconnu.
// Jamais d exception : un lecteur manquant ou qui leve donne `null`.
const SONDE_DIRS = [
  ['N', 0, -1], ['NE', 1, -1], ['E', 1, 0], ['SE', 1, 1],
  ['S', 0, 1], ['SO', -1, 1], ['O', -1, 0], ['NO', -1, -1]
]

function estAir (nom) {
  return nom === 'air' || nom === 'cave_air' || nom === 'void_air'
}

function estLiquide (nom) {
  return typeof nom === 'string' && /water|lava|bubble_column/.test(nom)
}

// At least one face open to sight (leaves, plants, glass and liquids let it
// through). La face du dessous ne se voit que d en dessous : sous les pieds du
// bot, elle ne compte pas (vu sur craft/stone-pickaxe : dessous de la couche de
// pierre sous l arene, a l air libre, vise puis creuse vers le bas).
function blocExpose (bot, pos, feetLevel) {
  const see = p => {
    const b = bot.blockAt(p)
    return !b || b.boundingBox !== 'block' || /_leaves$|glass/.test(b.name)
  }
  return [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]
    .some(([x, y, z]) => !(y === -1 && pos.y < feetLevel) && see(pos.offset(x, y, z)))
}

// Columns under the bot's 0.6-wide hitbox at height y.
function colonnesSousHitbox (position, y) {
  const span = v => [...new Set([Math.floor(v - 0.3), Math.floor(v + 0.3 - 1e-6)])]
  return span(position.x).flatMap(x => span(position.z).map(z => new Vec3(x, y, z)))
}

function estSolide (bloc) {
  if (!bloc || !bloc.name) return false
  if (bloc.boundingBox === 'empty') return false
  if (bloc.boundingBox === 'block') return true
  if (estAir(bloc.name) || estLiquide(bloc.name)) return false
  return true
}

// Le bot peut-il sauter ? `entity.onGround` de mineflayer passe a FAUX quand le
// bot pousse dans un obstacle (mesure en jeu : contre une marche, onGround est
// faux alors que le bot est au sol et immobile). Le saut de denivele ne se
// declenchait donc jamais une fois bloque. On retombe sur le bloc solide sous
// les pieds, en excluant la montee (velocity.y > 0 = deja en l air). Meme regle
// que `standsOnGround` de build.js, pour ne pas diverger.
function peutSauter (bot) {
  try {
    if (bot.entity.onGround) return true
    const p = bot.entity.position
    const below = bot.blockAt(p.offset(0, -1, 0).floored())
    const vy = bot.entity.velocity?.y ?? 0
    return estSolide(below) && vy <= 0.02
  } catch (_) {
    return false
  }
}

// Fenetre de saut mesuree en jeu : un `forward`+`jump` lance a plus d un bloc
// du contact retombe avant la marche ; a 0,9 bloc ou moins, il passe. On sonde
// donc court (0,9 puis 0,6) pour ne declarer la marche que quand on est deja
// dans la fenetre. `sprint` etant plus tolerant (jusqu a ~1,9 bloc), il est
// tenu en plus pendant le saut.
const JUMP_LOOKAHEAD = [0.9, 0.6]

// Detecte ce qui barre le chemin DROIT DEVANT, a hauteur des pieds, dans la
// fenetre de saut. Rend :
//   - 'step' : marche d un bloc (bloc solide aux pieds, case au-dessus libre),
//              franchissable au saut preventif ;
//   - 'wall' : obstacle de deux blocs ou plus (la tete est bouchee), a
//              contourner, jamais a sauter droit ;
//   - null   : rien devant (ou chunk inconnu).
// La direction vient du regard (meme convention que choisirCoteContournement :
// vecteur avant = (-sin yaw, -cos yaw)). Aucune exception ne remonte.
function marcheDevant (bot) {
  try {
    if (!bot?.entity || typeof bot.blockAt !== 'function') return null
    const p = bot.entity.position
    const fx = -Math.sin(bot.entity.yaw)
    const fz = -Math.cos(bot.entity.yaw)
    for (const d of JUMP_LOOKAHEAD) {
      const pieds = bot.blockAt(p.offset(fx * d, 0, fz * d).floored())
      const tete = bot.blockAt(p.offset(fx * d, 1, fz * d).floored())
      if (!pieds || !tete) continue
      if (!estSolide(pieds)) continue
      return estSolide(tete) ? 'wall' : 'step'
    }
    return null
  } catch (_) {
    return null
  }
}

// Vide devant le bot (~0,8 bloc sur son cap) : chute seche de plus de deux
// blocs, donc des degats (vu sur trees/bent, 0e5dee5 : `avancer` sans cible
// depuis un pilier de 4, chute de 4). Rend la hauteur de chute, ou null si le
// sol devant est a deux blocs au plus (marche, descente d un ou deux blocs).
const CHUTE_MAX = 2
// `dir` : direction horizontale {x, z} du mouvement (defaut : le cap du bot).
function videDevant (bot, dir = null) {
  try {
    if (!bot?.entity || typeof bot.blockAt !== 'function' || !bot.entity.onGround) return null
    const p = bot.entity.position
    const n = dir ? Math.hypot(dir.x, dir.z) : 0
    const devant = dir && n > 1e-6
      ? p.offset(dir.x / n * 0.8, 0, dir.z / n * 0.8)
      : p.offset(-Math.sin(bot.entity.yaw) * 0.8, 0, -Math.cos(bot.entity.yaw) * 0.8)
    const pieds = bot.blockAt(devant.floored())
    if (!pieds || estSolide(pieds)) return null
    for (let d = 1; d <= CHUTE_MAX + 1; d += 1) {
      const b = bot.blockAt(devant.offset(0, -d, 0).floored())
      if (!b) return null
      if (estSolide(b) || /water|lava/.test(b.name)) return d - 1 > CHUTE_MAX ? d - 1 : null
    }
    return CHUTE_MAX + 1
  } catch (_) {
    return null
  }
}

function sondeAlentours (lire, baseX, piedsY, baseZ) {
  const relief = {}
  try {
    if (typeof lire !== 'function' || !Number.isFinite(baseX) || !Number.isFinite(piedsY) || !Number.isFinite(baseZ)) {
      return null
    }
    for (const [nom, dx, dz] of SONDE_DIRS) {
      let sol = null
      let pieds = null
      let tete = null
      try {
        sol = lire(baseX + dx, piedsY - 1, baseZ + dz)
        pieds = lire(baseX + dx, piedsY, baseZ + dz)
        tete = lire(baseX + dx, piedsY + 1, baseZ + dz)
      } catch (_) {
        relief[nom] = null
        continue
      }
      if (!sol || !pieds || !tete) {
        relief[nom] = null
        continue
      }
      if (estLiquide(sol.name) || estLiquide(pieds.name) || estLiquide(tete.name)) {
        relief[nom] = 'vide'
      } else if (!estSolide(sol)) {
        relief[nom] = 'vide'
      } else if (estSolide(tete)) {
        relief[nom] = 'obstacle'
      } else {
        relief[nom] = 'libre'
      }
    }
    return relief
  } catch (_) {
    return null
  }
}

// Cap cardinal (8 vents, 0 deg = nord) pour un vecteur (dx, dz) en blocs.
// Convention Minecraft : nord = -Z, sud = +Z, est = +X, ouest = -X.
function capDepuisVecteur (dx, dz) {
  const deg = (Math.atan2(dx, -dz) * 180) / Math.PI
  const norm = ((deg + 360) % 360 + 360) % 360
  const caps = ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ouest', 'ouest', 'nord-ouest']
  return caps[Math.round(norm / 45) % 8]
}

// Traduit un cap lisible (`capDepuisVecteur`) en cle de la sonde 8 cases
// (SONDE_DIRS) : le relief local est indexe N, NE, E, SE, S, SO, O, NO.
const CASE_PAR_CAP = {
  nord: 'N',
  'nord-est': 'NE',
  est: 'E',
  'sud-est': 'SE',
  sud: 'S',
  'sud-ouest': 'SO',
  ouest: 'O',
  'nord-ouest': 'NO'
}

// Decides ou strafer pour contourner un obstacle, a partir du regard et du
// relief local. FONCTION PURE : ni acces au bot, ni horloge, ni etat global.
//
// Entrees :
//   - `yaw`    : orientation du bot en radians (bot.entity.yaw ; 0 = nord,
//                +90 deg = ouest, comme `capDepuisVecteur`) ;
//   - `cible`  : vecteur horizontal { dx, dz } du bot vers la cible, ou null ;
//   - `relief` : les 8 cases de `sondeAlentours` ('libre' | 'obstacle' |
//                'vide' | null), ou null si indisponible.
// Sortie : 'left' | 'right' | null. `null` = pas de choix fonde (relief
// illisible, aucun cote libre, ou les deux libres a egalite) : l appelant
// garde alors son alternance de repli.
//
// Le cote gauche/droite, relatif au regard, est traduit en case cardinale via
// le yaw, puis lu dans le relief. Vecteur avant du bot : (-sin yaw, -cos yaw).
// Lateral gauche = (-cos yaw, sin yaw), lateral droit = son oppose.
function choisirCoteContournement (yaw, cible, relief) {
  try {
    if (!relief || typeof relief !== 'object' || !Number.isFinite(yaw)) return null

    const fx = -Math.sin(yaw)
    const fz = -Math.cos(yaw)
    const gauche = { x: fz, z: -fx }
    const droite = { x: -fz, z: fx }

    const libreGauche = relief[CASE_PAR_CAP[capDepuisVecteur(gauche.x, gauche.z)]] === 'libre'
    const libreDroite = relief[CASE_PAR_CAP[capDepuisVecteur(droite.x, droite.z)]] === 'libre'

    if (!libreGauche && !libreDroite) return null
    if (libreGauche && !libreDroite) return 'left'
    if (libreDroite && !libreGauche) return 'right'

    // Les deux cotes sont libres : celui qui rapproche de la cible. Le bot
    // etant souvent deja pivote vers elle, les deux projections sont egales
    // (produit scalaire nul) : on rend null pour laisser l alternance jouer.
    if (cible && Number.isFinite(cible.dx) && Number.isFinite(cible.dz) &&
        (cible.dx !== 0 || cible.dz !== 0)) {
      const versGauche = gauche.x * cible.dx + gauche.z * cible.dz
      const versDroite = droite.x * cible.dx + droite.z * cible.dz
      if (versGauche > versDroite) return 'left'
      if (versDroite > versGauche) return 'right'
    }
    return null
  } catch (_) {
    return null
  }
}


function dansEmprise (emprise, position) {
  return Boolean(emprise) && position.x >= emprise.x0 && position.x <= emprise.x1 &&
    position.z >= emprise.z0 && position.z <= emprise.z1
}

// Lowest pillar height (from `depuis` to PILER_MAX) that puts `centre` in
// reach from feet `pose` anchored on row `piedY`, measured like piler would
// climb: real cells the head crosses in every column under the hitbox
// (solid or liquid stops the climb, leaves are cleared), the pillar's own
// blocks standing, real sight line. Returns { hauteur } or the obstacle.
function hauteurDePilier (bot, pose, piedY, centre, depuis, { pilerMax = PILER_MAX, reach = REACH } = {}) {
  const colonnes = colonnesSousHitbox(pose, piedY)
  const sousHitbox = p => colonnes.some(c => c.x === p.x && c.z === p.z)
  const ax = Math.floor(pose.x)
  const az = Math.floor(pose.z)
  for (let h = depuis; h <= pilerMax; h += 1) {
    if (h >= 1) {
      const tete = colonnes.map(c => bot.blockAt(c.offset(0, h + 1, 0)))
        .find(b => !b || estLiquide(b.name) || (estSolide(b) && !/_leaves$/.test(b.name)))
      if (tete !== undefined) return { obstacle: tete?.name ?? 'bloc inconnu', niveau: h + 1 }
    }
    const vue = { entity: bot.entity,
      blockAt: p => {
        if (p.x === ax && p.z === az && p.y >= piedY && p.y < piedY + h) {
          return { name: 'dirt', position: p, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
        }
        const reel = bot.blockAt(p)
        return reel && /_leaves$/.test(reel.name) && sousHitbox(p) && p.y > piedY && p.y <= piedY + h + 1
          ? { name: 'air', position: p, boundingBox: 'empty', shapes: [] } : reel
      } }
    // Measured from the anchor (floored feet, whole cell), the one piler
    // really builds on: a fractional y (landing tolerated at +0.25, standing
    // on a leaf) put the virtual post one cell too high, its floor on air,
    // and the check said « aucune hauteur » from a post where piler works
    // (banc composite 755b262, cabane 45 min).
    if (blockInReach(vue, new Vec3(pose.x, piedY + h, pose.z), centre, reach)) return { hauteur: h }
  }
  return {}
}

// Ground posts around a high target from which a pillar of 1..PILER_MAX
// reaches it, lowest climb first then nearest. Real chunks only: a standable
// cell (two free, solid floor that is not part of a tree), outside the
// chantier footprint, not the bot's current cell, not already tried for this
// target. The code finds the post; the planner is no longer asked to.
function postesDePilier (bot, cible, centre, essayes, { emprise = null, pilerMax = PILER_MAX, reach = REACH } = {}) {
  const here = bot.entity.position
  const courant = here.floored()
  const postes = []
  for (let dx = -reach; dx <= reach; dx += 1) {
    for (let dz = -reach; dz <= reach; dz += 1) {
      if ((dx === 0 && dz === 0) || Math.hypot(dx, dz) > reach) continue
      const x = cible.x + dx
      const z = cible.z + dz
      // The topmost floor below the target in this column.
      for (let y = cible.y - 1; y >= cible.y - pilerMax - reach; y -= 1) {
        const sol = bot.blockAt(new Vec3(x, y - 1, z))
        if (!build.standable(bot, x, y, z)) {
          if (sol === null) break
          continue
        }
        // On the crown: the ground may lie further down, under the leaves.
        if (/_(leaves|log|stem|wood|hyphae)$/.test(sol?.name ?? '')) continue
        const cle = `${x},${y},${z}`
        if (essayes.has(cle) || (x === courant.x && z === courant.z) || dansEmprise(emprise, { x, z })) break
        const pose = new Vec3(x + 0.5, y, z + 0.5)
        const mesure = hauteurDePilier(bot, pose, y, centre, 1, { pilerMax, reach })
        if (mesure.hauteur !== undefined) {
          postes.push({ cle, pose, hauteur: mesure.hauteur, distance: here.distanceTo(pose) })
        }
        break
      }
    }
  }
  return postes.sort((a, b) => a.hauteur - b.hauteur || a.distance - b.distance)
}

// Instantane d une region autour d un point : palette des noms de blocs et
// suite compacte (valeur, repetitions) dans l ordre y, z, x. Pris au moment
// d un blocage, il permet de rejouer hors ligne la perception sur le monde
// reel du banc (tmp/replay-snapshot.js) sans relancer 45 minutes de scenario.
// Une case non chargee vaut null.
function instantane (bot, centre, { rayon = 10, bas = 6, haut = 12 } = {}) {
  const c = new Vec3(Math.floor(centre.x), Math.floor(centre.y), Math.floor(centre.z))
  const origine = { x: c.x - rayon, y: c.y - bas, z: c.z - rayon }
  const taille = { x: 2 * rayon + 1, y: bas + haut + 1, z: 2 * rayon + 1 }
  const palette = []
  const index = new Map()
  const rle = []
  for (let y = 0; y < taille.y; y++) {
    for (let z = 0; z < taille.z; z++) {
      for (let x = 0; x < taille.x; x++) {
        let nom = null
        try { nom = bot.blockAt(new Vec3(origine.x + x, origine.y + y, origine.z + z))?.name ?? null } catch (_) {}
        if (!index.has(nom)) { index.set(nom, palette.length); palette.push(nom) }
        const v = index.get(nom)
        const dernier = rle[rle.length - 1]
        if (dernier && dernier[0] === v) dernier[1] += 1
        else rle.push([v, 1])
      }
    }
  }
  return { origine, taille, palette, rle }
}

// Lecture d un instantane : la table des noms par case, hors region = null.
function lireInstantane (snap) {
  const noms = new Map()
  let i = 0
  const { origine, taille } = snap
  for (const [v, n] of snap.rle) {
    for (let k = 0; k < n; k++, i++) {
      const nom = snap.palette[v]
      if (nom === null) continue
      const x = i % taille.x
      const z = Math.floor(i / taille.x) % taille.z
      const y = Math.floor(i / (taille.x * taille.z))
      noms.set(`${origine.x + x},${origine.y + y},${origine.z + z}`, nom)
    }
  }
  return noms
}

module.exports = {
  REACH, PILER_MAX, MAX_REACH_UP, PILER_DIRT, scaffoldingStock,
  SONDE_DIRS, estAir, estLiquide, estSolide, blocExpose, colonnesSousHitbox, peutSauter,
  JUMP_LOOKAHEAD, marcheDevant, CHUTE_MAX, videDevant, sondeAlentours, capDepuisVecteur, CASE_PAR_CAP,
  choisirCoteContournement, dansEmprise, hauteurDePilier, postesDePilier, instantane, lireInstantane
}
