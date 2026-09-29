'use strict'

// Fabrication, outillage et lecture d inventaire.
//
// Ce module ne parle jamais au modele, exactement comme build.js : le modele choisit
// « fabriquer » puis « une porte », tout le reste (quelles recettes existent, ce
// qu il faut comme ingredients, combien d exemplaires on peut faire) est mesure
// ici a partir de l inventaire reel et du registre du serveur.
//
// Trois contraintes dictent la forme du code :
//
//   1. `bot.recipesFor(id, null, 1, table)` ne renvoie que les recettes dont les
//      ingredients sont **deja en inventaire**. C est donc lui, et pas une table
//      d ingredients ecrite a la main, qui dit ce qui est faisable maintenant.
//      La faisabilite est gratuite et toujours juste ; on ne la recalcule pas.
//   2. Une recette 3x3 (porte, outils) exige un etabli **pose et a portee**.
//      `ensureTable()` en trouve un, en pose un, ou en fabrique un d abord.
//   3. L essence du bois n est pas connue d avance : le bot coupe ce qu il
//      trouve. Tous les noms d objets sont donc derives de l inventaire
//      (`oak_log` -> `oak_planks` -> `oak_door`) et jamais codes en dur.

const Vec3 = require('vec3').Vec3
const build = require('./build')
const { planCraft } = require('./recipe-plan')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Du meilleur au moins bon : sert a la fois a equiper l outil le plus efficace
// et a proposer la meilleure fabrication possible (pioche en pierre plutot
// qu en bois si le bot a deja de la pierre).
const MATERIAL_RANK = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']

// Quel outil accelere — ou autorise — la casse de ce bloc. L ordre compte : un
// `mossy_cobblestone` doit repondre pioche avant de repondre autre chose.
const TOOL_FOR_BLOCK = [
  [/_log$|_wood$|_stem$|_hyphae$|_planks$|crafting_table|chest|_door$|_fence$/, 'axe'],
  [/stone|cobble|deepslate|granite|diorite|andesite|tuff|_ore$|obsidian|furnace|brick/, 'pickaxe'],
  [/dirt|grass_block|podzol|mud|clay|sand|gravel|snow|soul_soil|farmland/, 'shovel']
]

// ---------------------------------------------------------------------------
// Lecture d inventaire
// ---------------------------------------------------------------------------

function items (bot) {
  return bot?.inventory ? bot.inventory.items() : []
}

function countOf (bot, pattern) {
  return items(bot).reduce(
    (sum, item) => sum + (pattern.test(item.name) ? item.count : 0), 0)
}

function findItem (bot, name) {
  return items(bot).find(item => item.name === name) ?? null
}

// L objet le plus abondant qui corresponde au motif. Sert a choisir l essence :
// on fabrique dans le bois dont on a le plus, pas dans un bois arbitraire.
function mostAbundant (bot, pattern) {
  let best = null
  const totals = new Map()

  for (const item of items(bot)) {
    if (!pattern.test(item.name)) continue
    totals.set(item.name, (totals.get(item.name) ?? 0) + item.count)
  }

  for (const [name, count] of totals) {
    if (!best || count > best.count) best = { name, count }
  }
  return best
}

// `oak_log` -> `oak_planks`, `crimson_stem` -> `crimson_planks`.
function plankNameFor (logName) {
  return String(logName).replace(/_log$|_wood$|_stem$|_hyphae$/, '') + '_planks'
}

// `oak_planks` -> `oak`.
function woodPrefix (plankName) {
  return String(plankName).replace(/_planks$/, '')
}

// Etat des stocks, tel qu il part dans l etat de mission a chaque tour. C est
// ce qui permet au modele de choisir « fabriquer » plutot que « construire » quand
// il n y a plus rien a poser, sans qu aucun enchainement soit code en dur.
function snapshot (bot) {
  const tools = {}
  for (const kind of ['axe', 'pickaxe', 'shovel']) {
    const held = bestToolOfKind(bot, kind)
    tools[kind] = held ? held.name : null
  }

  return {
    buches: countOf(bot, /_log$|_wood$|_stem$|_hyphae$/),
    planches: countOf(bot, /_planks$/),
    batons: countOf(bot, /^stick$/),
    etablis: countOf(bot, /^crafting_table$/),
    portes: countOf(bot, /_door$/),
    pierre: countOf(bot, /^(cobblestone|cobbled_deepslate|stone)$/),
    outils: {
      hache: tools.axe,
      pioche: tools.pickaxe,
      pelle: tools.shovel
    }
  }
}

// ---------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------

function toolKindFor (blockName) {
  for (const [pattern, kind] of TOOL_FOR_BLOCK) {
    if (pattern.test(blockName)) return kind
  }
  return null
}

// Le meilleur outil de ce type present en inventaire, ou null.
function bestToolOfKind (bot, kind) {
  if (!kind) return null

  let best = null
  let bestRank = MATERIAL_RANK.length

  for (const item of items(bot)) {
    if (!item.name.endsWith(`_${kind}`)) continue
    const material = item.name.slice(0, -kind.length - 1)
    const rank = MATERIAL_RANK.indexOf(material)
    if (rank === -1) continue
    if (rank < bestRank) {
      best = item
      bestRank = rank
    }
  }

  return best
}

