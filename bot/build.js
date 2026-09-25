'use strict'

// Construction : geometrie et pose de blocs.
//
// Ce module ne parle jamais a Jev. Le modele classe (« c est une construction,
// en terre, a cote d un arbre, avec une porte ») ; tout ce qui est chiffre —
// dimensions, emplacement, ordre de pose — est calcule ici.
//
// Trois contraintes dictent la forme du code :
//
//   1. `bot.placeBlock` exige un bloc **deja solide** comme appui, et une face
//      libre. D ou l ordre de pose du bas vers le haut, et le tri en anneaux
//      pour la derniere couche, dont l interieur n a rien en dessous.
//   2. Aucun passage en creative : la main se remplit depuis l inventaire reel
//      (voir equipMaterial). Un chantier en survie peut donc manquer de
//      materiau — c est voulu, c est ce qui fait choisir « casser » ou
//      « fabriquer » au planificateur plutot qu une pose gratuite.
//   3. Le placement se fait depuis un **poste de tir au sol**, rejoint en
//      gestes unitaires (findVantage puis moveTo : pivoter + forward + jump par
//      paliers, memes regles que Fix 1, sans pathfinder). `creative.flyTo` ne
//      rend jamais la main, un /tp n est plus possible (aucun pouvoir d admin),
//      et `pathfinder.goto` est sorti des missions.

const Vec3 = require('vec3').Vec3

// Bornes de bon sens : un « 40 par 40 » demande par erreur ne doit pas lancer
// un chantier de 9000 blocs.
const MIN_SIZE = 3
const MAX_SIZE = 9
const DEFAULT_SIZE = 5

// Portee serveur : 4,5 blocs de l oeil au centre de la case. On garde une marge.
const PLACE_REACH = 4.2
const SITE_MIN_DISTANCE = 3
const SITE_MAX_DISTANCE = 12
// Delai d un trajet vers un poste de tir en gestes unitaires. Marcher prend du
// temps (Fix 3 : plus aucun pathfinder en mission, meme pour rallier un poste).
const MOVE_TIMEOUT_MS = Number(process.env.BUILD_MOVE_TIMEOUT_MS || 12000)
// Reglages du pas de marche : les memes que la primitive walkForward de
// mission.js (Fix 1). Meme vitesse au sol (~1 s par bloc + marge de saut),
// meme fenetre sans progres avant de sauter, meme echec sur obstacle de deux
// blocs ou plus.
const WALK_TICK_MS = 100
const STUCK_CHECK_STEP = 0.3
const STEP_MS_PER_BLOCK = 1100
const WALK_EXTRA_MS = 4000
// Saut de denivele : memes reglages que walkForward (mission.js) pour ne pas
// diverger. On declenche tot, puis on re-essaie en relachant/rappuyant `jump`.
const JUMP_FIRST_MS = Number(process.env.MISSION_JUMP_FIRST_MS || 600)
const JUMP_RETRY_MS = Number(process.env.MISSION_JUMP_RETRY_MS || 700)
const JUMP_MAX_ATTEMPTS = Number(process.env.MISSION_JUMP_MAX_ATTEMPTS || 3)
// Fenetre de saut mesuree en jeu (voir marcheDevant) : on ne declare la marche
// d un bloc que lorsque le contact est a ~0,9 bloc ou moins.
const JUMP_LOOKAHEAD = [0.9, 0.6]
// On est « arrive » a moins d un bloc HORIZONTALEMENT du poste : l altitude ne
// compte pas, sinon chaque denivele fausse l arrivee (Fix 1).
const ARRIVE_XZ = 0.8
// Contournement d obstacle (Fix 1) : un pas de cote + avant + saut, puis on
// re-pivote vers le poste. Au-dela de 3 contournements, le poste est declare
// injoignable : un geste rate replanifie, pas indetermine.
const STRAFE_MS = 1000
const MAX_STRAFES = 3

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function horizontalDistance (a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

function isLiquidName (name) {
  return name === 'water' || name === 'flowing_water' || name === 'lava' ||
    name === 'flowing_lava' || name === 'bubble_column'
}

function standsInLiquid (bot) {
  try {
    const pos = bot.entity.position
    return isLiquidName(bot.blockAt(pos)?.name) || isLiquidName(bot.blockAt(pos.offset(0, 1, 0))?.name)
  } catch (_) {
    return false
  }
}

// Le bot peut-il sauter ? `entity.onGround` de mineflayer passe a FAUX quand le
// bot pousse dans un obstacle (mesure en jeu : contre une marche, onGround est
// faux alors que le bot est au sol). Le saut de denivele ne se declenchait donc
// jamais une fois bloque. On retombe sur le bloc solide sous les pieds, en
// excluant la montee (velocity.y > 0 = deja en l air). Meme regle que
// `peutSauter` de mission.js, pour ne pas diverger.
function standsOnGround (bot) {
  try {
    if (bot.entity.onGround) return true
    const p = bot.entity.position
    const below = bot.blockAt(p.offset(0, -1, 0).floored())
    const vy = bot.entity.velocity?.y ?? 0
    return isSolid(below) && vy <= 0.02
  } catch (_) {
    return false
  }
}

// Detecte ce qui barre le chemin DROIT DEVANT, a hauteur des pieds, dans la
// fenetre de saut (Fix 1) : 'step' = marche d un bloc a sauter preventivement,
// 'wall' = obstacle de deux blocs ou plus a contourner, null = rien. Meme regle
// et meme convention de regard que `marcheDevant` de mission.js, pour ne pas
// diverger. Sert a sauter AVANT le contact : une fois contre le mur, `onGround`
// passe a faux et le saut ne repart plus.
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
      if (!isSolid(pieds)) continue
      return isSolid(tete) ? 'wall' : 'step'
    }
    return null
  } catch (_) {
    return null
  }
}

