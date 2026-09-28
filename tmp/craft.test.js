'use strict'
// Preuves fabrication générique (périmètre EXCLUSIF : bot/craft.js, bot/skills.js,
// bot/planner.js contrat objet libre, tmp/craft.test.js).
// Fakes (aucun monde) + dataset 26.1 quand minecraft-data disponible.
// Lancement : node --test tmp/craft.test.js
// Dans Docker : MSYS_NO_PATHCONV=1 docker run --rm -v "//c/.../bot:/src:ro" -v "//c/.../tmp:/tmp/t:ro" --entrypoint node minecraft-bot-test-bot:latest --test /tmp/t/craft.test.js
// (adapter les chemins volume selon la machine ; ne rebuild ni n installe rien)
const { test } = require('node:test')
const assert = require('node:assert/strict')

const craft = require('../bot/craft')
const skills = require('../bot/skills')
const planner = require('../bot/planner')
const { planCraft } = require('../bot/recipe-plan')

// --- Fakes ----------------------------------------------------------------

function makeFake ({ stock = {}, recipes = [], craftBehavior = null } = {}) {
  const state = { stock: { ...stock } }
  const itemsByName = {}
  const ensureItem = (name) => {
    if (typeof name !== 'string' || !name) return
    if (!itemsByName[name]) itemsByName[name] = { id: name, name }
  }
  Object.keys(state.stock).forEach(ensureItem)
  for (const r of recipes) {
    if (r?.result?.id) ensureItem(String(r.result.id))
    for (const ing of r?.ingredients ?? []) if (ing?.id) ensureItem(String(ing.id))
    for (const row of r?.inShape ?? []) for (const cell of row ?? []) {
      if (cell && cell.id) ensureItem(String(cell.id))
    }
  }
  for (const n of ['oak_log', 'oak_planks', 'stick', 'torch', 'coal', 'crafting_table']) ensureItem(n)

  const needsOf = (r) => {
    const needs = {}
    if (Array.isArray(r.ingredients)) {
      for (const ing of r.ingredients) {
        if (!ing || ing.id === undefined) continue
        needs[String(ing.id)] = (needs[String(ing.id)] ?? 0) + (ing.count || 1)
      }
    } else if (Array.isArray(r.inShape)) {
      for (const row of r.inShape) for (const cell of row ?? []) {
        if (!cell || cell.id === undefined || cell.id === null) continue
        needs[String(cell.id)] = (needs[String(cell.id)] ?? 0) + 1
      }
    }
    return needs
  }

  const bot = {
    version: '26.1',
    registry: { itemsByName, blocksByName: { crafting_table: { id: 'crafting_table' } }, recipes },
    inventory: {
      items: () => Object.entries(state.stock)
        .filter(([, c]) => c > 0)
        .map(([name, count]) => ({ name, count })),
      selectedItem: null
    },
    _state: state,
    recipesFor (id) {
      const out = []
      for (const r of recipes) {
        if (String(r?.result?.id) !== String(id)) continue
        const needs = needsOf(r)
        let ok = true
        for (const [k, need] of Object.entries(needs)) {
          if ((state.stock[k] ?? 0) < need) { ok = false; break }
        }
        if (ok) out.push({ result: { count: r.result.count || 1 }, _fake: r })
      }
      return out
    },
    async craft (recipe, n) {
      if (craftBehavior) return craftBehavior(recipe, n, state, bot)
      const r = recipe?._fake
      if (!r) throw new Error('recette inconnue (fake)')
      const needs = needsOf(r)
      for (const [k, need] of Object.entries(needs)) {
        if ((state.stock[k] ?? 0) < need) throw new Error('missing ingredient')
      }
      for (const [k, need] of Object.entries(needs)) {
        state.stock[k] -= need
        if (state.stock[k] <= 0) delete state.stock[k]
      }
      const outId = String(r.result.id)
      state.stock[outId] = (state.stock[outId] ?? 0) + (r.result.count || 1)
    },
    entity: { position: { floored: () => ({ x: 0, y: 0, z: 0 }), distanceTo: () => 0 } },
    findBlock: () => null,
    blockAt: () => null,
    lookAt: async () => {}
  }
  return bot
}

// Recettes fixtures : 1 bûche -> 4 planches ; 2 planches -> 4 bâtons.
const RECIPES_BOIS = [
  { result: { id: 'oak_planks', count: 4 }, ingredients: [{ id: 'oak_log', count: 1 }] },
  { result: { id: 'stick', count: 4 }, ingredients: [{ id: 'oak_planks', count: 2 }] }
]