// Un bloc qui exige un outil (pierre, minerais) casse quand meme a la main,
// mais **ne lache rien**. Compter une reussite dans ce cas rendrait une mission
// de recolte interminable sans jamais dire pourquoi : on verifie avant.
function harvestCheck (bot, block) {
  if (!block) return { ok: false, need: null, reason: 'aucun bloc' }

  const needed = block.harvestTools ? Object.keys(block.harvestTools).map(Number) : null
  if (!needed || needed.length === 0) return { ok: true, need: null }

  const held = items(bot).find(item => needed.includes(item.type))
  if (held) return { ok: true, need: null }

  const kind = toolKindFor(block.name) ?? 'pickaxe'
  const french = { axe: 'hache', pickaxe: 'pioche', shovel: 'pelle' }[kind]
  // Outil le plus modeste qui convient : « une pioche » trompait le modele
  // quand il en tenait deja une trop faible (bois sur du fer).
  const TIERS = ['wooden', 'golden', 'stone', 'copper', 'iron', 'diamond', 'netherite']
  const noms = needed.map(id => bot.registry?.items?.[id]?.name).filter(Boolean)
  const minimal = noms.sort((a, b) => TIERS.indexOf(a.split('_')[0]) - TIERS.indexOf(b.split('_')[0]))[0]
  const need = minimal && minimal !== `wooden_${kind}` ? `${french} (${minimal} ou mieux)` : french
  return {
    ok: false,
    need,
    reason: `${block.name} ne lache rien sans ${need}`
  }
}

// Equipe l outil adapte avant de creuser. Sans outil adapte on creuse a la main :
// c est lent mais valide pour le bois, la terre et la vegetation.
async function equipForBlock (bot, block) {
  if (!block) return null

  const kind = toolKindFor(block.name)
  const tool = bestToolOfKind(bot, kind)
  if (!tool) return null
  if (bot.heldItem && bot.heldItem.name === tool.name) return tool.name

  try {
    await bot.equip(tool, 'hand')
    return tool.name
  } catch (err) {
    return null
  }
}

// ---------------------------------------------------------------------------
// Recettes
//
// Les cibles courtes, nommees dans les mots du joueur : servies au modele comme
// suggestions (`fabrications_possibles`) ; `fabriquer` accepte aussi tout objet
// du registre. Chacune resout son nom d objet reel a partir de l inventaire,
// puis demande au jeu si la recette est faisable.
// ---------------------------------------------------------------------------

const TARGETS = {
  planches: {
    summary: 'transformer des buches en planches',
    intent: "Il faut des planches : transformer en planches les buches que le bot a coupees. C est la premiere transformation de tout travail du bois",
    resolve (bot) {
      const log = mostAbundant(bot, /_log$|_wood$|_stem$|_hyphae$/)
      return log ? [plankNameFor(log.name)] : ['oak_planks']
    }
  },

  batons: {
    summary: 'fabriquer des batons',
    intent: 'Il faut des batons, le manche de tout outil : les fabriquer a partir de planches',
    resolve: () => ['stick']
  },

  etabli: {
    summary: 'fabriquer un etabli',
    intent: "Il faut un etabli (table de craft) : sans lui, ni porte ni outil ne peuvent etre fabriques",
    resolve: () => ['crafting_table']
  },

  porte: {
    summary: 'fabriquer une porte',
    intent: 'Le joueur a demande une porte et il n y en a pas en inventaire : la fabriquer a partir de planches',
    resolve (bot) {
      const planks = mostAbundant(bot, /_planks$/)
      const prefix = planks ? woodPrefix(planks.name) : 'oak'
      return [`${prefix}_door`, 'oak_door']
    }
  },

  hache: {
    summary: 'fabriquer une hache',
    intent: 'Couper du bois a la main est lent : fabriquer une hache pour aller plus vite',
    resolve: () => ['stone_axe', 'wooden_axe']
  },

  pioche: {
    summary: 'fabriquer une pioche',
    intent: "La pierre et les minerais ne lachent rien sans pioche : en fabriquer une",
    resolve: () => ['stone_pickaxe', 'wooden_pickaxe']
  },

  pelle: {
    summary: 'fabriquer une pelle',
    intent: 'Creuser la terre, le sable ou le gravier a la main est lent : fabriquer une pelle',
    resolve: () => ['wooden_shovel']
  }
}

// ---------------------------------------------------------------------------
// Fabrication générique pilotée par les recettes du jeu.
//
// TARGETS ci-dessus reste la couche « mots du joueur » (7 alias FR conservés :
// planches, batons, etabli, porte, hache, pioche, pelle). `make()` accepte en
// plus TOUT nom d objet Minecraft valide (ex : torch, oak_stairs, stick) : la
// restriction aux 7 cibles était artificielle, les recettes minecraft-data
// (via planCraft de recipe-plan.js, PURE) font foi, pas une phrase par objet.
//
// - `options()`/`targetCriteria()` restent les suggestions courtes (les 7 FR)
//   pour le second étage / fabrications_possibles : des hints, pas une limite.
// - `make()` résout l alias FR vers son item concret puis calcule un plan
//   générique (prérequis depuis le stock, quantités output vs repeats,
//   requiresTable) et l exécute en unitaire avec preuve par delta.
// - Stock manquant : rien n est inventé ni récolté ici, on rend une erreur
//   structurée (code 'missing', champ .missing) au pilote, pas un quota
//   implicite.
// ---------------------------------------------------------------------------

function stripNs (name) {
  return String(name ?? '').trim().toLowerCase().replace(/^minecraft:/, '')
}

function escapeRegExp (s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function inventoryMap (bot) {
  const map = {}
  for (const item of items(bot)) {
    if (!item || typeof item.name !== 'string') continue
    map[item.name] = (map[item.name] ?? 0) + (Number.isInteger(item.count) ? item.count : 0)
  }
  return map
}

function snapshotInventory (bot) {
  const map = new Map()
  for (const item of items(bot)) {
    if (!item || typeof item.name !== 'string') continue
    map.set(item.name, (map.get(item.name) ?? 0) + (Number.isInteger(item.count) ? item.count : 0))
  }
  return map
}

// Dataset du jeu pour planCraft : bot.registry s il porte .recipes (fakes),
// sinon minecraft-data de la version du bot, sinon null (repli mono-étape).
function getDataset (bot) {
  if (bot?.registry?.recipes) return bot.registry
  const versions = []
  if (typeof bot?.version === 'string' && bot.version) versions.push(bot.version)
  versions.push('26.1')
  for (const ver of versions) {
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const mcdata = require('minecraft-data')(ver)
      if (mcdata?.recipes) return mcdata
    } catch (_) { /* dataset indisponible : repli ci-dessous */ }
  }
  return null
}