// Ce qu on peut recouvrir sans hesiter en posant un bloc.
const REPLACEABLE = new Set([
  'air', 'cave_air', 'void_air', 'short_grass', 'tall_grass', 'fern',
  'large_fern', 'snow', 'dead_bush', 'seagrass', 'vine', 'dandelion', 'poppy'
])

const FACES = [
  new Vec3(0, -1, 0), // appui du dessous : le cas normal, on construit vers le haut
  new Vec3(1, 0, 0),
  new Vec3(-1, 0, 0),
  new Vec3(0, 0, 1),
  new Vec3(0, 0, -1),
  new Vec3(0, 1, 0)
]

// ---------------------------------------------------------------------------
// Lecture des dimensions dans la phrase du joueur
// ---------------------------------------------------------------------------

function clamp (value) {
  if (!Number.isFinite(value)) return DEFAULT_SIZE
  return Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(value)))
}

// « 5 par 5 par 5 », « 5x5x5 », « 6 sur 4 », « de 5 blocs ». Jev ne sait pas
// extraire de nombres, et ce n est pas son role : une expression reguliere est
// exacte et gratuite.
function parseDimensions (text) {
  const clean = String(text || '').toLowerCase().replace(/,/g, ' ')
  const sep = '\\s*(?:par|sur|x|\\*)\\s*'

  const three = clean.match(new RegExp(`(\\d+)${sep}(\\d+)${sep}(\\d+)`))
  if (three) {
    return {
      width: clamp(Number(three[1])),
      height: clamp(Number(three[3])),
      depth: clamp(Number(three[2])),
      source: 'trois dimensions lues'
    }
  }

  const two = clean.match(new RegExp(`(\\d+)${sep}(\\d+)`))
  if (two) {
    return {
      width: clamp(Number(two[1])),
      depth: clamp(Number(two[2])),
      height: DEFAULT_SIZE,
      source: 'deux dimensions lues, hauteur par defaut'
    }
  }

  const one = clean.match(/(\d+)\s*blocs?/)
  if (one) {
    const size = clamp(Number(one[1]))
    return { width: size, depth: size, height: size, source: 'une dimension lue, cube' }
  }

  return { width: DEFAULT_SIZE, depth: DEFAULT_SIZE, height: DEFAULT_SIZE, source: 'aucune dimension lue' }
}

// Nombres en toutes lettres utilises pour une quantite de recolte. On exclut
// `un`/`une` : ce sont des articles (« un arbre », « une maison ») bien plus
// souvent qu un compte.
const QUOTA_WORDS = {
  deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9,
  dix: 10, quinze: 15, vingt: 20, trente: 30, cinquante: 50, cent: 100
}

