'use strict'
// Preuves PURES de bot/recipe-plan.js (D16/D48) : aucune installation, aucun LLM,
// aucun monde. Fixtures abstraites + exemples vrais du dataset 26.1 quand
// minecraft-data est disponible (image Docker, NODE_PATH=/app/node_modules).
// Lancement : node --test tmp/recipe-plan.test.js
// Dans Docker : docker compose exec -T -e NODE_PATH=/app/node_modules bot node --test /tmp/rp/tmp/recipe-plan.test.js
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { planCraft } = require('../bot/recipe-plan')

function regList (recipes) {
  return { recipes }
}

function opTargets (plan) {
  return plan.operations.map(o => String(o.target.id))
}

// --- Fixtures abstraites : formes shaped/shapeless, batch, table ---

test('stock suffisant : ok sans operation, quantite exacte', () => {
  const registry = regList([
    { result: { id: 'T', count: 1 }, ingredients: [{ id: 'P', count: 2 }] }
  ])
  const inventory = { T: 5 }
  const before = JSON.stringify(inventory)
  const plan = planCraft({ registry, target: 'T', count: 1, inventory })
  assert.equal(plan.ok, true)
  assert.equal(plan.operations.length, 0)
  assert.deepEqual(plan.quantity, { wanted: 1, planned: 1 })
  assert.deepEqual(plan.missing, [])
  assert.equal(plan.requiresTable, false)
  assert.equal(JSON.stringify(inventory), before) // purete : entree non mutee
})

test('multi-recettes : choisit celle qui utilise le stock', () => {
  const registry = regList([
    { result: { id: 'T', count: 1 }, ingredients: [{ id: 'A', count: 1 }] },
    { result: { id: 'T', count: 1 }, ingredients: [{ id: 'B', count: 1 }] }
  ])
  const plan = planCraft({ registry, target: 'T', count: 1, inventory: { B: 1 } })
  assert.equal(plan.ok, true)
  assert.equal(plan.operations.length, 1)
  assert.equal(String(plan.operations[0].ingredients[0].id), 'B')
})

test('surplus/batch : distingue repeats (executions) vs output (objets)', () => {
  const registry = regList([
    { result: { id: 'T', count: 4 }, ingredients: [{ id: 'P', count: 2 }] }
  ])
  const plan = planCraft({ registry, target: 'T', count: 5, inventory: { P: 4 } })
  assert.equal(plan.ok, true)
  assert.equal(plan.operations.length, 1)
  const op = plan.operations[0]
  assert.equal(op.repeats, 2) // 2 executions ...
  assert.equal(op.outputPerCraft, 4)
  assert.equal(op.outputTotal, 8) // ... = 8 objets
  assert.deepEqual(plan.quantity, { wanted: 5, planned: 8 })
  assert.equal(plan.surplus.length, 1)
  assert.equal(plan.surplus[0].count, 3)
})

test('stock partage : deux branches ne consomment pas deux fois la meme unite', () => {
  const registry = regList([
    { result: { id: 'A', count: 1 }, ingredients: [{ id: 'P', count: 1 }] },
    { result: { id: 'B', count: 1 }, ingredients: [{ id: 'P', count: 1 }] },
    { result: { id: 'X', count: 1 }, ingredients: [{ id: 'A', count: 2 }, { id: 'B', count: 2 }] }
  ])
  const okPlan = planCraft({ registry, target: 'X', count: 1, inventory: { P: 4 } })
  assert.equal(okPlan.ok, true)
  assert.deepEqual(okPlan.missing, [])
  const shortPlan = planCraft({ registry, target: 'X', count: 1, inventory: { P: 3 } })
  assert.equal(shortPlan.ok, false)
  const missP = shortPlan.missing.find(m => String(m.id) === 'P')
  assert.ok(missP, 'P manquant attendu')
  assert.equal(missP.count, 1) // 4-3=1, pas 2 : le partage est compté une fois
})

test('surplus reutilise : excedent d une branche couvre l autre', () => {
  const registry = regList([
    { result: { id: 'P', count: 4 }, ingredients: [{ id: 'L', count: 1 }] },
    { result: { id: 'X', count: 1 }, ingredients: [{ id: 'P', count: 6 }] }
  ])
  // 1 L -> 4 P (surplus si besoin >4 ? ici besoin 6 -> 2 crafts = 8 P, surplus 2)
  const plan = planCraft({ registry, target: 'X', count: 1, inventory: { L: 2 } })
  assert.equal(plan.ok, true)
  const pop = plan.operations.find(o => String(o.target.id) === 'P')
  assert.ok(pop)
  assert.equal(pop.repeats, 2)
  assert.equal(pop.outputTotal, 8)
})