// Une buche/planche manquante accepte toutes les essences (recettes a
// variantes) : le planificateur en nomme une au hasard (cherry_log), le
// modele partait chercher un cerisier. On dit la famille.
function formatMissing (missing) {
  return (missing ?? []).map(m => {
    const name = String(m.name || m.id)
    const family = /_(log|stem)$/.test(name) ? 'buche (toute essence)' : /_planks$/.test(name) ? 'planches (toute essence)' : name
    return `${family} x${m.count}`
  }).join(', ')
}

// Stock utile a la fabrication (bois, batons, etabli) : joint a un echec
// « ingredients manquants » pour que le modele et le journal voient le reel.
function woodStock (inv) {
  const parts = Object.entries(inv)
    .filter(([name, n]) => n > 0 && /(_log|_stem|_planks|^stick|^crafting_table)$/.test(name))
    .map(([name, n]) => `${name} x${n}`)
  return parts.length ? parts.join(', ') : 'aucun bois'
}

// Candidats concrets pour une demande : alias FR -> resolve() selon stock,
// sinon nom d objet direct. Rend { key, candidates } ou null.
function resolveCandidates (bot, requested) {
  const key = stripNs(requested)
  if (!key) return null
  if (Object.prototype.hasOwnProperty.call(TARGETS, key)) {
    return { key, kind: 'target', candidates: TARGETS[key].resolve(bot) }
  }
  if (!/^[a-z0-9_]+$/.test(key)) return null
  return { key, kind: 'item', candidates: [key] }
}

function isKnownItem (bot, itemName) {
  if (bot?.registry?.itemsByName?.[itemName]) return true
  // Sans registre (fakes minimaux) : le format suffit, recipeFor tranchera.
  if (!bot?.registry) return /^[a-z0-9_]+$/.test(itemName)
  return false
}

// La recette faisable, si elle l est. `table` vaut null (grille 2x2 de
// l inventaire), true (verification seule : « il faudrait un etabli ») ou un
// bloc d etabli reellement pose.
function recipeFor (bot, itemName, table) {
  const item = bot.registry?.itemsByName?.[itemName]
  if (!item) return null

  let recipes = []
  try {
    recipes = bot.recipesFor(item.id, null, 1, table ?? null)
  } catch (err) {
    return null
  }

  return recipes.length > 0 ? { recipe: recipes[0], item } : null
}

// Ce que le bot peut fabriquer maintenant, et pourquoi il ne peut pas le reste.
// Les options impossibles ne sont pas suggerees au modele.
function options (bot) {
  const list = []
  if (!bot?.registry) return list

  for (const [name, spec] of Object.entries(TARGETS)) {
    const candidates = spec.resolve(bot)
    let found = null

    for (const itemName of candidates) {
      const small = recipeFor(bot, itemName, null)
      if (small) {
        found = { itemName, needsTable: false }
        break
      }
      const big = recipeFor(bot, itemName, true)
      if (big) {
        found = { itemName, needsTable: true }
        break
      }
    }

    list.push({
      name,
      summary: spec.summary,
      intent: spec.intent,
      item: found ? found.itemName : candidates[0],
      needsTable: found ? found.needsTable : null,
      possible: Boolean(found)
    })
  }

  return list
}

// Les cibles faisables maintenant (suggestions servies au modele).
function targetCriteria (bot) {
  const criteria = {}
  for (const option of options(bot)) {
    if (option.possible) criteria[option.name] = option.intent
  }
  return criteria
}

// ---------------------------------------------------------------------------
// Etabli
// ---------------------------------------------------------------------------

// Cases libres pour poser un bloc utilitaire (etabli, four), les plus proches
// d abord ; jamais une case que recouvre le corps du bot ou d un autre joueur :
// le serveur refuse la pose (« the block is still air », craft/stone-pickaxe).
function freeSpotsNear (bot, max = 4) {
  const feet = bot.entity.position.floored()
  const corps = Object.values(bot.entities ?? {}).filter(e => e?.type === 'player' && e.position).map(e => e.position)
  if (!corps.some(p => p === bot.entity.position)) corps.push(bot.entity.position)
  const spots = []

  for (let radius = 1; radius <= 3 && spots.length < max; radius += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue

        const target = new Vec3(feet.x + dx, feet.y, feet.z + dz)
        if (!build.isFree(bot.blockAt(target))) continue
        if (!build.isSolid(bot.blockAt(target.offset(0, -1, 0)))) continue
        if (!build.isFree(bot.blockAt(target.offset(0, 1, 0)))) continue
        if (corps.some(p => build.bodyOverlaps(p, target))) continue
        spots.push(target)
        if (spots.length >= max) break
      }
    }
  }

  return spots
}

// Pose `item` sur la premiere case libre qui l accepte (trois essais).
async function placeNear (bot, item) {
  const spots = freeSpotsNear(bot, 3)
  if (spots.length === 0) throw new Error(`aucune place libre pour poser ${item}`)
  let derniere = null
  for (const spot of spots) {
    try {
      await build.placeOne(bot, spot, item)
      return spot
    } catch (err) {
      derniere = err
    }
  }
  throw derniere
}

// Un etabli deja pose a moins de TABLE_REUSE_RADIUS blocs sert encore : le bot
// y retourne. Borne a 4-6 blocs, le solveur de prerequis le perdait de vue des
// que le bot partait miner (craft/furnace : pierre a ~25 blocs, plan qui
// reclamait un nouvel etabli donc du bois, allers-retours bouleau/pierre).
const TABLE_REUSE_RADIUS = Number(process.env.CRAFT_TABLE_REUSE_RADIUS || 24)

