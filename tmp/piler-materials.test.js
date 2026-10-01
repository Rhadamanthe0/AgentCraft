'use strict'

process.env.MISSION_TICK_MS = '1'
process.env.MISSION_QUEUE_TICK_MS = '1'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { EventEmitter } = require('node:events')
const planner = require('../bot/planner')
const craft = require('../bot/craft')
const delivery = require('../bot/delivery')
const build = require('../bot/build')
const { createMissionRunner } = require('../bot/mission')
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)) }

async function simulate (t, { inventory, height = 6, refuseAt = null, noLanding = false, wrongBlock = false, retryError = false, loseStock = false, logY = 74, logAt = null, start = null, extra = {}, first = 'piler', onPlace = null, text = 'casse cet arbre', allLogs = false, queue = null, digFailure = null, kind = 'recolte', onDig = null, navigate = null, entities = {}, loaded = () => true, resume = null, reviseAfterCut = false, revisionText = null, context = null, collectImmediately = true, completedStructure = false, pauseAfterCut = false, revisionOnPendingJoin = false, setup = null, pauseLifecycle = null, duringRevisionBrief = null, reviseWhen = null, abortAfterDig = null }) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000000 })
  t.mock.method(planner, 'isEnabled', () => true)
  t.mock.method(craft, 'targetCriteria', () => ({}))
  let briefs = 0
  t.mock.method(planner, 'readBrief', async () => (++briefs > 1 && duringRevisionBrief?.(bot), { kind, kindConfidence: 1,
    resource: 'bois', resourceConfidence: 1, landmark: 'ici', door: false, doorProbability: 0 }))
  if (completedStructure) {
    t.mock.method(build, 'findSite', () => ({ origin: new Vec3(10, 65, 0), distance: 10 }))
    t.mock.method(build, 'planHouse', () => ({ origin: new Vec3(10, 65, 0), blocks: [{ position: new Vec3(10, 65, 0) }], width: 1, height: 1, depth: 1 }))
    const previous = process.env.FEATURE_PLANS
    process.env.FEATURE_PLANS = '0'
    t.after(() => { if (previous === undefined) delete process.env.FEATURE_PLANS; else process.env.FEATURE_PLANS = previous })
  }
  const states = []
  const stopsAtPlans = []
  let staleAborted = false
  t.mock.method(planner, 'plan', async (state, _kind, _supply, _extra, _image, { signal }) => {
    states.push(state)
    stopsAtPlans.push(stops)
    const step = (action, choices = {}) => ({ action, choices, scale: 0, scaleLevel: null })
    // Other first actions keep the queue short: status shows the last 5 steps.
    // queue: actions of each successive plan, then the default script.
    const steps = queue?.[states.length - 1] ? queue[states.length - 1].map(action =>
      typeof action === 'string' ? step(action) : step(action.action, action.choices))
      : first !== 'piler' ? (states.length === 1 ? [step(first), step('dire', { texte: 'OLD QUEUE' })] : [step('terminer')])
      : states.length === 1 ? [step('piler', { hauteur: height }), step('dire', { texte: 'OLD QUEUE' })]
        : states.length === 2 ? [step('dire', { texte: 'OLD PREFETCH' })] : [step('terminer')]
    if (states.length === 2) signal.addEventListener('abort', () => { staleAborted = true }, { once: true })
    return { ms: 0, seconds: 1, rejected: [], done: 0, finished: false, steps }
  })
  const stock = inventory.map(item => ({ ...item }))
  const log = logAt ?? new Vec3(1, logY, 0)
  const blocks = new Map([['0,64,0', 'stone'], [`${log.x},${log.y},${log.z}`, 'oak_log'], ...Object.entries(extra)])
  const placements = []
  const commands = []
  const messages = []
  const bot = { entity: { id: 42, position: start ?? new Vec3(0.5, 65, 0.5), yaw: 0, pitch: 0, onGround: true },
    registry: { blocksByName: { oak_log: { id: 1 }, dirt: { id: 2, boundingBox: 'block' },
      coarse_dirt: { id: 3, boundingBox: 'block' }, oak_planks: { id: 4, boundingBox: 'block' },
      birch_planks: { id: 5, boundingBox: 'block' }, fake_planks: { id: 6, boundingBox: 'empty' } }, itemsByName: {} },
    inventory: { items: () => stock.filter(item => item.count > 0) }, players: {}, entities: { ...entities },
    // allLogs: every oak_log of the map, nearest first; else the main log only.
    findBlocks: ({ matching }) => !matching.includes(1) ? []
      : !allLogs ? (blocks.get(`${log.x},${log.y},${log.z}`) === 'oak_log' ? [log] : [])
      : [...blocks].filter(([, name]) => name === 'oak_log').map(([key]) => new Vec3(...key.split(',').map(Number)))
        .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position)),
    findBlock: () => null,
    blockAt: p => { const position = p.floored(); if (!loaded(position)) return null; const name = blocks.get(`${position.x},${position.y},${position.z}`) ?? 'air'
      return { name, position, boundingBox: name === 'air' ? 'empty' : 'block', shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]] } },
    clearControlStates () {},
    setControlState (control, value) {
      commands.push({ control, value })
      if (control === 'jump' && value) { bot.entity.position.y = Math.floor(bot.entity.position.y) + 1.1; bot.entity.onGround = false }
      if (control === 'jump' && !value) {
        while (bot.entity.position.y > 65 && !blocks.has(`0,${Math.floor(bot.entity.position.y) - 1},0`)) bot.entity.position.y -= 1
        bot.entity.position.y = Math.floor(bot.entity.position.y)
        bot.entity.onGround = !noLanding
      }
    },
    dig: async block => {
      if (digFailure?.(block)) throw new Error('temporary dig failure')
      blocks.delete(`${block.position.x},${block.position.y},${block.position.z}`)
      const owned = stock.find(item => item.name === block.name)
      if (collectImmediately) {
        if (owned) owned.count++
        else stock.push({ name: block.name, count: 1 })
        const pickup = { name: 'item', uuid: `pickup-${block.position}`,
          position: block.position.offset(0.5, 0.5, 0.5), getDroppedItem: () => ({ name: block.name, count: 1 }) }
        bot.emit('entitySpawn', pickup)
        bot.emit('playerCollect', bot.entity, pickup)
      }
      // Digging under the feet drops the bot into the hole.
      if (block.position.y < bot.entity.position.y) bot.entity.position.y = block.position.y
      onDig?.(block, bot)
      if (abortAfterDig?.(block)) throw new Error('Digging aborted')
    },
    equip: async item => { commands.push({ equip: item.name }); bot.heldItem = item }, lookAt: async () => {},
    placeBlock: async support => {
      if (placements.length + 1 === refuseAt) throw new Error('server refused')
      const name = wrongBlock ? 'coarse_dirt' : bot.heldItem.name
      blocks.set(`${support.position.x},${support.position.y + 1},${support.position.z}`, name)
      bot.heldItem.count--
      placements.push(name)
      onPlace?.(placements, blocks, bot)
      if (loseStock) stock.forEach(item => { item.count = 0 })
      if (retryError) throw new Error('late server error')
    } }
  Object.assign(bot, new EventEmitter())
  Object.setPrototypeOf(bot, EventEmitter.prototype)
  setup?.(bot)
  let stops = 0
  const snapshots = []
  const runner = createMissionRunner({ getBot: () => bot, isReady: () => true, inLiquid: () => false,
    stopPathfinding () { stops++ }, chat: text => messages.push(text),
    navigateToPosition: navigate ? (position, options) => navigate(position, options, bot) : undefined,
    navigateToPlayer: navigate ? (name, options) => navigate(name, options, bot) : undefined },
  { objectives: { recordProgress: value => snapshots.push(structuredClone(value)), resume () {} } })
  t.after(() => runner.stop('test cleanup'))
  if (resume) runner.rehydrate(resume)
  else await runner.start(text, 'human', context ? { objectiveId: 'simulated-tree' } : {})
  if (context) runner.addContext(context, 'human')
  let revised = false
  let revisionPending = false
  let paused = false
  let lifecycleListeners = null
  for (let i = 0; i < 600 && (runner.isRunning() || runner.isPaused() || revisionPending); i++) {
    t.mock.timers.tick(50); await flush()
    if (pauseAfterCut && !paused && runner.status().blocs_casses > 0) {
      paused = true
      runner.pauseWork('pause apres coupe')
      setTimeout(async () => {
        if (!pauseLifecycle) return runner.resumeWork()
        if (pauseLifecycle === 'stop') runner.stop('stop pendant pause')
        if (pauseLifecycle === 'end') bot.emit('end')
        if (pauseLifecycle === 'new') {
          revisionPending = true
          try { await runner.start('coupe du bois', 'human') } finally { revisionPending = false }
        }
        lifecycleListeners = ['entitySpawn', 'entityGone', 'entityUpdate', 'itemDrop', 'playerCollect', 'end'].reduce((n, event) => n + bot.listenerCount(event), 0)
        if (pauseLifecycle === 'end') runner.stop('cleanup apres deconnexion mesuree')
      }, 1000)
    }
    if (((reviseAfterCut && runner.status().blocs_casses > 0) || (revisionOnPendingJoin && snapshots.at(-1)?.descripteur.pendingJoin) || reviseWhen?.(snapshots.at(-1))) && !revised) {
      revised = true
      revisionPending = true
      runner.revise(revisionText ?? text, 'human').finally(() => { revisionPending = false })
    }
  }
  assert.equal(runner.isRunning(), false)
  const status = runner.status()
  return { status, snapshots, blocks, step: status.historique.find(step => step.action === first), placements, commands, states, messages, staleAborted, stopsAtPlans, lifecycleListeners,
    collectionListeners: bot.listenerCount('playerCollect'), spawnListeners: ['entitySpawn', 'entityGone', 'entityUpdate', 'itemDrop', 'end'].reduce((n, event) => n + bot.listenerCount(event), 0) }
}

test('stock1 hauteur6 : refus integral avant equipement saut ou pose', async t => {
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 1 }] })
  assert.equal(f.step.echec, true)
  assert.equal(f.step.code, 'stock_echafaudage_insuffisant')
  assert.deepEqual(f.placements, [])
  assert.deepEqual(f.commands, [])
  assert.equal(f.stopsAtPlans[2], f.stopsAtPlans[0], 'preflight ne stoppe pas la physique')
  assert.equal(f.states[0].environnement.cible_haute.cible, 'oak_log')
  assert.equal(f.states[0].environnement.dirt_secondaire_admise, true)
})

