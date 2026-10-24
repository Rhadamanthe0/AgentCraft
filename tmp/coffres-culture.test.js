'use strict'

// Coffres et culture (A/B `coffres` et `culture`, idee 5 de la revue du
// 2026-10-16, prerequis d une ferme a canne a sucre). Gestes generaux, objet,
// quantite et lieu en parametres (regle immuable, AGENTS.md) : deposer et
// retirer d un conteneur, planter = poser une graine (labour par le code avec
// une houe), recolter les seules cultures mures et jamais le pied d une canne.
// Serveur simule : vrai A*, vraie physique, vraie mission scriptee ; la fin
// est jugee par le code sur ce que le monde et l inventaire montrent.

const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { createSimServer, registry, etatDe } = require('./sim-server')
const craft = require('../bot/craft')
craft.targetCriteria = craft.targetCriteria ?? (() => ({}))
const { createMissionRunner } = require('../bot/mission')
const culture = require('../bot/culture')
const skills = require('../bot/skills')

async function jouer ({ blocks = {}, inventory = [], conteneurs = {}, brief, script, features, objectif }) {
  const sim = createSimServer({ blocks, conteneurs, start: new Vec3(8.5, 200, 15.5), borne: { x0: 0, x1: 30, z0: 0, z1: 30 }, inventory })
  const log = console.log
  const lignes = []
  console.log = (...a) => { lignes.push(a.join(' ')) }
  try {
    const r = createMissionRunner(sim.host)
    r.setFeatures({ reset: true, ...features })
    const started = await r.start(objectif, 'joueur', { brief, script })
    assert.ok(started.ok, started.error)
    const debut = Date.now()
    while (r.isRunning() && Date.now() - debut < 90000) await new Promise(resolve => setTimeout(resolve, 100))
    return { sim, lignes }
  } finally {
    console.log = log
    sim.close()
  }
}
const fin = lignes => lignes.filter(l => /mission|poser|deposer|retirer|recolter|Objectif/.test(l)).slice(-14).join('\n')

test('culture : graine -> plante et sol, age mur decode de l etat, produit d une culture', () => {
  assert.deepEqual(culture.plante('wheat_seeds', registry), { objet: 'wheat_seeds', bloc: 'wheat', sols: ['farmland'], labour: true, eau: false })
  assert.equal(culture.plante('sugar_cane', registry).eau, true)
  assert.equal(culture.plante('oak_sapling', registry).bloc, 'oak_sapling')
  assert.equal(culture.plante('cobblestone', registry), null)
  const ble = registry.blocksByName.wheat
  assert.equal(culture.ageMax(ble), 7)
  assert.equal(culture.propriete(ble, etatDe('wheat[age=7]'), 'age'), 7)
  assert.equal(culture.propriete(ble, etatDe('wheat[age=2]'), 'age'), 2)
  // Propriete au milieu d une base mixte (cacao : age puis facing).
  assert.equal(culture.propriete(registry.blocksByName.cocoa, etatDe('cocoa[age=2,facing=east]'), 'age'), 2)
  assert.ok(culture.recoltable(registry, 'wheat', etatDe('wheat[age=7]'), 'farmland'))
  assert.ok(!culture.recoltable(registry, 'wheat', etatDe('wheat[age=3]'), 'farmland'))
  assert.ok(!culture.recoltable(registry, 'sugar_cane', etatDe('sugar_cane'), 'sand'), 'pied d une canne garde')
  assert.ok(culture.recoltable(registry, 'sugar_cane', etatDe('sugar_cane'), 'sugar_cane'))
  assert.ok(culture.recoltable(registry, 'stone', 1, 'stone'), 'hors cultures : sans regle')
  // Le ble du registre ne lache que ses graines : la matiere ouverte compte le ble.
  assert.ok(skills.resourceSpec('libre:wheat', registry).items.test('wheat'))
  assert.ok(!skills.resourceSpec('libre:wheat', registry).items.test('wheat_seeds'))
})

test('interrupteurs : deposer/retirer servis avec `coffres`, capacites couvertes retirees du brief', () => {
  const r = createMissionRunner({ getBot: () => null, isReady: () => false })
  r.setFeatures({ reset: true })
  assert.ok(!skills.actionsFor('recolte').includes('deposer'))
  assert.ok('conteneur' in skills.capacitesAbsentes() && 'culture' in skills.capacitesAbsentes())
  assert.ok(!/Planter, c est poser/.test(skills.describeAction('poser')))
  r.setFeatures({ coffres: true, culture: true })
  assert.ok(skills.actionsFor('recolte').includes('deposer') && skills.actionsFor('geste').includes('retirer'))
  assert.ok(!('conteneur' in skills.capacitesAbsentes()) && !('culture' in skills.capacitesAbsentes()))
  assert.ok('animal' in skills.capacitesAbsentes())
  assert.ok(/Planter, c est poser/.test(skills.describeAction('poser')))
  r.setFeatures({ reset: true })
})

