'use strict'

// Sous-buts (A/B sous_buts) : le code conduit un chantier ou une chaine du
// solveur jusqu au bout, un geste mesure a la fois ; il rend la main au
// premier echec (code garde) ou sans progres mesure.

const test = require('node:test')
const assert = require('node:assert/strict')
const { createSousButs, prochainGesteChantier, prochainGesteSolveur } = require('../bot/action-sous-buts')

const base = { arbreInacheve: false, planChoisi: true, restants: 20, stock: 0, besoins: {},
  porteVoulue: false, portePosee: false, porteEnPoche: false, etapeSolveur: null }

test('chantier : ordre des gestes suivant les besoins mesures', () => {
  assert.equal(prochainGesteChantier({ ...base, arbreInacheve: true }).action, 'recolter')
  assert.equal(prochainGesteChantier({ ...base, planChoisi: false }).action, 'choisir_terrain')
  assert.deepEqual(prochainGesteChantier({ ...base, stock: 64 }).params, { quantite: 20 })
  assert.deepEqual(prochainGesteChantier({ ...base, besoins: { planches_a_fabriquer: 24, buches_en_poche: 2 } }).params,
    { objet: 'planches', quantite: 8 })
  assert.deepEqual(prochainGesteChantier({ ...base, besoins: { buches_a_recolter: 5 } }).params, { quantite: 5 })
  const outil = { action: 'fabriquer', params: { objet: 'wooden_pickaxe', quantite: 1 } }
  assert.equal(prochainGesteChantier({ ...base, besoins: { a_obtenir: 20 }, etapeSolveur: outil }).params.objet, 'wooden_pickaxe')
  assert.equal(prochainGesteChantier({ ...base, besoins: { a_obtenir: 20 } }).action, 'recolter')
  assert.ok(prochainGesteChantier({ ...base, besoins: {} }).bloque)
  assert.equal(prochainGesteChantier({ ...base, restants: 0, porteVoulue: true }).params.objet, 'porte')
  // Planches de la porte prises par les murs : bûches puis planches d abord.
  const porte = { ...base, restants: 0, porteVoulue: true }
  assert.equal(prochainGesteChantier({ ...porte, besoins: { buches_a_recolter: 1 } }).action, 'recolter')
  assert.deepEqual(prochainGesteChantier({ ...porte, besoins: { planches_a_fabriquer: 6, buches_en_poche: 1 } }).params,
    { objet: 'planches', quantite: 4 })
  assert.equal(prochainGesteChantier({ ...base, restants: 0, porteVoulue: true, porteEnPoche: true }).action, 'poser_porte')
  assert.equal(prochainGesteChantier({ ...base, restants: 0 }).fini, true)
})

test('chantier : la matiere de la porte et de l etabli est reservee avant de construire', () => {
  const etat = { ...base, restants: 20, stock: 16, porteVoulue: true, portePosee: false, porteEnPoche: false,
    besoins: { porte_a_fabriquer: true, etabli_a_fabriquer: true, planches_a_fabriquer: 10, buches_en_poche: 2 } }
  // 16 en poche moins 6 (porte) + 4 (etabli) : seuls 6 vont aux murs.
  assert.deepEqual(prochainGesteChantier(etat).params, { quantite: 6 })
  // Stock au niveau de la reserve : les planches de la porte d abord, sans recolter.
  const reserve = { ...etat, stock: 10 }
  assert.equal(prochainGesteChantier(reserve).action, 'fabriquer')
  assert.equal(prochainGesteChantier(reserve).params.objet, 'planches')
  // Sans etabli : seule la porte est reservee.
  const sansEtabli = { ...etat, besoins: { ...etat.besoins, etabli_a_fabriquer: false } }
  assert.deepEqual(prochainGesteChantier(sansEtabli).params, { quantite: 10 })
  // Porte en poche : aucune reserve, les murs prennent tout.
  assert.deepEqual(prochainGesteChantier({ ...etat, porteEnPoche: true }).params, { quantite: 16 })
})

