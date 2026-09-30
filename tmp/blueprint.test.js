'use strict'
// build.compileBlueprint : plan libre verifie (bornes, blocs flottants, porte,
// ordre de pose). Pur, sans monde.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const build = require('../bot/build')

const key = c => `${c.x},${c.y},${c.z}`
function assertBuildable (cells) {
  const placed = new Set()
  for (const c of cells) {
    const n = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]
      .some(([x, y, z]) => placed.has(key({ x: c.x + x, y: c.y + y, z: c.z + z })))
    assert.ok(c.y === 0 || n, `bloc ${key(c)} pose sans voisin`)
    placed.add(key(c))
  }
}

test('tour creuse fermee 3x3x6 : centre du toit hors de portee, retire par le code', () => {
  // Vu en jeu (build/tower 559d03e, a9f44ad) : 49/50, le centre du toit a
  // +5 n est a portee d aucun poste que le bot rejoint a pied. Puis (4b9eb74)
  // le modele redessinait trois fois la meme tour : le code retire lui-meme
  // ce seul bloc (tour ouverte en haut) au lieu de refuser le plan.
  const r = build.compileBlueprint({ largeur: 3, profondeur: 3, hauteur: 6, elements: [{ type: 'creux', de: [0, 0, 0], a: [2, 5, 2] }] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.retires, [[1, 5, 1]])
  assert.equal(r.cells.length, 9 * 2 + 8 * 4 - 1)
  assertBuildable(r.cells)
})

test('trop de blocs hors de portee : plan refuse avec la raison', () => {
  // Boite fermee 7x7x7 : tout le toit (49 blocs) est hors de portee, bien
  // plus que 10 % du volume ; le modele doit redessiner.
  const r = build.compileBlueprint({ largeur: 7, profondeur: 7, hauteur: 7, elements: [{ type: 'creux', de: [0, 0, 0], a: [6, 6, 6] }] })
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /impossibles a poser/)
})

test('tour creuse ouverte en haut : enveloppe seule, posable dans l ordre', () => {
  const r = build.compileBlueprint({ largeur: 3, profondeur: 3, hauteur: 6,
    elements: [{ type: 'creux', de: [0, 0, 0], a: [2, 5, 2] }, { type: 'vide', de: [1, 5, 1] }] })
  assert.equal(r.ok, true)
  assert.equal(r.cells.length, 9 * 2 + 8 * 4 - 1)
  assertBuildable(r.cells)
})

test('toit sans appui : refuse avec la raison', () => {
  const r = build.compileBlueprint({ largeur: 3, profondeur: 3, hauteur: 4, elements: [{ type: 'plein', de: [0, 0, 0], a: [2, 0, 2] }, { type: 'plein', de: [0, 3, 0], a: [2, 3, 2] }] })
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /flottant/)
})

test('element hors du volume : refuse', () => {
  const r = build.compileBlueprint({ largeur: 3, profondeur: 1, hauteur: 2, elements: [{ type: 'plein', de: [0, 0, 0], a: [5, 1, 0] }] })
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /sort du volume/)
})

test('porte : ouverture degagee, sol exige dessous', () => {
  const r = build.compileBlueprint({ largeur: 5, profondeur: 5, hauteur: 4, elements: [{ type: 'creux', de: [0, 0, 0], a: [4, 3, 4] }], porte: [2, 0] })
  assert.equal(r.ok, true)
  assert.ok(!r.cells.some(c => c.x === 2 && c.z === 0 && (c.y === 1 || c.y === 2)))
  const plan = build.planFromBlueprint(r, { x: 100, y: 64, z: 100 })
  assert.deepEqual([plan.door.position.x, plan.door.position.y, plan.door.position.z], [102, 65, 100])
  assert.ok(plan.doorApproach.z < 100)
  const bad = build.compileBlueprint({ largeur: 5, profondeur: 5, hauteur: 4, elements: [{ type: 'creux', de: [0, 0, 0], a: [4, 3, 4] }], porte: [2, 2] })
  assert.equal(bad.ok, false)
})

test('arche : les piliers portent le linteau', () => {
  const r = build.compileBlueprint({ largeur: 5, profondeur: 1, hauteur: 4, elements: [{ type: 'plein', de: [0, 0, 0], a: [4, 3, 0] }, { type: 'vide', de: [1, 0, 0], a: [3, 2, 0] }] })
  assert.equal(r.ok, true)
  assertBuildable(r.cells)
})