test('cycle A<->B : echec explicite, jamais un succes', () => {
  const registry = regList([
    { result: { id: 'A', count: 1 }, ingredients: [{ id: 'B', count: 1 }] },
    { result: { id: 'B', count: 1 }, ingredients: [{ id: 'A', count: 1 }] }
  ])
  const plan = planCraft({ registry, target: 'A', count: 1, inventory: {} })
  assert.equal(plan.ok, false)
  assert.equal(plan.reason, 'cycle')
  assert.equal(plan.operations.length, 0)
})

test('auto-cycle : echec explicite', () => {
  const registry = regList([
    { result: { id: 'A', count: 1 }, ingredients: [{ id: 'A', count: 1 }] }
  ])
  const plan = planCraft({ registry, target: 'A', count: 1, inventory: {} })
  assert.equal(plan.ok, false)
  assert.equal(plan.reason, 'cycle')
})

test('limite profondeur : chaine trop longue -> max-depth', () => {
  const registry = regList([
    { result: { id: 'A', count: 1 }, ingredients: [{ id: 'B', count: 1 }] },
    { result: { id: 'B', count: 1 }, ingredients: [{ id: 'C', count: 1 }] },
    { result: { id: 'C', count: 1 }, ingredients: [{ id: 'D', count: 1 }] },
    { result: { id: 'D', count: 1 }, ingredients: [{ id: 'E', count: 1 }] }
  ])
  const plan = planCraft({ registry, target: 'A', count: 1, inventory: {}, limits: { maxDepth: 2, maxOperations: 100 } })
  assert.equal(plan.ok, false)
  assert.equal(plan.reason, 'max-depth')
})

test('limite operations : explosion bornee -> max-operations', () => {
  const registry = regList([
    { result: { id: 'A', count: 1 }, ingredients: [{ id: 'B', count: 1 }] },
    { result: { id: 'B', count: 1 }, ingredients: [{ id: 'C', count: 1 }] }
  ])
  const plan = planCraft({ registry, target: 'A', count: 1, inventory: {}, limits: { maxDepth: 12, maxOperations: 1 } })
  assert.equal(plan.ok, false)
  assert.equal(plan.reason, 'max-operations')
})

test('inconnu : ni air ni succes, manquant a obtenir', () => {
  const registry = regList([
    { result: { id: 'T', count: 1 }, ingredients: [{ id: 'Q', count: 1 }] }
  ])
  const plan = planCraft({ registry, target: 'T', count: 1, inventory: {} })
  assert.equal(plan.ok, false)
  assert.equal(plan.reason, 'missing')
  assert.equal(plan.missing.length, 1)
  assert.equal(String(plan.missing[0].id), 'Q')
  // cible totalement inconnue : pas de succes invente
  const unknown = planCraft({ registry, target: 'ZZZ_INCONNU', count: 1, inventory: {} })
  assert.equal(unknown.ok, false)
  assert.ok(['unknown', 'missing'].includes(unknown.reason))
  assert.ok(unknown.missing.some(m => String(m.id) === 'ZZZ_INCONNU'))
})

test('table : 2x2 sans etabli, 3x3 avec etabli', () => {
  const small = regList([
    { result: { id: 'S', count: 1 }, inShape: [[{ id: 'P' }, { id: 'P' }], [{ id: 'P' }, { id: 'P' }]] }
  ])
  const big = regList([
    {
      result: { id: 'B', count: 1 },
      inShape: [[{ id: 'P' }, { id: 'P' }, { id: 'P' }], [{ id: 'P' }, { id: 'P' }, { id: 'P' }], [{ id: 'P' }, { id: 'P' }, { id: 'P' }]]
    }
  ])
  const ps = planCraft({ registry: small, target: 'S', count: 1, inventory: { P: 4 } })
  assert.equal(ps.ok, true)
  assert.equal(ps.requiresTable, false)
  const pb = planCraft({ registry: big, target: 'B', count: 1, inventory: { P: 9 } })
  assert.equal(pb.ok, true)
  assert.equal(pb.requiresTable, true)
  assert.equal(pb.operations[0].requiresTable, true)
})

test('shaped avec cases air (null) : seules les cases pleines comptent', () => {
  const registry = regList([
    { result: { id: 'T', count: 1 }, inShape: [[{ id: 'P' }, null], [null, { id: 'P' }]] }
  ])
  const plan = planCraft({ registry, target: 'T', count: 1, inventory: { P: 2 } })
  assert.equal(plan.ok, true)
  assert.equal(plan.operations[0].ingredients[0].count, 2)
})