test('planches seules utilisables et reobservation apres montee complete', async t => {
  const f = await simulate(t, { inventory: [{ name: 'oak_planks', count: 6 }] })
  assert.equal(f.step.echec, false)
  assert.deepEqual(f.placements, Array(6).fill('oak_planks'))
  assert.equal(f.states[0].inventaire.echafaudage.total, 6)
  assert.equal(f.states[0].inventaire.dirt_en_inventaire, 0)
  assert.equal(f.states[0].environnement.cible_haute.cible, 'oak_log')
  assert.equal(f.states[0].environnement.dirt_secondaire_admise, false)
  assert.equal(f.states[2].bot.position.y, 71)
  assert.equal(f.staleAborted, true)
  assert.equal(f.messages.some(message => /OLD QUEUE|OLD PREFETCH/.test(message)), false)
  assert.equal(f.status.blocs_casses, 0)
})

test('dirt prioritaire puis planches, pas de credit recolte pour la pose', async t => {
  const f = await simulate(t, { inventory: [{ name: 'oak_planks', count: 5 }, { name: 'dirt', count: 1 }] })
  assert.equal(f.step.echec, false)
  assert.deepEqual(f.placements, ['dirt', ...Array(5).fill('oak_planks')])
  assert.equal(f.status.dirt_secondaire, 0)
  assert.equal(f.status.blocs_casses, 0)
})

test('sable gravier feuilles et fausses planches exclus du stock', async t => {
  const f = await simulate(t, { inventory: ['sand', 'gravel', 'oak_leaves', 'fake_planks', 'unknown_planks'].map(name => ({ name, count: 64 })) })
  assert.equal(f.states[0].inventaire.echafaudage.total, 0)
  assert.equal(f.step.echec, true)
  assert.deepEqual(f.commands, [])
})

test('refus niveau2 : premiere pose prouvee mais montee partielle en echec', async t => {
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 6 }], refuseAt: 2 })
  assert.deepEqual(f.placements, ['dirt'])
  assert.equal(f.step.echec, true)
  assert.match(f.step.resultat, /1\/6/)
})

test('bloc different du materiau choisi ne prouve pas la pose', async t => {
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 1 }], height: 1, wrongBlock: true, logY: 69 })
  assert.equal(f.step.echec, true)
  assert.match(f.step.resultat, /non pose|different/)
})

test('pose presente sans atterrissage prouve reste un echec mesure', async t => {
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 1 }], height: 1, noLanding: true, logY: 69 })
  assert.equal(f.step.echec, true)
  assert.match(f.step.resultat, /1\/1.*atterrissage/)
})

test('stock perdu apres premiere pose : echec partiel mesure et pas de vieux plan', async t => {
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 6 }], loseStock: true })
  assert.deepEqual(f.placements, ['dirt'])
  assert.equal(f.step.echec, true)
  assert.match(f.step.resultat, /1\/6.*plus de blocs/)
  assert.equal(f.messages.some(message => /OLD QUEUE|OLD PREFETCH/.test(message)), false)
})

test('retry ne valide jamais un bloc different du materiau choisi', async t => {
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 2 }], height: 1, wrongBlock: true, retryError: true, logY: 69 })
  assert.equal(f.step.echec, true)
  assert.match(f.step.resultat, /pilier impossible/)
})

test('hauteur trop courte pour la buche la plus basse : portee au minimum mesure', async t => {
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 6 }], height: 1 })
  assert.match(f.step.resultat, /hauteur 1 portee a 6/)
  assert.ok(f.placements.length > 1)
})

// Decentre (z 0.18), la tete du bot touche aussi la colonne z = -1 : un bloc
// solide y arrete le saut (trees/tall 9e079e5, « saut trop bas » au niveau 5).
test('bloc solide au-dessus de la colonne voisine sous la hitbox : plafond dit, pas de saut', async t => {
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 8 }], start: new Vec3(0.5, 65, 0.18),
    extra: { '0,69,-1': 'stone' } })
  assert.deepEqual(f.placements, ['dirt', 'dirt'])
  assert.equal(f.step.echec, true)
  assert.match(f.step.resultat, /plafond au-dessus/)
})

test('buche voisine au-dessus de la tete et a portee : montee finie sans echec', async t => {
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 8 }], start: new Vec3(0.5, 65, 0.18),
    logAt: new Vec3(0, 70, -1) })
  assert.deepEqual(f.placements, ['dirt', 'dirt', 'dirt'])
  assert.equal(f.step.echec, false)
  assert.equal(f.step.code, 'pilier_pose')
  assert.match(f.step.resultat, /oak_log deja a portee, casser depuis le haut/)
})

// Poste deplace ou cible disparue pendant la montee : le sommet atteint ne
// prouve pas la portee, avancer le mesure avant de dire la cible rejointe.
test('avancer : pilier pose mais aucune cible a portee au sommet, echec mesure', async t => {
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 8 }], first: 'avancer',
    onPlace: (placements, blocks) => { if (placements.length === 6) blocks.delete('1,74,0') } })
  assert.equal(f.placements.length, 6)
  assert.equal(f.step.echec, true)
  assert.equal(f.step.code, 'cible_haute')
  assert.match(f.step.resultat, /Pilier pose .* aucune cible a portee depuis le sommet/)
})

test('avancer : pilier pose et cible a portee au sommet, succes', async t => {
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 8 }], first: 'avancer' })
  assert.equal(f.placements.length, 6)
  assert.equal(f.step.echec, false)
  assert.equal(f.step.code, 'pilier')
  // Climbed and gathered: the queued step belongs to the pre-climb state.
  assert.equal(f.messages.some(message => /OLD QUEUE/.test(message)), false)
})

// Perche a +2 sans terre autour : le pilier defait rend ses 2 blocs, refait a
// la meme hauteur, aucun gain. Echec qui dit le recours, pas « reobserver »
// (trees/tall c6dd16e : cinq piler de suite rendus « 2/2 »).
test('pilier defait puis refait sans gain : echec qui propose les planches', async t => {
  const f = await simulate(t, { inventory: [{ name: 'oak_log', count: 3 }], height: 3, start: new Vec3(0.5, 67, 0.5),
    extra: { '0,65,0': 'dirt', '0,66,0': 'dirt' } })
  assert.deepEqual(f.placements, ['dirt', 'dirt'])
  assert.equal(f.step.echec, true)
  assert.match(f.step.resultat, /gain net 0\/4 .*: fabriquer des planches \(3 buche\(s\) en inventaire\)/)
})

// Un bloc en reserve : pilier de 2 defait, refait a 3, gain net 1 sur 4
// demandes. Partiel, jamais « pilier_pose ».
test('pilier refait plus haut mais gain net court : echec partiel', async t => {
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 1 }], height: 3, start: new Vec3(0.5, 67, 0.5),
    extra: { '0,65,0': 'dirt', '0,66,0': 'dirt' } })
  assert.deepEqual(f.placements, ['dirt', 'dirt', 'dirt'])
  assert.equal(f.step.echec, true)
  assert.equal(f.step.code, 'pilier_partiel')
  assert.match(f.step.resultat, /gain net 1\/4 \(pilier de 2 defait puis refait a 3\) : prendre de la terre plus loin/)
})

test('bois en blocs (hyphae) compte comme source de planches pour l echafaudage', async t => {
  const f = await simulate(t, { inventory: [{ name: 'crimson_hyphae', count: 2 }], height: 3, start: new Vec3(0.5, 67, 0.5),
    extra: { '0,65,0': 'dirt', '0,66,0': 'dirt' } })
  assert.equal(f.step.echec, true)
  assert.match(f.step.resultat, /fabriquer des planches \(2 buche\(s\) en inventaire\)/)
})

// Cible a +5 et 3 blocs de cote : denivele - portee (2) laisse la buche a 4.6
// blocs. La hauteur se mesure avec la portee reelle depuis un poste virtuel.
test('avancer : hauteur du pilier mesuree avec la portee reelle, cible decalee', async t => {
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 8 }], first: 'avancer', logAt: new Vec3(3, 70, 0) })
  assert.equal(f.placements.length, 3)
  assert.equal(f.step.echec, false)
  assert.equal(f.step.code, 'pilier')
})

// Glisse du bloc pose sur un voisin de meme hauteur (buche) : le +1 est reel,
// pas un atterrissage manque (trees/bent 9f907a6).
test('atterrissage sur un voisin de meme hauteur : montee comptee', async t => {
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 2 }], height: 1, logY: 69, extra: { '1,65,0': 'oak_log' },
    onPlace: (_placements, _blocks, bot) => { bot.entity.position.x = 1.1 } })
  assert.deepEqual(f.placements, ['dirt'])
  assert.equal(f.step.echec, false, f.step.resultat)
  assert.equal(f.step.code, 'pilier_pose')
})

// Glisse hors de l axe du pilier : le centre du bot passe au-dessus du vide,
// l appui reste le pilier sous la hitbox. La montee continue sur cette colonne
// (trees/tall 799e412 : « plus d appui solide sous les pieds »).
test('glisse hors de l axe du pilier : montee poursuivie sur la colonne qui porte', async t => {
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 6 }],
    onPlace: (placements, _blocks, bot) => { if (placements.length === 1) bot.entity.position.x = 1.1 } })
  assert.deepEqual(f.placements, Array(6).fill('dirt'))
  assert.equal(f.step.echec, false, f.step.resultat)
  assert.equal(f.step.code, 'pilier_pose')
})

// Bloc solide dans la colonne a mi-hauteur : la cible serait a portee au-dessus,
// mais la montee s arreterait dessous. Aucun pilier automatique ni stock gaspille.
test('avancer : plafond reel a mi-hauteur, aucun pilier automatique', async t => {
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 8 }], first: 'avancer', logAt: new Vec3(3, 70, 0),
    extra: { '0,68,0': 'stone' } })
  assert.deepEqual(f.placements, [])
  assert.equal(f.step.echec, true)
  assert.equal(f.step.code, 'cible_haute')
  // The measured obstruction is reported, not a piler recommendation.
  assert.match(f.step.resultat, /montee bloquee ici : stone a \+3/)
  assert.doesNotMatch(f.step.resultat, /piler peut aider/)
})

// Decentre (z 0.18) : la tete touche aussi la colonne z = -1, comme piler la
// verifie. Un plafond mi-hauteur y annule le pilier sur place ; le code
// cherche alors un autre poste (ici, le seul : sur ce bloc, injoignable).
test('avancer : plafond dans la colonne voisine sous la hitbox, aucun pilier sur place', async t => {
  const trajets = []
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 8 }], first: 'avancer', logAt: new Vec3(3, 70, 0),
    start: new Vec3(0.5, 65, 0.18), extra: { '0,68,-1': 'stone' },
    navigate: async position => { trajets.push(position); return { reached: false, code: 'no_path' } } })
  assert.deepEqual(f.placements, [])
  assert.equal(f.step.code, 'cible_haute')
  assert.match(f.step.resultat, /montee bloquee ici : stone a \+3 .*injoignables a pied/)
  assert.deepEqual(trajets, [new Vec3(0.5, 69, -0.5)])
})

