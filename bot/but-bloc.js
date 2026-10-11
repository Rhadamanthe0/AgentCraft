'use strict'

// But « bloc en vue et a portee » du trajet qui creuse (index.digToward).
//
// GoalLookAtBlock de mineflayer-pathfinder 2.4.5 mesure la portee entre le
// coin des pieds du noeud et un point 1,6 bloc AU-DESSUS du bloc vise : un
// bloc a deux blocs au-dessus des pieds (buche du haut d un tronc de trois,
// au fond d un trou) n etait jamais « a portee », d aucun poste ; l A*
// cherchait jusqu au delai et le trajet rendait no_path (terrain/far-hedge-pit,
// 2026-10-11). Ici la portee se mesure des yeux au centre du bloc, comme les
// actions ; la visibilite d une face reste celle du pathfinder.

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')

const YEUX = 1.62
// Le controle de portee du parent est desarme (assez large pour tout noeud
// deja accepte ici) ; il ne sert plus qu au rayon du lancer de visibilite.
const MARGE_PARENT = 4

class GoalBlocEnVue extends goals.GoalLookAtBlock {
  constructor (pos, world, { reach = 3.5 } = {}) {
    super(pos, world, { reach: reach + MARGE_PARENT })
    this.portee = reach
    this.centre = new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5)
  }

  isEnd (node) {
    const dx = node.x + 0.5 - this.centre.x
    const dy = node.y + YEUX - this.centre.y
    const dz = node.z + 0.5 - this.centre.z
    if (dx * dx + dy * dy + dz * dz > this.portee * this.portee) return false
    return super.isEnd(node)
  }
}

module.exports = { GoalBlocEnVue }
