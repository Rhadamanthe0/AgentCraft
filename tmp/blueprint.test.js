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
