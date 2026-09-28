'use strict'

// Planification generique des prerequis de fabrication (D16/D48).
//
// PURE : aucune entree/sortie, aucun appel reseau, aucun appel LLM, aucune
// mutation des arguments. Ne fabrique rien en jeu : calcule seulement un plan
// a partir des donnees du jeu (registre de recettes) et d'un etat de stock.
// L'execution reste du ressort du runtime existant (craft.js) : un plan `ok`
// est un calcul reussi, pas un objet fabrique.
//
// Integration :
//   const { planCraft } = require('./recipe-plan')
//   const plan = planCraft({
//     registry: bot.registry,            // ou require('minecraft-data')('26.1')
//     target: 'oak_door',                // nom, id numerique, ou {id,name,metadata}
//     count: 3,                          // quantite exacte en unites d'objets
//     inventory: { oak_planks: 6 },      // map, liste [{name,id,metadata,count}], ou Map
//     limits: { maxDepth: 12, maxOperations: 100 } // optionnel
//   })
//   if (!plan.ok) -> plan.missing = ressources a obtenir (a recolter, pas inventees)
//   plan.operations = crafts a executer dans l'ordre (ingredients d'abord)
//   plan.requiresTable = vrai si au moins une operation exige un etabli
//   plan.quantity = { wanted, planned } en unites d'objets (distinct de `repeats`)
//   Chaque operation porte repeats (executions de la recette) vs outputTotal
//   (objets produits = repeats * outputPerCraft), plus sa provenance.
//
// Registre accepte (sans scenario par objet) :
//   - { recipes, itemsByName?, items? } style minecraft-data / prismarine-registry
//     (recipes = dict resultatId -> [recette] ou liste plate)
//   - recettes shaped ({ inShape, result }) et shapeless ({ ingredients, result }),
//     cellules null = air (ignore), id -1 = air (ignore)
//   - instances prismarine-recipe ({ result, inShape/outShape, ingredients,
//     delta, requiresTable }) : delta negatif = consommation
//   - ref ingredient/resultat : nombre (id), [id, metadata], {id,metadata,count}
//     metadata null/32767+ = joker (wildcard) ; toute autre valeur = variante exacte
//   - fixtures abstraites : ids symboliques (chaines) acceptes de la meme facon
//
// Regles :
//   - choix parmi les variantes de recettes : prefere celles qui consomment le
//     stock disponible (moins de manquants), puis moins d'operations, puis moins
//     de surplus. Le stock partage est simule sequentiellement : deux branches
//     ne consomment pas deux fois la meme unite.
//   - surplus de batch (outputTotal - besoin) recredite dans le stock simule et
//     retourne dans `surplus` ; il est reutilise par les autres branches.
//   - cycles (A exige B exige A) et depassements (maxDepth/maxOperations)
//     rendent `ok:false` avec `reason` explicite, jamais un succes silencieux.
//   - inconnu (ni en stock, ni produit par une recette, ni declare au registre)
//     = manquant a obtenir, jamais de l'air, jamais un succes.
//   - `missing` = ressources a obtenir par d'autres capacites (recolte, coffres)
//     : le planificateur ne les invente pas disponibles.

const AIR_IDS = new Set([-1])
const WILDCARD_METADATA = 32767

