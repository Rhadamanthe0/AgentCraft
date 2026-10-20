'use strict'

// Solveur deterministe de prerequis : « que faut-il faire, dans quel ordre,
// pour obtenir N objets X a partir de cet inventaire ? ».
//
// PUR : aucune entree/sortie, aucun appel au modele. Il etend planCraft
// (recettes seules) aux trois autres manieres d obtenir un objet :
//   - le recolter : blocs dont les drops contiennent l objet (donnees du jeu),
//     avec l outil exige par ces blocs (`harvestTools`), obtenu d abord ;
//   - le cuire au four (table SMELT, reprise de Mindcraft, licence MIT) ;
//   - sinon : introuvable, dit tel quel, jamais un succes invente.
// Idee de GITM / Mindcraft (getDetailedCraftingPlan) : le code connait l arbre
// des technologies, le modele choisit quoi faire de ce plan. Le plan se
// recalcule sur l inventaire reel a chaque tour : la premiere etape est
// toujours la prochaine chose a faire.
//
// Variantes : planCraft choisit une essence arbitraire quand l inventaire est
// vide (cherry_log, cobbled_deepslate). Un manquant d une famille connue
// (bois, pierre...) est remplace par la variante preferee de sa famille si la
// recette l accepte : d abord `prefer` (ce qui est visible autour du bot),
// puis l ordre des blocs de la matiere (skills.RESOURCES).

const { planCraft } = require('./recipe-plan')

// Cuisson au four : produit -> ingredient cru (Mindcraft, src/utils/mcdata.js).
const SMELT = {
  baked_potato: 'potato',
  cooked_beef: 'beef',
  cooked_chicken: 'chicken',
  cooked_cod: 'cod',
  cooked_mutton: 'mutton',
  cooked_porkchop: 'porkchop',
  cooked_rabbit: 'rabbit',
  cooked_salmon: 'salmon',
  dried_kelp: 'kelp',
  iron_ingot: 'raw_iron',
  gold_ingot: 'raw_gold',
  copper_ingot: 'raw_copper',
  glass: 'sand',
  stone: 'cobblestone',
  smooth_stone: 'stone',
  charcoal: 'oak_log'
}

// Equivalences de recette que la famille de matiere ne dit pas : une torche
// se fait au charbon (mine) comme au charbon de bois (cuit).
const EQUIV = { charcoal: ['coal'], coal: ['charcoal'] }

// Outils du moins cher au plus cher : on vise toujours le premier fabricable.
const TIERS = ['wooden', 'stone', 'copper', 'iron', 'golden', 'diamond', 'netherite']
function tierRank (name) {
  const i = TIERS.findIndex(t => name.startsWith(`${t}_`))
  return i < 0 ? TIERS.length : i
}

function itemName (registry, id) {
  return registry.items?.[id]?.name ?? registry.itemsArray?.find(i => i.id === id)?.name ?? null
}

function dropIds (block) {
  return (block.drops ?? []).map(d => (typeof d === 'object' && d !== null ? (d.drop?.id ?? d.drop ?? d.id) : d))
}

// Matiere (cle de RESOURCES) d un nom d objet ou de bloc, sinon null.
function resourceOf (resources, name) {
  if (!resources || !name) return null
  for (const [key, spec] of Object.entries(resources)) {
    if (key === 'aucune') continue
    if (spec.blocks?.includes(name)) return key
  }
  for (const [key, spec] of Object.entries(resources)) {
    if (key === 'aucune') continue
    if (spec.items instanceof RegExp && spec.items.test(name)) return key
  }
  return null
}

// Matiere d un bloc naturel : seulement les blocs listes (des planches posees
// ne sont pas une source de bois).
function blockResource (resources, name) {
  if (!resources || !name) return null
  for (const [key, spec] of Object.entries(resources)) {
    if (key !== 'aucune' && spec.blocks?.includes(name)) return key
  }
  return null
}