// L etabli que CE bot a pose ou utilise reste le sien tant que le bloc est la,
// jusqu a TABLE_KNOWN_MAX blocs : un rayon fixe ne suffit pas (craft/furnace,
// 83bbfad : pierre a ~26 blocs de l etabli, juste hors des 24).
const TABLE_KNOWN_MAX = Number(process.env.CRAFT_TABLE_KNOWN_MAX || 64)

function placedTable (bot, radius = TABLE_REUSE_RADIUS) {
  const blockId = bot.registry?.blocksByName?.crafting_table?.id
  if (!blockId) return null
  let found = null
  try {
    found = typeof bot.findBlock === 'function' ? bot.findBlock({ matching: blockId, maxDistance: radius }) : null
  } catch (_) {
    found = null
  }
  if (found) return found
  const known = bot.craftTable
  if (!known || typeof bot.blockAt !== 'function' || !bot.entity?.position) return null
  try {
    const block = bot.blockAt(known)
    if (block?.type === blockId && bot.entity.position.distanceTo(known) <= TABLE_KNOWN_MAX) return block
  } catch (_) { /* chunk absent */ }
  return null
}

function rememberTable (bot, table) {
  if (table?.position) bot.craftTable = table.position.clone ? table.position.clone() : table.position
}

// Un etabli a portee : celui qui traine (a TABLE_REUSE_RADIUS blocs au plus),
// celui qu on pose, ou celui qu on fabrique d abord. Le bot est ensuite amene
// a cote, faute de quoi le serveur refuse d ouvrir la fenetre de craft.
async function ensureTable (bot, { move = null } = {}) {
  const blockId = bot.registry.blocksByName.crafting_table?.id
  let table = placedTable(bot)

  if (!table) {
    if (!findItem(bot, 'crafting_table')) {
      const recipe = recipeFor(bot, 'crafting_table', null)
      if (!recipe) throw new Error('pas d etabli et pas de quoi en fabriquer (4 planches)')
      await bot.craft(recipe.recipe, 1, null)
      await sleep(250)
    }

    await placeNear(bot, 'crafting_table')
    await sleep(350)

    table = blockId ? bot.findBlock({ matching: blockId, maxDistance: 6 }) : null
    if (!table) throw new Error('etabli pose mais introuvable')
  }

  // La fenetre de craft ne s ouvre que si le bloc est a portee du serveur.
  if (bot.entity.position.distanceTo(table.position) > 3.5) {
    const vantage = build.findVantage(bot, table.position)
    // Trajet par le navigateur de l appelant d abord (A*, obstacles) : les
    // gestes de build.moveTo expiraient a 12 s sur un etabli a ~29 blocs
    // (craft/furnace 811c888 : 8 pierres en poche, four jamais fabrique).
    let reached = false
    if (vantage && move) {
      try { reached = await move(vantage.stand) } catch (_) { reached = false }
    }
    if (vantage && !reached && bot.entity.position.distanceTo(table.position) > 4.5) {
      await build.moveTo(bot, vantage.stand)
    }
    if (bot.entity.position.distanceTo(table.position) > 4.5) {
      throw new Error(`etabli pose a ${bot.entity.position.distanceTo(table.position).toFixed(1)} blocs, pas rejoint`)
    }
  }

  rememberTable(bot, table)
  await bot.lookAt(table.position.offset(0.5, 0.5, 0.5), true)
  return table
}

// ---------------------------------------------------------------------------
// Fabrication
// ---------------------------------------------------------------------------

// Ingredients restes dans la grille 2x2 de l inventaire (slots 1 a 4) ou sur
// le curseur apres un craft desynchronise : `items()` ne les voit pas, ils
// passaient pour consommes (craft/torches 4ee01ef : etabli « -8 ingredients
// sans produit », plus de bois pour la suite). mineflayer ne ferme jamais la
// fenetre 0 ; la fermer fait rendre grille et curseur par le serveur. Rend
// vrai si quelque chose etait bloque (l inventaire se resynchronise ensuite).
// Laisse le serveur renvoyer grille et curseur (1,5 s au plus).
async function waitInventorySettled (bot) {
  for (let waited = 0; waited < 1500; waited += 100) {
    await sleep(100)
    const inv = bot?.inventory
    if (!inv?.selectedItem && ![1, 2, 3, 4].some(slot => inv?.slots?.[slot])) return
  }
}

async function recoverStranded (bot) {
  const inv = bot?.inventory
  if (!inv || bot.currentWindow || typeof bot.closeWindow !== 'function') return false
  const stranded = Boolean(inv.selectedItem) ||
    [1, 2, 3, 4].some(slot => inv.slots?.[slot])
  if (!stranded) return false
  try { await bot.closeWindow(inv) } catch (_) { return false }
  return true
}

// Numero d etat PAR FENETRE dans chaque clic. mineflayer n en garde qu un,
// ecrase par tout paquet de fenetre : pendant un craft sur etabli, les
// `set_slot` de l inventaire (fenetre 0, main secondaire) le remplacent, le
// clic suivant sur l etabli part avec l etat de la fenetre 0, le serveur
// renvoie alors la fenetre entiere telle qu AVANT les derniers clics, et le
// modele local, ecrase en pleine sequence, ne correspond plus au serveur :
// hache jamais fabriquee, sans consommation (craft/axe cabbdfcd ; mesure
// locale sur Paper 26.1.2 : 3 essais sur 3 rates, clics a st97 sur une
// fenetre a st5). Un clic a -1 (resynchronisation voulue) reste tel quel.
function trackWindowStateIds (bot) {
  const client = bot?._client
  if (!client || typeof client.write !== 'function' || client.stateIdPerWindow) return
  const states = new Map()
  const remember = packet => {
    if (Number.isInteger(packet?.windowId) && Number.isInteger(packet?.stateId)) states.set(packet.windowId, packet.stateId)
  }
  client.on('window_items', remember)
  client.on('set_slot', remember)
  const write = client.write
  client.write = function (name, params, ...rest) {
    if (name === 'window_click' && params && params.stateId !== -1 && states.has(params.windowId)) {
      params = { ...params, stateId: states.get(params.windowId) }
    }
    return write.call(this, name, params, ...rest)
  }
  client.stateIdPerWindow = true
}

