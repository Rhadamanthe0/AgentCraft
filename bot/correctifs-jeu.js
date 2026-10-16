'use strict'
// Correctifs des donnees du jeu et des reglages du pathfinder en 26.1, reperes
// dans les patchs de Mindcraft (revue du 2026-10-16) puis verifies sur nos
// versions (minecraft-data 3.117, mineflayer 4.39, pathfinder 2.4.5).
//
// 1. Vitesse de casse des minerais. minecraft-data 26.1 range 108 blocs a
//    pioche (minerais, blocs de metal, obsidienne, cuivre, paratonnerres...)
//    dans le materiau `incorrect_for_wooden_tool`, dont les multiplicateurs ne
//    connaissent que les outils en bois. `block.digTime` comptait donc toute
//    pioche en pierre ou en fer comme une main nue : minerai de fer a la pioche
//    en pierre 4,55 s au lieu de 1,15 s, diamant a la pioche en fer 4,55 s au
//    lieu de 0,75 s. Le serveur acceptait la casse (trop lente, jamais trop
//    tot), mais chaque minerai coutait 4 a 6 fois son temps, et le pathfinder
//    surestimait le cout d un passage a travers. Ces materiaux recoivent les
//    multiplicateurs de `mineable/pickaxe` ; qui peut recolter quoi reste
//    decide par `harvestTools`, inchange.
// 2. Lianes. Le pathfinder 2.4.5 laisse `vine` hors de `climbables` (ligne
//    commentee) alors que prismarine-physics la grimpe comme une echelle : un
//    mur ou un tronc couvert de lianes etait infranchissable sans creuser ni
//    monter en tour. Seule `vine` est ajoutee : les autres lianes (cave_vines,
//    weeping/twisting) ne sont pas grimpees par la physique, le chemin
//    calcule ne serait pas executable.
const PIOCHE = 'mineable/pickaxe'
const MAUVAIS_OUTIL = /^incorrect_for_/

function corrigerVitesseCasse (registry) {
  const materiaux = registry?.materials
  if (!materiaux?.[PIOCHE]) return 0
  let corriges = 0
  for (const nom of Object.keys(materiaux)) {
    if (!MAUVAIS_OUTIL.test(nom) || materiaux[nom] === materiaux[PIOCHE]) continue
    materiaux[nom] = materiaux[PIOCHE]
    corriges++
  }
  return corriges
}

// Plugin : le registre existe des l injection des plugins (version connue).
function brancherCorrectifs (bot) {
  corrigerVitesseCasse(bot.registry)
}

function lianesGrimpables (movements, registry) {
  const vigne = registry?.blocksByName?.vine
  if (vigne && movements?.climbables) movements.climbables.add(vigne.id)
  return movements
}

module.exports = { brancherCorrectifs, corrigerVitesseCasse, lianesGrimpables }
