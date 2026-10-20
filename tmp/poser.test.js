'use strict'

// Poser un objet (A/B `poser`) : l objet et le lieu sont des parametres
// (regle immuable du proprietaire, AGENTS.md). Serveur simule : vrai A*,
// vraie physique, vraie mission scriptee. Une ligne de rails entre deux blocs
// nommes, une torche a cote d un bloc nomme, un minecart pose SUR un rail ;
// la fin est jugee par le code sur les poses verifiees (consigne.poses).

const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { createSimServer } = require('./sim-server')
const craft = require('../bot/craft')
craft.targetCriteria = craft.targetCriteria ?? (() => ({}))
const { createMissionRunner } = require('../bot/mission')
const poserMod = require('../bot/action-poser')

async function jouer ({ blocks, inventory, brief, script, features = { poser: true }, objectif = 'Fais-moi une ligne de minecart entre les deux blocs' }) {
  const sim = createSimServer({ blocks, start: new Vec3(8.5, 200, 15.5), borne: { x0: 0, x1: 30, z0: 0, z1: 30 }, inventory })
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
    return { sim, lignes, etat: r.status?.() }
  } finally {
    console.log = log
    sim.close()
  }
}

test('poser : cases d une ligne au sol, droite puis en L, sans case sous un mur', () => {
  const sim = createSimServer({ blocks: { '5,200,0': 'stone' } })
  try {
    const droite = poserMod.casesLigne(sim.bot, new Vec3(0, 200, 0), new Vec3(3, 200, 0))
    assert.deepEqual(droite.cases.map(c => [c.x, c.y, c.z]), [[0, 200, 0], [1, 200, 0], [2, 200, 0], [3, 200, 0]])
    const enL = poserMod.casesLigne(sim.bot, new Vec3(0, 200, 0), new Vec3(2, 200, 2))
    assert.deepEqual(enL.cases.map(c => [c.x, c.z]), [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]])
    // Un bloc dans la ligne : la case monte d un bloc sur lui (marche).
    const marche = poserMod.casesLigne(sim.bot, new Vec3(4, 200, 0), new Vec3(6, 200, 0))
    assert.deepEqual(marche.cases.map(c => [c.x, c.y]), [[4, 200], [5, 201], [6, 200]])
    assert.ok(poserMod.correspond('wall_torch', 'torch'))
    assert.ok(poserMod.correspond('redstone_wall_torch', 'redstone_torch'))
    assert.ok(!poserMod.correspond('rail', 'powered_rail'))
  } finally {
    sim.close()
  }
})

test('poser : ligne de rails entre deux blocs nommes, torche a cote, minecart sur un rail, fin mesuree', async () => {
  const { sim, lignes } = await jouer({
    blocks: { '10,199,15': 'red_wool', '20,199,15': 'blue_wool' },
    inventory: [{ name: 'rail', count: 16 }, { name: 'powered_rail', count: 2 }, { name: 'redstone_torch', count: 1 }, { name: 'minecart', count: 1 }],
    brief: { type: 'recolte', matiere: 'aucune', pose: [{ objet: 'rail' }, { objet: 'powered_rail', quantite: 2 }, { objet: 'minecart', quantite: 1 }] },
    script: [
      { action: 'poser', objet: 'powered_rail', quantite: 2, de: 'red_wool', vers: 'blue_wool' },
      { action: 'poser', objet: 'rail', de: 'red_wool', vers: 'blue_wool' },
      { action: 'poser', objet: 'redstone_torch', de: 'powered_rail' },
      { action: 'poser', objet: 'minecart', de: 'rail' },
      { action: 'terminer' }
    ]
  })
  const ligne = []
  for (let x = 10; x <= 20; x++) ligne.push(sim.nameAt(x, 200, 15))
  assert.deepEqual(ligne.slice(0, 2), ['powered_rail', 'powered_rail'], lignes.filter(l => /poser|mission/.test(l)).slice(-12).join('\n'))
  assert.ok(ligne.slice(2).every(n => n === 'rail'), ligne.join(','))
  assert.ok(sim.count(n => n === 'redstone_torch') === 1, 'torche posee a cote du rail accelerateur')
  assert.ok(Object.values(sim.bot.entities).some(e => e.name === 'minecart'), 'minecart pose sur un rail')
  assert.ok(lignes.some(l => /Objectif atteint/.test(l)), lignes.slice(-8).join('\n'))
})