// Resynchronisation complete de l inventaire (clic a numero d etat perime,
// `_syncWindow` du mineflayer patche) : 1,5 s au plus, sans effet sinon.
async function resyncInventory (bot) {
  if (!bot?.inventory || bot.currentWindow || typeof bot._syncWindow !== 'function') return
  let timer
  try {
    await Promise.race([
      bot._syncWindow(bot.inventory),
      new Promise(resolve => { timer = setTimeout(resolve, 1500) })
    ])
  } catch (_) { /* inventaire local tel quel */ } finally { clearTimeout(timer) }
}

// Fabrique `wanted` UNITES (pas des executions) de la cible, alias FR ou nom
// d objet direct. Renvoie le produit REEL mesuré sur l inventaire, jamais le
// planifié : `bot.craft` ne dit pas combien il a fait, et la fenêtre 26.1 est
// instable (mesure live : -2 bûches / +4 planches au lieu de +8 annoncés).
// Compatibilité : (bot, target, wanted) -> { item, produced, usedTable } ;
// champs en plus : wanted, planned, partial, operations, repeats, ackMs.
// Échec sans production : throw avec .code ('unknown' | 'missing' |
// 'partial-uncertain' | 'craft-failed'), .missing (ressources à obtenir, à
// récolter, jamais inventées), .item, .wanted, .produced.
// Profondeur des `make` imbriques (sous-crafts recursifs) : seul l appel
// exterieur resynchronise a la sortie.
let makeDepth = 0

// Apres un craft, l inventaire local peut encore mentir (craft/door f61180a :
// buche restante invisible, « il manque des buches », porte jamais faite
// alors que 1 buche + 4 planches suffisaient) : grille rendue et
// resynchronisation avant que la mission relise l inventaire.
async function make (bot, targetName, wanted = 1, opts = {}) {
  makeDepth += 1
  try {
    return await makeOnce(bot, targetName, wanted, opts)
  } finally {
    makeDepth -= 1
    if (makeDepth === 0) {
      try {
        if (await recoverStranded(bot)) await waitInventorySettled(bot)
        await resyncInventory(bot)
      } catch (_) { /* inventaire local tel quel */ }
    }
  }
}