function planAcquire (args) {
  const { registry, target, count = 1, inventory = {}, resources = null, prefer = [], tableNearby = false, furnaceNearby = false, charbonVu = false } = args ?? {}
  if (!registry?.itemsByName) throw new TypeError('registry manquant (minecraft-data ou bot.registry)')
  const maxSteps = args?.maxSteps ?? 40
  const stock = new Map()
  for (const [k, v] of Object.entries(inventory)) if (v > 0) stock.set(k, v)
  if (tableNearby) stock.set('crafting_table', Math.max(1, stock.get('crafting_table') ?? 0))
  if (furnaceNearby) stock.set('furnace', Math.max(1, stock.get('furnace') ?? 0))
  const steps = []
  const blocked = []
  const have = n => stock.get(n) ?? 0
  const add = (n, q) => stock.set(n, have(n) + q)
  const take = (n, q) => stock.set(n, Math.max(0, have(n) - q))

  // Variante preferee d une famille : visible d abord, puis l ordre des blocs
  // de la matiere (leurs drops), puis le nom lui-meme.
  function variantsFor (name) {
    const res = resourceOf(resources, name)
    const out = []
    const push = n => { if (n && !out.includes(n) && resourceOf(resources, n) === res) out.push(n) }
    for (const p of prefer) push(p)
    for (const b of resources?.[res]?.blocks ?? []) {
      const block = registry.blocksByName?.[b]
      for (const id of block ? dropIds(block) : []) push(itemName(registry, id))
    }
    return res ? out : []
  }

  // Blocs qui lachent l objet, le plus simple d abord : sans outil, puis
  // dans l ordre des blocs de sa matiere (le naturel d abord : stone avant
  // cobblestone), puis le bloc du meme nom.
  function sourcesOf (name) {
    const id = registry.itemsByName[name]?.id
    if (id === undefined) return []
    const blocks = (registry.blocksArray ?? Object.values(registry.blocks ?? {}))
      .filter(b => dropIds(b).includes(id))
    const score = b => {
      const res = blockResource(resources, b.name)
      const idx = res ? resources[res].blocks.indexOf(b.name) : -1
      return (b.harvestTools ? 2 : 0) + (idx >= 0 ? idx * 0.01 : (b.name === name ? 4 : 5))
    }
    return blocks.sort((a, b) => score(a) - score(b))
  }

  // Recettes a plat d un objet : ingredients par execution et nombre produit.
  function recipesOf (name) {
    const id = registry.itemsByName[name]?.id
    const raw = id === undefined ? [] : [].concat(registry.recipes?.[id] ?? [])
    const out = []
    for (const r of raw) {
      const cells = r.inShape ? r.inShape.flat() : (r.ingredients ?? [])
      const ingredients = new Map()
      for (const c of cells) {
        const cid = c && typeof c === 'object' ? c.id : c
        if (cid === null || cid === undefined || cid === -1) continue
        const n = itemName(registry, cid)
        if (!n) continue
        ingredients.set(n, (ingredients.get(n) ?? 0) + 1)
      }
      if (ingredients.size) out.push({ ingredients, count: r.result?.count ?? 1 })
    }
    return out
  }

  function hasRecipe (name) {
    const id = registry.itemsByName[name]?.id
    const list = id === undefined ? null : registry.recipes?.[id]
    return Array.isArray(list) ? list.length > 0 : Boolean(list)
  }

  function toolFor (block) {
    if (!block.harvestTools) return { ok: true, tool: null }
    const tools = Object.keys(block.harvestTools).map(i => itemName(registry, Number(i))).filter(Boolean)
    const owned = tools.find(t => have(t) > 0)
    if (owned) return { ok: true, tool: owned }
    return { ok: false, tools: tools.sort((a, b) => tierRank(a) - tierRank(b)) }
  }

  // Remplace les variantes manquantes par les preferees quand la recette les
  // accepte (stock fictif de la variante, re-planification). Rend une table
  // manquant -> variante.
  function substitutions (plan, qty) {
    const subs = new Map()
    for (const m of plan.missing) {
      const candidates = variantsFor(m.name).concat(EQUIV[m.name] ?? [])
      for (const v of candidates) {
        if (v === m.name) break
        const trial = new Map(stock)
        trial.set(v, (trial.get(v) ?? 0) + m.count * 4)
        const p = planCraft({ registry, target: plan.target.name, count: qty, inventory: Object.fromEntries(trial) })
        if (!p.missing.some(x => x.name === m.name || x.name === v)) {
          subs.set(m.name, v)
          break
        }
      }
    }
    return subs
  }

  // Trois manieres d obtenir un objet, essayees dans l ordre ; une voie qui
  // echoue est defaite (stock, etapes, blocages) avant la suivante. Le lingot
  // de fer a une recette (neuf pepites) mais se cuit : la cuisson passe avant
  // la recette.
  function ensure (name, qty, depth, chain) {
    if (have(name) >= qty) return true
    if (steps.length >= maxSteps) { blocked.push({ objet: name, raison: 'plan trop long' }); return false }
    if (depth > 10 || chain.includes(name)) { blocked.push({ objet: name, raison: 'cycle de prerequis' }); return false }
    const ctx = { name, qty, depth, next: chain.concat(name) }
    // Un objet qu un bloc naturel connu lache (minerai, pierre) se recolte
    // avant de se fabriquer : raw_iron vient du minerai, pas du bloc de 9.
    const natural = sourcesOf(name).some(b => blockResource(resources, b.name))
    const ways = natural
      ? [bySource, bySmelt, byRecipe]
      : (SMELT[name] ? [bySmelt, byRecipe, bySource] : [byRecipe, bySource, bySmelt])
    let firstFailure = null
    for (const way of ways) {
      const saved = { stock: new Map(stock), steps: steps.length, blocked: blocked.length }
      const result = way(ctx)
      if (result === true) return true
      if (result === false && !firstFailure) firstFailure = blocked.slice(saved.blocked)
      stock.clear()
      for (const [k, v] of saved.stock) stock.set(k, v)
      steps.length = saved.steps
      blocked.length = saved.blocked
    }
    if (firstFailure?.length) blocked.push(...firstFailure)
    else blocked.push({ objet: name, raison: 'ni recette, ni cuisson, ni bloc source' })
    return false
  }

  // Voie recette : null = pas de recette, false = ingredients introuvables.
  function byRecipe ({ name, qty, depth, next }) {
    if (!hasRecipe(name)) return null
    // planCraft compte le stock de la cible : on lui demande le total vise.
    const replan = () => planCraft({ registry, target: name, count: qty, inventory: Object.fromEntries(stock) })
    let plan
    try { plan = replan() } catch (_) { return null }
    // L etabli d abord : fabrique apres coup, il mangeait les planches
    // comptees pour la recette.
    if (plan.requiresTable && have('crafting_table') === 0 && name !== 'crafting_table') {
      if (!ensure('crafting_table', 1, depth + 1, next)) return false
      plan = replan()
    }
    for (let round = 0; round < 4 && !plan.ok; round++) {
      const subs = substitutions(plan, qty)
      for (const m of plan.missing) {
        const n = subs.get(m.name) ?? m.name
        if (!ensure(n, have(n) + m.count, depth + 1, next)) return false
      }
      plan = replan()
    }
    // Cycle de recettes (lingot <-> pepites <-> bloc) : planCraft refuse tout.
    // On descend alors d un seul niveau : ingredients d une recette obtenus
    // chacun par sa meilleure voie (cuisson du lingot), puis re-planification.
    if (!plan.ok && plan.missing.length === 0 && ['cycle', 'max-depth'].includes(plan.reason)) {
      for (const recipe of recipesOf(name)) {
        const repeats = Math.ceil((qty - have(name)) / recipe.count)
        const saved = { stock: new Map(stock), steps: steps.length, blocked: blocked.length }
        let good = true
        for (const [ing, n] of recipe.ingredients) {
          if (!ensure(ing, n * repeats, depth + 1, next)) { good = false; break }
        }
        if (good) { plan = replan(); if (plan.ok) break }
        stock.clear()
        for (const [k, v] of saved.stock) stock.set(k, v)
        steps.length = saved.steps
        blocked.length = saved.blocked
      }
    }
    if (!plan.ok) { blocked.push({ objet: name, raison: 'ingredients introuvables' }); return false }
    for (const op of plan.operations) {
      for (const ing of op.ingredients) take(ing.name, ing.count)
      add(op.target.name, op.outputTotal)
      steps.push({ op: 'fabriquer', objet: op.target.name, quantite: op.outputTotal, etabli: Boolean(op.requiresTable) })
    }
    return have(name) >= qty
  }

  // Voie four : action `cuire` (craft.smelt), combustible compte en planches.
  function bySmelt ({ name, qty, depth, next }) {
    if (!SMELT[name]) return null
    const need = qty - have(name)
    let raw = SMELT[name]
    // Une autre essence deja en poche fait l affaire (charbon de bois : toute
    // buche), jamais un autre objet de la matiere (minerai : fer != charbon).
    const suffix = n => n.slice(n.lastIndexOf('_'))
    if (have(raw) === 0) raw = variantsFor(raw).find(v => have(v) > 0 && suffix(v) === suffix(raw)) ?? raw
    // `ensure(x, n)` vise un STOCK de n : le cru deja en poche compte (avant :
    // have + need, le plan redemandait toujours autant de minerai qu il en
    // tenait deja, iron-pickaxe 45ee8cf et 453d7f4).
    if (!ensure(raw, need, depth + 1, next)) return false
    if (have('furnace') === 0 && !ensure('furnace', 1, depth + 1, next)) return false
    // Combustible deja en poche, toute essence (charbon, buches, planches ;
    // jamais le cru) : avant, seules les oak_planks comptaient (iron-pickaxe
    // b7421cc : 4 birch_planks en poche, « recolter 1 oak_log » sans arbre).
    const FUEL = [[/^(coal|charcoal)$/, 8], [/_log$|_stem$/, 1.5], [/_planks$/, 1.5], [/^stick$/, 0.5]]
    let reste = need
    const brule = []
    for (const [motif, par] of FUEL) {
      for (const [nom, n] of [...stock]) {
        if (reste <= 0 || nom === raw || !motif.test(nom) || n <= 0) continue
        const pris = Math.min(n, Math.ceil(reste / par))
        brule.push([nom, pris])
        reste -= pris * par
      }
    }
    // Charbon en vue : un minerai cuit 8 objets, une buche 1,5. Sans lui, le
    // dernier bois de l arene partait en combustible et le minecart restait
    // sans cuisson, charbon a cote (composite/powered-rail-line~aleatoire
    // a309ebc : 20 min a chercher un arbre).
    if (reste > 0 && charbonVu && raw !== 'coal' && raw !== 'oak_log') {
      const n = Math.ceil(reste / 8)
      const saved = { stock: new Map(stock), steps: steps.length, blocked: blocked.length }
      if (ensure('coal', have('coal') + n, depth + 1, next)) {
        brule.push(['coal', n])
        reste = 0
      } else {
        stock.clear()
        for (const [k, v] of saved.stock) stock.set(k, v)
        steps.length = saved.steps
        blocked.length = saved.blocked
      }
    }
    if (reste > 0) {
      const planches = prefer.find(p => /_planks$/.test(p)) ?? 'oak_planks'
      const manque = Math.ceil(reste / 1.5)
      if (!ensure(planches, have(planches) + manque, depth + 1, next)) return false
      brule.push([planches, manque])
    }
    take(raw, need)
    for (const [nom, n] of brule) take(nom, n)
    add(name, need)
    steps.push({ op: 'cuire', objet: name, quantite: need, depuis: raw })
    return true
  }

  // Voie recolte : le bloc source le plus simple, son outil obtenu d abord.
  function bySource ({ name, qty, depth, next }) {
    const sources = sourcesOf(name)
    if (sources.length === 0) return null
    const need = qty - have(name)
    const block = sources[0]
    const tool = toolFor(block)
    let outil = tool.tool
    if (!tool.ok) {
      const pick = tool.tools.find(t => registry.itemsByName[t]) ?? tool.tools[0]
      if (!ensure(pick, 1, depth + 1, next)) return false
      outil = pick
    }
    add(name, need)
    const matiere = blockResource(resources, block.name)
    steps.push({ op: 'recolter', objet: name, quantite: need, bloc: block.name, matiere, outil: outil ?? null })
    if (!matiere) blocked.push({ objet: name, raison: `aucune matiere du bot ne vise le bloc ${block.name}` })
    return true
  }

  const ok = ensure(target, have(target) + count, 0, [])
  return {
    ok: ok && blocked.length === 0,
    cible: target,
    quantite: count,
    etapes: steps,
    bloque: blocked
  }
}