// Feuilles sur la montee : piler les casse, la hauteur reste mesurable.
test('avancer : feuilles sur la montee comptees comme degagees', async t => {
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 8 }], first: 'avancer', logAt: new Vec3(3, 70, 0),
    extra: { '0,68,0': 'oak_leaves' } })
  assert.equal(f.placements.length, 3, f.step.resultat)
})

// A +9 et 4 blocs de cote, aucune hauteur de 1 a 6 ne met la buche a portee,
// et aucun sol autour d elle : ni pilier ni conseil de piler, le constat le dit.
test('avancer : aucune hauteur de pilier ne suffit, aucun poste autour', async t => {
  const trajets = []
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 8 }], first: 'avancer', logAt: new Vec3(4, 74, 0),
    navigate: async position => { trajets.push(position); return { reached: true, code: 'arrived' } } })
  assert.deepEqual(f.placements, [])
  assert.equal(f.step.code, 'cible_haute')
  assert.match(f.step.resultat, /aucune hauteur de pilier \(1 a 6\) .*aucun poste de pilier libre autour de oak_log/)
  assert.doesNotMatch(f.step.resultat, /piler peut aider/)
  assert.deepEqual(trajets, [])
})

// Meme buche, sol tout autour : le code mesure les postes au sol, rejoint le
// plus bas (pilier le plus court) puis le plus proche, et reprend la mesure
// depuis la. Avant, « changer de poste » revenait au modele, qui relancait
// avancer depuis le meme endroit (cabane ~aleatoire 858ba92, dix tours).
test('avancer : aucune hauteur ne suffit ici, le code rejoint un poste mesure', async t => {
  const sol = {}
  for (let x = -2; x <= 8; x++) for (let z = -4; z <= 4; z++) sol[`${x},64,${z}`] = 'stone'
  const trajets = []
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 8 }], first: 'avancer', logAt: new Vec3(4, 74, 0),
    extra: sol,
    navigate: async (position, _options, bot) => {
      trajets.push(position)
      bot.entity.position = position.clone()
      return { reached: true, code: 'arrived' }
    } })
  assert.equal(trajets.length, 1)
  const poste = trajets[0]
  assert.equal(poste.y, 65)
  // Next to the trunk column, never in it: a 6-block pillar reaches +9 only from there.
  assert.ok(Math.hypot(poste.x - 4.5, poste.z - 0.5) <= 1.01, `poste ${poste}`)
  assert.match(f.step.resultat, /^poste de pilier rejoint en \d+,65,-?\d+ \(pilier de 6 mesure\) ; /)
})

// Arbre commence avec une quantite dite : ni la quantite atteinte ni terminer
// ne closent tant qu il reste des buches debout, et l arbre voisin n est pas
// la cible (regle joueur : jamais d arbre partiellement coupe).
async function arbreCommence (t, arbreFini) {
  const avant = process.env.FEATURE_ARBRE_FINI
  process.env.FEATURE_ARBRE_FINI = arbreFini ? '1' : '0'
  t.after(() => { if (avant === undefined) delete process.env.FEATURE_ARBRE_FINI; else process.env.FEATURE_ARBRE_FINI = avant })
  const tronc = Object.fromEntries([65, 66, 67, 68, 69, 70, 71, 72].map(y => [`1,${y},0`, 'oak_log']))
  return simulate(t, { inventory: [], first: 'casser', text: 'coupe 2 buches', logY: 65, allLogs: true,
    extra: { ...tronc, '5,65,0': 'oak_log', '5,66,0': 'oak_log' } })
}

test('arbre commence : pas de fin ni d autre arbre tant qu il reste des buches', async t => {
  const f = await arbreCommence(t, true)
  assert.equal(f.status.etat, 'stopped')
  assert.match(f.status.raison, /limite de 60 etapes/, 'seule la limite globale arrete cette mission, pas les quatre demandes de fin')
  assert.ok(f.states.length > 7)
  const apres = f.states[f.states.length - 1]
  assert.equal(JSON.stringify(apres).includes('"buches_debout":6'), true)
  assert.notEqual(apres.environnement.distance_du_bloc_cible, 4.5, 'l arbre voisin n est pas la cible')
})

test('arbre commence sans l interrupteur : quantite atteinte, mission close', async t => {
  const f = await arbreCommence(t, false)
  assert.equal(f.status.etat, 'done')
})

test('construction : avancer vise les buches hautes de l arbre commence apres un changement de poste', async t => {
  const destinations = []
  const f = await simulate(t, { inventory: [], kind: 'construction', first: 'casser',
    text: 'construis une cabane en bois', logY: 65, allLogs: true,
    extra: Object.fromEntries([66, 67, 68, 69, 70].map(y => [`1,${y},0`, 'oak_log'])),
    queue: [['casser'], ['casser'], ['avancer']],
    onDig: (block, bot) => { if (block.position.y === 68) bot.entity.position = new Vec3(20.5, 65, 0.5) },
    navigate: async (position, options) => {
      destinations.push({ position, options })
      return { reached: false, code: 'advanced', travelled: 1 }
    } })
  assert.equal(f.blocks.has('1,68,0'), false)
  assert.ok(destinations.some(d => d.options.interaction && d.position.equals(new Vec3(1.5, 69.5, 0.5))),
    'le navigateur doit viser la derniere partie du tronc, meme en construction')
})

test('rapporter l arbre : ramasser la derniere buche avant de rejoindre le joueur', async t => {
  let joins = 0
  const f = await simulate(t, { inventory: [], collectImmediately: false, first: 'casser', text: 'coupe un arbre et rapporte moi le bois',
    logY: 65, queue: [['casser'], ['rejoindre_demandeur']],
    onDig: (block, bot) => {
      if (block.name === 'oak_log') bot.entities.drop = { name: 'item', position: new Vec3(4.5, 65, 0.5),
        getDroppedItem: () => ({ name: 'oak_log', count: 1 }) }
      spawnOwn(bot, bot.entities.drop)
    },
    navigate: async target => { if (typeof target === 'string') joins++; return { reached: true, code: 'arrived', remaining: 1 } } })
  assert.equal(joins, 0, 'aucun retour au joueur avec du bois encore au sol')
  assert.ok(f.states.some(state => state.dernieres_etapes?.some(step => step.code === 'arbre_a_ramasser')))
})

test('arbre entier sans arbre_fini : le bois tombe bloque aussi le retour et le don', async t => {
  const previous = process.env.FEATURE_ARBRE_FINI
  process.env.FEATURE_ARBRE_FINI = '0'
  t.after(() => { if (previous === undefined) delete process.env.FEATURE_ARBRE_FINI; else process.env.FEATURE_ARBRE_FINI = previous })
  let joins = 0
  const f = await simulate(t, { inventory: [], collectImmediately: false, first: 'casser', text: 'coupe un arbre et donne le bois a human',
    logY: 65, queue: [['casser'], ['rejoindre_demandeur'],
      [{ action: 'donner', choices: { objet: 'oak_log', quantite: 1, destinataire: 'human' } }]],
    onDig: (block, bot) => {
      if (block.name === 'oak_log') bot.entities.drop = { name: 'item', position: new Vec3(4.5, 65, 0.5),
        getDroppedItem: () => ({ name: 'oak_log', count: 1 }) }
      spawnOwn(bot, bot.entities.drop)
    }, navigate: async target => { if (typeof target === 'string') joins++; return { reached: true, code: 'arrived', remaining: 1 } } })
  assert.equal(joins, 0)
  for (const action of ['rejoindre_demandeur', 'donner']) {
    const step = f.states.flatMap(state => state.dernieres_etapes ?? []).find(step => step.action === action)
    assert.equal(step.code, 'arbre_a_ramasser')
    assert.equal(step.echec, true)
  }
})

test('rapporter l arbre : le retour est permis quand coupe et ramassage sont mesures termines', async t => {
  let joins = 0
  const f = await simulate(t, { inventory: [], first: 'casser', text: 'coupe un arbre et rapporte moi le bois',
    logY: 65, queue: [['casser'], ['rejoindre_demandeur']],
    onDig: (_block, bot) => { bot.players.human = { entity: { position: new Vec3(5, 65, 0) } } },
    navigate: async target => { if (typeof target === 'string') joins++; return { reached: true, code: 'arrived', remaining: 1 } } })
  assert.equal(joins, 1)
  assert.equal(f.status.etat, 'done')
  assert.match(f.status.raison, /bois rapporte/)
})

for (const demande of ['remets-moi', 'file-moi', 'passe-moi', 'au joueur']) {
  test(`livraison ${demande} : la derniere buche bloque le retour et le don`, async t => {
    let joins = 0
    const f = await simulate(t, { inventory: [], collectImmediately: false, first: 'casser',
      text: demande === 'au joueur' ? 'coupe un arbre, le bois au joueur' : `coupe un arbre et ${demande} le bois`, logY: 65,
      queue: [['casser'], ['rejoindre_demandeur'],
        [{ action: 'donner', choices: { objet: 'oak_log', quantite: 1, destinataire: 'human' } }]],
      onDig: (_block, bot) => {
        bot.entities.drop = { name: 'item', position: new Vec3(4.5, 65, 0.5),
          getDroppedItem: () => ({ name: 'oak_log', count: 1 }) }
        spawnOwn(bot, bot.entities.drop)
      }, navigate: async target => { if (typeof target === 'string') joins++; return { reached: true, code: 'arrived', remaining: 1 } } })
    assert.equal(joins, 0)
    for (const action of ['rejoindre_demandeur', 'donner']) {
      const step = f.states.flatMap(state => state.dernieres_etapes ?? []).find(step => step.action === action)
      assert.equal(step.code, 'arbre_a_ramasser')
    }
  })
}

for (const mode of ['meme plan', 'plans separes', 'action intermediaire']) {
  test(`arbre de cabane encore debout : don de pommes permis (${mode})`, async t => {
    const gifts = []
    let joins = 0
    t.mock.method(delivery, 'giveToPlayer', async (_bot, options) => {
      gifts.push({ item: options.item, count: options.count })
      return { status: 'succeeded', requested: options.count, deposited: options.count,
        inventoryRemoved: options.count, evidence: { item: options.item }, reason: 'depot mesure' }
    })
    const f = await simulate(t, { inventory: [{ name: 'apple', count: 2 }], kind: 'construction', first: 'casser',
      text: 'construis une cabane en bois et donne deux pommes a human', logY: 65,
      extra: { '1,66,0': 'oak_log', '1,67,0': 'oak_log', '1,68,0': 'oak_log', '1,69,0': 'oak_log' }, allLogs: true,
      queue: mode === 'plans separes'
        ? [['casser'], ['rejoindre_demandeur'], [{ action: 'donner', choices: { objet: 'apple', quantite: 2, destinataire: 'human' } }]]
        : [['casser'], ['rejoindre_demandeur', ...(mode === 'action intermediaire' ? ['tourner_vers_demandeur'] : []),
          { action: 'donner', choices: { objet: 'apple', quantite: 2, destinataire: 'human' } }]],
      onDig: (_block, bot) => { bot.players.human = { entity: { position: new Vec3(5, 65, 0) } } },
      navigate: async target => { if (typeof target === 'string') joins++; return { reached: true, code: 'arrived', remaining: 1 } } })
    assert.ok(f.blocks.has('1,69,0'), 'une partie du tronc reste debout')
    assert.deepEqual(gifts, [{ item: 'apple', count: 2 }])
    assert.equal(joins, 1)
    const step = f.states.flatMap(state => state.dernieres_etapes ?? []).find(step => step.action === 'donner')
    assert.equal(Boolean(step.echec), false)
  })
}