async function makeOnce (bot, targetName, wanted = 1, opts = {}) {
  const wantedUnits = Number.isFinite(Number(wanted))
    ? Math.max(1, Math.round(Number(wanted)))
    : 1

  const resolved = resolveCandidates(bot, targetName)
  if (!resolved) throw Object.assign(
    new Error(`fabrication inconnue : ${targetName}`),
    { code: 'unknown', item: String(targetName ?? ''), wanted: wantedUnits, produced: 0, missing: [] }
  )

  // Candidats valides au registre (recettes du jeu font foi). Les alias FR
  // gardent leur ordre (ex : hache -> stone_axe puis wooden_axe).
  const validCandidates = resolved.candidates.filter(name => isKnownItem(bot, name))
  if (validCandidates.length === 0) {
    const err = new Error(`fabrication inconnue : ${targetName}`)
    err.code = 'unknown'
    err.item = resolved.candidates[0] ?? String(targetName)
    err.wanted = wantedUnits
    err.produced = 0
    err.missing = []
    throw err
  }

  // Restes d un craft precedent dans la grille ou sur le curseur : les rendre
  // avant de planifier sur l inventaire (craft/axe 33abea6 : etabli fabrique,
  // 8 planches invisibles, batons « impossibles, buche manquante »).
  if (await recoverStranded(bot)) await waitInventorySettled(bot)
  // Inventaire local desynchronise apres un craft (objets disparus du modele,
  // presents cote serveur : craft/axe 33abea6, 8 planches ; craft/door
  // 0b1d4a3, une buche puis l etabli) : le serveur renvoie l inventaire
  // complet avant qu on planifie dessus.
  await resyncInventory(bot)

  const invBase = inventoryMap(bot)
  const dataset = getDataset(bot)

  // Plan générique par candidat : le stock de la cible finale est retiré pour
  // forcer la PRODUCTION de `wanted` unités neuves (pas la consommation du
  // stock déjà là). Les intermédiaires (planches pour une porte) gardent leur
  // stock : ils sont réutilisés, pas re-craftés pour rien.
  let bestMissing = null
  let bestPlan = null
  let bestItem = null
  let fellBack = false

  if (dataset) {
    for (const candidate of validCandidates) {
      const inv = { ...invBase }
      delete inv[candidate]
      let plan = null
      try {
        plan = planCraft({ registry: dataset, target: candidate, count: wantedUnits, inventory: inv })
      } catch (_) {
        fellBack = true
        continue
      }
      if (plan.ok) {
        bestPlan = plan
        bestItem = candidate
        bestMissing = null
        break
      }
      if (!bestMissing) {
        bestMissing = plan
        bestItem = candidate
      }
    }
  } else {
    fellBack = true
  }

  if (!bestPlan) {
    if (bestMissing) {
      const desc = formatMissing(bestMissing.missing) || bestItem
      const err = new Error(`ingredients manquants pour ${bestItem} : ${desc} (a recolter, rien d invente ; en poche : ${woodStock(invBase)})`)
      err.code = 'missing'
      err.item = bestItem
      err.wanted = wantedUnits
      err.produced = 0
      err.missing = bestMissing.missing ?? []
      err.plan = bestMissing
      throw err
    }
    // Repli mono-étape sans dataset (registre sans .recipes) : une seule
    // recette faisable, mais exécution unitaire + delta honnête ci-dessous.
    for (const candidate of validCandidates) {
      const small = recipeFor(bot, candidate, null)
      if (small) {
        const perCraft = Number.isInteger(small.recipe?.result?.count) && small.recipe.result.count > 0
          ? small.recipe.result.count
          : (Number.isInteger(small.recipe?.outputCount) && small.recipe.outputCount > 0 ? small.recipe.outputCount : 1)
        bestPlan = {
          ok: true,
          quantity: { wanted: wantedUnits, planned: wantedUnits },
          requiresTable: false,
          operations: [{
            target: { id: small.item?.id ?? candidate, name: candidate, metadata: null },
            repeats: Math.ceil(wantedUnits / perCraft),
            demand: wantedUnits,
            outputPerCraft: perCraft,
            outputTotal: Math.ceil(wantedUnits / perCraft) * perCraft,
            requiresTable: false,
            ingredients: [],
            provenance: { source: 'recipes', kind: 'fallback', recipeIndex: -1 }
          }]
        }
        bestItem = candidate
        break
      }
    }
    if (!bestPlan) {
      for (const candidate of validCandidates) {
        if (!recipeFor(bot, candidate, true)) continue
        bestPlan = {
          ok: true,
          quantity: { wanted: wantedUnits, planned: wantedUnits },
          requiresTable: true,
          operations: [{
            target: { id: candidate, name: candidate, metadata: null },
            repeats: wantedUnits,
            demand: wantedUnits,
            outputPerCraft: 1,
            outputTotal: wantedUnits,
            requiresTable: true,
            ingredients: [],
            provenance: { source: 'recipes', kind: 'fallback', recipeIndex: -1 }
          }]
        }
        bestItem = candidate
        break
      }
    }
    if (!bestPlan) {
      const err = new Error(`ingredients manquants pour ${validCandidates[0]} (a recolter, rien d invente)`)
      err.code = 'missing'
      err.item = validCandidates[0]
      err.wanted = wantedUnits
      err.produced = 0
      err.missing = []
      throw err
    }
  }

  // Recette sur etabli sans etabli pose ni en poche : ensureTable en
  // fabriquait un en cours d execution (4 planches) sans que le plan l ait
  // compte ; la recette suivante manquait alors de planches (vu sur craft/axe :
  // deux etablis, hache impossible). L etabli d abord, par le planificateur
  // complet, puis nouveau plan sur l inventaire reel.
  const needsTable = bestPlan.operations.some(op => op.requiresTable)
  if (needsTable && bestItem !== 'crafting_table' && !findItem(bot, 'crafting_table')) {
    if (!placedTable(bot)) {
      await make(bot, 'crafting_table', 1, opts)
      return make(bot, targetName, wanted, opts)
    }
  }

  const finalItem = bestPlan.operations.length > 0
    ? bestPlan.operations[bestPlan.operations.length - 1].target.name
    : bestItem
  const initialFinal = countOf(bot, new RegExp(`^${escapeRegExp(finalItem)}$`))

  // Exécution unitaire, jamais en lot : `bot.craft(recette, N)` N > 1
  // désynchronise la fenêtre sur 26.1. Chaque repeat est UN `bot.craft(...,1)`
  // suivi d un settle, puis preuve par delta inventaire (pas par le resolve
  // de l await). Arrêt partiel honnête : on rend le produit réel, on ne
  // rejoue jamais une consommation incertaine (doublons).
  let table = null
  let usedTable = false
  let lastError = null
  let executedRepeats = 0
  let ackMs = 0
  let stoppedUncertain = false

  for (const op of bestPlan.operations) {
    if (lastError || stoppedUncertain) break
    if (op.requiresTable && !table) {
      table = await ensureTable(bot, opts)
      usedTable = true
    }
    const tableForOp = op.requiresTable ? table : null
    const opRepeats = Number.isInteger(op.repeats) && op.repeats > 0 ? op.repeats : 1

    for (let r = 0; r < opRepeats; r += 1) {
      if (stoppedUncertain) break
      const beforeTarget = countOf(bot, new RegExp(`^${escapeRegExp(op.target.name)}$`))
      const beforeSnap = snapshotInventory(bot)
      let fresh = recipeFor(bot, op.target.name, tableForOp)
      if (!fresh && op.requiresTable) {
        try {
          table = await ensureTable(bot, opts)
          usedTable = true
          fresh = recipeFor(bot, op.target.name, table)
        } catch (err) {
          lastError = err
          break
        }
      }
      if (!fresh) {
        lastError = new Error(`recette introuvable pour ${op.target.name} (stock a change)`)
        lastError.code = 'missing'
        break
      }
      const start = Date.now()
      try {
        await bot.craft(fresh.recipe, 1, tableForOp ?? table ?? null)
      } catch (err) {
        lastError = err
        break
      }
      ackMs += Date.now() - start
      // Le produit peut arriver tard dans l inventaire (serveur charge : vu
      // sur craft/table, etabli absent a 200 ms, planches deja consommees,
      // arret « consommation incertaine »). Attendre jusqu a 2 s.
      let afterTarget = beforeTarget
      for (let waited = 0; waited < 2000; waited += 100) {
        await sleep(100)
        afterTarget = countOf(bot, new RegExp(`^${escapeRegExp(op.target.name)}$`))
        if (afterTarget > beforeTarget) break
      }
      if (afterTarget - beforeTarget > 0) {
        executedRepeats += 1
        lastError = null
        await sleep(120)
        continue
      }
      // Échec silencieux : produit nul sans erreur. Consommation ?
      const consumedSince = () => {
        const afterSnap = snapshotInventory(bot)
        let total = 0
        for (const ing of op.ingredients ?? []) {
          const b = beforeSnap.get(ing.name) ?? 0
          const a = afterSnap.get(ing.name) ?? 0
          if (a < b) total += (b - a)
        }
        return total
      }
      let consumed = consumedSince()
      if (consumed > 0 && await recoverStranded(bot)) {
        for (let waited = 0; waited < 1500 && consumed > 0; waited += 100) {
          await sleep(100)
          consumed = consumedSince()
        }
      }
      if (consumed > 0) {
        // The local model can lie (craft/torches 0f59abf: log gone, planks
        // unseen for 3.5 s): ask the server for the whole inventory first.
        await resyncInventory(bot)
        afterTarget = countOf(bot, new RegExp(`^${escapeRegExp(op.target.name)}$`))
        if (afterTarget > beforeTarget) {
          executedRepeats += 1
          lastError = null
          await sleep(120)
          continue
        }
        consumed = consumedSince()
      }
      if (consumed > 0) {
        // Incertain : des ingrédients ont disparu sans produit. Ne pas
        // rejouer (doublons/gaspillage) : arrêt partiel, produit réel rendu.
        lastError = new Error(`${op.target.name} non fabrique (consommation incertaine : -${consumed} ingredient(s) sans produit, arret partiel)`)
        lastError.code = 'partial-uncertain'
        stoppedUncertain = true
        break
      }
      // Sans consommation : retentatives sûres (réouverture table). Sous charge,
      // la fenetre de l etabli rate parfois (vu sur craft/axe) : on ferme ce
      // qui reste ouvert et on laisse le serveur souffler avant de rejouer.
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch (_) {}
      await sleep(600)
      try {
        let retryTable = tableForOp ?? table ?? null
        if (op.requiresTable) {
          try {
            table = await ensureTable(bot, opts)
            usedTable = true
            retryTable = table
          } catch (_) { /* garde la table existante */ }
        }
        const retry = recipeFor(bot, op.target.name, retryTable)
        if (!retry) {
          lastError = new Error(`${op.target.name} non fabrique (echec silencieux)`)
          break
        }
        const start2 = Date.now()
        await bot.craft(retry.recipe, 1, retryTable)
        ackMs += Date.now() - start2
        // Meme attente que le premier essai : produit tardif sous charge.
        let after2 = beforeTarget
        for (let waited = 0; waited < 2000; waited += 100) {
          await sleep(100)
          after2 = countOf(bot, new RegExp(`^${escapeRegExp(op.target.name)}$`))
          if (after2 > beforeTarget) break
        }
        if (after2 - beforeTarget > 0) {
          executedRepeats += 1
          lastError = null
          continue
        }
        // Deuxieme et derniere retentative, meme precaution.
        try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch (_) {}
        await sleep(800)
        const retry3 = recipeFor(bot, op.target.name, retryTable)
        if (retry3) {
          await bot.craft(retry3.recipe, 1, retryTable)
          let after3 = beforeTarget
          for (let waited = 0; waited < 2000; waited += 100) {
            await sleep(100)
            after3 = countOf(bot, new RegExp(`^${escapeRegExp(op.target.name)}$`))
            if (after3 > beforeTarget) break
          }
          if (after3 > beforeTarget) {
            executedRepeats += 1
            lastError = null
            continue
          }
        }
        lastError = new Error(`${op.target.name} non fabrique (echec silencieux sans consommation)`)
        break
      } catch (err) {
        lastError = err
        break
      }
    }
  }

  await sleep(150)
  const produced = countOf(bot, new RegExp(`^${escapeRegExp(finalItem)}$`)) - initialFinal

  if (produced <= 0) {
    const err = lastError instanceof Error
      ? lastError
      : new Error(`${finalItem} non fabrique`)
    if (!err.code) err.code = 'craft-failed'
    err.item = err.item ?? finalItem
    err.wanted = err.wanted ?? wantedUnits
    err.produced = 0
    if (!err.missing) err.missing = bestPlan.missing ?? []
    throw err
  }

  return {
    item: finalItem,
    produced,
    wanted: wantedUnits,
    planned: bestPlan.quantity?.planned ?? wantedUnits,
    partial: produced < wantedUnits,
    operations: bestPlan.operations.length,
    repeats: executedRepeats,
    ackMs,
    usedTable: usedTable || Boolean(table)
  }
}

