'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const missionState = require('../bot/mission-state')

const pleine = () => ({
  tree: { x: 1, y: 65, z: 2 },
  buchesArbreDemande: [{ x: 1, y: 65, z: 2 }, { x: 1, y: 66, z: 2 }],
  dropsArbreDemande: ['d1'],
  arbreEntitiesInitial: ['e1'],
  arbreSources: [{ x: 1, y: 65, z: 2, objet: 'oak_log', id: 'm:0', confirmee: true, ouverte: false, ambigu: false, drop: 'd1' }],
  arbreSpawns: [{ id: 'd1', x: 1.5, y: 65.5, z: 2.5, objet: 'oak_log', source: 'm:0', collectedByBot: true, collectCount: 1,
    collectPosition: { x: 1, y: 65, z: 2 }, gone: true, tiers: false, fin: { x: 1, y: 65, z: 2 } }],
  arbreBaseline: [{ id: 'b1', objet: 'oak_log', count: 2 }],
  arbreCoupes: 2,
  arbreCollectes: 1,
  arbreInventaireDepart: 3,
  arbreCollecteIds: ['d1'],
  arbreEnCours: { x: 1, y: 65, z: 2 },
  buchesArbre: [{ x: 1, y: 66, z: 2 }],
  echafaudageEnAttente: [new Vec3(0, 65, 0)],
  echafaudageEssais: { '0,65,0': 2 },
  echafaudagePose: [new Vec3(0, 66, 0)]
})

// Un champ declare est ecrit puis relu a l identique : persistance et
// restauration ne peuvent plus diverger (arbreInventaireDepart, 2026-10-01).
test('chaque champ du suivi d arbre survit a un aller-retour JSON', () => {
  const m = pleine()
  const relu = missionState.restaurer(missionState.SUIVI_ARBRE,
    JSON.parse(JSON.stringify(missionState.serialiser(missionState.SUIVI_ARBRE, m))))
  for (const champ of Object.keys(missionState.SUIVI_ARBRE)) {
    if (champ === 'echafaudageEssais') assert.deepEqual(relu[champ], {}, 'etat de travail remis a neuf')
    else assert.deepEqual(JSON.parse(JSON.stringify(relu[champ])), JSON.parse(JSON.stringify(m[champ])), champ)
  }
  assert.ok(relu.echafaudagePose[0] instanceof Vec3)
})

test('le descripteur ne persiste que le schema, sans l etat de travail', () => {
  const ecrit = missionState.serialiser(missionState.SUIVI_ARBRE, pleine())
  assert.deepEqual(Object.keys(ecrit).sort(),
    Object.keys(missionState.SUIVI_ARBRE).filter(c => c !== 'echafaudageEssais').sort())
})

test('valeurs corrompues ou absentes : rejetees, jamais inventees', () => {
  const relu = missionState.restaurer(missionState.SUIVI_ARBRE, {
    tree: { x: 1.5, y: 65, z: 2 }, arbreCoupes: -4, arbreInventaireDepart: 'trois',
    dropsArbreDemande: [3, 'ok'], echafaudagePose: [{ x: 0, y: 'a', z: 0 }], buchesArbre: 'non'
  })
  assert.equal(relu.tree, null)
  assert.equal(relu.arbreCoupes, 0)
  assert.equal(relu.arbreInventaireDepart, null)
  assert.deepEqual(relu.dropsArbreDemande, ['ok'])
  assert.deepEqual(relu.echafaudagePose, [])
  assert.equal(relu.buchesArbre, null)
  const vide = missionState.restaurer(missionState.SUIVI_ARBRE, undefined)
  assert.equal(vide.arbreCoupes, 0)
  assert.deepEqual(vide.arbreSources, [])
})

test('ancien descripteur : coupe sans identifiant confirmee par le compte, spawn rattache', () => {
  const relu = missionState.restaurer(missionState.SUIVI_ARBRE, {
    arbreCoupes: 1,
    arbreSources: [{ x: 1, y: 65, z: 2, objet: 'oak_log' }],
    arbreSpawns: [{ id: 'd1', x: 1.5, y: 65.5, z: 2.5, objet: 'oak_log' }]
  })
  assert.equal(relu.arbreSources[0].id, 'legacy-cut:0')
  assert.equal(relu.arbreSources[0].confirmee, true)
  assert.equal(relu.arbreSpawns[0].source, 'legacy-cut:0')
})

test('schema de reprise : bornes et valeurs par defaut, aller-retour', () => {
  const schema = missionState.schemaReprise({ landmarks: { ici: {}, arbre: {} }, defaultQuota: 16, craftMin: 1, craftMax: 16 })
  const m = { kind: 'recolte', resource: 'bois', landmark: 'arbre', quota: 5, quotaExplicite: true, wholeTree: false,
    pendingJoin: true, fabricationCible: 'hache', fabricationQuantite: 2, fabricationInitial: 1 }
  assert.deepEqual(missionState.restaurer(schema, JSON.parse(JSON.stringify(missionState.serialiser(schema, m)))), m)
  const borne = missionState.restaurer(schema, { kind: 'recolte', resource: 'bois', landmark: 'lune', quota: 'x',
    fabricationQuantite: 99, fabricationInitial: -3 })
  assert.equal(borne.landmark, 'ici')
  assert.equal(borne.quota, 16)
  assert.equal(borne.fabricationQuantite, 16)
  assert.equal(borne.fabricationInitial, 0)
  assert.equal(borne.fabricationCible, null)
  assert.equal(borne.pendingJoin, false)
})