test('delta negatif : consommation lue depuis delta', () => {
  const registry = regList([
    { result: { id: 'T', count: 1 }, delta: [{ id: 'P', count: -2 }, { id: 'T', count: 1 }], requiresTable: false }
  ])
  const plan = planCraft({ registry, target: 'T', count: 1, inventory: { P: 2 } })
  assert.equal(plan.ok, true)
  assert.equal(plan.operations[0].ingredients[0].count, 2)
  assert.equal(plan.operations[0].provenance.kind, 'delta')
})

test('metadata : variante exacte preservee, joker accepte le stock', () => {
  const registry = regList([
    { result: { id: 'T', count: 1 }, ingredients: [{ id: 'P', metadata: 1, count: 1 }] }
  ])
  // stock variante 0 ne satisfait pas une exigence variante 1
  const strict = planCraft({ registry, target: 'T', count: 1, inventory: [{ id: 'P', metadata: 0, count: 5 }] })
  assert.equal(strict.ok, false)
  // exigence joker (metadata null) accepte toute variante en stock
  const wild = regList([
    { result: { id: 'T', count: 1 }, ingredients: [{ id: 'P', count: 1 }] }
  ])
  const plan = planCraft({ registry: wild, target: 'T', count: 1, inventory: [{ id: 'P', metadata: 0, count: 1 }] })
  assert.equal(plan.ok, true)
})

test('forme [id, metadata] et ids numeriques : support prismarine/minecraft-data', () => {
  const registry = regList([
    { result: { id: 100, count: 1 }, ingredients: [[101, 2]] }
  ])
  const plan = planCraft({ registry, target: 100, count: 1, inventory: [{ id: 101, metadata: 2, count: 1 }] })
  assert.equal(plan.ok, true)
})

test('instance prismarine-recipe : inShape d objets + requiresTable declare', () => {
  const registry = regList([
    {
      result: { id: 200, metadata: null, count: 1 },
      inShape: [[{ id: 201, metadata: null, count: 1 }]],
      ingredients: null,
      delta: [{ id: 201, metadata: null, count: -1 }, { id: 200, metadata: null, count: 1 }],
      requiresTable: true
    }
  ])
  const plan = planCraft({ registry, target: 200, count: 1, inventory: [{ id: 201, count: 1 }] })
  assert.equal(plan.ok, true)
  assert.equal(plan.requiresTable, true)
})

test('recettes invalides ignorees sans planter, stats l expose', () => {
  const registry = regList([
    null,
    { nope: true },
    { result: { id: 'T', count: 1 }, ingredients: [{ id: 'P', count: 1 }] }
  ])
  const plan = planCraft({ registry, target: 'T', count: 1, inventory: { P: 1 } })
  assert.equal(plan.ok, true)
  assert.ok(plan.stats.invalidRecipes >= 2)
})

test('provenance : chaque operation cite recipes/donnees-jeu', () => {
  const registry = regList([
    { result: { id: 'T', count: 1 }, ingredients: [{ id: 'P', count: 1 }] }
  ])
  const plan = planCraft({ registry, target: 'T', count: 1, inventory: { T: 1 } })
  // cas stock direct : zero operation ; on force un craft pour voir la provenance
  const plan2 = planCraft({ registry, target: 'T', count: 1, inventory: {} })
  assert.equal(plan2.ok, false) // P manquant : pas de stock, pas de recette pour P
  const registry2 = regList([
    { result: { id: 'P', count: 1 }, ingredients: [{ id: 'M', count: 1 }] },
    { result: { id: 'T', count: 1 }, ingredients: [{ id: 'P', count: 1 }] }
  ])
  const plan3 = planCraft({ registry: registry2, target: 'T', count: 1, inventory: { M: 1 } })
  assert.equal(plan3.ok, true)
  for (const op of plan3.operations) {
    assert.equal(op.provenance.source, 'recipes')
    assert.ok(['shaped', 'shapeless', 'delta'].includes(op.provenance.kind))
  }
  assert.equal(plan3.provenance.source, 'recipes')
  assert.equal(plan3.provenance.origine, 'donnees-jeu')
  assert.deepEqual(opTargets(plan), [])
})