// ---------------------------------------------------------------------------
// Cuisson au four (2026-09-27 : fer, charbon de bois, verre, pierre lisse...)
// ---------------------------------------------------------------------------

// Combustibles, du meilleur au moins bon, avec le nombre d objets cuits par
// unite (valeurs du jeu). Jamais l objet a cuire lui-meme (buche pour du
// charbon de bois).
const FUELS = [
  [/^(coal|charcoal)$/, 8],
  [/^coal_block$/, 80],
  [/_log$|_wood$|_stem$/, 1.5],
  [/_planks$/, 1.5],
  [/^stick$/, 0.5]
]
const SMELT_TICK_MS = 10000 // 200 ticks par objet

function furnaceBlock (bot, radius = TABLE_REUSE_RADIUS) {
  const id = bot.registry?.blocksByName?.furnace?.id
  if (!id || typeof bot.findBlock !== 'function') return null
  try { return bot.findBlock({ matching: id, maxDistance: radius }) } catch (_) { return null }
}

// Un four a portee : celui qui traine (24 blocs), sinon celui de l inventaire
// pose a cote. Sans four, erreur `missing` : le solveur le fait fabriquer.
async function ensureFurnace (bot, { move = null } = {}) {
  let four = furnaceBlock(bot)
  if (!four) {
    if (!findItem(bot, 'furnace')) {
      throw Object.assign(new Error('pas de four (8 cobblestone sur un etabli)'), { code: 'missing', missing: [{ name: 'furnace', count: 1 }] })
    }
    await placeNear(bot, 'furnace')
    await sleep(350)
    four = furnaceBlock(bot, 6)
    if (!four) throw new Error('four pose mais introuvable')
  }
  if (bot.entity.position.distanceTo(four.position) > 3.5) {
    const vantage = build.findVantage(bot, four.position)
    let reached = false
    if (vantage && move) {
      try { reached = await move(vantage.stand) } catch (_) { reached = false }
    }
    if (vantage && !reached && bot.entity.position.distanceTo(four.position) > 4.5) await build.moveTo(bot, vantage.stand)
    if (bot.entity.position.distanceTo(four.position) > 4.5) {
      throw new Error(`four a ${bot.entity.position.distanceTo(four.position).toFixed(1)} blocs, pas rejoint`)
    }
  }
  await bot.lookAt(four.position.offset(0.5, 0.5, 0.5), true)
  return four
}

