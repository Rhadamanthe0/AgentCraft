'use strict'

// Connaissances du jeu sur les cultures (A/B `culture`, idee 5 de la revue
// du 2026-10-16, prerequis d une ferme a canne a sucre). Calculees par le
// code, jamais un niveau du banc : quel objet se plante, sur quel sol, ce
// qu il faut pour labourer, quand une culture est mure, et ce qu elle donne.
// minecraft-data ne relie pas une graine a sa plante ni une plante a son
// produit (le ble n y lache que ses graines) : ces tables le disent.

// Sols des plantes. `labour` : terre labouree seulement (graines, carotte...).
const TERRE = ['dirt', 'grass_block', 'podzol', 'coarse_dirt', 'rooted_dirt', 'mycelium', 'moss_block', 'mud', 'muddy_mangrove_roots']
const SABLE = ['sand', 'red_sand', 'suspicious_sand', 'suspicious_red_sand']
const SOLS = {
  labour: ['farmland'],
  terre: [...TERRE, 'farmland'],
  terre_ou_sable: [...TERRE, ...SABLE],
  bambou: [...TERRE, ...SABLE, 'gravel', 'suspicious_gravel'],
  ame: ['soul_sand']
}
// Ce qu une houe change en terre labouree d un seul coup (bloc d air dessus).
const LABOURABLES = ['dirt', 'grass_block', 'dirt_path']

// Objet planté -> bloc pose, famille de sol, eau voisine exigee.
const PLANTES = {
  wheat_seeds: { bloc: 'wheat', sol: 'labour' },
  beetroot_seeds: { bloc: 'beetroots', sol: 'labour' },
  carrot: { bloc: 'carrots', sol: 'labour' },
  potato: { bloc: 'potatoes', sol: 'labour' },
  melon_seeds: { bloc: 'melon_stem', sol: 'labour' },
  pumpkin_seeds: { bloc: 'pumpkin_stem', sol: 'labour' },
  torchflower_seeds: { bloc: 'torchflower_crop', sol: 'labour' },
  pitcher_pod: { bloc: 'pitcher_crop', sol: 'labour' },
  // Canne a sucre : terre ou sable touchant l eau sur un cote.
  sugar_cane: { bloc: 'sugar_cane', sol: 'terre_ou_sable', eau: true },
  sweet_berries: { bloc: 'sweet_berry_bush', sol: 'terre' },
  bamboo: { bloc: 'bamboo_sapling', sol: 'bambou' },
  nether_wart: { bloc: 'nether_wart', sol: 'ame' },
  mangrove_propagule: { bloc: 'mangrove_propagule', sol: 'terre' },
  azalea: { bloc: 'azalea', sol: 'terre' },
  flowering_azalea: { bloc: 'flowering_azalea', sol: 'terre' }
}

// Bloc de culture -> objet recolte ; `base` : la plante pousse en colonne, son
// pied reste (canne a sucre, bambou, cactus : on recolte au-dessus du pied,
// comme un joueur qui garde sa ferme). Sans `base`, une plante a age (ble,
// carotte...) ne se recolte que mure.
const CULTURES = {
  wheat: { produit: 'wheat' },
  carrots: { produit: 'carrot' },
  potatoes: { produit: 'potato' },
  beetroots: { produit: 'beetroot' },
  nether_wart: { produit: 'nether_wart' },
  cocoa: { produit: 'cocoa_beans' },
  sweet_berry_bush: { produit: 'sweet_berries' },
  torchflower_crop: { produit: 'torchflower_seeds' },
  pitcher_crop: { produit: 'pitcher_plant' },
  sugar_cane: { produit: 'sugar_cane', base: true },
  bamboo: { produit: 'bamboo', base: true },
  cactus: { produit: 'cactus', base: true },
  melon: { produit: 'melon_slice' },
  pumpkin: { produit: 'pumpkin' }
}

const nomPropre = texte => String(texte ?? '').trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_')

// Ce qu un objet donne une fois plante, ou null (pas une plante).
// Pousses d arbre : meme nom au registre (oak_sapling), sur la terre.
function plante (objet, registry = null) {
  const nom = nomPropre(objet)
  const spec = PLANTES[nom] ?? (/_sapling$/.test(nom) ? { bloc: nom, sol: 'terre' } : null)
  if (!spec) return null
  if (registry?.blocksByName && !registry.blocksByName[spec.bloc]) return null
  return { objet: nom, bloc: spec.bloc, sols: SOLS[spec.sol], labour: spec.sol === 'labour', eau: spec.eau === true }
}

// Valeur d une propriete d etat (age...) d un numero d etat : les proprietes
// de minecraft-data sont codees en base mixte, la derniere varie le plus vite.
function propriete (def, stateId, nom) {
  const etats = def?.states ?? []
  if (!def || !Number.isInteger(stateId) || stateId < def.minStateId || stateId > def.maxStateId) return null
  let reste = stateId - def.minStateId
  const valeurs = []
  for (let i = etats.length - 1; i >= 0; i--) {
    const n = etats[i].num_values ?? 1
    valeurs[i] = reste % n
    reste = Math.floor(reste / n)
  }
  const i = etats.findIndex(e => e.name === nom)
  if (i < 0) return null
  const brut = etats[i].values?.[valeurs[i]]
  return etats[i].type === 'int' && brut !== undefined ? Number(brut) : valeurs[i]
}

// Age maximal d une culture a age (7 pour le ble), null sans age.
function ageMax (def) {
  const age = def?.states?.find(e => e.name === 'age')
  if (!age) return null
  return age.values ? Math.max(...age.values.map(Number)) : (age.num_values ?? 1) - 1
}

// Ce bloc de culture se recolte-t-il maintenant ? Une plante a age : mure.
// Une plante en colonne : jamais son pied. `dessous` : nom du bloc dessous.
// Un bloc hors des cultures : oui (la regle ne vaut que pour elles).
function recoltable (registry, nom, stateId, dessous) {
  const c = CULTURES[nom]
  if (!c) return true
  if (c.base) return dessous === nom
  const def = registry?.blocksByName?.[nom]
  const max = ageMax(def)
  if (max === null) return true
  return propriete(def, stateId, 'age') === max
}

// Culture -> objet recolte, ou null.
function produitDe (nom) {
  return CULTURES[nomPropre(nom)]?.produit ?? null
}

function estCulture (nom) {
  return Object.hasOwn(CULTURES, nomPropre(nom))
}

module.exports = { PLANTES, CULTURES, SOLS, LABOURABLES, plante, propriete, ageMax, recoltable, produitDe, estCulture, nomPropre }