function isPlainObject (v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// Normalise une reference d'objet (ingredient ou resultat).
// Rend null pour l'air (a ignorer dans les grilles), sinon {id,metadata,count}.
// Ne leve pas : l'appelant ecarte les recettes invalides sans planter.
function normalizeRef (ref, forResult) {
  if (ref === null || ref === undefined) return null
  if (typeof ref === 'number') {
    if (AIR_IDS.has(ref)) return null
    return { id: ref, metadata: null, count: 1 }
  }
  if (typeof ref === 'string') {
    if (ref === '' || ref === 'air' || ref === 'minecraft:air') return null
    return { id: ref, metadata: null, count: 1, nameHint: ref }
  }
  if (Array.isArray(ref)) {
    if (ref.length === 0) return null
    const id = ref[0]
    if (id === null || id === undefined || AIR_IDS.has(id)) return null
    let metadata = ref.length > 1 ? ref[1] : null
    if (metadata === undefined) metadata = null
    if (typeof metadata === 'number' && metadata >= WILDCARD_METADATA) metadata = null
    return { id, metadata, count: 1 }
  }
  if (isPlainObject(ref)) {
    const id = ref.id !== undefined ? ref.id : ref.itemId
    const nameHint = ref.name !== undefined ? ref.name : undefined
    if (id === null || id === undefined) {
      // Forme {name} sans id : garde le nom comme identifiant symbolique.
      if (typeof nameHint === 'string' && nameHint !== '') {
        const count = ref.count !== undefined ? ref.count : 1
        const n = forResult ? count : Math.abs(count) || 1
        let metadata = ref.metadata !== undefined ? ref.metadata : (ref.meta !== undefined ? ref.meta : null)
        if (typeof metadata === 'number' && metadata >= WILDCARD_METADATA) metadata = null
        return { id: nameHint, metadata, count: n, nameHint }
      }
      return null
    }
    if (AIR_IDS.has(id)) return null
    if (typeof id === 'string' && (id === '' || id === 'air' || id === 'minecraft:air')) return null
    let metadata = ref.metadata !== undefined ? ref.metadata : (ref.meta !== undefined ? ref.meta : null)
    if (metadata === undefined) metadata = null
    if (typeof metadata === 'number' && metadata >= WILDCARD_METADATA) metadata = null
    let count = ref.count !== undefined ? ref.count : 1
    if (typeof count !== 'number' || !Number.isFinite(count)) count = 1
    if (!forResult && count < 0) count = Math.abs(count)
    if (!Number.isInteger(count) || count <= 0) return null
    const out = { id, metadata, count }
    if (typeof nameHint === 'string' && nameHint !== '') out.nameHint = nameHint
    return out
  }
  return null
}

function exactKey (id, metadata) {
  return String(id) + '@@' + (metadata === null || metadata === undefined ? '*' : String(metadata))
}

function sameId (a, b) {
  return String(a) === String(b)
}

// L'ingredient exige (id, metadata) accepte-t-il l'entree de stock (sid, smeta) ?
// metadata null des deux cotes = joker. Variante exacte exige l'egalite.
function matchesVariant (needId, needMeta, stockId, stockMeta) {
  if (!sameId(needId, stockId)) return false
  if (needMeta === null || needMeta === undefined) return true
  if (stockMeta === null || stockMeta === undefined) return true
  return String(needMeta) === String(stockMeta)
}

function buildNameMaps (registry) {
  const nameToId = new Map()
  const idToName = new Map()
  if (!registry || typeof registry !== 'object') return { nameToId, idToName }
  const byName = registry.itemsByName
  if (byName && typeof byName === 'object') {
    for (const [name, entry] of Object.entries(byName)) {
      if (entry && (typeof entry.id === 'number' || typeof entry.id === 'string')) {
        if (!nameToId.has(name)) nameToId.set(name, entry.id)
        const k = exactKey(entry.id, entry.metadata ?? null)
        if (!idToName.has(k)) idToName.set(k, name)
        const generic = String(entry.id)
        if (!idToName.has(generic)) idToName.set(generic, name)
      }
    }
  }
  const items = registry.items
  const pushItem = (entry) => {
    if (!entry) return
    const id = entry.id
    const name = entry.name
    if ((typeof id === 'number' || typeof id === 'string') && typeof name === 'string') {
      const k = exactKey(id, entry.metadata ?? null)
      if (!idToName.has(k)) idToName.set(k, name)
      if (!idToName.has(String(id))) idToName.set(String(id), name)
      if (!nameToId.has(name)) nameToId.set(name, id)
    }
  }
  if (Array.isArray(items)) items.forEach(pushItem)
  else if (items && typeof items === 'object') Object.values(items).forEach(pushItem)
  if (Array.isArray(registry.itemsArray)) registry.itemsArray.forEach(pushItem)
  return { nameToId, idToName }
}

function displayName (id, metadata, maps) {
  const exact = maps.idToName.get(exactKey(id, metadata))
  if (exact) return exact
  const generic = maps.idToName.get(String(id))
  if (generic) return generic
  return String(id)
}

// Calcule requiresTable a la maniere prismarine-recipe quand non declare :
// grille > 2x2 ou plus de 4 cases/items consommes => etabli.
function computeRequiresTable (kind, nonNullCells, ingredientUnits, declared) {
  if (typeof declared === 'boolean') return declared
  if (kind === 'shaped' && nonNullCells && (nonNullCells.rows > 2 || nonNullCells.cols > 2)) return true
  const units = kind === 'shaped' ? (nonNullCells ? nonNullCells.count : 0) : ingredientUnits
  return (units || 0) > 4
}

function normalizeRecipe (entry, index) {
  if (!isPlainObject(entry) && typeof entry !== 'object') return null
  if (!entry || typeof entry !== 'object') return null
  const resultRef = entry.result !== undefined ? entry.result : entry.output
  const result = normalizeRef(resultRef, true)
  if (!result) return null
  if (!Number.isInteger(result.count) || result.count <= 0) return null

  let kind = null
  let ingredients = []
  let shapeInfo = null

  if (entry.inShape !== undefined && entry.inShape !== null) {
    kind = 'shaped'
    if (!Array.isArray(entry.inShape)) return null
    const agg = new Map()
    let rows = entry.inShape.length
    let cols = 0
    let count = 0
    for (const row of entry.inShape) {
      if (!Array.isArray(row)) return null
      cols = Math.max(cols, row.length)
      for (const cell of row) {
        if (cell === null || cell === undefined) continue
        const ref = normalizeRef(cell, false)
        if (!ref) continue // air explicite : case vide, pas une consommation
        count += 1
        const k = exactKey(ref.id, ref.metadata)
        const prev = agg.get(k)
        if (prev) prev.count += 1
        else agg.set(k, { id: ref.id, metadata: ref.metadata, count: 1, nameHint: ref.nameHint })
      }
    }
    shapeInfo = { rows, cols, count }
    ingredients = [...agg.values()]
  } else if (entry.ingredients !== undefined && entry.ingredients !== null) {
    kind = 'shapeless'
    if (!Array.isArray(entry.ingredients)) return null
    const agg = new Map()
    for (const elem of entry.ingredients) {
      if (elem === null || elem === undefined) continue
      const ref = normalizeRef(elem, false)
      if (!ref) continue
      const units = Number.isInteger(ref.count) && ref.count > 0 ? ref.count : 1
      const k = exactKey(ref.id, ref.metadata)
      const prev = agg.get(k)
      if (prev) prev.count += units
      else agg.set(k, { id: ref.id, metadata: ref.metadata, count: units, nameHint: ref.nameHint })
    }
    ingredients = [...agg.values()]
  } else if (entry.inputs !== undefined && entry.inputs !== null) {
    kind = 'shapeless'
    if (!Array.isArray(entry.inputs)) return null
    const agg = new Map()
    for (const elem of entry.inputs) {
      if (elem === null || elem === undefined) continue
      const ref = normalizeRef(elem, false)
      if (!ref) continue
      const units = Number.isInteger(ref.count) && ref.count > 0 ? ref.count : 1
      const k = exactKey(ref.id, ref.metadata)
      const prev = agg.get(k)
      if (prev) prev.count += units
      else agg.set(k, { id: ref.id, metadata: ref.metadata, count: units, nameHint: ref.nameHint })
    }
    ingredients = [...agg.values()]
  } else if (entry.delta !== undefined && entry.delta !== null) {
    kind = 'delta'
    if (!Array.isArray(entry.delta)) return null
    const agg = new Map()
    for (const elem of entry.delta) {
      const ref = normalizeRef(elem, false)
      if (!ref) continue
      // Convention prismarine : delta negatif = consomme. Positif = produit
      // (le resultat y figure aussi) : on ne garde que le consomme ici.
      const raw = isPlainObject(elem) && typeof elem.count === 'number' ? elem.count : -1
      if (raw >= 0) continue
      const units = Math.abs(raw) || 1
      const k = exactKey(ref.id, ref.metadata)
      const prev = agg.get(k)
      if (prev) prev.count += units
      else agg.set(k, { id: ref.id, metadata: ref.metadata, count: units, nameHint: ref.nameHint })
    }
    ingredients = [...agg.values()]
  } else {
    return null
  }

  const declared = entry.requiresTable !== undefined ? entry.requiresTable : entry.needsTable
  const requiresTable = computeRequiresTable(
    kind === 'delta' ? 'shapeless' : kind,
    shapeInfo,
    ingredients.reduce((s, i) => s + i.count, 0),
    declared
  )

  return {
    index,
    kind,
    result: { id: result.id, metadata: result.metadata ?? null, count: result.count, nameHint: result.nameHint },
    ingredients,
    requiresTable,
    provenance: { source: 'recipes', kind, recipeIndex: index }
  }
}

function collectRecipes (registry) {
  const raw = registry.recipes
  const flat = []
  if (Array.isArray(raw)) {
    for (const entry of raw) flat.push(entry)
  } else if (raw && typeof raw === 'object') {
    for (const value of Object.values(raw)) {
      if (Array.isArray(value)) {
        for (const entry of value) flat.push(entry)
      } else if (value && typeof value === 'object') {
        flat.push(value)
      }
    }
  } else {
    throw new TypeError('registry.recipes doit etre un tableau ou un dictionnaire id -> recettes')
  }
  const normalized = []
  let invalid = 0
  flat.forEach((entry, i) => {
    const r = normalizeRecipe(entry, i)
    if (r) normalized.push(r)
    else invalid += 1
  })
  return { normalized, invalid, total: flat.length }
}

function normalizeTarget (target, maps) {
  if (typeof target === 'string') {
    if (target === '') throw new TypeError('target doit etre un nom ou un id non vide')
    if (target === 'air' || target === 'minecraft:air') throw new TypeError('target air invalide : rien a planifier')
    const id = maps.nameToId.has(target) ? maps.nameToId.get(target) : target
    const name = maps.nameToId.has(target) ? target : displayName(id, null, maps)
    return { id, metadata: null, name }
  }
  if (typeof target === 'number') {
    if (!Number.isFinite(target)) throw new TypeError('target id invalide')
    if (AIR_IDS.has(target)) throw new TypeError('target air invalide : rien a planifier')
    return { id: target, metadata: null, name: displayName(target, null, maps) }
  }
  if (isPlainObject(target)) {
    const metadata = target.metadata !== undefined ? target.metadata : (target.meta !== undefined ? target.meta : null)
    if (target.id !== undefined && target.id !== null) {
      if (typeof target.id === 'number' && AIR_IDS.has(target.id)) throw new TypeError('target air invalide : rien a planifier')
      const name = typeof target.name === 'string' && target.name !== ''
        ? target.name
        : displayName(target.id, metadata ?? null, maps)
      return { id: target.id, metadata: metadata ?? null, name }
    }
    if (typeof target.name === 'string' && target.name !== '') {
      if (target.name === 'air' || target.name === 'minecraft:air') throw new TypeError('target air invalide : rien a planifier')
      const id = maps.nameToId.has(target.name) ? maps.nameToId.get(target.name) : target.name
      return { id, metadata: metadata ?? null, name: target.name }
    }
    throw new TypeError('target doit porter un id ou un nom')
  }
  throw new TypeError('target doit etre un nom, un id, ou {id,name,metadata}')
}

function normalizeInventory (inventory, maps) {
  // Rend une Map exactKey -> {id,metadata,name,count}, sans muter l'entree.
  const stock = new Map()
  const add = (id, metadata, name, count) => {
    if (!Number.isInteger(count) || count < 0) {
      throw new TypeError('inventaire : quantite entiere >= 0 exigee (vu ' + String(count) + ')')
    }
    if (count === 0) return
    const k = exactKey(id, metadata)
    const prev = stock.get(k)
    if (prev) prev.count += count
    else stock.set(k, { id, metadata, name, count })
  }
  if (inventory === undefined || inventory === null) return stock
  if (inventory instanceof Map) {
    for (const [key, count] of inventory.entries()) {
      if (typeof key === 'string' && maps.nameToId.has(key)) {
        add(maps.nameToId.get(key), null, key, count)
      } else if (typeof key === 'string' && key.includes('@@')) {
        const [sid, smeta] = key.split('@@')
        const id = /^-?\d+$/.test(sid) ? Number(sid) : sid
        const metadata = smeta === '*' || smeta === '' ? null : (/^-?\d+$/.test(smeta) ? Number(smeta) : smeta)
        add(id, metadata, displayName(id, metadata, maps), count)
      } else if (typeof key === 'number' || /^-?\d+$/.test(String(key))) {
        const id = typeof key === 'number' ? key : Number(key)
        add(id, null, displayName(id, null, maps), count)
      } else {
        add(key, null, String(key), count)
      }
    }
    return stock
  }
  if (Array.isArray(inventory)) {
    for (const entry of inventory) {
      if (!isPlainObject(entry)) throw new TypeError('inventaire : entree objet exigee')
      const count = entry.count !== undefined ? entry.count : (entry.quantity !== undefined ? entry.quantity : undefined)
      if (count === undefined) throw new TypeError('inventaire : champ count exige')
      const metadata = entry.metadata !== undefined ? entry.metadata : (entry.meta !== undefined ? entry.meta : null)
      if (entry.id !== undefined && entry.id !== null) {
        const name = typeof entry.name === 'string' && entry.name !== ''
          ? entry.name
          : displayName(entry.id, metadata ?? null, maps)
        add(entry.id, metadata ?? null, name, count)
      } else if (typeof entry.name === 'string' && entry.name !== '') {
        const id = maps.nameToId.has(entry.name) ? maps.nameToId.get(entry.name) : entry.name
        add(id, metadata ?? null, entry.name, count)
      } else {
        throw new TypeError('inventaire : entree sans id ni nom')
      }
    }
    return stock
  }
  if (isPlainObject(inventory)) {
    for (const [key, count] of Object.entries(inventory)) {
      if (maps.nameToId.has(key)) {
        add(maps.nameToId.get(key), null, key, count)
      } else if (/^-?\d+$/.test(key)) {
        const id = Number(key)
        add(id, null, displayName(id, null, maps), count)
      } else {
        add(key, null, key, count)
      }
    }
    return stock
  }
  throw new TypeError('inventory doit etre une map {nom: quantite}, une liste, ou une Map')
}

function cloneStock (stock) {
  const out = new Map()
  for (const [k, v] of stock.entries()) out.set(k, { id: v.id, metadata: v.metadata, name: v.name, count: v.count })
  return out
}

// Consomme jusqu'a qty depuis le stock simule. Rend la quantite prise.
function consumeStock (stock, needId, needMeta, qty) {
  if (qty <= 0) return 0
  const matching = []
  for (const [k, v] of stock.entries()) {
    if (v.count <= 0) continue
    if (matchesVariant(needId, needMeta, v.id, v.metadata)) matching.push(v)
  }
  // Exact d'abord (variante preservee), generique ensuite. Deterministe.
  matching.sort((a, b) => {
    const aExact = a.metadata !== null && a.metadata !== undefined && needMeta !== null && needMeta !== undefined && String(a.metadata) === String(needMeta) ? 0 : 1
    const bExact = b.metadata !== null && b.metadata !== undefined && needMeta !== null && needMeta !== undefined && String(b.metadata) === String(needMeta) ? 0 : 1
    if (aExact !== bExact) return aExact - bExact
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0
  })
  let taken = 0
  for (const entry of matching) {
    if (taken >= qty) break
    const use = Math.min(entry.count, qty - taken)
    entry.count -= use
    taken += use
  }
  // Compacte les zeros pour garder la simulation lisible (sans changer le sens).
  for (const [k, v] of [...stock.entries()]) {
    if (v.count <= 0) stock.delete(k)
  }
  return taken
}

function creditStock (stock, id, metadata, name, qty) {
  if (qty <= 0) return
  const k = exactKey(id, metadata)
  const prev = stock.get(k)
  if (prev) prev.count += qty
  else stock.set(k, { id, metadata, name, count: qty })
}

function planCraft (args) {
  if (!isPlainObject(args)) throw new TypeError('planCraft({registry,target,count,inventory,limits?}) attendu')
  const { registry, target, count, inventory, limits } = args
  if (!registry || typeof registry !== 'object') throw new TypeError('registry manquant : fournir minecraft-data, bot.registry, ou {recipes}')
  if (registry.recipes === undefined || registry.recipes === null) {
    throw new TypeError('registry.recipes manquant : fournir les donnees du jeu, pas des recettes codees')
  }
  const wanted = count
  if (!Number.isInteger(wanted) || wanted <= 0) throw new TypeError('count doit etre un entier >= 1 (unites d objets)')

  let maxDepth = 12
  let maxOperations = 100
  if (limits !== undefined && limits !== null) {
    if (!isPlainObject(limits)) throw new TypeError('limits doit etre un objet {maxDepth,maxOperations}')
    if (limits.maxDepth !== undefined) {
      if (!Number.isInteger(limits.maxDepth) || limits.maxDepth < 1) throw new TypeError('limits.maxDepth doit etre un entier >= 1')
      maxDepth = limits.maxDepth
    }
    if (limits.maxOperations !== undefined) {
      if (!Number.isInteger(limits.maxOperations) || limits.maxOperations < 1) throw new TypeError('limits.maxOperations doit etre un entier >= 1')
      maxOperations = limits.maxOperations
    }
    if (limits.maxDepth !== undefined && limits.maxOperations !== undefined) {
      // borne explicite anti-explosion : les deux plafonds s'appliquent ensemble
    }
  }

  const maps = buildNameMaps(registry)
  const normTarget = normalizeTarget(target, maps)
  const stock = normalizeInventory(inventory, maps)
  const { normalized: recipes, invalid: invalidRecipes, total: totalRecipes } = collectRecipes(registry)

  const byResult = new Map()
  for (const r of recipes) {
    const k = String(r.result.id)
    if (!byResult.has(k)) byResult.set(k, [])
    byResult.get(k).push(r)
  }
  const findRecipes = (id, metadata) => {
    const list = byResult.get(String(id))
    if (!list) return []
    return list.filter(r => {
      if (metadata === null || metadata === undefined) return true
      if (r.result.metadata === null || r.result.metadata === undefined) return true
      return String(r.result.metadata) === String(metadata)
    })
  }
  // Inconnu = jamais declare : ni produit, ni consomme, ni catalogue, ni stock initial.
  const knownIds = new Set()
  for (const r of recipes) {
    knownIds.add(String(r.result.id))
    for (const ing of r.ingredients) knownIds.add(String(ing.id))
  }
  for (const name of maps.nameToId.keys()) knownIds.add(String(maps.nameToId.get(name)))
  for (const v of stock.values()) knownIds.add(String(v.id))

  const stats = { calls: 0, recipesConsidered: 0, depthMax: 0, invalidRecipes, totalRecipes }

  let limitError = null
  const checkBudget = () => {
    if (stats.recipesConsidered > Math.max(500, maxOperations * 10)) {
      limitError = limitError || 'max-operations'
      return false
    }
    return true
  }

  // Assure qty unites de (id,metadata). Mutile `stock` (deja un clone de branche).
  // Rend {taken, crafted, ops, missing, requiresTable, error}
  function ensure (id, metadata, name, qty, depth, ancestry) {
    stats.calls += 1
    stats.depthMax = Math.max(stats.depthMax, depth)
    if (depth > maxDepth) return { taken: 0, crafted: 0, ops: [], missing: [], requiresTable: false, error: 'max-depth' }
    const selfKey = exactKey(id, metadata)
    if (ancestry.has(selfKey)) return { taken: 0, crafted: 0, ops: [], missing: [], requiresTable: false, error: 'cycle', cycleKey: selfKey }

    const taken = consumeStock(stock, id, metadata, qty)
    const remaining = qty - taken
    if (remaining <= 0) {
      return { taken, crafted: 0, ops: [], missing: [], requiresTable: false, error: null }
    }

    const candidates = findRecipes(id, metadata)
    if (candidates.length === 0) {
      const known = knownIds.has(String(id))
      return {
        taken,
        crafted: 0,
        ops: [],
        missing: [{ id, metadata, name, count: remaining, reason: known ? 'no-recipe' : 'unknown' }],
        requiresTable: false,
        error: null
      }
    }

    // Evaluation deterministe : tri par index de recette.
    const ordered = [...candidates].sort((a, b) => a.index - b.index)
    let best = null

    for (const recipe of ordered) {
      stats.recipesConsidered += 1
      if (!checkBudget()) {
        const err = { taken, crafted: 0, ops: [], missing: [], requiresTable: false, error: 'max-operations' }
        if (!best || best.error === 'cycle') best = err
        continue
      }
      if (limitError) continue
      const perCraft = recipe.result.count
      if (!Number.isInteger(perCraft) || perCraft <= 0) continue
      const repeats = Math.ceil(remaining / perCraft)
      const outputTotal = repeats * perCraft
      const branchStock = cloneStock(stock)
      // Isole la branche : la recursion travaille sur branchStock via echange temporaire.
      const savedStock = stock
      // Note : `ensure` utilise la variable `stock` du dessus via closure ;
      // on la permute pour la branche. Restauree dans tous les cas.
      let branchResult
      try {
        // Remplace le contenu de `stock` par le clone pour la recursion.
        savedStock.clear()
        for (const [k, v] of branchStock.entries()) savedStock.set(k, v)
        const nextAncestry = new Set(ancestry)
        nextAncestry.add(selfKey)
        const subOps = []
        const subMissing = []
        let subRequiresTable = false
        let branchError = null
        let branchCycleKey = null
        // Ordre deterministe des ingredients (stock partage coherent).
        const needs = [...recipe.ingredients].sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0)
        for (const ing of needs) {
          const needQty = ing.count * repeats
          const ingName = ing.nameHint || displayName(ing.id, ing.metadata, maps)
          const r = ensure(ing.id, ing.metadata, ingName, needQty, depth + 1, nextAncestry)
          subOps.push(...r.ops)
          subMissing.push(...r.missing)
          subRequiresTable = subRequiresTable || r.requiresTable
          if (r.error) {
            // cycle/profondeur/limite : la branche est invalide, on arrete ses ingredients.
            branchError = r.error
            branchCycleKey = r.cycleKey ?? null
            break
          }
          if (subOps.length > maxOperations) {
            branchError = 'max-operations'
            break
          }
        }
        if (branchError) {
          branchResult = { recipe, repeats, outputTotal, ops: subOps, missing: subMissing, requiresTable: subRequiresTable, error: branchError, cycleKey: branchCycleKey }
        } else {
          const surplus = outputTotal - remaining
          if (surplus > 0) {
            const rname = recipe.result.nameHint || displayName(recipe.result.id, recipe.result.metadata, maps)
            creditStock(savedStock, recipe.result.id, recipe.result.metadata, rname, surplus)
          }
          const ingredients = recipe.ingredients.map(ing => ({
            id: ing.id,
            name: ing.nameHint || displayName(ing.id, ing.metadata, maps),
            metadata: ing.metadata,
            count: ing.count * repeats
          }))
          const op = {
            target: { id: recipe.result.id, name: recipe.result.nameHint || displayName(recipe.result.id, recipe.result.metadata, maps), metadata: recipe.result.metadata },
            repeats,
            demand: remaining,
            outputPerCraft: perCraft,
            outputTotal,
            requiresTable: recipe.requiresTable,
            ingredients,
            provenance: { source: 'recipes', kind: recipe.kind, recipeIndex: recipe.index }
          }
          const ops = [...subOps, op]
          if (ops.length > maxOperations) {
            branchResult = { recipe, repeats, outputTotal, ops, missing: subMissing, requiresTable: subRequiresTable || recipe.requiresTable, error: 'max-operations' }
          } else {
            branchResult = { recipe, repeats, outputTotal, ops, missing: subMissing, requiresTable: subRequiresTable || recipe.requiresTable, error: null }
          }
        }
      } finally {
        // Capture l'etat de branche puis restaure le stock d'entree.
        branchResult.branchStock = cloneStock(savedStock)
        savedStock.clear()
        for (const [k, v] of branchStock.entries()) savedStock.set(k, v)
        // NOTE : branchStock etait le clone initial ; savedStock (== stock externe)
        // contient maintenant l'etat mute par la recursion. On le remplace par la
        // capture si cette branche est finalement choisie (plus bas).
        branchResult._restore = branchResult.branchStock
      }

      const score = (b) => {
        if (!b) return null
        if (b.error) return { hard: 1, rank: b.error === 'cycle' ? 0 : b.error === 'max-depth' ? 1 : 2, missing: Infinity, ops: Infinity }
        const missingSum = b.missing.reduce((s, m) => s + m.count, 0)
        return { hard: 0, rank: 0, missing: missingSum, ops: b.ops.length }
      }
      const sNew = score(branchResult)
      const sBest = score(best)
      let take = false
      if (!best) take = true
      else if (sBest.hard !== sNew.hard) take = sNew.hard < sBest.hard
      else if (sBest.hard === 1) take = sNew.rank < sBest.rank
      else if (sNew.missing !== sBest.missing) take = sNew.missing < sBest.missing
      else if (sNew.ops !== sBest.ops) take = sNew.ops < sBest.ops
      else {
        // Dernier departage deterministe : moins de surplus, puis index bas.
        const surplusNew = branchResult.outputTotal - remaining
        const surplusBest = best.outputTotal - remaining
        if (surplusNew !== surplusBest) take = surplusNew < surplusBest
        else take = branchResult.recipe.index < best.recipe.index
      }
      if (take) {
        best = branchResult
        best._chosenStock = branchResult._restore
        // Succes parfait minimal : on peut arreter l'exploration.
        if (!best.error && best.missing.length === 0 && best.ops.length > 0) {
          // Continue quand meme si une recette ulterieure ferait moins d'ops ?
          // Non : l'ordre est par index, pas par cout. On explore tout pour
          // garantir le choix stock/min-ops, sauf budget epuise.
        }
      }
      // Restaure le stock d'entree avant la prochaine candidate.
      stock.clear()
      for (const [k, v] of branchStock.entries()) stock.set(k, v)
    }

    if (!best) {
      return { taken, crafted: 0, ops: [], missing: [{ id, metadata, name, count: remaining, reason: 'no-recipe' }], requiresTable: false, error: null }
    }
    // Toutes les recettes ramenent a l objet lui-meme (lingot <-> pepites,
    // lingot <-> bloc) : il ne se fabrique pas, il s obtient ailleurs (cuisson,
    // recolte). Manquant, pas une erreur : sinon « ingredients manquants » sans
    // rien nommer (craft/iron-pickaxe 453d7f4).
    if (best.error === 'cycle' && best.cycleKey === selfKey) {
      return { taken, crafted: 0, ops: [], missing: [{ id, metadata, name, count: remaining, reason: 'no-recipe' }], requiresTable: false, error: null }
    }
    if (best.error) {
      return { taken: 0, crafted: 0, ops: best.ops || [], missing: best.missing || [], requiresTable: false, error: best.error, cycleKey: best.cycleKey }
    }
    // Applique l'etat de stock de la branche choisie.
    stock.clear()
    for (const [k, v] of best._chosenStock.entries()) stock.set(k, v)
    return { taken, crafted: best.outputTotal, ops: best.ops, missing: best.missing, requiresTable: best.requiresTable, error: null }
  }

  const ancestry = new Set()
  const top = ensure(normTarget.id, normTarget.metadata, normTarget.name, wanted, 0, ancestry)

  if (top.error === 'cycle') {
    return Object.freeze({
      ok: false,
      reason: 'cycle',
      target: { id: normTarget.id, name: normTarget.name, metadata: normTarget.metadata, wanted },
      quantity: { wanted, planned: top.taken },
      operations: Object.freeze([]),
      requiresTable: false,
      missing: Object.freeze([]),
      surplus: Object.freeze([]),
      provenance: Object.freeze({ source: 'recipes', origine: 'donnees-jeu', recettes: recipes.length }),
      stats: Object.freeze({ depthMax: stats.depthMax, operations: 0, recipesConsidered: stats.recipesConsidered, invalidRecipes })
    })
  }
  if (top.error === 'max-depth') {
    return Object.freeze({
      ok: false,
      reason: 'max-depth',
      target: { id: normTarget.id, name: normTarget.name, metadata: normTarget.metadata, wanted },
      quantity: { wanted, planned: top.taken },
      operations: Object.freeze([]),
      requiresTable: false,
      missing: Object.freeze([]),
      surplus: Object.freeze([]),
      provenance: Object.freeze({ source: 'recipes', origine: 'donnees-jeu', recettes: recipes.length }),
      stats: Object.freeze({ depthMax: stats.depthMax, operations: 0, recipesConsidered: stats.recipesConsidered, invalidRecipes })
    })
  }
  if (top.error === 'max-operations' || limitError === 'max-operations') {
    return Object.freeze({
      ok: false,
      reason: 'max-operations',
      target: { id: normTarget.id, name: normTarget.name, metadata: normTarget.metadata, wanted },
      quantity: { wanted, planned: top.taken },
      operations: Object.freeze([]),
      requiresTable: false,
      missing: Object.freeze([]),
      surplus: Object.freeze([]),
      provenance: Object.freeze({ source: 'recipes', origine: 'donnees-jeu', recettes: recipes.length }),
      stats: Object.freeze({ depthMax: stats.depthMax, operations: 0, recipesConsidered: stats.recipesConsidered, invalidRecipes })
    })
  }

  // Agrege les manquants par (id,metadata) : ressources a obtenir, pas inventees.
  const missingAgg = new Map()
  for (const m of top.missing) {
    const k = exactKey(m.id, m.metadata)
    const prev = missingAgg.get(k)
    if (prev) prev.count += m.count
    else missingAgg.set(k, { id: m.id, name: m.name || displayName(m.id, m.metadata, maps), metadata: m.metadata, count: m.count, reason: m.reason || 'no-recipe' })
  }
  const missing = [...missingAgg.values()].sort((a, b) => String(a.id) < String(b.id) ? -1 : 1)
  // Surplus brut par operationrave (outputTotal - demand), derive du chemin choisi
  // uniquement : pas de pollution par les branches ecartees. Le stock partage
  // simulé a deja reutilise ces excedents quand c'etait possible (pas de double craft).
  const surplusAgg = new Map()
  for (const o of top.ops) {
    const extra = o.outputTotal - (o.demand || o.outputTotal)
    if (extra > 0) {
      const k = exactKey(o.target.id, o.target.metadata)
      const prev = surplusAgg.get(k)
      if (prev) prev.count += extra
      else surplusAgg.set(k, { id: o.target.id, name: o.target.name, metadata: o.target.metadata, count: extra })
    }
  }
  const surplus = [...surplusAgg.values()]
    .sort((a, b) => String(a.id) < String(b.id) ? -1 : 1)

  const planned = top.taken + top.crafted
  const ok = missing.length === 0
  const requiresTable = top.ops.some(o => o.requiresTable)

  return Object.freeze({
    ok,
    reason: ok ? null : (missing.some(m => m.reason === 'unknown') && missing.length > 0 && top.ops.length === 0 && !knownIds.has(String(normTarget.id)) ? 'unknown' : 'missing'),
    target: Object.freeze({ id: normTarget.id, name: normTarget.name, metadata: normTarget.metadata, wanted }),
    quantity: Object.freeze({ wanted, planned }),
    operations: Object.freeze(top.ops.map(o => Object.freeze({
      target: Object.freeze({ ...o.target }),
      repeats: o.repeats,
      demand: o.demand,
      outputPerCraft: o.outputPerCraft,
      outputTotal: o.outputTotal,
      requiresTable: o.requiresTable,
      ingredients: Object.freeze(o.ingredients.map(i => Object.freeze({ ...i }))),
      provenance: Object.freeze({ ...o.provenance })
    }))),
    requiresTable,
    missing: Object.freeze(missing.map(m => Object.freeze({ ...m }))),
    surplus: Object.freeze(surplus.map(s => Object.freeze({ ...s }))),
    provenance: Object.freeze({ source: 'recipes', origine: 'donnees-jeu', recettes: recipes.length }),
    stats: Object.freeze({ depthMax: stats.depthMax, operations: top.ops.length, recipesConsidered: stats.recipesConsidered, invalidRecipes })
  })
}

module.exports = { planCraft }