test('solveur : premiere etape faisable, recolte bornee, fin et blocage dits', () => {
  const toujours = () => true
  assert.equal(prochainGesteSolveur(null, toujours).code, 'obtenir_sans_cible')
  assert.equal(prochainGesteSolveur({ etapes: [] }, toujours).fini, true)
  const plan = { etapes: [{ op: 'recolter', matiere: 'pierre', quantite: 30, outil: 'wooden_pickaxe' },
    { op: 'fabriquer', objet: 'wooden_pickaxe', quantite: 1 }] }
  // La recolte attend son outil : la fabrication passe d abord.
  const g = prochainGesteSolveur(plan, (etapes, s) => !s.outil)
  assert.deepEqual([g.action, g.params.objet], ['fabriquer', 'wooden_pickaxe'])
  assert.equal(prochainGesteSolveur({ etapes: [plan.etapes[0]] }, toujours).params.quantite, 16)
  assert.equal(prochainGesteSolveur({ etapes: [plan.etapes[0]], bloque: [] }, () => false).code, 'obtenir_bloque')
})

function monde (reparation) {
  const etat = { ...base, planChoisi: false, restants: 8, stock: 0, besoins: { buches_a_recolter: 1 } }
  const joues = []
  const actions = {
    choisir_terrain: async () => { joues.push('choisir_terrain'); etat.planChoisi = true; return { resultat: 'ok' } },
    recolter: async (_, p) => { joues.push('recolter'); etat.besoins = { planches_a_fabriquer: 8, buches_en_poche: 2 }; return { resultat: `${p.quantite}` } },
    fabriquer: async () => { joues.push('fabriquer'); etat.besoins = {}; etat.stock = 8; return { resultat: 'ok' } },
    construire: async (_, p) => { joues.push('construire'); etat.restants -= p.quantite; etat.stock -= p.quantite; return { resultat: 'ok' } }
  }
  const mission = { cancelled: false }
  const sb = createSousButs({
    getMission: () => mission,
    actions: () => actions,
    etatChantier: () => etat,
    planSolveur: () => null,
    recolteFaisable: () => true,
    empreinte: () => JSON.stringify(etat),
    reparation
  })
  return { etat, joues, actions, mission, sb }
}

test('batir : terrain, buches, planches, pose, puis fini', async () => {
  const m = monde()
  const r = await m.sb.batir()
  assert.equal(r.echec, undefined, r.resultat)
  assert.deepEqual(m.joues, ['choisir_terrain', 'recolter', 'fabriquer', 'construire'])
  assert.match(r.resultat, /^batir accompli en 4 geste/)
})

test('batir : le premier echec rend la main avec le code de l action', async () => {
  const m = monde()
  m.actions.recolter = async () => ({ resultat: 'cible trop haute', echec: true, code: 'cible_haute' })
  const r = await m.sb.batir()
  assert.equal(r.echec, true)
  assert.equal(r.code, 'cible_haute')
  assert.match(r.resultat, /batir arrete sur recolter \(buches a recolter\) : cible trop haute/)
})

test('batir : un echec sans code garde le code generique de l action ratee', async () => {
  const m = monde()
  m.actions.choisir_terrain = async () => ({ resultat: 'aucun terrain plat', echec: true })
  const r = await m.sb.batir()
  assert.equal(r.code, 'choisir_terrain_echec')
})

test('batir : trois gestes sans changement mesure arretent le sous-but', async () => {
  const m = monde()
  m.etat.planChoisi = true
  m.actions.recolter = async () => ({ resultat: 'rien' })
  const r = await m.sb.batir()
  assert.equal(r.code, 'batir_sans_progres')
  assert.equal(m.joues.length, 0)
})

test('batir : une mission arretee ou remplacee interrompt le sous-but', async () => {
  const m = monde()
  m.actions.choisir_terrain = async () => { m.mission.cancelled = true; return { resultat: 'ok' } }
  const r = await m.sb.batir()
  assert.equal(r.code, 'cancelled')
})

test('batir : un tronc haut est repare une fois (piler mesure), puis le chantier reprend', async () => {
  const m = monde(code => code === 'cible_haute' ? [{ action: 'piler', params: { hauteur: 3 }, pourquoi: 'tronc haut' }] : null)
  let hautes = 1
  const recolter = m.actions.recolter
  m.actions.recolter = async (s, p) => hautes-- > 0
    ? { resultat: 'cible haute', echec: true, code: 'cible_haute' }
    : recolter(s, p)
  m.actions.piler = async (_, p) => { m.joues.push(`piler ${p.hauteur}`); return { resultat: 'pilier' } }
  const r = await m.sb.batir()
  assert.equal(r.echec, undefined, r.resultat)
  assert.deepEqual(m.joues, ['choisir_terrain', 'piler 3', 'recolter', 'fabriquer', 'construire'])
})

