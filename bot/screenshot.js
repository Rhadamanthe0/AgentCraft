'use strict'

// Mini-carte PNG autonome : rend une vue top-down des blocs autour du bot, en
// PNG, **sans aucune dependance npm**. L encodeur PNG est ecrit a la main
// (signature + IHDR + IDAT + IEND, CRC32 maison, compression via `zlib`, qui est
// un builtin de Node).
//
// Pourquoi ce module : le planificateur distant du gateway Go sait lire une
// image envoyee en data URL `image_url`, mais il n a rien a lire tant que le bot
// ne produit pas de pixels. `prismarine-viewer` coute ~400 Mo et 1 a 3 s par
// capture ; ici on echantillonne directement les chunks **deja charges** via
// `bot.blockAt`, et on encode une carte 33x33 en quelques millisecondes.
//
// Ce module ne parle a aucun modele et ne touche pas au reseau : il transforme
// un bot Mineflayer en data URL PNG, que `llm.call(..., { image })` sait joindre.

const zlib = require('zlib')

// ---------------------------------------------------------------------------
// Palette par nom de bloc
//
// Une seule couleur par famille suffit : la carte sert a situer les masses
// (eau, sol, tronc, feuillage, pierre), pas a identifier chaque variante. Les
// teintes sont celles de la carte Minecraft en vue de dessus.
// ---------------------------------------------------------------------------
const COULEURS = {
  eau: [63, 118, 228],
  lave: [207, 74, 20],
  herbe: [109, 191, 70],
  terre: [134, 96, 61],
  podzol: [91, 65, 37],
  pierre: [128, 128, 128],
  ardoise: [74, 74, 74],
  cailloux: [120, 120, 120],
  sable: [232, 217, 160],
  neige: [240, 245, 245],
  air: [27, 27, 27],
  planches: [185, 138, 82],
  tronc: [107, 74, 43],
  feuilles: [63, 122, 47]
}

// Blocs teints (laine, beton, terre cuite, vitre...) : la couleur du nom,
// sinon un repere colore (« va pres du bloc rouge ») serait gris inconnu.
const TEINTES = {
  white: [233, 236, 236], orange: [240, 118, 19], magenta: [189, 68, 179], light_blue: [58, 175, 217],
  yellow: [248, 197, 39], lime: [112, 185, 25], pink: [237, 141, 172], gray: [62, 68, 71],
  light_gray: [142, 142, 134], cyan: [21, 137, 145], purple: [121, 42, 172], blue: [53, 57, 157],
  brown: [114, 71, 40], green: [84, 109, 27], red: [161, 39, 34], black: [20, 21, 25]
}
const TEINTE = /^(light_blue|light_gray|white|orange|magenta|yellow|lime|pink|gray|cyan|purple|blue|brown|green|red|black)_(wool|concrete|concrete_powder|terracotta|glazed_terracotta|stained_glass|carpet)$/

// Un nom inconnu (bloc d un mod, variante non listee) tombe sur un gris moyen.
const GRIS_INCONNU = [128, 128, 128]

// L ordre des tests porte une information : `cobblestone` contient `stone`, donc
// il doit etre teste avant ; `deepslate` de meme. Rater cet ordre repeindrait
// tout le bati en gris pierre.
function couleurDe (nom) {
  if (!nom || typeof nom !== 'string') return GRIS_INCONNU

  if (nom === 'air' || nom === 'cave_air' || nom === 'void_air') return COULEURS.air
  const teinte = TEINTE.exec(nom)
  if (teinte) return TEINTES[teinte[1]]
  if (nom === 'water' || nom.indexOf('water') !== -1) return COULEURS.eau
  if (nom === 'lava' || nom.indexOf('lava') !== -1) return COULEURS.lave
  if (nom === 'grass_block' || nom === 'grass' || nom === 'grass_path') return COULEURS.herbe
  if (nom === 'podzol') return COULEURS.podzol
  if (nom.indexOf('deepslate') !== -1 || nom.indexOf('blackstone') !== -1) return COULEURS.ardoise
  if (nom.indexOf('cobblestone') !== -1 || nom.indexOf('mossy_stone') !== -1) return COULEURS.cailloux
  if (nom.indexOf('stone') !== -1 || nom.indexOf('andesite') !== -1 ||
      nom.indexOf('granite') !== -1 || nom.indexOf('diorite') !== -1) return COULEURS.pierre
  if (nom.indexOf('sand') !== -1) return COULEURS.sable
  if (nom.indexOf('snow') !== -1 || nom === 'powder_snow') return COULEURS.neige
  if (nom.indexOf('leaves') !== -1) return COULEURS.feuilles
  if (nom.indexOf('planks') !== -1) return COULEURS.planches
  if (nom.indexOf('log') !== -1 || nom.indexOf('wood') !== -1 ||
      nom.indexOf('stem') !== -1 || nom === 'hyphae') return COULEURS.tronc
  if (nom === 'dirt' || nom.indexOf('dirt') !== -1) return COULEURS.terre

  return GRIS_INCONNU
}