// La quantite visee, lue dans la phrase (« mine dix charbons », « coupe 3
// arbres »). On retire d abord les dimensions, sinon « de 5 par 5 » passerait
// pour un quota. Le modele ne compte pas : c est le code qui lit le nombre.
function parseQuota (text, { allowBlockUnits = false } = {}) {
  const original = String(text || '')
    .toLowerCase()
    .replace(/\d+\s*(?:par|sur|x|\*)\s*\d+(?:\s*(?:par|sur|x|\*)\s*\d+)?/g, ' ')
  if (allowBlockUnits) {
    const words = { un: 1, une: 1, ...QUOTA_WORDS }
    const count = original.match(new RegExp(`\\b(\\d{1,3}|${Object.keys(words).join('|')})\\s+blocs?\\b`))
    if (count) {
      const value = words[count[1]] ?? Number(count[1])
      if (value >= 1 && value <= 999) return value
    }
  }
  const clean = original.replace(/\d+\s*blocs?/g, ' ')

  const digit = clean.match(/\b(\d{1,3})\b/)
  if (digit) {
    const value = Number(digit[1])
    if (value >= 1 && value <= 999) return value
  }

  for (const [word, value] of Object.entries(QUOTA_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(clean)) return value
  }

  return null
}

// ---------------------------------------------------------------------------
// Plan de la maison
// ---------------------------------------------------------------------------

// Distance d une case au bord de sa couche. Sert a poser les couches sans appui
// dessous (le toit) en spirale depuis le bord vers le centre : chaque bloc
// interieur a alors deja un voisin pose.
function ringIndex (dx, dz, width, depth) {
  return Math.min(dx, width - 1 - dx, dz, depth - 1 - dz)
}

// Boite creuse : sol plein, quatre murs, toit plein, et une ouverture de deux
// blocs de haut pour la porte, au milieu du mur z-.
function planHouse ({ origin, width, depth, height }) {
  const doorX = origin.x + Math.floor(width / 2)
  const doorZ = origin.z
  const opening = [
    { x: doorX, y: origin.y + 1, z: doorZ },
    { x: doorX, y: origin.y + 2, z: doorZ }
  ]

  const isOpening = (x, y, z) => opening.some(o => o.x === x && o.y === y && o.z === z)

  const blocks = []

  for (let dy = 0; dy < height; dy += 1) {
    const layer = []

    for (let dx = 0; dx < width; dx += 1) {
      for (let dz = 0; dz < depth; dz += 1) {
        const onWall = dx === 0 || dx === width - 1 || dz === 0 || dz === depth - 1
        const isFloor = dy === 0
        const isRoof = dy === height - 1
        if (!onWall && !isFloor && !isRoof) continue

        const x = origin.x + dx
        const y = origin.y + dy
        const z = origin.z + dz
        if (isOpening(x, y, z)) continue

        layer.push({
          position: new Vec3(x, y, z),
          role: isFloor ? 'sol' : isRoof ? 'toit' : 'mur',
          ring: ringIndex(dx, dz, width, depth)
        })
      }
    }

    // Du bord vers le centre : indispensable pour le toit, inoffensif ailleurs.
    layer.sort((a, b) => a.ring - b.ring)
    blocks.push(...layer)
  }

  return {
    origin,
    width,
    depth,
    height,
    blocks,
    // La porte occupe les deux cases laissees libres ; on ne pose que la case
    // du bas, le jeu ajoute la moitie haute.
    door: { position: new Vec3(doorX, origin.y + 1, doorZ) },
    // D ou regarder la porte pour qu elle s ouvre vers l exterieur.
    doorApproach: new Vec3(doorX + 0.5, origin.y, doorZ - 1.5)
  }
}

// ---------------------------------------------------------------------------
// Choix du terrain
// ---------------------------------------------------------------------------

function isSolid (block) {
  return Boolean(block && block.boundingBox === 'block')
}

function isFree (block) {
  if (!block) return false
  return block.boundingBox === 'empty' || REPLACEABLE.has(block.name)
}

// Niveau du sol en (x, z) : le premier espace libre au-dessus du dernier bloc
// solide, cherche autour de `yHint`.
function groundLevel (bot, x, z, yHint) {
  for (let y = yHint + 4; y >= yHint - 6; y -= 1) {
    const here = bot.blockAt(new Vec3(x, y, z))
    const below = bot.blockAt(new Vec3(x, y - 1, z))
    if (isFree(here) && isSolid(below)) return y
  }
  return null
}