test('alias FR conservé : planches depuis bûche (batch honnête, pas 1=1)', async () => {
  const bot = makeFake({ stock: { oak_log: 1 }, recipes: RECIPES_BOIS })
  const res = await craft.make(bot, 'planches', 1)
  assert.equal(res.item, 'oak_planks')
  // 1 craft donne 4 planches : on annonce le réel (+4), pas la demande (1).
  assert.equal(res.produced, 4)
  assert.equal(res.wanted, 1)
  assert.ok(res.planned >= 1)
  assert.equal(res.partial, false)
  assert.equal(res.usedTable, false)
})

test('item direct générique : stick x4 depuis 2 planches (output vs repeat)', async () => {
  const bot = makeFake({ stock: { oak_planks: 2 }, recipes: RECIPES_BOIS })
  const res = await craft.make(bot, 'stick', 4)
  assert.equal(res.item, 'stick')
  assert.equal(res.produced, 4)
  assert.equal(res.wanted, 4)
  assert.equal(res.operations, 1)
  assert.equal(res.repeats, 1)
})

test('output vs repeat : 5 bâtons -> 2 exécutions = 8 objets (repeats distinct)', async () => {
  const bot = makeFake({ stock: { oak_planks: 4 }, recipes: RECIPES_BOIS })
  const res = await craft.make(bot, 'stick', 5)
  assert.equal(res.produced, 8)
  assert.equal(res.wanted, 5)
  assert.equal(res.planned, 8)
  assert.equal(res.repeats, 2)
  // Honnête : partiel faux car surplus (8 >= 5), mais on n annonce pas 5.
  assert.equal(res.partial, false)
})

test('chaîne générique : 4 bâtons via 1 bûche (prérequis depuis stock)', async () => {
  const bot = makeFake({ stock: { oak_log: 1 }, recipes: RECIPES_BOIS })
  const res = await craft.make(bot, 'stick', 4)
  assert.equal(res.item, 'stick')
  assert.equal(res.produced, 4)
  assert.ok(res.operations >= 2, `attendu >=2 ops, vu ${res.operations}`)
})

test('manquant structuré : sans stock, rien d inventé ni récolté', async () => {
  const bot = makeFake({ stock: {}, recipes: RECIPES_BOIS })
  const before = JSON.stringify(bot._state.stock)
  await assert.rejects(() => craft.make(bot, 'stick', 4), (err) => {
    assert.equal(err.code, 'missing')
    assert.ok(Array.isArray(err.missing) && err.missing.length > 0)
    assert.equal(err.wanted, 4)
    assert.equal(err.produced, 0)
    return true
  })
  assert.equal(JSON.stringify(bot._state.stock), before, 'aucune consommation sur manquant')
})

test('inconnu : jamais un succès, code unknown', async () => {
  const bot = makeFake({ stock: { oak_log: 2 }, recipes: RECIPES_BOIS })
  // 'objet_qui_n_existe_pas_xyz' absent du registre fake -> unknown
  await assert.rejects(() => craft.make(bot, 'objet_qui_n_existe_pas_xyz', 1), (err) => {
    assert.equal(err.code, 'unknown')
    return true
  })
})

test('partiel honnête sans doublon : -2 bûches / +4 planches au lieu de +8', async () => {
  // Reproduit la mesure live : 2e craft consomme sans produire (fenêtre 26.1).
  // On ne doit ni annoncer 8, ni rejouer la consommation incertaine.
  const recipes = [{ result: { id: 'oak_planks', count: 4 }, ingredients: [{ id: 'oak_log', count: 1 }] }]
  let calls = 0
  const bot = makeFake({
    stock: { oak_log: 2 },
    recipes,
    craftBehavior: async (recipe, n, state) => {
      calls += 1
      const r = recipe._fake
      assert.ok(r, 'recette fake attendue')
      if (calls === 1) {
        state.stock.oak_log -= 1
        if (state.stock.oak_log <= 0) delete state.stock.oak_log
        state.stock.oak_planks = (state.stock.oak_planks ?? 0) + 4
        return
      }
      // 2e appel : consomme sans produire, sans lever (silencieux incertain).
      state.stock.oak_log -= 1
      if (state.stock.oak_log <= 0) delete state.stock.oak_log
    }
  })
  const res = await craft.make(bot, 'oak_planks', 8)
  assert.equal(res.item, 'oak_planks')
  assert.equal(res.produced, 4, 'on annonce le réel (+4), pas 8')
  assert.equal(res.wanted, 8)
  assert.equal(res.partial, true)
  assert.equal(calls, 2, 'pas de 3e rejouée après consommation incertaine')
  assert.equal(bot._state.stock.oak_log ?? 0, 0)
})