test('culture : graines plantees sur terre labouree par le code avec la houe, pres de l eau, fin mesuree', async () => {
  const blocks = { '14,199,15': 'water' }
  const { sim, lignes } = await jouer({
    blocks,
    inventory: [{ name: 'wheat_seeds', count: 3 }, { name: 'wooden_hoe', count: 1 }],
    brief: { type: 'recolte', matiere: 'aucune', pose: [{ objet: 'wheat_seeds', quantite: 3 }] },
    script: [{ action: 'poser', objet: 'wheat_seeds', quantite: 3 }, { action: 'terminer' }],
    features: { poser: true, culture: true },
    objectif: 'Plante 3 graines de ble'
  })
  assert.equal(sim.count(n => n === 'wheat'), 3, fin(lignes))
  assert.equal(sim.count(n => n === 'farmland'), 3)
  // Humide d abord : chaque champ a 4 blocs de l eau.
  for (let x = 0; x <= 30; x++) for (let z = 0; z <= 30; z++) {
    if (sim.nameAt(x, 200, z) === 'wheat') assert.ok(Math.abs(x - 14) <= 4 && Math.abs(z - 15) <= 4, `${x} ${z}`)
  }
  assert.ok(lignes.some(l => /Objectif atteint/.test(l)), fin(lignes))
})

test('culture : sans terre labouree ni houe, la pose le dit (houe_absente) et le solveur vise la houe', async () => {
  const { sim, lignes } = await jouer({
    inventory: [{ name: 'wheat_seeds', count: 2 }],
    brief: { type: 'recolte', matiere: 'aucune', pose: [{ objet: 'wheat_seeds', quantite: 2 }] },
    script: [{ action: 'poser', objet: 'wheat_seeds' }],
    features: { poser: true, culture: true },
    objectif: 'Plante 2 graines de ble'
  })
  assert.equal(sim.count(n => n === 'wheat'), 0)
  assert.ok(lignes.some(l => /aucune houe en poche/.test(l)), fin(lignes))
  assert.ok(lignes.some(l => /solveur vers wooden_hoe/.test(l)), lignes.filter(l => /solveur/.test(l)).join('\n'))
})

test('culture : la canne a sucre se plante sur le sol qui touche l eau', async () => {
  const { sim, lignes } = await jouer({
    blocks: { '12,199,15': 'water', '11,199,15': 'sand' },
    inventory: [{ name: 'sugar_cane', count: 1 }],
    brief: { type: 'recolte', matiere: 'aucune', pose: [{ objet: 'sugar_cane', quantite: 1 }] },
    script: [{ action: 'poser', objet: 'sugar_cane' }, { action: 'terminer' }],
    features: { poser: true, culture: true },
    objectif: 'Plante une canne a sucre au bord de l eau'
  })
  const ou = []
  for (let x = 0; x <= 30; x++) for (let z = 0; z <= 30; z++) if (sim.nameAt(x, 200, z) === 'sugar_cane') ou.push([x, z])
  assert.equal(ou.length, 1, fin(lignes))
  assert.ok([[11, 15], [13, 15], [12, 14], [12, 16]].some(([x, z]) => ou[0][0] === x && ou[0][1] === z), JSON.stringify(ou))
})

test('culture : recolter ne prend que le ble mur, la jeune pousse reste ; jamais le pied d une canne', async () => {
  const blocks = {}
  for (const x of [10, 11, 12]) { blocks[`${x},199,13`] = 'farmland'; blocks[`${x},200,13`] = 'wheat[age=7]' }
  for (const x of [9, 10, 11]) { blocks[`${x},199,17`] = 'farmland'; blocks[`${x},200,17`] = 'wheat[age=2]' }
  const { sim, lignes } = await jouer({
    blocks,
    brief: { type: 'recolte', matiere: 'aucune', bloc: 'wheat' },
    script: [{ action: 'recolter', quantite: 3, repeter: 4 }, { action: 'ramasser', quantite: 3, repeter: 2 }],
    features: { culture: true, buts_ouverts: true, recolter: true },
    objectif: 'Ramene-moi 3 bles'
  })
  const jeunes = [9, 10, 11].filter(x => /^wheat\[age=2\]$/.test(sim.nameAt(x, 200, 17))).length
  assert.equal(jeunes, 3, fin(lignes))
  assert.ok((sim.inventory().find(i => i.name === 'wheat')?.count ?? 0) >= 3, JSON.stringify(sim.inventory()) + '\n' + fin(lignes))

  const canne = { '12,199,15': 'water', '11,199,15': 'sand', '11,200,15': 'sugar_cane', '11,201,15': 'sugar_cane' }
  const c = await jouer({
    blocks: canne,
    brief: { type: 'recolte', matiere: 'aucune', bloc: 'sugar_cane' },
    script: [{ action: 'recolter', quantite: 1 }],
    features: { culture: true, buts_ouverts: true, recolter: true, arbre_fini: true },
    objectif: 'Ramene-moi 1 canne a sucre'
  })
  assert.equal(c.sim.nameAt(11, 201, 15), 'air', fin(c.lignes))
  assert.equal(c.sim.nameAt(11, 200, 15), 'sugar_cane', fin(c.lignes))
})