test('construction : retour sans objet connu puis don de bois bloque par l arbre encore debout', async t => {
  let joins = 0
  const f = await simulate(t, { inventory: [], kind: 'construction', first: 'casser',
    text: 'construis une cabane en bois et donne deux buches a human', logY: 65,
    extra: { '1,66,0': 'oak_log', '1,67,0': 'oak_log', '1,68,0': 'oak_log', '1,69,0': 'oak_log' }, allLogs: true,
    queue: [['casser'], ['rejoindre_demandeur'],
      [{ action: 'donner', choices: { objet: 'oak_log', quantite: 2, destinataire: 'human' } }]],
    navigate: async target => { if (typeof target === 'string') joins++; return { reached: true, code: 'arrived', remaining: 1 } } })
  assert.equal(joins, 1, 'le trajet sans objet connu est differe du controle du don')
  const state = f.states.find(state => state.dernieres_etapes?.some(step => step.action === 'donner'))
  assert.equal(state.dernieres_etapes.find(step => step.action === 'donner').code, 'arbre_inacheve')
  assert.equal(state.arbre_en_cours?.buches_debout, 3, 'le trajet ne supprime pas l arbre actif des plans suivants')
  assert.notEqual(f.status.etat, 'done', 'la mission ne se clot pas avec cet arbre debout')
})

for (const action of ['construire', 'poser_porte']) {
  test(`chantier : ${action} refuse tant que l arbre commence est debout`, async t => {
    const f = await simulate(t, { inventory: [{ name: 'oak_planks', count: 8 }], kind: 'construction', first: 'casser',
      text: 'construis une cabane en bois', logY: 65, completedStructure: true,
      extra: { '1,66,0': 'oak_log', '1,67,0': 'oak_log', '1,68,0': 'oak_log', '1,69,0': 'oak_log' }, allLogs: true,
      queue: [['choisir_terrain'], ['casser'], [action]],
      navigate: async () => ({ reached: true, code: 'arrived', remaining: 1 }) })
    assert.ok(f.blocks.has('1,69,0'), 'une partie du tronc reste debout')
    const step = f.states.flatMap(state => state.dernieres_etapes ?? []).find(step => step.action === action)
    assert.ok(step, `${action} joue`)
    assert.equal(step.code, 'arbre_inacheve')
    assert.match(step.resultat, /finir la coupe avant de construire/)
  })
}

for (const split of [false, true]) {
  test(`arbre entier et pommes : trajet avec objet explicite (${split ? 'plans separes' : 'meme plan'})`, async t => {
    let joins = 0
    const join = { action: 'rejoindre_demandeur', choices: { objet: 'apple' } }
    const give = { action: 'donner', choices: { objet: 'apple', quantite: 2, destinataire: 'human' } }
    const f = await simulate(t, { inventory: [{ name: 'apple', count: 2 }], first: 'casser', logY: 65,
      text: 'coupe un arbre', context: 'donne aussi deux pommes a human', allLogs: true,
      extra: { '1,66,0': 'oak_log', '1,67,0': 'oak_log', '1,68,0': 'oak_log', '1,69,0': 'oak_log' },
      queue: split ? [['casser'], [join], [give]] : [['casser'], [join, give]],
      navigate: async target => { if (typeof target === 'string') joins++; return { reached: true, code: 'arrived', remaining: 1 } } })
    assert.ok(f.states.some(state => state.arbre_demande), 'obligation arbre entier active')
    assert.equal(joins, 1)
    const don = f.states.flatMap(state => state.dernieres_etapes ?? []).find(step => step.action === 'donner')
    assert.equal(don.code, 'no_ceiling', 'la garde arbre autorise le don ; son quota reste a preciser sur l objectif')
    assert.notEqual(f.status.etat, 'done', 'don independant ne clot pas la coupe')
  })
}

for (const fini of ['1', '0']) {
test(`arbre entier : voisin non connecte et buches deja au sol hors engagement (arbre_fini=${fini})`, async t => {
  const previous = process.env.FEATURE_ARBRE_FINI
  process.env.FEATURE_ARBRE_FINI = fini
  t.after(() => { if (previous === undefined) delete process.env.FEATURE_ARBRE_FINI; else process.env.FEATURE_ARBRE_FINI = previous })
  let joins = 0
  const f = await simulate(t, { inventory: [], first: 'casser', logY: 65,
    text: 'coupe un arbre et rapporte le bois', allLogs: true, extra: { '3,65,0': 'oak_log' },
    entities: { foreign: { name: 'item', position: new Vec3(3.5, 65, 0.5), getDroppedItem: () => ({ name: 'oak_log', count: 3 }) } },
    queue: [['casser'], ['rejoindre_demandeur']],
    onDig: (_block, bot) => { bot.players.human = { entity: { position: new Vec3(5, 65, 0) } } },
    navigate: async target => { if (typeof target === 'string') joins++; return { reached: true, code: 'arrived', remaining: 1 } } })
  assert.equal(f.blocks.has('3,65,0'), true)
  assert.equal(f.status.blocs_casses, 1)
  assert.equal(joins, 1)
  assert.equal(f.status.etat, 'done')
  assert.deepEqual(f.snapshots.at(-1).descripteur.buchesArbreDemande, [{ x: 1, y: 65, z: 0 }])
})
}

test('arbre entier : cellule de charge inconnue ne prouve pas la fin', async t => {
  let known = true
  let joins = 0
  const f = await simulate(t, { inventory: [], first: 'casser', logY: 65,
    text: 'coupe un arbre et rapporte le bois', queue: [['casser'], ['rejoindre_demandeur']],
    loaded: pos => known || pos.x !== 1,
    onDig: () => { known = false },
    navigate: async target => { if (typeof target === 'string') joins++; return { reached: true, code: 'arrived', remaining: 1 } } })
  assert.equal(joins, 0)
  assert.notEqual(f.status.etat, 'done')
  assert.equal(f.status.arbre_entier.buches_restantes, 1, 'cellule inconnue conserve une obligation non satisfaite')
})

for (const reprise of ['revision', 'rehydrate']) {
  test(`arbre entier : cellules et drops conserves apres ${reprise}`, async t => {
    let joins = 0
    const drop = { name: 'item', uuid: 'stable-drop-uuid', position: new Vec3(4.5, 65, 0.5), getDroppedItem: () => ({ name: 'oak_log', count: 1 }) }
    const desc = { kind: 'recolte', resource: 'bois', landmark: 'ici', quota: 16, wholeTree: true,
      tree: { x: 1, y: 65, z: 0 }, buchesArbreDemande: [{ x: 1, y: 65, z: 0 }], dropsArbreDemande: ['stable-drop-uuid'],
      arbreCoupes: 1, arbreCollectes: 0, arbreCollecteIds: [] }
    const f = await simulate(t, { inventory: [], collectImmediately: false, first: 'casser', logY: reprise === 'rehydrate' ? 75 : 65,
      text: 'coupe un arbre et rapporte le bois', queue: [['casser'], ['rejoindre_demandeur']],
      resume: reprise === 'rehydrate' ? { id: 'saved-tree', texte: 'coupe un arbre et rapporte le bois', auteur: 'human', progression: { descripteur: desc } } : null,
      entities: reprise === 'rehydrate' ? { anotherEntityId: drop } : {}, reviseAfterCut: reprise === 'revision',
      onDig: (_block, bot) => { bot.entities.drop = drop; spawnOwn(bot, drop) },
      navigate: async target => { if (typeof target === 'string') joins++; return { reached: true, code: 'arrived', remaining: 1 } } })
    assert.equal(joins, 0)
    const saved = f.snapshots.at(-1).descripteur
    assert.equal(saved.wholeTree, true)
    assert.deepEqual(saved.tree, desc.tree)
    assert.deepEqual(saved.buchesArbreDemande, desc.buchesArbreDemande)
    assert.deepEqual(saved.dropsArbreDemande, ['stable-drop-uuid'])
    assert.equal(saved.arbreCoupes, 1)
    if (reprise === 'revision') {
      assert.equal(saved.arbreSources[0].drop, 'stable-drop-uuid')
      assert.equal(saved.arbreSpawns[0].id, 'stable-drop-uuid')
      assert.equal(saved.arbreSpawns[0].x, 1.5)
      assert.equal(saved.arbreSpawns[0].objet, 'oak_log')
    }
    assert.equal(f.status.arbre_entier.buches_au_sol, 1)
  })
}

test('arbre entier : collecte rapide avant capture, preuve conservée et listener retire', async t => {
  const f = await simulate(t, { inventory: [], first: 'casser', logY: 65, text: 'coupe un arbre' })
  assert.equal(f.status.etat, 'done')
  assert.equal(f.snapshots.at(-1).descripteur.arbreCoupes, 1)
  assert.equal(f.snapshots.at(-1).descripteur.arbreCollectes, 1)
  assert.equal(f.collectionListeners, 0)
  assert.equal(f.spawnListeners, 0)
})

for (const retard of ['apparition', 'metadata']) {
  test(`arbre entier : derniere buche a ${retard} tardive ne permet pas de partir`, async t => {
    let joins = 0
    let metadataReady = retard !== 'metadata'
    const drop = { name: 'item', uuid: 'last-log', position: new Vec3(1.5, 65, 0.5),
      getDroppedItem: () => metadataReady ? { name: 'oak_log', count: 1 } : null }
    const f = await simulate(t, { inventory: [], collectImmediately: false, first: 'casser', logY: 65,
      text: 'coupe un arbre et rapporte le bois', queue: [['casser'], ['rejoindre_demandeur']],
      onDig: (_block, bot) => {
        if (retard === 'metadata') { bot.entities.drop = drop; bot.emit('entitySpawn', drop) }
        setTimeout(() => { metadataReady = true; bot.entities.drop = drop; bot.emit('entitySpawn', drop) }, 650)
      }, navigate: async target => { if (typeof target === 'string') joins++; return { reached: true, code: 'arrived', remaining: 1 } } })
    assert.equal(joins, 0)
    assert.notEqual(f.status.etat, 'done')
    assert.equal(f.status.arbre_entier.buches_au_sol, 1)
  })
}

