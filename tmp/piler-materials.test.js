'use strict'

process.env.MISSION_TICK_MS = '1'
process.env.MISSION_QUEUE_TICK_MS = '1'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const planner = require('../bot/planner')
const craft = require('../bot/craft')
const { createMissionRunner } = require('../bot/mission')
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)) }

async function simulate (t, { inventory, height = 6, refuseAt = null, noLanding = false, wrongBlock = false, retryError = false, loseStock = false, logY = 74, logAt = null, start = null, extra = {}, first = 'piler', onPlace = null }) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000000 })
  t.mock.method(planner, 'isEnabled', () => true)
  t.mock.method(craft, 'targetCriteria', () => ({}))
  t.mock.method(planner, 'readBrief', async () => ({ kind: 'recolte', kindConfidence: 1,
    resource: 'bois', resourceConfidence: 1, landmark: 'ici', door: false, doorProbability: 0 }))
  const states = []
  const stopsAtPlans = []
  let staleAborted = false
  t.mock.method(planner, 'plan', async (state, _kind, _supply, _extra, _image, { signal }) => {
    states.push(state)
    stopsAtPlans.push(stops)
    const step = (action, choices = {}) => ({ action, choices, scale: 0, scaleLevel: null })
    // Other first actions keep the queue short: status shows the last 5 steps.
    const steps = first !== 'piler' ? (states.length === 1 ? [step(first), step('dire', { texte: 'OLD QUEUE' })] : [step('terminer')])
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
  const bot = { entity: { position: start ?? new Vec3(0.5, 65, 0.5), yaw: 0, pitch: 0, onGround: true },
    registry: { blocksByName: { oak_log: { id: 1 }, dirt: { id: 2, boundingBox: 'block' },
      coarse_dirt: { id: 3, boundingBox: 'block' }, oak_planks: { id: 4, boundingBox: 'block' },
      birch_planks: { id: 5, boundingBox: 'block' }, fake_planks: { id: 6, boundingBox: 'empty' } }, itemsByName: {} },
    inventory: { items: () => stock.filter(item => item.count > 0) }, players: {}, entities: {},
    findBlocks: ({ matching }) => matching.includes(1) && blocks.get(`${log.x},${log.y},${log.z}`) === 'oak_log' ? [log] : [],
    findBlock: () => null,
    blockAt: p => { const position = p.floored(); const name = blocks.get(`${position.x},${position.y},${position.z}`) ?? 'air'
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
      blocks.delete(`${block.position.x},${block.position.y},${block.position.z}`)
      const owned = stock.find(item => item.name === block.name)
      if (owned) owned.count++
      else stock.push({ name: block.name, count: 1 })
      bot.entity.position.y = block.position.y
    },
    equip: async item => { commands.push({ equip: item.name }); bot.heldItem = item }, lookAt: async () => {},
    placeBlock: async support => {
      if (placements.length + 1 === refuseAt) throw new Error('server refused')
      const name = wrongBlock ? 'coarse_dirt' : bot.heldItem.name
      blocks.set(`0,${support.position.y + 1},0`, name)
      bot.heldItem.count--
      placements.push(name)
      onPlace?.(placements, blocks, bot)
      if (loseStock) stock.forEach(item => { item.count = 0 })
      if (retryError) throw new Error('late server error')
    } }
  let stops = 0
  const runner = createMissionRunner({ getBot: () => bot, isReady: () => true, inLiquid: () => false,
    stopPathfinding () { stops++ }, chat: text => messages.push(text) })
  t.after(() => runner.stop('test cleanup'))
  await runner.start('casse cet arbre', 'human')
  for (let i = 0; i < 600 && runner.isRunning(); i++) { t.mock.timers.tick(50); await flush() }
  assert.equal(runner.isRunning(), false)
  const status = runner.status()
  return { status, step: status.historique.find(step => step.action === first), placements, commands, states, messages, staleAborted, stopsAtPlans }
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

// Bloc solide dans la colonne a mi-hauteur : la cible serait a portee au-dessus,
// mais la montee s arreterait dessous. Aucun pilier automatique ni stock gaspille.
test('avancer : plafond reel a mi-hauteur, aucun pilier automatique', async t => {
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 8 }], first: 'avancer', logAt: new Vec3(3, 70, 0),
    extra: { '0,68,0': 'stone' } })
  assert.deepEqual(f.placements, [])
  assert.equal(f.step.echec, true)
  assert.equal(f.step.code, 'cible_haute')
})

// Decentre (z 0.18) : la tete touche aussi la colonne z = -1, comme piler la
// verifie. Un plafond mi-hauteur y annule le pilier automatique.
test('avancer : plafond dans la colonne voisine sous la hitbox, aucun pilier automatique', async t => {
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 8 }], first: 'avancer', logAt: new Vec3(3, 70, 0),
    start: new Vec3(0.5, 65, 0.18), extra: { '0,68,-1': 'stone' } })
  assert.deepEqual(f.placements, [])
  assert.equal(f.step.code, 'cible_haute')
})

// Feuilles sur la montee : piler les casse, la hauteur reste mesurable.
test('avancer : feuilles sur la montee comptees comme degagees', async t => {
  const f = await simulate(t, { inventory: [{ name: 'dirt', count: 8 }], first: 'avancer', logAt: new Vec3(3, 70, 0),
    extra: { '0,68,0': 'oak_leaves' } })
  assert.equal(f.placements.length, 3, f.step.resultat)
})