test('poser : construction sans matiere ni dimension = pose ; la ligne entiere puis chaque objet avant la fin', async () => {
  const { sim, lignes } = await jouer({
    blocks: { '10,199,15': 'red_wool', '20,199,15': 'blue_wool' },
    inventory: [{ name: 'rail', count: 16 }, { name: 'minecart', count: 1 }],
    brief: { type: 'construction', matiere: 'aucune', pose: [{ objet: 'rail', de: 'red_wool', vers: 'blue_wool' }, { objet: 'minecart', quantite: 1 }] },
    script: [
      { action: 'poser', objet: 'rail', quantite: 2, de: 'red_wool', vers: 'blue_wool' },
      { action: 'terminer' },
      { action: 'poser', objet: 'rail', de: 'red_wool', vers: 'blue_wool' },
      { action: 'terminer' }
    ]
  })
  assert.ok(lignes.some(l => /-> type recolte .*a poser rail \(ligne red_wool -> blue_wool\), minecart x1/.test(l)), lignes.filter(l => /\[mission\] "/.test(l)).join('\n'))
  assert.equal(sim.count(n => n === 'rail'), 11)
  assert.ok(lignes.some(l => /terminer refuse \(1\/\d\) : 2 rail pose\(s\) sur 11 \(9 case\(s\) libre\(s\) entre red_wool et blue_wool\)/.test(l)), lignes.slice(-12).join('\n'))
  assert.ok(lignes.some(l => /terminer refuse \(2\/\d\) : 0 minecart pose\(s\) sur 1/.test(l)), lignes.slice(-8).join('\n'))
  assert.ok(!lignes.some(l => /Objectif atteint|chantier/i.test(l)), lignes.filter(l => /chantier|Objectif/i.test(l)).join('\n'))
})

test('poser : les autres blocs a poser prennent des cases de la ligne, le solveur fabrique d autant moins', async () => {
  const { lignes } = await jouer({
    blocks: { '10,199,15': 'red_wool', '27,199,15': 'blue_wool' },
    inventory: [{ name: 'iron_ingot', count: 40 }, { name: 'stick', count: 20 }, { name: 'crafting_table', count: 1 }],
    brief: { type: 'recolte', matiere: 'aucune', pose: [{ objet: 'rail', de: 'red_wool', vers: 'blue_wool' }, { objet: 'powered_rail', quantite: 2 }, { objet: 'minecart', quantite: 1 }] },
    script: [{ action: 'attendre', duree: 1 }]
  })
  // 18 cases, 2 rails accelerateurs : 16 rails, une seule fournee (6 fer), jamais 32.
  const solveur = lignes.filter(l => /solveur/.test(l))
  assert.ok(solveur.some(l => /fabriquer 16 rail\b/.test(l)), solveur.join('\n'))
  assert.ok(!solveur.some(l => /fabriquer 32 rail\b/.test(l)), solveur.join('\n'))
  // Minecart en tete et sur la ligne (brief du banc 39406009525) : un
  // objet-entite n a pas de bloc, il ne couvre pas la ligne (13 minecarts,
  // 65 fer : plus que l arene n en a) ; les rails la couvrent.
  const enTete = await jouer({
    blocks: { '10,199,15': 'red_wool', '27,199,15': 'blue_wool' },
    inventory: [{ name: 'iron_ingot', count: 40 }, { name: 'stick', count: 20 }, { name: 'crafting_table', count: 1 }],
    brief: { type: 'recolte', matiere: 'aucune', pose: [{ objet: 'minecart', de: 'red_wool', vers: 'blue_wool' }, { objet: 'rail', de: 'red_wool', vers: 'blue_wool' }, { objet: 'powered_rail', quantite: 2 }] },
    script: [{ action: 'attendre', duree: 1 }]
  })
  assert.ok(enTete.lignes.some(l => /a poser minecart, rail \(ligne red_wool -> blue_wool\)/.test(l)), enTete.lignes.filter(l => /\[mission\] "/.test(l)).join('\n'))
  const solveurTete = enTete.lignes.filter(l => /solveur/.test(l))
  assert.ok(solveurTete.some(l => /fabriquer 1 minecart\b/.test(l)) && !solveurTete.some(l => /fabriquer \d{2,} minecart/.test(l)), solveurTete.join('\n'))
})

test('poser : deux objets sur la meme ligne, le premier garde la place du second, chacun compte', async () => {
  const { sim, lignes } = await jouer({
    blocks: { '10,199,15': 'red_wool', '20,199,15': 'blue_wool' },
    inventory: [{ name: 'rail', count: 16 }, { name: 'powered_rail', count: 2 }],
    brief: { type: 'recolte', matiere: 'aucune', pose: [{ objet: 'rail', de: 'red_wool', vers: 'blue_wool' }, { objet: 'powered_rail', quantite: 2, de: 'red_wool', vers: 'blue_wool' }] },
    script: [
      { action: 'poser', objet: 'rail', de: 'red_wool', vers: 'blue_wool' },
      { action: 'terminer' },
      { action: 'poser', objet: 'powered_rail', de: 'red_wool', vers: 'blue_wool' },
      { action: 'terminer' }
    ]
  })
  assert.equal(sim.count(n => n === 'rail'), 9, lignes.filter(l => /poser/.test(l)).join('\n'))
  assert.ok(lignes.some(l => /terminer refuse \(1\/\d\) : 0 powered_rail pose\(s\) sur 2/.test(l)), lignes.slice(-10).join('\n'))
  assert.equal(sim.count(n => n === 'powered_rail'), 2)
  assert.ok(lignes.some(l => /Objectif atteint/.test(l)), lignes.slice(-8).join('\n'))
})

test('poser : un pluriel sans nombre (« des torches ») en veut deux, une seule pose ne clot pas', async () => {
  const { sim, lignes } = await jouer({
    objectif: 'Pose des torches a cote de la laine rouge',
    blocks: { '10,199,15': 'red_wool' },
    inventory: [{ name: 'torch', count: 3 }],
    brief: { type: 'recolte', matiere: 'aucune', pose: [{ objet: 'torch' }] },
    script: [{ action: 'poser', objet: 'torch', quantite: 1, de: 'red_wool' }, { action: 'terminer' }]
  })
  assert.equal(sim.count(n => n === 'torch' || n === 'wall_torch'), 1)
  assert.ok(lignes.some(l => /terminer refuse \(1\/\d\) : 1 torch pose\(s\) sur 2 : poser le reste/.test(l)), lignes.slice(-8).join('\n'))
  assert.ok(!lignes.some(l => /Objectif atteint/.test(l)))
})

test('poser : chantier couvert par la terre en poche, la recolte d un objet a poser reste permise', async () => {
  const { lignes } = await jouer({
    blocks: { '12,200,15': 'coal_ore', '12,201,15': 'stone' },
    inventory: [{ name: 'dirt', count: 64 }, { name: 'stick', count: 4 }, { name: 'wooden_pickaxe', count: 1 }],
    objectif: 'Construis une cabane de 3 blocs avec des torches',
    brief: { type: 'construction', matiere: 'terre', pose: [{ objet: 'torch', quantite: 2 }] },
    script: [{ action: 'choisir_terrain' }, { action: 'recolter', quantite: 1 }, { action: 'terminer' }]
  })
  const recolte = lignes.find(l => /\] 2\. recolter/.test(l)) ?? ''
  assert.match(recolte, /1\/1 objet\(s\) de minerai/, lignes.filter(l => /mission\] \d/.test(l)).join('\n'))
})

test('poser : objet absent de l inventaire, echec dit avec son code', async () => {
  const { lignes } = await jouer({
    blocks: { '10,199,15': 'red_wool' },
    inventory: [],
    brief: { type: 'recolte', matiere: 'aucune' },
    script: [{ action: 'poser', objet: 'torch', de: 'red_wool' }, { action: 'poser', objet: 'spruce_planks' }, { action: 'terminer' }]
  })
  assert.ok(lignes.some(l => /aucun torch en inventaire/.test(l)), lignes.slice(-10).join('\n'))
  // Nom exact du registre garde tel quel, jamais la famille (oak_planks).
  assert.ok(lignes.some(l => /aucun spruce_planks en inventaire/.test(l)), lignes.slice(-10).join('\n'))
})

test('obtenir : objet nomme deja en poche ou inconnu, dit sans rien jouer', async () => {
  const { lignes } = await jouer({
    blocks: {},
    inventory: [{ name: 'rail', count: 5 }],
    brief: { type: 'recolte', matiere: 'aucune' },
    features: { poser: true, sous_buts: true },
    script: [{ action: 'obtenir', objet: 'rail', quantite: 4 }, { action: 'obtenir', objet: 'licorne' }, { action: 'poser', objet: 'rail', de: 'cobble_stone' }, { action: 'terminer' }]
  })
  assert.ok(lignes.some(l => /obtenir .*-> 5 rail deja en poche/.test(l)), lignes.slice(-10).join('\n'))
  assert.ok(lignes.some(l => /objet inconnu : « licorne »/.test(l)), lignes.slice(-10).join('\n'))
  // Un nom mal forme du registre est refuse avec le nom proche, jamais corrige en silence.
  assert.ok(lignes.some(l => /« cobble_stone » n est pas un bloc du jeu .*voulais-tu dire « cobblestone » \?/.test(l)), lignes.slice(-10).join('\n'))
})

const { createExecutor } = require('../bot/executor')
function actionIsolee (sim, signal, compte, autres = {}) {
  return poserMod.createPoser({
    ...autres,
    getBot: () => sim.bot, resoudreObjet: texte => texte,
    enInventaire: nom => sim.bot.inventory.items().find(i => i.name === nom),
    rejoindre: async () => false, signal: () => signal,
    compter: (nom, n) => compte.push([nom, n])
  })
}

// Sans lieu nomme, face a un mur (cabane finie, composite/lit-cabin) : la case
// devant est pleine, la torche va sur le sol libre a cote, jamais dans le corps.
test('poser : face a un mur, l objet va sur une case libre autour du bot', async () => {
  const sim = createSimServer({ start: new Vec3(0.5, 200, 0.5), inventory: [{ name: 'torch', count: 2 }],
    blocks: { '0,200,-1': 'stone', '0,201,-1': 'stone' } })
  sim.bot.entity.yaw = 0
  const compte = []
  try {
    const r = await actionIsolee(sim, null, compte).poser({ objet: 'torch' })
    assert.ok(!r.echec, r.resultat)
    assert.equal(sim.count(n => n === 'torch'), 1)
    assert.notEqual(sim.nameAt(0, 200, 0), 'torch')
    assert.deepEqual(compte, [['torch', 1]])
    // Cases d un chantier encore a remplir (toit au-dessus d un mur) : jamais.
    const reservees = []
    const r2 = await actionIsolee(sim, null, compte, { reservee: c => { reservees.push(c); return true } })
      .poser({ objet: 'torch' })
    assert.equal(r2.echec, true)
    assert.ok(reservees.length > 0)
    assert.equal(sim.count(n => n === 'torch'), 1)
  } finally { sim.close() }
})

for (const etape of ['equip', 'lookAt', 'placeBlock']) {
  test(`poser : timeout pendant ${etape}, vrai writer tenu jusqu au settle, aucune continuation tardive`, async t => {
    const sim = createSimServer({ start: new Vec3(0.5, 200, 0.5), inventory: [{ name: 'rail', count: 1 }] })
    const ex = createExecutor({ stopControls: () => sim.bot.clearControlStates() })
    const compte = []
    let liberation
    let commence
    const entree = new Promise(resolve => { commence = resolve })
    const gate = new Promise(resolve => { liberation = resolve })
    const original = sim.bot[etape]
    sim.bot[etape] = async (...args) => { commence(); await gate; return original(...args) }
    try {
      t.mock.timers.enable({ apis: ['setTimeout'] })
      const premiere = ex.run({ id: 'ancienne', kind: 'work' }, ({ signal }) => actionIsolee(sim, signal, compte).poser({ objet: 'rail' }))
      await entree
      t.mock.timers.tick(15001)
      // Vider la chaine Promise.race/action/executor avant de mesurer le writer.
      for (let i = 0; i < 10; i++) await Promise.resolve()
      assert.equal(ex.status().current.id, 'ancienne')
      await assert.rejects(ex.run({ id: 'nouvelle', kind: 'work' }, async () => {}), { code: 'busy' })
      liberation()
      const resultat = await premiere
      assert.equal(resultat.value.echec, true)
      assert.deepEqual(compte, [])
      const posesAuRetour = sim.journal.places.length
      await ex.run({ id: 'nouvelle', kind: 'work' }, async () => {})
      await Promise.resolve()
      assert.equal(sim.journal.places.length, posesAuRetour)
      assert.equal(posesAuRetour, etape === 'placeBlock' ? 1 : 0)
    } finally { liberation(); t.mock.timers.reset(); sim.close() }
  })
}

test('poser : abort pendant equip interdit le regard et la pose apres deblocage', async () => {
  const sim = createSimServer({ start: new Vec3(0.5, 200, 0.5), inventory: [{ name: 'rail', count: 1 }] })
  const ex = createExecutor({})
  let liberation
  let commence
  const entree = new Promise(resolve => { commence = resolve })
  const gate = new Promise(resolve => { liberation = resolve })
  sim.bot.equip = async () => { commence(); await gate }
  let regards = 0
  const regard = sim.bot.lookAt
  sim.bot.lookAt = async (...args) => { regards += 1; return regard(...args) }
  try {
    const premiere = ex.run({ id: 'pose', kind: 'work' }, ({ signal }) => actionIsolee(sim, signal, []).poser({ objet: 'rail' }))
    await entree
    ex.pauseWork('test')
    ex.resume()
    await assert.rejects(ex.run({ id: 'autre', kind: 'work' }, async () => {}), { code: 'busy' })
    liberation()
    assert.equal((await premiere).outcome, 'cancelled')
    assert.equal(regards, 0)
    assert.deepEqual(sim.journal.places, [])
  } finally { liberation(); sim.close() }
})

for (const variante of ['pig', 'minecart-sans-consommation', 'bloc-change']) {
  test(`poser : aucune preuve attribuable pour ${variante}`, async () => {
    const sim = createSimServer({ start: new Vec3(0.5, 200, 0.5), inventory: [{ name: 'minecart', count: 1 }] })
    const compte = []
    sim.bot.activateBlock = async bloc => {
      sim.bot.entities[321] = { id: 321, name: variante === 'pig' ? 'pig' : 'minecart', type: 'other', position: bloc.position.offset(0.5, 0.1, 0.5) }
      if (variante === 'bloc-change') {
        const original = sim.bot.blockAt
        sim.bot.blockAt = p => p.equals(bloc.position.offset(0, 1, 0)) ? { name: 'stone', position: p } : original(p)
      }
    }
    try {
      const r = await actionIsolee(sim, null, compte).poser({ objet: 'minecart' })
      assert.equal(r.echec, true)
      assert.deepEqual(compte, [])
      assert.equal(sim.bot.inventory.items().find(i => i.name === 'minecart').count, 1)
    } finally { sim.close() }
  })
}

test('obtenir : vraie mission water_bucket inaccessible annonce le blocage, jamais accompli', async () => {
  const { sim, lignes } = await jouer({ blocks: {}, inventory: [],
    brief: { type: 'recolte', matiere: 'aucune' }, features: { sous_buts: true },
    script: [{ action: 'obtenir', objet: 'water_bucket', quantite: 1 }, { action: 'terminer' }] })
  assert.ok(lignes.some(l => /obtenir.*acquisition impossible.*water_bucket/.test(l)), lignes.slice(-10).join('\n'))
  assert.ok(!lignes.some(l => /obtenir accompli/.test(l)))
  assert.ok(!sim.bot.inventory.items().some(i => i.name === 'water_bucket'))
})

for (const objet of ['oak_boat', 'oak_chest_boat']) {
  test(`poser : ${objet} du protocole 26.1 credite sa nouvelle entite et sa consommation`, async () => {
    const sim = createSimServer({ start: new Vec3(0.5, 200, 0.5), inventory: [{ name: objet, count: 1 }] })
    const compte = []
    try {
      assert.ok(sim.bot.registry.entitiesByName[objet], 'type reel du registre 26.1')
      const r = await actionIsolee(sim, null, compte).poser({ objet })
      assert.equal(r.echec, undefined)
      assert.deepEqual(compte, [[objet, 1]])
      assert.ok(Object.values(sim.bot.entities).some(e => e.name === objet))
      assert.ok(!sim.bot.inventory.items().some(i => i.name === objet))
    } finally { sim.close() }
  })
}