// Deux buches tombees ensemble fusionnent en une pile : la seconde disparait
// hors tolerance de position, la pile est ramassee avec un compte lu avant la
// fusion (chat/question-keeps-mission 41565cc, bb4212f : 3/3 en poche, mission
// jamais close). Le gain d inventaire, sans buche au sol, prouve la collecte.
for (const depense of [false, true]) {
  test(`arbre entier : piles fusionnees ${depense ? 'puis bois depense : preuve ordinaire seule' : 'prouvees par le gain d inventaire'}`, async t => {
    const logs = { name: 'oak_log', count: 0 }
    let digs = 0
    const a = { name: 'item', uuid: 'drop-a', position: new Vec3(1.5, 65.2, 0.5), getDroppedItem: () => ({ name: 'oak_log', count: 1 }) }
    const b = { name: 'item', uuid: 'drop-b', position: new Vec3(1.5, 66.4, 0.5), getDroppedItem: () => ({ name: 'oak_log', count: 1 }) }
    const f = await simulate(t, { inventory: [], collectImmediately: false, first: 'casser', logY: 65, allLogs: true,
      text: 'coupe un arbre', extra: { '1,66,0': 'oak_log' }, queue: [['casser'], ['casser'], ['casser']],
      setup: bot => { const items = bot.inventory.items; bot.inventory.items = () => [...items(), logs].filter(i => i.count > 0) },
      onDig: (block, bot) => {
        if (!digs++) { bot.entities.a = a; bot.emit('entitySpawn', a); return }
        {
          bot.emit('entitySpawn', b)
          bot.emit('entityGone', b)
          delete bot.entities.a
          bot.emit('playerCollect', bot.entity, a)
          logs.count = depense ? 1 : 2
        }
      } })
    assert.equal(f.snapshots.at(-1).descripteur.arbreCoupes, 2)
    if (depense) {
      assert.notEqual(f.status.etat, 'done', 'gain trop court : pas de preuve par la mesure')
    } else {
      assert.equal(f.status.etat, 'done')
      assert.match(f.status.raison ?? f.status.fin ?? JSON.stringify(f.status), /arbre entier coupe et ramasse/)
    }
  })
}

test('arbre entier : collecte avant metadata prouve la fin quand son objet devient connu', async t => {
  let ready = false
  let joins = 0
  const drop = { name: 'item', uuid: 'fast-unknown', position: new Vec3(1.5, 65, 0.5),
    getDroppedItem: () => ready ? { name: 'oak_log', count: 1 } : null }
  const f = await simulate(t, { inventory: [], collectImmediately: false, first: 'casser', logY: 65,
    text: 'coupe un arbre et rapporte le bois', queue: [['casser'], ['rejoindre_demandeur']],
    onDig: (_block, bot) => {
      bot.players.human = { entity: { position: new Vec3(5, 65, 0) } }
      bot.emit('entitySpawn', drop)
      bot.emit('playerCollect', bot.entity, drop)
      setTimeout(() => { ready = true }, 650)
    }, navigate: async target => { if (typeof target === 'string') joins++; return { reached: true, code: 'arrived', remaining: 1 } } })
  assert.equal(joins, 1)
  assert.equal(f.status.etat, 'done')
  assert.equal(f.snapshots.at(-1).descripteur.arbreCollectes, 1)
  assert.equal(f.collectionListeners, 0)
  assert.equal(f.spawnListeners, 0)
})

test('arbre entier : collecte de bois preexistant ne couvre pas sa derniere buche', async t => {
  let joins = 0
  const foreign = { name: 'item', uuid: 'foreign-log', position: new Vec3(3.5, 65, 0.5),
    getDroppedItem: () => ({ name: 'oak_log', count: 4 }) }
  const f = await simulate(t, { inventory: [], collectImmediately: false, first: 'casser', logY: 65,
    text: 'coupe un arbre et rapporte le bois', entities: { foreign }, queue: [['casser'], ['rejoindre_demandeur']],
    onDig: (_block, bot) => { bot.emit('playerCollect', bot.entity, foreign); delete bot.entities.foreign },
    navigate: async target => { if (typeof target === 'string') joins++; return { reached: true, code: 'arrived', remaining: 1 } } })
  assert.equal(joins, 0)
  assert.notEqual(f.status.etat, 'done')
  assert.equal(f.snapshots.at(-1).descripteur.arbreCollectes, 0)
  assert.equal(f.status.arbre_entier.buches_au_sol, 1)
})

for (const [name, y] of [['birch_log', 65], ['oak_log', 65], ['oak_log', 1]]) {
  test(`arbre entier : nouveau drop etranger ${name} a y=${y} proche ne couvre pas sa coupe`, async t => {
    const foreign = { name: 'item', uuid: `new-foreign-${name}`, position: new Vec3(3.5, y, 0.5),
      getDroppedItem: () => ({ name, count: 1 }) }
    const f = await simulate(t, { inventory: [], collectImmediately: false, first: 'casser', logY: 65,
      text: 'coupe un arbre', extra: { '3,65,0': 'oak_log' }, allLogs: true,
      onDig: (_block, bot) => {
        bot.entities.foreign = foreign
        bot.emit('entitySpawn', foreign)
        bot.emit('playerCollect', bot.entity, foreign)
        delete bot.entities.foreign
        setTimeout(() => { bot.entities.own = { name: 'item', uuid: 'own-late', position: new Vec3(1.5, 65, 0.5),
          getDroppedItem: () => ({ name: 'oak_log', count: 1 }) }; bot.emit('entitySpawn', bot.entities.own) }, 650)
      } })
    assert.notEqual(f.status.etat, 'done')
    assert.equal(f.snapshots.at(-1).descripteur.arbreCollectes, 0)
    assert.equal(f.status.arbre_entier.buches_au_sol, 1)
    assert.equal(f.blocks.has('3,65,0'), true)
  })
}

// Arbre fini depuis le pilier : le pilier monte pour lui est defait (regle
// joueur : retirer ce qui a ete construit a cote de l arbre).
test('arbre fini depuis le pilier : pilier retire avant la fin', async t => {
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 6 }], queue: [['piler'], ['casser']] })
  assert.deepEqual(f.placements, Array(6).fill('dirt'))
  assert.equal(f.status.etat, 'done', f.status.raison)
  assert.equal([65, 66, 67, 68, 69, 70].filter(y => f.blocks.has(`0,${y},0`)).length, 0, 'pilier defait')
  assert.equal(f.status.echafaudage_laisse, 0)
})

// Premier arbre fini, pilier monte ensuite pour le suivant : l ancre du
// premier est oubliee a sa fin, le nouveau pilier n est pas defait avant
// d avoir servi (revue Codex 71cbbf4).
test('arbre fini puis pilier pour le suivant : pilier garde', async t => {
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 6 }], logAt: new Vec3(3, 74, 0), allLogs: true,
    text: 'coupe du bois', extra: { '1,65,0': 'oak_log' }, queue: [['casser'], ['piler']] })
  assert.equal(f.blocks.has('1,65,0'), false, 'premier arbre coupe')
  assert.deepEqual(f.placements, Array(6).fill('dirt'))
  assert.equal([65, 66, 67, 68, 69, 70].filter(y => f.blocks.has(`0,${y},0`)).length, 6, 'pilier garde')
})


test('arbre commence : une buche deconnectee dans la meme colonne reste intacte', async t => {
  const f = await simulate(t, { inventory: [], first: 'casser', text: 'coupe 1 buche',
    logY: 65, allLogs: true, extra: { '1,70,0': 'oak_log' } })
  assert.equal(f.status.etat, 'done')
  assert.equal(f.blocks.has('1,70,0'), true)
  assert.equal(f.status.blocs_casses, 1)
})

test('fin arbre dans une rafale : le voisin attend le demontage', async t => {
  const f = await simulate(t, { inventory: [], first: 'casser', text: 'coupe 1 buche',
    logY: 65, allLogs: true, extra: { '3,65,0': 'oak_log' } })
  assert.equal(f.status.blocs_casses, 1)
  assert.equal(f.blocks.has('3,65,0'), true)
})

test('echafaudage : une panne de creusage temporaire est retentee', async t => {
  let refusals = 0
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 6 }],
    queue: [['piler'], ['casser'], ['dire']],
    digFailure: block => block.name === 'dirt' && refusals++ < 2 })
  assert.equal(f.status.etat, 'done')
  assert.equal(f.status.echafaudage_laisse, 0)
  assert.equal([65, 66, 67, 68, 69, 70].filter(y => f.blocks.has(`0,${y},0`)).length, 0)
})


test('echafaudage : un echec durable conserve les cellules dans le descripteur', async t => {
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 6 }],
    queue: [['piler'], ['casser']], digFailure: block => block.name === 'dirt' })
  assert.equal(f.status.echafaudage_laisse, 6)
  assert.equal(f.snapshots.at(-1).descripteur.echafaudageEnAttente.length, 6)
  assert.equal(f.snapshots.at(-1).descripteur.arbreEnCours, null)
  assert.equal(f.snapshots.at(-1).descripteur.echafaudagePose.length, 0)
})

function spawnOwn (bot, entity) {
  if (!entity) return
  entity.uuid ??= 'own-drop'
  const drifted = entity.position
  entity.position = new Vec3(1.5, 65.5, 0.5)
  bot.emit('entitySpawn', entity)
  entity.position = drifted
}

for (const source of ['sans spawn', 'derive apres spawn']) {
  test(`arbre entier : collecte ${source} garde sa provenance initiale`, async t => {
    const drop = { name: 'item', uuid: 'provenance', position: new Vec3(1.5, 65.5, 0.5), getDroppedItem: () => ({ name: 'oak_log', count: 1 }) }
    const f = await simulate(t, { inventory: [], collectImmediately: false, first: 'casser', logY: 65, text: 'coupe un arbre',
      onDig: (_block, bot) => {
        if (source !== 'sans spawn') bot.emit('entitySpawn', drop)
        drop.position = new Vec3(4.5, 65, 0.5)
        bot.emit('playerCollect', bot.entity, drop)
      } })
    assert.equal(f.snapshots.at(-1).descripteur.arbreCollectes, source === 'sans spawn' ? 0 : 1)
    assert.equal(f.status.etat === 'done', source !== 'sans spawn')
  })
}

test('arbre entier : pile fusionnee ne credite pas davantage que la coupe prouvee', async t => {
  const f = await simulate(t, { inventory: [], collectImmediately: false, first: 'casser', logY: 65, text: 'coupe un arbre',
    onDig: (_block, bot) => {
      const drop = { name: 'item', uuid: 'merged', position: new Vec3(1.5, 65.5, 0.5), getDroppedItem: () => ({ name: 'oak_log', count: 5 }) }
      bot.emit('entitySpawn', drop)
      bot.emit('playerCollect', bot.entity, drop)
    } })
  assert.equal(f.status.etat, 'done')
  assert.equal(f.snapshots.at(-1).descripteur.arbreCollectes, 1)
})