// ---------------------------------------------------------------------------
// Encodeur PNG minimal (RVB 8 bits, sans entrelacement)
// ---------------------------------------------------------------------------
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// CRC32 (polynome PNG 0xedb88320), table calculee une fois au chargement.
const TABLE_CRC = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c
  }
  return table
})()

function crc32 (buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = TABLE_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// Un chunk PNG : longueur (4 o BE), type (4 o ASCII), donnees, CRC32 sur
// type+donnees (4 o BE). Le CRC porte sur le type ET les donnees, pas sur la
// longueur — l oublier est l erreur classique qui produit un PNG refuse.
function chunk (type, donnees) {
  const typeBuf = Buffer.from(type, 'ascii')
  const longueur = Buffer.alloc(4)
  longueur.writeUInt32BE(donnees.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, donnees])), 0)
  return Buffer.concat([longueur, typeBuf, donnees, crc])
}

// `rgb` : Buffer de largeur*hauteur*3 octets, ligne par ligne. Chaque scanline
// du flux IDAT est precedee d un octet de filtre (0 = aucun).
function encoderPng (largeur, hauteur, rgb) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(largeur, 0)
  ihdr.writeUInt32BE(hauteur, 4)
  ihdr[8] = 8 // profondeur de bit
  ihdr[9] = 2 // type de couleur 2 = RVB
  ihdr[10] = 0 // methode de compression
  ihdr[11] = 0 // methode de filtre
  ihdr[12] = 0 // entrelacement : aucun

  const stride = largeur * 3
  const brut = Buffer.alloc(hauteur * (1 + stride))
  for (let y = 0; y < hauteur; y++) {
    const dst = y * (1 + stride)
    brut[dst] = 0
    rgb.copy(brut, dst + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(brut)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

// Rend une carte carree top-down autour du bot.
//
//   bot       : instance Mineflayer (`bot.entity.position` + `bot.blockAt`)
//   options   : { rayon = 16, y = null }
//               `rayon` : demi-cote en blocs, borne a [1, 64].
//               `y`     : couche echantillonnee ; par defaut le bloc juste SOUS
//                         les pieds (le terrain, pas le bloc dans lequel le bot
//                         a les pieds).
//
// Rend `{ dataUrl, largeur, hauteur, blocs, coutMs }`, ou `null` si l entree est
// invalide ou si la lecture du monde echoue. **Ne leve jamais** : un appelant
// qui a besoin de la carte doit pouvoir tester le `null` sans proteger l appel.
function miniCartePng (bot, options = {}) {
  const debut = Date.now()
  try {
    if (!bot || typeof bot.blockAt !== 'function') return null
    const position = bot.entity && bot.entity.position
    if (!position) return null
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) return null

    let rayon = Number.isFinite(options.rayon) ? Math.floor(options.rayon) : 16
    if (rayon < 1) rayon = 1
    if (rayon > 64) rayon = 64

    const y = Number.isFinite(options.y) ? Math.floor(options.y) : Math.floor(position.y) - 1
    const baseX = Math.floor(position.x)
    const baseZ = Math.floor(position.z)

    const largeur = rayon * 2 + 1
    const hauteur = largeur
    const rgb = Buffer.alloc(largeur * hauteur * 3)
    const stride = largeur * 3

    // `bot.blockAt` de cette version appelle `pos.floored()` : il exige un Vec3
    // de prismarine, pas un simple `{x,y,z}`. On derive donc chaque case de la
    // position du bot par `.offset()`, ce qui evite d importer `vec3` (et donc
    // toute dependance) tout en donnant un vrai Vec3. Un faux bot de test, dont
    // la position est un objet nu, retombe sur la forme litterale.
    const positionVecteur = typeof position.offset === 'function'

    for (let dz = -rayon; dz <= rayon; dz++) {
      for (let dx = -rayon; dx <= rayon; dx++) {
        let bloc = null
        try {
          let cible
          if (positionVecteur) {
            cible = position.offset(dx, 0, dz)
            cible.y = y
          } else {
            cible = { x: baseX + dx, y, z: baseZ + dz }
          }
          bloc = bot.blockAt(cible)
        } catch (_) {
          bloc = null // case hors des chunks charges : gris inconnu, pas d echec
        }
        const couleur = couleurDe(bloc && bloc.name)
        const i = (dz + rayon) * stride + (dx + rayon) * 3
        rgb[i] = couleur[0]
        rgb[i + 1] = couleur[1]
        rgb[i + 2] = couleur[2]
      }
    }

    const png = encoderPng(largeur, hauteur, rgb)
    return {
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      largeur,
      hauteur,
      blocs: largeur * hauteur,
      coutMs: Date.now() - debut
    }
  } catch (_) {
    // Entree pathologique (position qui jette, encodeur...) : null, jamais une
    // exception qui remonterait au milieu d une mission.
    return null
  }
}

module.exports = { miniCartePng, couleurDe, encoderPng }