test('trop de blocs : refuse', () => {
  const r = build.compileBlueprint({ largeur: 12, profondeur: 12, hauteur: 12, elements: [{ type: 'plein', de: [0, 0, 0], a: [11, 11, 11] }] })
  assert.equal(r.ok, false)
})

test('maison de 3 de haut : une seule case d air sous le toit, refusee (piege a bot)', () => {
  // Vu en jeu (build/windows 66d7caf) : bot coince sous le toit, 60/61.
  const r = build.compileBlueprint({ largeur: 5, profondeur: 5, hauteur: 3, elements: [{ type: 'creux', de: [0, 0, 0], a: [4, 2, 4] }] })
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /une seule case d air/)
  const ok = build.compileBlueprint({ largeur: 5, profondeur: 5, hauteur: 4, elements: [{ type: 'creux', de: [0, 0, 0], a: [4, 3, 4] }], porte: [2, 0] })
  assert.equal(ok.ok, true)
})

// --- Choix du terrain : anneau de sol sec autour de l emprise ---------------

function siteWorld ({ water = [], rock = null } = {}) {
  const Vec3 = require('vec3').Vec3
  const at = (x, y, z) => {
    if (rock && x >= rock.x1 && x <= rock.x2 && z >= rock.z1 && z <= rock.z2 && y >= 200 && y <= rock.top) {
      return { name: 'stone', boundingBox: 'block' }
    }
    if (y === 199 && water.includes(x)) return { name: 'water', boundingBox: 'empty' }
    if (y <= 199) return { name: 'grass_block', boundingBox: 'block' }
    return { name: 'air', boundingBox: 'empty' }
  }
  return { blockAt: v => at(v.x, v.y, v.z), Vec3 }
}

test('findSite : jamais un chantier colle a l eau (postes de tir au sec)', () => {
  const build = require('../bot/build')
  const bot = siteWorld({ water: [16, 17] })
  const site = build.findSite(bot, { near: { x: 10.5, y: 200, z: 18.5 }, width: 4, depth: 4, height: 4 })
  assert.ok(site, 'un terrain existe')
  const { x } = site.origin
  // Emprise [x, x+3] et anneau [x-1, x+4] hors de l eau (16-17).
  assert.ok(x + 4 < 16 || x - 1 > 17, `emprise ${x}..${x + 3} trop pres de l eau`)
})

test('findSite : pas au bord d un rocher (le toit y perdait ses postes)', () => {
  const build = require('../bot/build')
  // Rocher 9x7, bot debout dessus : un 3x3 + anneau tient au milieu, pas au bord.
  const bot = siteWorld({ rock: { x1: 6, x2: 14, z1: 28, z2: 34, top: 202 } })
  const site = build.findSite(bot, { near: { x: 12.5, y: 203, z: 31.5 }, width: 3, depth: 3, height: 3 })
  assert.ok(site)
  const { x, y, z } = site.origin
  if (y === 203) {
    assert.ok(x - 1 >= 6 && x + 3 <= 14 && z - 1 >= 28 && z + 3 <= 34, `bord du rocher : ${x},${z}`)
  }
})

test('findSite : repere sur un rocher, bot au sol : chantier au niveau de ses pieds', () => {
  const build = require('../bot/build')
  // Rocher de 3 de haut (sommet a 203), bot au sol (pieds a 200) : le sommet
  // tiendrait le chantier, mais aucun poste de la deuxieme rangee n y est joignable.
  const bot = siteWorld({ rock: { x1: 6, x2: 14, z1: 28, z2: 34, top: 202 } })
  const site = build.findSite(bot, { near: { x: 12.5, y: 202, z: 31.5 }, width: 3, depth: 3, height: 3, pied: 200 })
  assert.ok(site)
  assert.equal(site.origin.y, 200)
  // Plus bas que les pieds, le rayon decide encore : bot sur le rocher, sommet choisi.
  const dessus = build.findSite(bot, { near: { x: 12.5, y: 203, z: 31.5 }, width: 3, depth: 3, height: 3, pied: 203 })
  assert.equal(dessus.origin.y, 203)
  // Sans hauteur de pieds connue, le choix d avant reste (sommet admis).
  const libre = build.findSite(bot, { near: { x: 12.5, y: 202, z: 31.5 }, width: 3, depth: 3, height: 3 })
  assert.equal(libre.origin.y, 203)
})