test('arbre entier : amendement de remise sans mot arbre garde le ramassage', async t => {
  const f = await simulate(t, { inventory: [], collectImmediately: false, first: 'casser', logY: 65,
    text: 'coupe un arbre', revisionText: 'rapporte-moi le bois', reviseAfterCut: true,
    onDig: (_block, bot) => { bot.entities.drop = { name: 'item', uuid: 'amended', position: new Vec3(4.5, 65, 0.5), getDroppedItem: () => ({ name: 'oak_log', count: 1 }) }; spawnOwn(bot, bot.entities.drop) } })
  assert.equal(f.snapshots.at(-1).descripteur.wholeTree, true)
  assert.notEqual(f.status.etat, 'done')
  assert.equal(f.status.arbre_entier.buches_au_sol, 1)
})

for (const [otherCollector, delta] of [[false, 1], [true, 1], [false, 2]]) {
  test(`arbre entier : fusion dans pile preexistante delta=${delta}, coupe ramassee par ${otherCollector ? 'tiers' : 'bot'}`, async t => {
    let quantity = 5
    const baseline = { name: 'item', uuid: 'baseline-stack', position: new Vec3(1.5, 65.5, 0.5), getDroppedItem: () => ({ name: 'oak_log', count: quantity }) }
    const f = await simulate(t, { inventory: [], collectImmediately: false, first: 'casser', logY: 65, text: 'coupe un arbre', entities: { baseline },
      onDig: (_block, bot) => {
        const own = { name: 'item', uuid: 'own-before-merge', position: new Vec3(1.5, 65.5, 0.5), getDroppedItem: () => ({ name: 'oak_log', count: 1 }) }
        bot.emit('entitySpawn', own)
        if (otherCollector) bot.emit('playerCollect', { id: 900 }, own)
        bot.emit('entityGone', own)
        quantity = 5 + delta
        bot.emit('entityUpdate', baseline)
        bot.emit('playerCollect', bot.entity, baseline)
        delete bot.entities.baseline
      } })
    assert.equal(f.snapshots.at(-1).descripteur.arbreCollectes, otherCollector || delta !== 1 ? 0 : 1)
    assert.equal(f.status.etat === 'done', !otherCollector && delta === 1)
  })
}

test('arbre entier : deux coupes fusionnees dans la nouvelle pile prouvent deux unites', async t => {
  let first
  const f = await simulate(t, { inventory: [], collectImmediately: false, first: 'casser', logY: 65, text: 'coupe un arbre', allLogs: true, extra: { '2,65,0': 'oak_log' },
    onDig: (block, bot) => {
      const own = { name: 'item', uuid: `merge-${block.position.x}`, position: block.position.offset(0.5, 0.5, 0.5), getDroppedItem: () => ({ name: 'oak_log', count: first ? 2 : 1 }) }
      bot.emit('entitySpawn', own)
      if (!first) { first = own; return }
      first.position = own.position
      bot.emit('entityGone', first)
      bot.emit('playerCollect', bot.entity, own)
    } })
  assert.equal(f.status.etat, 'done')
  assert.equal(f.snapshots.at(-1).descripteur.arbreCoupes, 2)
  assert.equal(f.snapshots.at(-1).descripteur.arbreCollectes, 2)
})

test('construction complete : retour differe apres arbre doit preceder fin', async t => {
  let joins = 0
  let permitSecond = false
  const f = await simulate(t, { inventory: [], kind: 'construction', text: 'construis une cabane et rapporte-moi le bois', completedStructure: true, digFailure: block => block.position.y === 66 && !permitSecond,
    first: 'casser', logY: 65, extra: { '1,66,0': 'oak_log' }, allLogs: false,
    queue: [['choisir_terrain'], ['casser'], [{ action: 'rejoindre_demandeur', choices: { objet: 'oak_log' } }], ['casser'], [{ action: 'rejoindre_demandeur', choices: { objet: 'oak_log' } }]],
    onDig: (block, bot) => { bot.players.human = { entity: { position: new Vec3(5, 65, 0) } }; if (block.position.y === 65) setTimeout(() => { permitSecond = true }, 650); if (block.position.y === 66) { const old = bot.blockAt; bot.blockAt = p => p.x === 10 ? { name: 'oak_planks', position: p, boundingBox: 'block' } : old(p) } },
    navigate: async target => { if (typeof target === 'string') joins++; return { reached: true, code: 'arrived', remaining: 0 } } })
  assert.equal(joins, 1)
  assert.equal(f.status.etat, 'done')
  assert.ok(f.snapshots.some(s => s.descripteur.pendingJoin === true))
  assert.equal(f.snapshots.at(-1).descripteur.pendingJoin, false)
})

for (const unknown of ['initial', 'decharge']) {
  test(`arbre entier : cellule ${unknown} inconnue garde cible et recapture apres retour`, async t => {
    let known = false
    let movements = 0
    const f = await simulate(t, { inventory: [], first: 'casser', logY: 65, text: 'coupe un arbre', extra: { '1,66,0': 'oak_log' }, allLogs: false,
      loaded: p => unknown === 'initial' ? (known || p.x !== 2) : (known || p.x !== 1 || movements === 0),
      onDig: block => { if (unknown === 'decharge' && block.position.y === 65) movements = 1 },
      queue: [['casser'], ['avancer'], ['casser']],
      navigate: async () => { movements++; known = true; return { reached: true, code: 'arrived', remaining: 0 } } })
    assert.ok(movements > (unknown === 'decharge' ? 1 : 0))
    assert.equal(f.status.etat, 'done')
    assert.equal(f.snapshots.at(-1).descripteur.arbreCoupes, 2)
  })
}

test('arbre entier : collecte metadata retardee conserve preuve pendant revision', async t => {
  let ready = false
  const drop = { name: 'item', uuid: 'pending-revision', position: new Vec3(1.5, 65.5, 0.5), getDroppedItem: () => ready ? { name: 'oak_log', count: 1 } : null }
  const f = await simulate(t, { inventory: [], collectImmediately: false, first: 'casser', logY: 65, text: 'coupe un arbre', reviseAfterCut: true, queue: [['casser'], [{ action: 'attendre', choices: { duree: 1 } }]],
    onDig: (_block, bot) => { bot.emit('entitySpawn', drop); bot.emit('playerCollect', bot.entity, drop); setTimeout(() => { ready = true }, 650) } })
  assert.equal(f.status.etat, 'done')
  assert.equal(f.snapshots.at(-1).descripteur.arbreCollectes, 1)
})

test('arbre entier : spawns etrangers massifs restent hors suivi', async t => {
  const f = await simulate(t, { inventory: [], collectImmediately: false, first: 'casser', logY: 65, text: 'coupe un arbre',
    onDig: (_block, bot) => { for (let i = 0; i < 2000; i++) bot.emit('entitySpawn', { name: 'item', uuid: `distant-${i}`, position: new Vec3(30, 65, 30), getDroppedItem: () => ({ name: 'oak_log', count: 1 }) }) } })
  assert.equal(f.snapshots.at(-1).descripteur.arbreSpawns.length, 0)
  assert.notEqual(f.status.etat, 'done')
})

for (const metadata of [true, false]) {
  test(`arbre entier : reprise preuve collecteur persistée metadata=${metadata}`, async t => {
    const desc = { kind: 'recolte', resource: 'bois', landmark: 'ici', quota: 16, wholeTree: true,
      tree: { x: 1, y: 65, z: 0 }, buchesArbreDemande: [{ x: 1, y: 65, z: 0 }], dropsArbreDemande: [], arbreCoupes: 1, arbreCollectes: 0,
      arbreSources: [{ x: 1, y: 65, z: 0, objet: 'oak_log', id: 'saved-source', confirmee: true, ouverte: false, drop: null }],
      arbreSpawns: [{ id: 'saved-picked', source: 'saved-source', x: 1.5, y: 65.5, z: 0.5, objet: metadata ? 'oak_log' : null,
        collectedByBot: true, collectCount: metadata ? 1 : null, collectPosition: { x: 1.5, y: 65.5, z: 0.5 } }] }
    const f = await simulate(t, { inventory: [], first: 'casser', logY: 75,
      resume: { id: 'saved-tree', texte: 'coupe un arbre', auteur: 'human', progression: { descripteur: desc } } })
    assert.equal(f.status.etat === 'done', metadata)
    assert.equal(f.snapshots.at(-1).descripteur.arbreCollectes, metadata ? 1 : 0)
    assert.equal(f.snapshots.at(-1).descripteur.arbreSpawns[0].collectedByBot, true)
  })
}

for (const delayed of ['spawn', 'metadata']) {
  test(`arbre entier : vrai drop ${delayed}650ms collecte ensuite permet fin`, async t => {
    let ready = delayed === 'spawn'
    const drop = { name: 'item', uuid: `delayed-${delayed}`, position: new Vec3(1.5, 65.5, 0.5), getDroppedItem: () => ready ? { name: 'oak_log', count: 1 } : null }
    const f = await simulate(t, { inventory: [], collectImmediately: false, first: 'casser', logY: 65, text: 'coupe un arbre',
      queue: [['casser', { action: 'attendre', choices: { duree: 1 } }]],
      onDig: (_block, bot) => {
        if (delayed === 'metadata') bot.emit('entitySpawn', drop)
        setTimeout(() => { ready = true; bot.entities.drop = drop; if (delayed === 'spawn') bot.emit('entitySpawn', drop); else bot.emit('entityUpdate', drop) }, 650)
        setTimeout(() => { bot.emit('playerCollect', bot.entity, drop); delete bot.entities.drop }, 750)
      } })
    assert.equal(f.status.etat, 'done')
    assert.equal(f.snapshots.at(-1).descripteur.arbreCollectes, 1)
    assert.equal(f.collectionListeners, 0)
  })
}