test('ingredients restes dans la grille 2x2 : rendus a la fermeture, craft rejoue', async () => {
  // Vu sur craft/torches (4ee01ef) : craft desynchronise, planches restees dans
  // la grille de l inventaire (slots 1 a 4), comptees comme consommees.
  const recipes = [{ result: { id: 'oak_planks', count: 4 }, ingredients: [{ id: 'oak_log', count: 1 }] }]
  let calls = 0
  let closed = 0
  const bot = makeFake({
    stock: { oak_log: 1 },
    recipes,
    craftBehavior: async (recipe, n, state, b) => {
      calls += 1
      state.stock.oak_log -= 1
      if (state.stock.oak_log <= 0) delete state.stock.oak_log
      if (calls === 1) {
        b.inventory.slots[1] = { name: 'oak_log', count: 1 }
        return
      }
      state.stock.oak_planks = (state.stock.oak_planks ?? 0) + 4
    }
  })
  bot.inventory.slots = []
  bot.closeWindow = async (win) => {
    closed += 1
    assert.equal(win, bot.inventory)
    if (!win.slots[1]) return
    win.slots[1] = null
    bot._state.stock.oak_log = (bot._state.stock.oak_log ?? 0) + 1
  }
  const res = await craft.make(bot, 'oak_planks', 4)
  assert.equal(closed, 1, 'grille rendue par fermeture de l inventaire')
  assert.equal(calls, 2, 'rejoue apres recuperation, pas d arret incertain')
  assert.equal(res.produced, 4)
  assert.equal(bot._state.stock.oak_log ?? 0, 0)
})

test('ABI préservée : make(bot, cibleFR, n) rend {item, produced, usedTable}', async () => {
  const bot = makeFake({ stock: { oak_log: 1 }, recipes: RECIPES_BOIS })
  const res = await craft.make(bot, 'batons', 4)
  // 'batons' -> stick via TARGETS.resolve (sans planches en stock, via bûche)
  assert.ok(typeof res.item === 'string')
  assert.ok(Number.isInteger(res.produced) && res.produced > 0)
  assert.ok(typeof res.usedTable === 'boolean')
})

test('skills : fabriquer.objet accepte un texte libre (item, pas liste en dur)', () => {
  const desc = skills.jsonParamsFor('fabriquer')
  assert.ok(desc?.objet, 'objet json attendu')
  assert.equal(desc.objet.json.kind, 'text')
})

test('planner : objet libre conservé (torch, minecraft:torch, alias)', () => {
  const v1 = planner.validate({ fini: 0, plan: [{ action: 'fabriquer', objet: 'torch', quantite: 4 }] }, 'recolte', 'harvest')
  assert.equal(v1.steps.length, 1)
  assert.equal(v1.steps[0].choices.objet, 'torch')
  assert.deepEqual(v1.rejected, [])
  const v2 = planner.validate({ fini: 0, plan: [{ action: 'fabriquer', objet: 'minecraft:torch', quantite: 2 }] }, 'recolte', 'harvest')
  assert.equal(v2.steps[0].choices.objet, 'torch')
  const v3 = planner.validate({ fini: 0, plan: [{ action: 'fabriquer', objet: 'batons', quantite: 4 }] }, 'recolte', 'harvest')
  assert.equal(v3.steps[0].choices.objet, 'batons')
})

// --- Dataset réel 26.1 : seulement si minecraft-data disponible ---

let mcdata = null
try {
  // eslint-disable-next-line global-require
  mcdata = require('minecraft-data')('26.1')
} catch (_) { mcdata = null }
const hasData = Boolean(mcdata?.recipes && mcdata?.itemsByName)

test('dataset 26.1 : planCraft stick/porte via recettes du jeu (pas de phrase)', { skip: !hasData }, () => {
  const p1 = planCraft({ registry: mcdata, target: 'stick', count: 4, inventory: { oak_planks: 2 } })
  assert.equal(p1.ok, true)
  assert.equal(p1.operations[0].outputPerCraft, 4)
  const p2 = planCraft({ registry: mcdata, target: 'oak_door', count: 3, inventory: { oak_log: 2 } })
  assert.equal(p2.ok, true)
  assert.equal(p2.requiresTable, true)
})

test('dataset 26.1 : torch générique valide (hors 7 FR)', { skip: !hasData }, () => {
  assert.ok(mcdata.itemsByName.torch, 'torch attendu en 26.1')
  // Torche = 2 variantes jeu (charbon ou charcoal) : stock des deux pour une
  // preuve indépendante du choix de variante par planCraft.
  const plan = planCraft({ registry: mcdata, target: 'torch', count: 4, inventory: { stick: 1, coal: 1, charcoal: 1 } })
  // 1 charbon + 1 bâton -> 4 torches : ok sans table.
  assert.equal(plan.ok, true)
  assert.equal(plan.operations[0].outputTotal, 4)
})