test('batir : la reparation n est jouee qu une fois ; l echec d origine remonte ensuite', async () => {
  const m = monde(() => [{ action: 'piler', params: { hauteur: 3 }, pourquoi: 'tronc haut' }])
  m.etat.planChoisi = true
  m.actions.recolter = async () => ({ resultat: 'cible haute', echec: true, code: 'cible_haute' })
  let pilers = 0
  m.actions.piler = async () => { pilers += 1; return { resultat: 'pilier' } }
  const r = await m.sb.batir()
  assert.equal(pilers, 1)
  assert.equal(r.code, 'cible_haute')
})

// Miroir de remedesMesures (bot/mission.js) : la fonction n est pas exportee,
// le contrat est donc verifie au niveau conduire. Reproduit le banc
// skill/cabin-batir : recolter rend aucune_cible quand la matiere est hors
// de vue, le sous-but doit jouer explorer puis reprendre recolter.
function remedesMiroir (code, action) {
  if (code === 'aucune_cible' && action === 'recolter') return [{ action: 'explorer', params: { distance: 16 }, pourquoi: 'matiere hors de vue' }]
  return null
}

test('batir : matiere hors de vue sur recolter -> explorer joue puis recolter repris (skill/cabin-batir)', async () => {
  const m = monde(remedesMiroir)
  m.etat.planChoisi = true
  m.etat.besoins = { buches_a_recolter: 3 }
  let visible = false
  m.actions.recolter = async (s, p) => {
    if (!visible) return { resultat: 'aucun bloc de la matiere visee en vue : explorer, puis recolter', echec: true, code: 'aucune_cible' }
    m.joues.push('recolter')
    m.etat.besoins = {}
    m.etat.stock = 8
    return { resultat: 'ok' }
  }
  m.actions.explorer = async (s, p) => { m.joues.push(`explorer ${p.distance}`); visible = true; return { resultat: 'matiere en vue' } }
  const r = await m.sb.batir()
  assert.equal(r.echec, undefined, r.resultat)
  assert.deepEqual(m.joues, ['explorer 16', 'recolter', 'construire'])
})

test('batir : un progres mesure rouvre le remede (second arbre, nouveau tronc haut)', async () => {
  const m = monde(() => [{ action: 'piler', params: { hauteur: 3 }, pourquoi: 'tronc haut' }])
  m.etat.planChoisi = true
  m.etat.besoins = { buches_a_recolter: 2 }
  let essais = 0
  // Chaque arbre : tronc haut d abord, puis la coupe avance d une buche.
  m.actions.recolter = async () => {
    essais += 1
    if (essais % 2 === 1) return { resultat: 'cible haute', echec: true, code: 'cible_haute' }
    m.etat.besoins = { buches_a_recolter: m.etat.besoins.buches_a_recolter - 1 }
    if (m.etat.besoins.buches_a_recolter === 0) { m.etat.besoins = {}; m.etat.stock = 8 }
    return { resultat: 'ok' }
  }
  let pilers = 0
  m.actions.piler = async () => { pilers += 1; return { resultat: 'pilier' } }
  const r = await m.sb.batir()
  assert.equal(r.echec, undefined, r.resultat)
  assert.equal(pilers, 2)
})

test('obtenir : objet inaccessible sans etapes produit un echec explicite sans jouer de geste', async () => {
  const mission = { cancelled: false }
  let gestes = 0
  const sb = createSousButs({ getMission: () => mission,
    actions: () => { gestes += 1; return {} }, etatChantier: () => ({}),
    planSolveur: () => ({ ok: false, etapes: [], bloque: [{ objet: 'water_bucket', raison: 'aucune source' }] }),
    recolteFaisable: () => false, empreinte: () => 'inventaire vide' })
  const r = await sb.obtenir(() => ({ objet: 'water_bucket', manque: 1 }))
  assert.equal(r.echec, true)
  assert.equal(r.code, 'obtenir_bloque')
  assert.match(r.resultat, /water_bucket.*aucune source/)
  assert.equal(gestes, 0)
})