test('construction complete : don modele differe par arbre reste une obligation apres retour', async t => {
  let permitSecond = false
  let gifts = 0
  t.mock.method(delivery, 'giveToPlayer', async (_bot, options) => {
    gifts++
    return { status: 'succeeded', deposited: options.count, inventoryRemoved: options.count, requested: options.count, evidence: { item: options.item }, reason: 'inventory_decrease' }
  })
  const join = { action: 'rejoindre_demandeur', choices: { objet: 'oak_log' } }
  const gift = { action: 'donner', choices: { objet: 'oak_log', quantite: 2, destinataire: 'human' } }
  const f = await simulate(t, { inventory: [], kind: 'construction', text: 'construis une cabane et donne-moi 2 buches', completedStructure: true,
    digFailure: block => block.position.y === 66 && !permitSecond,
    first: 'casser', logY: 65, extra: { '1,66,0': 'oak_log' },
    queue: [['choisir_terrain'], ['casser'], [join, gift], ['casser'], ['casser'], [join, gift]],
    onDig: (block, bot) => { bot.players.human = { entity: { position: new Vec3(5, 65, 0) } }; if (block.position.y === 65) setTimeout(() => { permitSecond = true }, 650); if (block.position.y === 66) { const old = bot.blockAt; bot.blockAt = p => p.x === 10 ? { name: 'oak_planks', position: p, boundingBox: 'block' } : old(p) } },
    navigate: async () => ({ reached: true, code: 'arrived', remaining: 0 }) })
  assert.equal(gifts, 1)
  assert.equal(f.status.etat, 'done')
  assert.ok(f.snapshots.some(s => s.descripteur.livraison?.some(l => l.prouve === 0)))
})

for (const pickupPaused of [false, true]) {
  test(`arbre entier : spawn retarde pendant pause puis collecte pause=${pickupPaused} garde preuve`, async t => {
    const drop = { name: 'item', uuid: 'spawn-during-pause', position: new Vec3(1.5, 65.5, 0.5), getDroppedItem: () => ({ name: 'oak_log', count: 1 }) }
    const f = await simulate(t, { inventory: [], collectImmediately: false, first: 'casser', logY: 65, text: 'coupe un arbre', pauseAfterCut: true,
      queue: [['casser'], [{ action: 'attendre', choices: { duree: 1 } }]],
      onDig: (_block, bot) => { setTimeout(() => { bot.entities.drop = drop; bot.emit('entitySpawn', drop) }, 650); setTimeout(() => { bot.emit('playerCollect', bot.entity, drop); delete bot.entities.drop }, pickupPaused ? 750 : 1500) } })
    assert.equal(f.status.etat, 'done')
    assert.equal(f.snapshots.at(-1).descripteur.arbreCollectes, 1)
    assert.equal(f.spawnListeners, 0)
    assert.equal(f.collectionListeners, 0)
  })
}

for (const donEnFile of [false, true]) {
 test(`construction revisee sans livraison : retour ancien donEnFile=${donEnFile} ne bloque plus chantier complet`, async t => {
  let permitSecond = false
  const f = await simulate(t, { inventory: [], kind: 'construction', text: 'construis une cabane et donne-moi 2 buches', completedStructure: true,
    revisionOnPendingJoin: true, revisionText: 'construis seulement une cabane',
    digFailure: block => block.position.y === 66 && !permitSecond,
    first: 'casser', logY: 65, extra: { '1,66,0': 'oak_log' },
    queue: [['choisir_terrain'], ['casser'], [{ action: 'rejoindre_demandeur', choices: { objet: 'oak_log' } }, ...(donEnFile ? [{ action: 'donner', choices: { objet: 'oak_log', quantite: 2, destinataire: 'human' } }] : [])], ['casser'], ...(donEnFile ? [['casser']] : []), ['choisir_terrain']],
    onDig: (block, bot) => { if (block.position.y === 65) setTimeout(() => { permitSecond = true }, 650); if (block.position.y === 66) { const old = bot.blockAt; bot.blockAt = p => p.x === 10 ? { name: 'oak_planks', position: p, boundingBox: 'block' } : old(p) } } })
  assert.equal(f.status.etat, 'done')
  assert.equal(f.snapshots.at(-1).descripteur.pendingJoin, false)
  assert.ok(f.snapshots.some(s => s.descripteur.pendingJoin === true))
  assert.equal(f.snapshots.at(-1).descripteur.livraison.length, 0)
  if (donEnFile) assert.ok(f.snapshots.some(s => s.descripteur.livraison.length === 1))
 })
}


test('arbre entier : ancien descripteur source sans id reprend metadata retardee', async t => {
  let ready = false
  const drop = { name: 'item', uuid: 'legacy-drop', position: new Vec3(1.5, 65.5, 0.5), getDroppedItem: () => ready ? { name: 'oak_log', count: 1 } : null }
  const desc = { kind: 'recolte', resource: 'bois', landmark: 'ici', quota: 16, wholeTree: true,
    tree: { x: 1, y: 65, z: 0 }, buchesArbreDemande: [{ x: 1, y: 65, z: 0 }], arbreCoupes: 1,
    arbreSources: [{ x: 1, y: 65, z: 0, objet: 'oak_log', drop: null }],
    arbreSpawns: [{ id: 'legacy-drop', x: 1.5, y: 65.5, z: 0.5, objet: null }] }
  const f = await simulate(t, { inventory: [], first: 'attendre', logY: 75, entities: { drop },
    resume: { id: 'legacy-tree', texte: 'coupe un arbre', auteur: 'human', progression: { descripteur: desc } },
    setup: bot => { setTimeout(() => { ready = true; bot.emit('entityUpdate', drop) }, 650); setTimeout(() => { bot.emit('playerCollect', bot.entity, drop); delete bot.entities.drop }, 750) },
    navigate: async () => ({ reached: true }) })
  assert.equal(f.status.etat, 'done')
  assert.equal(f.snapshots.at(-1).descripteur.arbreCollectes, 1)
})

for (const boundary of ['ambigu', 'etranger']) {
  test(`arbre entier : migration legacy ${boundary} ne fabrique pas de provenance`, async t => {
    const drop = { name: 'item', uuid: 'legacy-unowned', position: new Vec3(1.5, 65.5, 0.5), getDroppedItem: () => ({ name: 'oak_log', count: 1 }) }
    const sources = [{ x: 1, y: 65, z: 0, objet: 'oak_log' }]
    if (boundary === 'ambigu') sources.push({ ...sources[0] })
    const desc = { kind: 'recolte', resource: 'bois', landmark: 'ici', quota: 16, wholeTree: true,
      tree: { x: 1, y: 65, z: 0 }, buchesArbreDemande: [{ x: 1, y: 65, z: 0 }], arbreCoupes: sources.length,
      arbreSources: sources, arbreSpawns: [{ id: 'legacy-unowned', x: boundary === 'etranger' ? 10 : 1.5, y: 65.5, z: 0.5, objet: null }] }
    const f = await simulate(t, { inventory: [], first: 'attendre', logY: 75, entities: { drop },
      resume: { id: 'legacy-unowned-tree', texte: 'coupe un arbre', auteur: 'human', progression: { descripteur: desc } },
      setup: bot => setTimeout(() => { bot.emit('playerCollect', bot.entity, drop); delete bot.entities.drop }, 650) })
    assert.notEqual(f.status.etat, 'done')
    assert.equal(f.snapshots.at(-1).descripteur.arbreCollectes, 0)
  })
}

for (const lifecycle of ['stop', 'new', 'end']) {
  test(`arbre entier : observation passive pause nettoyee par ${lifecycle}`, async t => {
    const f = await simulate(t, { inventory: [], collectImmediately: false, first: 'casser', logY: 65, text: 'coupe un arbre', pauseAfterCut: true, pauseLifecycle: lifecycle,
      queue: [['casser'], [{ action: 'attendre', choices: { duree: 1 } }]] })
    assert.equal(f.lifecycleListeners, 0)
    assert.equal(f.spawnListeners, 0)
    assert.equal(f.collectionListeners, 0)
  })
}

test('arbre entier : observation passive pause refuse2000spawns et conserve collecte tardive', async t => {
  const drop = { name: 'item', uuid: 'paused-real-drop', position: new Vec3(1.5, 65.5, 0.5), getDroppedItem: () => ({ name: 'oak_log', count: 1 }) }
  const f = await simulate(t, { inventory: [], collectImmediately: false, first: 'casser', logY: 65, text: 'coupe un arbre', pauseAfterCut: true,
    queue: [['casser'], [{ action: 'attendre', choices: { duree: 1 } }]],
    onDig: (_block, bot) => {
      setTimeout(() => { for (let i = 0; i < 2000; i++) bot.emit('entitySpawn', { name: 'item', uuid: `paused-foreign-${i}`, position: new Vec3(30, 65, 30), getDroppedItem: () => ({ name: 'oak_log', count: 1 }) }) }, 600)
      setTimeout(() => { bot.emit('entitySpawn', drop); bot.emit('playerCollect', bot.entity, drop) }, 650)
    } })
  assert.equal(f.status.etat, 'done')
  assert.equal(f.snapshots.at(-1).descripteur.arbreSpawns.length, 1)
  assert.equal(f.snapshots.at(-1).descripteur.arbreCollectes, 1)
  assert.equal(f.collectionListeners, 0)
})

for (const preuve of ['partielle', 'incertaine']) {
  test(`construction revisee sans livraison apres don ${preuve} : chantier finit et historique reste`, async t => {
    let gifts = 0
    t.mock.method(delivery, 'giveToPlayer', async (bot, options) => {
      gifts++
      bot.inventory.items().find(item => item.name === 'oak_log').count--
      const old = bot.blockAt
      bot.blockAt = p => p.x === 10 ? { name: 'oak_planks', position: p, boundingBox: 'block' } : old(p)
      return { status: 'partial', deposited: preuve === 'partielle' ? 1 : 0, inventoryRemoved: 1,
        requested: options.count, evidence: { item: options.item }, reason: 'observed_partial' }
    })
    const f = await simulate(t, { inventory: [{ name: 'oak_log', count: 2 }], kind: 'construction',
      text: 'construis une cabane et donne-moi 2 buches', completedStructure: true,
      revisionOnPendingJoin: true, revisionText: 'construis seulement une cabane',
      queue: [['choisir_terrain'], [{ action: 'donner', choices: { objet: 'oak_log', quantite: 2, destinataire: 'human' } }],
        [{ action: 'rejoindre_demandeur', choices: { objet: 'oak_log' } }], ['choisir_terrain']],
      navigate: async () => ({ reached: false, code: 'player_unknown', remaining: null }) })
    assert.equal(gifts, 1)
    assert.equal(f.status.etat, 'done')
    assert.equal(f.status.objectif, 'construis seulement une cabane')
    assert.equal(f.snapshots.at(-1).descripteur.pendingJoin, false)
    const ledger = f.snapshots.at(-1).descripteur.livraison[0]
    assert.equal(ledger.tente, 2)
    assert.equal(ledger.retire, 1)
    assert.equal(ledger.prouve, preuve === 'partielle' ? 1 : 0)
    assert.equal(ledger.incertain, preuve === 'partielle' ? 0 : 1)
    assert.equal(ledger.annule, true)
    assert.equal(ledger.invocations.length, 1)
  })
}