test('erreurs d appel : messages explicites, pas de succes fictif', () => {
  const registry = regList([{ result: { id: 'T', count: 1 }, ingredients: [] }])
  assert.throws(() => planCraft(null), TypeError)
  assert.throws(() => planCraft({ target: 'T', count: 1, inventory: {} }), TypeError)
  assert.throws(() => planCraft({ registry, target: 'T', count: 0, inventory: {} }), TypeError)
  assert.throws(() => planCraft({ registry, target: 'T', count: 1.5, inventory: {} }), TypeError)
  assert.throws(() => planCraft({ registry, target: null, count: 1, inventory: {} }), TypeError)
  assert.throws(() => planCraft({ registry, target: 'air', count: 1, inventory: {} }), TypeError)
  assert.throws(() => planCraft({ registry, target: 'T', count: 1, inventory: { P: -1 } }), TypeError)
  assert.throws(() => planCraft({ registry, target: 'T', count: 1, inventory: {}, limits: { maxDepth: 0 } }), TypeError)
  assert.throws(() => planCraft({ registry: { nope: 1 }, target: 'T', count: 1, inventory: {} }), TypeError)
})

// --- Dataset reel 26.1 : charge seulement si minecraft-data disponible ---

let mcdata = null
try {
  // eslint-disable-next-line global-require
  mcdata = require('minecraft-data')('26.1')
} catch (err) {
  mcdata = null
}

const hasData = mcdata && mcdata.recipes && mcdata.itemsByName

test('dataset 26.1 present : stick, planches, etabli, porte existent', { skip: !hasData }, () => {
  assert.ok(mcdata.itemsByName.stick, 'stick attendu dans minecraft-data 26.1')
  assert.ok(mcdata.itemsByName.oak_planks, 'oak_planks attendu')
  assert.ok(mcdata.itemsByName.crafting_table, 'crafting_table attendu')
  assert.ok(mcdata.itemsByName.oak_door, 'oak_door attendu')
  assert.ok(Array.isArray(mcdata.recipes[mcdata.itemsByName.stick.id]), 'recettes stick attendues')
})

test('dataset 26.1 : 4 batons depuis 2 planches (quantite exacte)', { skip: !hasData }, () => {
  const plan = planCraft({ registry: mcdata, target: 'stick', count: 4, inventory: { oak_planks: 2 } })
  assert.equal(plan.ok, true)
  assert.equal(plan.operations.length, 1)
  const op = plan.operations[0]
  assert.equal(op.repeats, 1)
  assert.equal(op.outputPerCraft, 4)
  assert.equal(op.outputTotal, 4)
  assert.deepEqual(plan.quantity, { wanted: 4, planned: 4 })
  assert.equal(plan.requiresTable, false)
})

test('dataset 26.1 : 5 batons -> 2 crafts = 8 (repeats vs output)', { skip: !hasData }, () => {
  const plan = planCraft({ registry: mcdata, target: 'stick', count: 5, inventory: { oak_planks: 4 } })
  assert.equal(plan.ok, true)
  const op = plan.operations[0]
  assert.equal(op.repeats, 2)
  assert.equal(op.outputTotal, 8)
  assert.deepEqual(plan.quantity, { wanted: 5, planned: 8 })
})

test('dataset 26.1 : porte en chene via buche (chaine generique, pas de scenario code)', { skip: !hasData }, () => {
  // 1 buche -> 4 planches ; 6 planches -> 3 portes. 3 portes exigent 6 planches
  // donc 2 buches (8 planches, surplus 2). Aucun nom code dans recipe-plan.js.
  const plan = planCraft({ registry: mcdata, target: 'oak_door', count: 3, inventory: { oak_log: 2 } })
  assert.equal(plan.ok, true)
  assert.ok(plan.quantity.planned >= 3)
  assert.ok(plan.operations.length >= 2)
  assert.equal(plan.requiresTable, true) // porte 3x3 exige l'etabli
  const ids = opTargets(plan)
  assert.ok(ids.includes(String(mcdata.itemsByName.oak_door.id)))
})

test('dataset 26.1 : sans stock, porte = manquants a obtenir (rien d invente)', { skip: !hasData }, () => {
  const plan = planCraft({ registry: mcdata, target: 'oak_door', count: 3, inventory: {} })
  assert.equal(plan.ok, false)
  assert.ok(plan.missing.length > 0)
  // Les manquants sont des ressources de base (buches), pas des objets inventes.
  for (const m of plan.missing) {
    assert.ok(Number.isInteger(m.count) && m.count > 0)
  }
})

test('dataset 26.1 : cible inconnue = echec, jamais air/succes', { skip: !hasData }, () => {
  const plan = planCraft({ registry: mcdata, target: 'objet_qui_n_existe_pas_xyz', count: 1, inventory: {} })
  assert.equal(plan.ok, false)
  assert.ok(plan.missing.length > 0)
})