// Un emplacement convient s il est plat, libre sur toute la hauteur, et si
// aucun tronc ne le traverse : on veut la maison **a cote** de l arbre.
function siteFits (bot, origin, width, depth, height) {
  for (let dx = 0; dx < width; dx += 1) {
    for (let dz = 0; dz < depth; dz += 1) {
      const x = origin.x + dx
      const z = origin.z + dz

      const level = groundLevel(bot, x, z, origin.y)
      if (level !== origin.y) return false

      for (let dy = 0; dy < height; dy += 1) {
        if (!isFree(bot.blockAt(new Vec3(x, origin.y + dy, z)))) return false
      }
    }
  }
  return true
}

// Cherche un terrain autour du repere, du plus proche au plus eloigne.
function findSite (bot, { near, width, depth, height }) {
  const base = groundLevel(bot, Math.floor(near.x), Math.floor(near.z), Math.floor(near.y)) ??
    Math.floor(near.y)

  for (let radius = SITE_MIN_DISTANCE; radius <= SITE_MAX_DISTANCE; radius += 1) {
    for (let angle = 0; angle < 16; angle += 1) {
      const theta = (angle / 16) * Math.PI * 2
      const cx = Math.floor(near.x + Math.cos(theta) * radius)
      const cz = Math.floor(near.z + Math.sin(theta) * radius)

      // (cx, cz) est le coin, pas le centre : la maison s ecarte ainsi du tronc.
      const level = groundLevel(bot, cx, cz, base)
      if (level === null) continue

      const candidate = new Vec3(cx, level, cz)
      if (siteFits(bot, candidate, width, depth, height)) {
        return { origin: candidate, distance: radius }
      }
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Pose
//
// Le serveur refuse de poser un bloc dans le corps d un joueur, et le message
// renvoye par mineflayer ne dit que « the block is still air » : rien n indique
// la cause. C est ce qui bloquait tout le chantier, le bot se tenant pile dans
// la case du sol qu il essayait de remplir.
//
// On ne cherche donc plus a « aller vers » la case, mais un **poste de tir** :
// une position au sol, a portee de la case, et dont le corps du bot ne la
// recouvre pas. Meme principe que la demo TypeSafe/Minecraft d ellistev, qui
// valide visibilite et recouvrement avant chaque pose.
//
// Voler serait une autre facon de degager le corps, mais `creative.startFlying`
// ne fait que mettre la gravite a zero cote client : apres un /tp le bot etait
// retombe dans la case avant la pose. Rester au sol est plus sur, et un poste
// au sol suffit pour toute la boite : les cases du toit se posent depuis
// l interieur, debout sur le plancher deja pose.
// ---------------------------------------------------------------------------

function findSupport (bot, target) {
  for (const face of FACES) {
    const reference = bot.blockAt(target.plus(face))
    if (isSolid(reference)) {
      // faceVector pointe de l appui vers la case a remplir.
      return { reference, faceVector: face.scaled(-1) }
    }
  }
  return null
}

// Le corps du bot (0,6 de large, 1,8 de haut, pieds a `stand`) recouvre-t-il la
// case ?
function bodyOverlaps (stand, target) {
  const horizontal =
    Math.abs(stand.x - (target.x + 0.5)) < 0.95 &&
    Math.abs(stand.z - (target.z + 0.5)) < 0.95

  return horizontal && stand.y < target.y + 1 && stand.y + 1.8 > target.y
}

// Peut-on tenir debout en (x, y, z) ? Deux cases libres, une case solide dessous.
function standable (bot, x, y, z) {
  return isFree(bot.blockAt(new Vec3(x, y, z))) &&
    isFree(bot.blockAt(new Vec3(x, y + 1, z))) &&
    isSolid(bot.blockAt(new Vec3(x, y - 1, z)))
}

// Anneaux de rayon 1 a 3 autour de la case, du plus proche au plus eloigne.
const VANTAGE_OFFSETS = (() => {
  const offsets = []
  for (let radius = 1; radius <= 3; radius += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue
        offsets.push([dx, dz])
      }
    }
  }
  return offsets
})()

// Le meilleur poste de tir pour cette case, ou null s il n y en a aucun.
function findVantage (bot, target) {
  const center = target.offset(0.5, 0.5, 0.5)
  let best = null

  for (const [dx, dz] of VANTAGE_OFFSETS) {
    const x = target.x + dx
    const z = target.z + dz

    // Le sol utile peut etre celui de la case, celui d en dessous (on pose le
    // plancher depuis l exterieur) ou plus bas encore ; et celui d au-dessus,
    // pour poser le toit depuis l interieur, debout sur le plancher.
    for (let dy = 1; dy >= -4; dy -= 1) {
      const y = target.y + dy
      if (!standable(bot, x, y, z)) continue

      const stand = new Vec3(x + 0.5, y, z + 0.5)
      if (bodyOverlaps(stand, target)) continue

      const distance = stand.offset(0, 1.62, 0).distanceTo(center)
      if (distance > PLACE_REACH) continue

      if (!best || distance < best.distance) best = { stand, distance }
    }
  }

  return best
}

// Rejoint un poste de tir **en gestes unitaires, sans pathfinder** (Fix 3).
// Decision structurante : deplacement 100 % en gestes pilotés, pathfinder sorti
// des missions. On pivote vers le poste (yaw) puis on avance par paliers en
// tenant `forward`, avec `jump` sur denivele d un bloc — les memes regles que
// la primitive walkForward de mission.js (Fix 1). Un obstacle de deux blocs ou
// plus declenche un contournement lateral (strafe + forward + jump, ~1 s) puis
// un re-pivot, jusqu a MAX_STRAFES. Au-dela, ou au bout de MOVE_TIMEOUT_MS,
// echec explicite : le poste est injoignable.
//
// C etait d abord un `/tp` (bot operateur), puis un `pathfinder.goto` : les
// deux sont interdits (plus aucun pouvoir d admin, pathfinder casse au-dela de
// quelques blocs). Une pose coute donc le temps d un trajet, et un poste
// geometriquement valide peut etre injoignable : c est le prix d un bot qui
// joue au jeu.
async function walkStep (bot, distance, deadline) {
  const start = bot.entity.position.clone()
  const stepDeadline = Math.min(deadline, Date.now() + distance * STEP_MS_PER_BLOCK + WALK_EXTRA_MS)
  let lastAnchor = start.clone()
  let lastProgressAt = Date.now()
  let jumpAttempts = 0

  bot.setControlState('forward', true)
  let sautPreventif = false
  try {
    while (true) {
      if (!bot?.entity) return { moved: 0, blocked: true }
      const here = bot.entity.position
      const moved = horizontalDistance(start, here)
      if (moved >= distance) return { moved: Number(moved.toFixed(2)), blocked: false }
      if (Date.now() > stepDeadline || Date.now() > deadline) {
        return { moved: Number(moved.toFixed(2)), blocked: moved < 0.5 }
      }

      // Saut PREVENTIF (Fix 1) : franchir la marche d un bloc AVANT le contact,
      // meme regle que walkForward (mission.js). Colle au mur, onGround est faux
      // et le saut apres blocage ne part jamais. 'wall' n est pas saute.
      const devant = marcheDevant(bot)
      if (devant === 'step' && !standsInLiquid(bot)) {
        if (!sautPreventif) {
          try { bot.setControlState('jump', true) } catch (_) {}
          try { bot.setControlState('sprint', true) } catch (_) {}
          sautPreventif = true
        }
      } else if (sautPreventif) {
        try { bot.setControlState('jump', false) } catch (_) {}
        try { bot.setControlState('sprint', false) } catch (_) {}
        sautPreventif = false
      }

      const progress = horizontalDistance(lastAnchor, here)
      if (progress >= STUCK_CHECK_STEP) {
        lastAnchor = here.clone()
        lastProgressAt = Date.now()
        jumpAttempts = 0
      } else {
        const fenetre = jumpAttempts === 0 ? JUMP_FIRST_MS : JUMP_RETRY_MS
        if (Date.now() - lastProgressAt >= fenetre) {
          // Meme regle que walkForward (mission.js) : on saute un denivele d un
          // bloc au sol, jamais dans un liquide (le bot ne sait pas nager), et
          // on re-essaie en relachant/rappuyant `jump`. Plusieurs sauts sans
          // progres signent un obstacle de deux blocs ou plus.
          if (standsInLiquid(bot)) {
            return { moved: Number(moved.toFixed(2)), blocked: true }
          }
          if (standsOnGround(bot)) {
            if (jumpAttempts >= JUMP_MAX_ATTEMPTS) {
              return { moved: Number(moved.toFixed(2)), blocked: true }
            }
            // Saut FRAIS avec relache de `forward` (parite walkForward,
            // mission.js) : pousse contre un mur, `forward` tenu garde
            // `onGround` faux et la physique ignore le saut — le trajet vers
            // le poste restait colle a 0.0 bloc jusqu au delai (« pose trop
            // longue » mesure en jeu a 2 blocs du chantier).
            try { bot.setControlState('forward', false) } catch (_) {}
            try { bot.setControlState('jump', false) } catch (_) {}
            await sleep(120)
            try { bot.setControlState('jump', true) } catch (_) {}
            await sleep(250)
            // `sprint` avec le saut (parite walkForward) : franchir la levre
            // avec de l elan, tenu jusqu a la fin du trajet.
            try { bot.setControlState('forward', true) } catch (_) {}
            try { bot.setControlState('sprint', true) } catch (_) {}
            jumpAttempts += 1
            lastProgressAt = Date.now()
          } else {
            // En l air (saut en cours, chute) : on patiente.
            lastProgressAt = Date.now()
          }
        }
      }
      await sleep(WALK_TICK_MS)
    }
  } finally {
    try { bot.setControlState('forward', false) } catch (_) {}
    try { bot.setControlState('jump', false) } catch (_) {}
    try { bot.setControlState('sprint', false) } catch (_) {}
  }
}

async function moveTo (bot, destination) {
  if (!bot?.entity) throw new Error('poste de tir injoignable a pied : bot non connecte')
  if (horizontalDistance(bot.entity.position, destination) < ARRIVE_XZ) return true

  const deadline = Date.now() + MOVE_TIMEOUT_MS
  let strafes = 0

  while (true) {
    if (!bot?.entity) throw new Error('poste de tir injoignable a pied : bot deconnecte en route')
    if (Date.now() > deadline) {
      throw new Error(`poste de tir injoignable a pied : trajet trop long (${MOVE_TIMEOUT_MS} ms)`)
    }
    const here = bot.entity.position
    const dist = horizontalDistance(here, destination)
    if (dist < ARRIVE_XZ) return true

    // Pivote vers le poste (meme convention que mission.js : yaw 0 = nord).
    const dx = destination.x - here.x
    const dz = destination.z - here.z
    const wantedYaw = Math.atan2(-dx, -dz)
    try {
      await bot.look(wantedYaw, 0, true)
    } catch (_) {}

    // Avance par palier de 10 blocs au plus, puis re-pivote : un long trajet
    // sans re-viser derive, comme en mission.
    const step = await walkStep(bot, Math.min(dist, 10), deadline)
    const now = bot.entity?.position
    if (!now) throw new Error('poste de tir injoignable a pied : bot deconnecte en route')
    if (horizontalDistance(now, destination) < ARRIVE_XZ) return true

    if (step.blocked) {
      // Contournement Fix 1 : pas de cote + avant + saut, puis re-pivot au tour
      // suivant. Au-dela de MAX_STRAFES, on echoue proprement pour que
      // `construire` passe au bloc suivant puis replanifie (max 3).
      if (strafes >= MAX_STRAFES) {
        throw new Error(`poste de tir injoignable a pied : bloque apres ${step.moved.toFixed(1)} bloc(s), obstacle infranchissable`)
      }
      strafes += 1
      const side = strafes % 2 === 1 ? 'left' : 'right'
      try {
        bot.setControlState(side, true)
        bot.setControlState('forward', true)
        bot.setControlState('jump', true)
        await sleep(STRAFE_MS)
      } finally {
        try { bot.setControlState(side, false) } catch (_) {}
        try { bot.setControlState('forward', false) } catch (_) {}
        try { bot.setControlState('jump', false) } catch (_) {}
      }
      continue
    }

    if (step.moved < 0.1) {
      throw new Error(`poste de tir injoignable a pied : immobile apres ${step.moved.toFixed(1)} bloc(s)`)
    }
    // Non bloque mais pas encore arrive : boucle et re-pivote vers le poste.
  }
}

// La main se remplit depuis l inventaire **reel**, et de nulle part ailleurs.
// Il y avait ici un remplissage par `creative.setInventorySlot()` : la maison
// ne coutait alors aucune ressource. Supprime avec le reste des pouvoirs
// d administration.
//
// Ce manque est utile : c est lui qui fait echouer `construire` a court de
// materiau, et donc qui fait choisir « casser » puis « fabriquer » au
// planificateur, sans qu aucun enchainement soit code en dur.
async function equipMaterial (bot, itemName) {
  const item = bot.registry.itemsByName[itemName]
  if (!item) throw new Error(`materiau inconnu du serveur : ${itemName}`)

  const held = bot.heldItem
  if (held && held.name === itemName) return

  const owned = bot.inventory.items().find(entry => entry.name === itemName)
  if (!owned) throw new Error(`plus de ${itemName} en inventaire`)

  await bot.equip(owned, 'hand')
}

// Renvoie 'pose' ou 'deja', ou leve avec une cause lisible.
// Le corps du bot (demi-largeur 0,3) recouvre-t-il la case `target` ?
function standsIn (position, target) {
  return Math.abs(position.x - (target.x + 0.5)) < 0.8 &&
    Math.abs(position.z - (target.z + 0.5)) < 0.8 &&
    position.y < target.y + 1 && position.y + 1.8 > target.y
}

// Petites poussees en s eloignant du centre de la case, 1,5 s au plus.
async function clearOfTarget (bot, target) {
  for (let i = 0; i < 20 && bot?.entity && standsIn(bot.entity.position, target); i += 1) {
    const p = bot.entity.position
    const dx = p.x - (target.x + 0.5)
    const dz = p.z - (target.z + 0.5)
    try { await bot.look(Math.atan2(-dx, -dz), 0, true) } catch (_) {}
    bot.setControlState('forward', true)
    await new Promise(resolve => setTimeout(resolve, 75))
    bot.setControlState('forward', false)
  }
  bot.setControlState('forward', false)
}

// `accept` : blocs deja bons a cette place (la terre posee pres de l herbe
// devient grass_block ; sans cela le bot la cassait pour la reposer).
// `move` : trajet vers le poste de tir (le navigateur partage de la mission),
// l ancien `moveTo` en gestes restant le repli.
async function placeOne (bot, target, itemName, { accept = null, move = null } = {}) {
  const existing = bot.blockAt(target)
  if (existing && (existing.name === itemName || accept?.test(existing.name))) return 'deja'

  const vantage = findVantage(bot, target)
  if (!vantage) throw new Error('aucun poste de tir au sol a portee')

  const arrived = move ? await move(vantage.stand).catch(() => false) : false
  if (!arrived) await moveTo(bot, vantage.stand)
  // moveTo s arrete a ARRIVE_XZ (0,8) du poste : le corps reel (0,6 de large)
  // peut alors deborder sur la case visee et le serveur refuse la pose
  // (« the block is still air », piege 11 ; vu sur build/dirt-box, bot en
  // 3712.87 pour une case en 3713, 90 etapes sans un bloc).
  await clearOfTarget(bot, target)

  const current = bot.blockAt(target)
  if (current && !isFree(current)) await bot.dig(current)

  const support = findSupport(bot, target)
  if (!support) throw new Error('aucun appui adjacent')

  await equipMaterial(bot, itemName)
  await bot.lookAt(target.offset(0.5, 0.5, 0.5), true)

  if (process.env.BUILD_DEBUG) {
    const p = bot.entity.position
    console.log(
      `[build] bot ${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)}` +
      ` -> cible ${target.x} ${target.y} ${target.z} (${bot.blockAt(target)?.name})` +
      ` appui ${support.reference.name} face ${support.faceVector.x} ${support.faceVector.y} ${support.faceVector.z}` +
      ` | main: ${bot.heldItem?.name ?? 'vide'} | portee ${vantage.distance.toFixed(2)}`
    )
  }

  await bot.placeBlock(support.reference, support.faceVector)
  return 'pose'
}

// La porte se pose sur le bloc du sol, depuis l exterieur : dans Minecraft une
// porte s oriente d apres le regard du poseur.
async function placeDoor (bot, plan, itemName) {
  const target = plan.door.position
  const existing = bot.blockAt(target)
  if (existing && existing.name === itemName) return 'deja'

  await moveTo(bot, plan.doorApproach)
  await bot.lookAt(target.offset(0.5, 0.5, 0.5), true)

  const floor = bot.blockAt(target.offset(0, -1, 0))
  if (!isSolid(floor)) throw new Error('pas de sol sous la porte')

  await equipMaterial(bot, itemName)
  await bot.placeBlock(floor, new Vec3(0, 1, 0))

  return 'pose'
}

module.exports = {
  parseDimensions,
  parseQuota,
  planHouse,
  findSite,
  placeOne,
  placeDoor,
  findVantage,
  moveTo,
  groundLevel,
  isFree,
  isSolid,
  MIN_SIZE,
  MAX_SIZE,
  DEFAULT_SIZE
}