for (const livraisonDemandee of [false, true]) {
  test(`don historique annule reprend puis livraisonDemandee=${livraisonDemandee} garde budget incertain`, async t => {
    let gifts = 0
    t.mock.method(delivery, 'giveToPlayer', async () => { gifts++; throw new Error('aucun retoss autorise') })
    const desc = { kind: 'construction', resource: 'bois', landmark: 'ici', quota: 16, wholeTree: false,
      livraison: [{ destinataire: 'human', objet: 'oak_log', plafond: 2, tente: 2, retire: 1,
        prouve: 0, incertain: 1, invocations: ['old#don-1'], termine: false, annule: true }] }
    const f = await simulate(t, { inventory: [{ name: 'oak_log', count: 2 }], kind: 'construction', completedStructure: true,
      resume: { id: 'cancelled-delivery', texte: livraisonDemandee ? 'construis une cabane et donne-moi 2 buches' : 'construis seulement une cabane', auteur: 'human', progression: { descripteur: desc } },
      queue: [livraisonDemandee ? [{ action: 'donner', choices: { objet: 'oak_log', quantite: 2, destinataire: 'human' } }] : ['choisir_terrain']],
      setup: bot => { const old = bot.blockAt; bot.blockAt = p => p.x === 10 ? { name: 'oak_planks', position: p, boundingBox: 'block' } : old(p) } })
    assert.equal(gifts, 0)
    assert.equal(f.status.etat === 'done', !livraisonDemandee)
    const ledger = f.snapshots.at(-1).descripteur.livraison[0]
    assert.equal(ledger.tente, 2)
    assert.equal(ledger.retire, 1)
    assert.equal(ledger.prouve, 0)
    assert.equal(ledger.incertain, 1)
    assert.equal(Boolean(ledger.annule), !livraisonDemandee)
    assert.deepEqual(ledger.invocations, ['old#don-1'])
    if (livraisonDemandee) assert.ok(f.states.some(state => state.dernieres_etapes?.some(step => step.code === 'uncertain_blocked')))
  })
}

test('arbre entier : drop apparu et ramasse pendant la lecture d une revision garde sa preuve', async t => {
  const drop = { name: 'item', uuid: 'spawn-during-revision', position: new Vec3(1.5, 65.5, 0.5), getDroppedItem: () => ({ name: 'oak_log', count: 1 }) }
  const f = await simulate(t, { inventory: [], collectImmediately: false, first: 'casser', logY: 65, text: 'coupe un arbre', reviseAfterCut: true,
    queue: [['casser'], [{ action: 'attendre', choices: { duree: 1 } }]],
    duringRevisionBrief: bot => { bot.emit('entitySpawn', drop); bot.emit('playerCollect', bot.entity, drop) } })
  assert.equal(f.status.etat, 'done')
  assert.equal(f.snapshots.at(-1).descripteur.arbreCollectes, 1)
  assert.equal(f.collectionListeners, 0)
})

test('don remplace par la revision : l ancien objet ne bloque plus, son historique reste', async t => {
  t.mock.method(delivery, 'giveToPlayer', async (_bot, options) => {
    const deposited = options.item === 'oak_log' ? 1 : options.count
    return { status: deposited < options.count ? 'partial' : 'succeeded', deposited, inventoryRemoved: deposited,
      requested: options.count, evidence: { item: options.item }, reason: 'inventory_decrease' }
  })
  const f = await simulate(t, { inventory: [{ name: 'oak_log', count: 2 }, { name: 'apple', count: 2 }], kind: 'construction',
    text: 'construis une cabane et donne-moi 2 buches', completedStructure: true,
    reviseWhen: snap => snap?.descripteur.livraison?.some(l => l.objet === 'oak_log' && l.prouve === 1),
    revisionText: 'construis une cabane et donne-moi 2 pommes',
    queue: [[{ action: 'donner', choices: { objet: 'oak_log', quantite: 2, destinataire: 'human' } }],
      [{ action: 'donner', choices: { objet: 'apple', quantite: 2, destinataire: 'human' } }], ['choisir_terrain']],
    setup: bot => { bot.players.human = { entity: { position: new Vec3(2, 65, 0) } }; const old = bot.blockAt; bot.blockAt = p => p.x === 10 ? { name: 'oak_planks', position: p, boundingBox: 'block' } : old(p) } })
  assert.equal(f.status.etat, 'done')
  const ledgers = f.snapshots.at(-1).descripteur.livraison
  const logs = ledgers.find(l => l.objet === 'oak_log')
  assert.equal(logs.prouve, 1)
  assert.equal(logs.annule, true)
  assert.equal(ledgers.find(l => l.objet === 'apple').prouve, 2)
})

test('arbre entier : creusage interrompu mais bloc casse par le serveur compte la coupe', async t => {
  let aborted = 0
  const f = await simulate(t, { inventory: [], first: 'casser', logY: 65, text: 'coupe un arbre', extra: { '1,66,0': 'oak_log' },
    abortAfterDig: () => aborted++ === 0,
    queue: [['casser'], ['casser'], ['casser'], [{ action: 'attendre', choices: { duree: 1 } }]] })
  assert.equal(aborted > 0, true)
  assert.equal(f.status.etat, 'done')
  const d = f.snapshots.at(-1).descripteur
  assert.equal(d.arbreCoupes, 2)
  assert.equal(d.arbreCollectes, 2)
})

test('arbre entier puis « rapporte-moi le bois » sans chiffre : le bois mesure de cet arbre est donne', async t => {
  const gifts = []
  t.mock.method(delivery, 'giveToPlayer', async (_bot, options) => {
    gifts.push(options.count)
    return { status: 'succeeded', deposited: options.count, inventoryRemoved: options.count, requested: options.count,
      evidence: { item: options.item }, reason: 'inventory_decrease' }
  })
  const f = await simulate(t, { inventory: [], first: 'casser', logY: 65, text: 'coupe un arbre', context: 'et rapporte moi le bois quand tu as fini',
    extra: { '1,66,0': 'oak_log' },
    queue: [['casser'], [{ action: 'donner', choices: { objet: 'oak_log', quantite: 5, destinataire: 'human' } }], ['rejoindre_demandeur']],
    setup: bot => { bot.players.human = { entity: { position: new Vec3(2, 65, 0) } } },
    // Premier retour manque : le modele donne avant d etre revenu (bench 6d5e479).
    navigate: (() => { let n = 0; return async () => n++ === 0 ? { reached: false, code: 'no_path', remaining: 5 } : { reached: true, code: 'arrived', remaining: 1 } })() })
  assert.deepEqual(gifts, [2], 'plafond = 2 buches de cet arbre, pas les 5 du modele')
  assert.equal(f.status.etat, 'done')
  assert.equal(f.snapshots.at(-1).descripteur.livraison[0].prouve, 2)
})

test('construction et don demande : don prouve ne prouve pas chantier incomplet', async t => {
  t.mock.method(delivery, 'giveToPlayer', async (bot, options) => {
    bot.inventory.items().find(item => item.name === 'oak_log').count -= options.count
    return { status: 'succeeded', deposited: options.count, inventoryRemoved: options.count, requested: options.count,
      evidence: { item: options.item }, reason: 'inventory_decrease' }
  })
  const f = await simulate(t, { inventory: [{ name: 'oak_log', count: 2 }], kind: 'construction', text: 'construis une cabane et donne-moi 2 buches', completedStructure: true,
    queue: [['choisir_terrain'], [{ action: 'donner', choices: { objet: 'oak_log', quantite: 2, destinataire: 'human' } }], ['terminer']] })
  assert.notEqual(f.status.etat, 'done')
  assert.equal(f.status.chantier.blocs_poses, 0)
  assert.equal(f.status.chantier.blocs_prevus, 1)
  assert.equal(f.snapshots.at(-1).descripteur.livraison[0].prouve, 2)
})

test('arbre entier et don independant : don prouve ne dispense pas collecte finale', async t => {
  let gifts = 0
  t.mock.method(delivery, 'giveToPlayer', async (bot, options) => {
    gifts++
    bot.inventory.items().find(item => item.name === 'apple').count -= options.count
    return { status: 'succeeded', deposited: options.count, inventoryRemoved: options.count, requested: options.count,
      evidence: { item: options.item }, reason: 'inventory_decrease' }
  })
  const f = await simulate(t, { inventory: [{ name: 'apple', count: 2 }], collectImmediately: false, first: 'casser', logY: 65,
    resume: { id: 'tree-apple-delivery', texte: 'coupe un arbre et donne-moi 2 pommes', auteur: 'human',
      progression: { descripteur: { kind: 'recolte', resource: 'bois', landmark: 'ici', quota: 16, wholeTree: true } } },
    queue: [['casser'], [{ action: 'donner', choices: { objet: 'apple', quantite: 2, destinataire: 'human' } }], ['terminer']] })
  assert.equal(gifts, 1)
  assert.notEqual(f.status.etat, 'done')
  assert.equal(f.status.arbre_entier.buches_au_sol, 1)
  assert.equal(f.snapshots.at(-1).descripteur.arbreCollectes, 0)
  assert.equal(f.snapshots.at(-1).descripteur.livraison[0].prouve, 2)
})

test('fabrication et don : don historique prouve ne dispense pas production cible', async t => {
  const desc = { kind: 'recolte', resource: 'bois', landmark: 'ici', quota: 16, wholeTree: false,
    fabricationCible: 'oak_planks', fabricationQuantite: 2, fabricationInitial: 0,
    livraison: [{ destinataire: 'human', objet: 'apple', plafond: 2, tente: 2, retire: 2, prouve: 2, incertain: 0, invocations: ['old#don-1'], termine: true }] }
  const f = await simulate(t, { inventory: [], first: 'terminer',
    resume: { id: 'fabrication-delivery', texte: 'fabrique 2 planches et donne-moi 2 pommes', auteur: 'human', progression: { descripteur: desc } } })
  assert.notEqual(f.status.etat, 'done')
  assert.equal(f.snapshots.at(-1).descripteur.fabricationCible, 'oak_planks')
  assert.equal(f.snapshots.at(-1).descripteur.fabricationQuantite, 2)
  assert.equal(f.snapshots.at(-1).descripteur.livraison[0].prouve, 2)
})

test('arbre entier fini : cloture automatique attend aussi fabrication demandee', async t => {
  const desc = { kind: 'recolte', resource: 'bois', landmark: 'ici', quota: 16, wholeTree: true,
    fabricationCible: 'oak_planks', fabricationQuantite: 2, fabricationInitial: 0 }
  const f = await simulate(t, { inventory: [], first: 'casser', logY: 65,
    resume: { id: 'tree-fabrication', texte: 'coupe un arbre et fabrique 2 planches', auteur: 'human', progression: { descripteur: desc } } })
  assert.notEqual(f.status.etat, 'done')
  assert.equal(f.status.arbre_entier.termine, true)
  assert.equal(f.snapshots.at(-1).descripteur.arbreCollectes, 1)
  assert.equal(f.snapshots.at(-1).descripteur.fabricationQuantite, 2)
})
