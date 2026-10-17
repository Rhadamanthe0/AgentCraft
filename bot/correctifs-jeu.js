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
// 3. Chemin vide (revue d Astra, rmalde/minecraft-agent, 2026-10-17). goto
//    (lib/goto.js) RESOUT quand l A* rend un chemin vide, meme avec le statut
//    `noPath` : bot enferme, aucun noeud meilleur que le depart. Le trajet qui
//    creuse rendait alors « dug », atteint, sans avoir bouge.
// 4. Point de retour perime (meme revue). Apres la pose d une marche
//    au-dessus d un trou (getMoveJumpUp, `returnPos`), le pathfinder ramene le
//    bot au centre du noeud de depart (index.js `returningPos`), tick apres
//    tick, but ou pas. Ni setGoal(null) ni resetPath n effacent ce point : un
//    trajet annule pendant ou juste apres la pose ramenait encore le bot
//    d environ un bloc, regard et commandes repris par-dessus l action
//    suivante.
//    Ecarte apres mesure (tmp/correctifs-jeu.test.js) : `fullStop`, qui
//    recentre la position (jusqu a 0,31 bloc) avant une casse, reste dans la
//    case que le bot occupe, jamais en collision : rien que le serveur refuse.
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

// Vrai si goto a resolu sur un chemin vide sans but atteint (3) : `derniere`
// est le dernier `path_update` du trajet.
function cheminVideSansBut (derniere, goal, position) {
  return Boolean(derniere && derniere.status === 'noPath' && derniere.path?.length === 0 &&
    goal && position && !goal.isEnd(position.floored()))
}

// Garde du point de retour (4), a ouvrir avant le goto. `neutraliser`, apres
// l annulation : retire `returnPos` des poses des chemins vus (une pose encore
// en vol n arme plus de retour), puis attend que le retour deja arme ait rendu
// les commandes (`calmes` ticks sans marche, `maxTicks` au plus). Rend le
// nombre de ticks ou le pathfinder menait encore le bot.
function gardeRetour (bot, { maxTicks = 30, calmes = 2, tickMs = 50 } = {}) {
  const poses = new Set()
  const onUpdate = r => {
    for (const noeud of r?.path ?? []) for (const pose of noeud.toPlace ?? []) if (pose.returnPos) poses.add(pose)
  }
  bot.on('path_update', onUpdate)
  const detacher = () => bot.removeListener('path_update', onUpdate)
  const tick = () => new Promise(resolve => {
    const fin = () => { clearTimeout(t); bot.removeListener('physicsTick', fin); resolve() }
    const t = setTimeout(fin, tickMs * 2)
    bot.on('physicsTick', fin)
  })
  async function neutraliser () {
    detacher()
    for (const pose of poses) delete pose.returnPos
    poses.clear()
    let mene = 0
    let calme = 0
    try { bot.clearControlStates() } catch (_) {}
    for (let i = 0; i < maxTicks && calme < calmes; i++) {
      await tick()
      if (bot.getControlState?.('forward')) { mene++; calme = 0 } else calme++
    }
    try { bot.clearControlStates() } catch (_) {}
    return mene
  }
  return { neutraliser, detacher }
}

module.exports = { brancherCorrectifs, corrigerVitesseCasse, lianesGrimpables, cheminVideSansBut, gardeRetour }