test('coffres : lire un coffre jamais ouvert, en retirer ce que la consigne veut, fin mesuree', async () => {
  const { sim, lignes } = await jouer({
    blocks: { '13,200,15': 'chest' },
    conteneurs: { '13,200,15': [{ name: 'cobblestone', count: 5 }, { name: 'dirt', count: 2 }] },
    brief: { type: 'recolte', matiere: 'aucune', retrait: [{ objet: 'cobblestone', quantite: 3 }] },
    script: [{ action: 'retirer', dans: 'chest' }, { action: 'retirer', objet: 'cobblestone' }, { action: 'terminer' }],
    features: { coffres: true },
    objectif: 'Prends 3 pierres taillees dans le coffre'
  })
  assert.ok(lignes.some(l => /chest en 13 200 15 ouvert : 5 cobblestone, 2 dirt/.test(l)), fin(lignes))
  assert.equal(sim.inventory().find(i => i.name === 'cobblestone')?.count, 3, fin(lignes))
  assert.deepEqual(sim.contenu('13,200,15'), [{ name: 'cobblestone', count: 2 }, { name: 'dirt', count: 2 }])
  assert.ok(lignes.some(l => /Objectif atteint/.test(l)), fin(lignes))
})

test('coffres : ranger tout le stock d une famille (« tes buches ») sans objet nomme, fin mesuree', async () => {
  const { sim, lignes } = await jouer({
    blocks: { '13,200,15': 'barrel' },
    inventory: [{ name: 'oak_log', count: 3 }, { name: 'birch_log', count: 2 }, { name: 'stick', count: 4 }],
    brief: { type: 'recolte', matiere: 'aucune', depot: [{ objet: 'buches', quantite: null }] },
    script: [{ action: 'deposer', repeter: 2 }, { action: 'terminer' }],
    features: { coffres: true },
    objectif: 'Range tes buches dans le tonneau'
  })
  assert.deepEqual(sim.contenu('13,200,15'), [{ name: 'oak_log', count: 3 }, { name: 'birch_log', count: 2 }], fin(lignes))
  assert.deepEqual(sim.inventory(), [{ name: 'stick', count: 4 }])
  assert.ok(lignes.some(l => /Objectif atteint/.test(l)), fin(lignes))
})

test('coffres : l etat montre le contenu lu et ce qui sert le solveur ; un objet fabrique puis range clot la mission', async t => {
  const planner = require('../bot/planner')
  const sim = createSimServer({ blocks: { '13,200,15': 'chest' }, conteneurs: { '13,200,15': [{ name: 'cobblestone', count: 3 }] },
    start: new Vec3(8.5, 200, 15.5), borne: { x0: 0, x1: 30, z0: 0, z1: 30 } })
  t.mock.method(planner, 'isEnabled', () => true)
  t.mock.method(planner, 'readBrief', async () => ({ kind: 'recolte', kindConfidence: 1, resource: 'aucune', resourceConfidence: 1,
    landmark: 'ici', landmarkConfidence: 1, door: false, doorProbability: 0, fabrication: 'stone_pickaxe', fabricationQuantite: 1,
    fabricationSuite: [], depot: [{ objet: 'stone_pickaxe', quantite: 1 }], retrait: null }))
  const etats = []
  const etape = (action, choices = {}) => ({ action, scale: 0, scaleLevel: null, choices })
  t.mock.method(planner, 'plan', async state => {
    etats.push(state)
    if (etats.length === 1) return { ms: 0, seconds: 1, rejected: [], done: 0, finished: false, steps: [etape('retirer', { dans: 'chest' })] }
    // Fabrication hors du simulateur : la pioche arrive en poche.
    if (etats.length === 2) sim.donner('stone_pickaxe', 1)
    return { ms: 0, seconds: 1, rejected: [], done: 0, finished: false, steps: [etape('deposer', { objet: 'stone_pickaxe' })] }
  })
  const log = console.log
  const lignes = []
  console.log = (...a) => { lignes.push(a.join(' ')) }
  try {
    const r = createMissionRunner(sim.host)
    r.setFeatures({ reset: true, coffres: true })
    const started = await r.start('Fabrique-moi une pioche en pierre et range-la dans le coffre', 'joueur')
    assert.ok(started.ok, started.error)
    const debut = Date.now()
    while (r.isRunning() && Date.now() - debut < 30000) await new Promise(resolve => setTimeout(resolve, 50))
  } finally {
    console.log = log
    sim.close()
  }
  assert.equal(etats[0].conteneurs[0].contenu, 'jamais ouvert : retirer sans objet pour le lire')
  assert.deepEqual(etats[1].conteneurs[0].contenu, { cobblestone: 3 })
  assert.deepEqual(etats[1].conteneurs[0].utiles, ['cobblestone'], JSON.stringify(etats[1].conteneurs))
  // La pioche en poche ne clot pas : le depot reste a faire.
  assert.ok(etats.length >= 2, fin(lignes))
  assert.deepEqual(sim.contenu('13,200,15'), [{ name: 'cobblestone', count: 3 }, { name: 'stone_pickaxe', count: 1 }], fin(lignes))
  assert.ok(lignes.some(l => /Objectif atteint/.test(l)), fin(lignes))
})