// Resume pour le modele : prochaine etape, matieres brutes a recolter
// (totaux), fabrications dans l ordre (sans doublons), blocages.
function summarize (plan) {
  const recolter = new Map()
  const fabriquer = []
  for (const s of plan.etapes) {
    if (s.op === 'recolter') {
      const prev = recolter.get(s.objet)
      recolter.set(s.objet, { objet: s.objet, quantite: (prev?.quantite ?? 0) + s.quantite, matiere: s.matiere, outil: s.outil, bloc: s.bloc })
    } else {
      const label = s.op === 'cuire' ? `cuire ${s.objet}` : s.objet
      const i = fabriquer.indexOf(label)
      if (i >= 0) fabriquer.splice(i, 1)
      fabriquer.push(label)
    }
  }
  const first = plan.etapes[0] ?? null
  return {
    complet: plan.ok,
    prochaine_etape: first ? describe({ etapes: [first] }, 1)[0] : null,
    a_recolter: [...recolter.values()].map(r => `${r.quantite} ${r.objet}${r.matiere ? ` (matiere ${r.matiere})` : ''}${r.outil ? `, outil ${r.outil}` : ''}`),
    a_fabriquer_dans_l_ordre: fabriquer,
    bloque: plan.bloque.map(b => `${b.objet} : ${b.raison}`)
  }
}

// Vue compacte pour l etat du planificateur : une ligne par etape.
function describe (plan, max = 8) {
  const lines = plan.etapes.slice(0, max).map(s => {
    if (s.op === 'recolter') return `recolter ${s.quantite} ${s.objet} (bloc ${s.bloc}${s.matiere ? `, matiere ${s.matiere}` : ''}${s.outil ? `, outil ${s.outil}` : ''})`
    if (s.op === 'cuire') return `cuire ${s.quantite} ${s.objet} depuis ${s.depuis}`
    return `fabriquer ${s.quantite} ${s.objet}${s.etabli ? ' (etabli)' : ''}`
  })
  if (plan.etapes.length > max) lines.push(`... ${plan.etapes.length - max} etape(s) de plus`)
  return lines
}

module.exports = { planAcquire, describe, summarize, SMELT }