// Cuit `wanted` `output` (iron_ingot, charcoal, glass...). L entree vient de
// la table SMELT (acquire-plan) ; une autre essence de buche fait l affaire
// pour le charbon de bois. Mesure le produit REEL en inventaire.
async function smelt (bot, output, wanted = 1, { move = null, input = null, timeoutMs = null } = {}) {
  const { SMELT } = require('./acquire-plan')
  const n = Math.max(1, Math.round(Number(wanted) || 1))
  const raw = input ?? SMELT[output]
  if (!raw) throw Object.assign(new Error(`${output} ne se cuit pas`), { code: 'unknown' })
  const suffix = raw.slice(raw.lastIndexOf('_'))
  const entree = items(bot).find(i => i.name === raw) ??
    items(bot).find(i => i.name.endsWith(suffix) && suffix === '_log')
  if (!entree) {
    throw Object.assign(new Error(`rien a cuire : il faut ${n} ${raw}`), { code: 'missing', missing: [{ name: raw, count: n }] })
  }
  const aCuire = Math.min(n, countOf(bot, new RegExp(`^${escapeRegExp(entree.name)}$`)))
  // Combustibles en poche (jamais l objet a cuire), du meilleur au moins bon.
  // Un seul type tient dans la case du four : on recharge avec le suivant
  // quand il s epuise (craft/iron-pickaxe 453d7f4 : 1 buche pour 3 fers,
  // 1 lingot cuit, 2 minerais restes dans le four, invisibles du solveur).
  // `source` : l inventaire du bot, ou celui de la fenetre du four une fois
  // ouverte (sinon « Can't find birch_log in slots » : objet deja pose).
  const combustibles = (source = items(bot)) => {
    const liste = []
    for (const [pattern, par] of FUELS) {
      for (const it of source.filter(i => pattern.test(i.name) && i.name !== entree.name)) {
        liste.push({ item: it, parUnite: par })
      }
    }
    return liste
  }
  const capacite = combustibles().reduce((sum, c) => sum + c.item.count * c.parUnite, 0)
  if (capacite <= 0) {
    throw Object.assign(new Error('pas de combustible (charbon, buches ou planches)'), { code: 'missing', missing: [{ name: 'coal', count: 1 }] })
  }
  if (capacite < aCuire) {
    throw Object.assign(new Error(`combustible pour ${Math.floor(capacite)} cuisson(s) seulement sur ${aCuire}`),
      { code: 'missing', missing: [{ name: 'oak_planks', count: Math.ceil((aCuire - capacite) / 1.5) }] })
  }
  const avant = countOf(bot, new RegExp(`^${escapeRegExp(output)}$`))
  const four = await ensureFurnace(bot, { move })
  const fenetre = await bot.openFurnace(four)
  let pris = 0
  const brules = new Map()
  const recharger = async () => {
    if (fenetre.fuelItem()) return false
    const c = combustibles(typeof fenetre.items === 'function' ? fenetre.items() : items(bot))[0]
    if (!c) return false
    const nombre = Math.min(c.item.count, Math.max(1, Math.ceil((aCuire - pris) / c.parUnite)))
    try {
      await fenetre.putFuel(c.item.type, null, nombre)
    } catch (_) {
      return false
    }
    brules.set(c.item.name, (brules.get(c.item.name) ?? 0) + nombre)
    return true
  }
  let arret = null
  try {
    const cuitDeja = fenetre.outputItem()
    if (cuitDeja) { await fenetre.takeOutput(); pris += cuitDeja.count }
    await recharger()
    await fenetre.putInput(entree.type, null, aCuire)
    const fin = Date.now() + (timeoutMs ?? aCuire * SMELT_TICK_MS + 8000)
    while (Date.now() < fin && pris < aCuire) {
      await sleep(500)
      const out = fenetre.outputItem()
      if (out && out.count > 0) {
        await fenetre.takeOutput()
        pris += out.count
      }
      // Case vide et feu eteint alors qu il reste a cuire : recharger.
      if (pris < aCuire && fenetre.inputItem() && !fenetre.fuelItem() && !(fenetre.fuel > 0)) {
        if (!(await recharger())) { arret = 'combustible epuise'; break }
      }
    }
    if (pris < aCuire && !arret) arret = 'delai de cuisson depasse'
  } finally {
    // Ce qui n est pas cuit revient en poche : le solveur et le modele
    // comptent l inventaire, pas le contenu du four.
    try { if (fenetre.inputItem()) await fenetre.takeInput() } catch (_) {}
    try { if (fenetre.outputItem()) { const o = fenetre.outputItem(); await fenetre.takeOutput(); pris += o.count } } catch (_) {}
    try { fenetre.close() } catch (_) {}
  }
  await sleep(300)
  await resyncInventory(bot)
  const produit = Math.max(0, countOf(bot, new RegExp(`^${escapeRegExp(output)}$`)) - avant)
  return {
    item: output,
    produced: produit,
    wanted: n,
    input: entree.name,
    fuel: [...brules.keys()].join('+') || 'aucun',
    fuelCount: [...brules.values()].reduce((a, b) => a + b, 0),
    arret
  }
}

module.exports = {
  smelt,
  trackWindowStateIds,
  ensureFurnace,
  furnaceBlock,
  TABLE_REUSE_RADIUS,
  TABLE_KNOWN_MAX,
  placedTable,
  rememberTable,
  snapshot,
  options,
  targetCriteria,
  make,
  recipeFor,
  ensureTable,
  equipForBlock,
  harvestCheck,
  bestToolOfKind,
  toolKindFor,
  countOf,
  findItem,
  mostAbundant,
  plankNameFor,
  inventoryMap,
  getDataset,
  TARGETS
}
