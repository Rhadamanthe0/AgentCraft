'use strict'
// tmp/capability-comparison.js — campagne comparative bornee local vs Mindcraft.
//
// PASSE 2 (appariee) : craft MEME recette/stock/quantite, don au vrai receveur
// TestProbe2, recolte 3 blocs sur fixtures equivalentes. Passe 1 (vitesses non
// appariees planches-vs-batons) conservee hors projet en proof dir.
//
// Modes (meme fichier, deux process/protocoles distincts) :
//   executeur : node /tmp/mindcraft-compare-h3.js TestProbe3
//   receveur  : node /tmp/mindcraft-receiver-h2.js TestProbe2 --receiver
// Tous deux silencieux (aucun bot.chat), survie, non-op. Usernames imposes.
// Upstream reel IMPORTE (dynamic import ESM), jamais recopie :
//     /tmp/mc/src/utils/mcdata.js (+ setSettings de src/agent/settings.js)
//     /tmp/mc/src/agent/library/skills.js (goToPosition, collectBlock, craftRecipe, giveToPlayer)
//   Commit fixe : 5f3acc87b479864124173de444f31fa5538f94a6.
// Local IMPORTE lecture seule : /localbot/navigation.js, /localbot/craft.js.
// Adaptateurs : bot.modes stubbe, bot.output="", settings reseau injectes,
// mineflayer 4.39.0 + minecraft-data 26.1 de l image (vs 4.33.0 / 3.97.0 eppingles).
// Fixtures monde RCON, arene autorisee uniquement (1000..1024,199,1000..1024) :
//   2 rangees x 3 buches oak_log (A=(1003..1005,200,1012), B=(1003..1005,200,1013))
//   via `setblock ... keep`, consommees par les trials. Aucun /give, aucun
//   inventaire creative : tout stock vient de casse reelle en survie.
// Succes DON = depot mesure (emetteur -1 + item localise), JAMAIS ramassage exige.
// Sortie executeur : /tmp/capability-comparison-results.json (recopiee projet).

const fs = require('fs')

const MC_DIR = '/tmp/mc'
const LOCAL_DIR = '/localbot'
const RESULTS_FILE = '/tmp/capability-comparison-results.json'

const HOST = 'minecraft'
const PORT = 25565
const VERSION = '26.1'
const EXECUTOR = 'TestProbe3'
const RECEIVER = 'TestProbe2'

// Fixtures : 2 rangees equivalentes (meme materiau, meme appui y=199, meme espacement).
const ROW_A = [{ x: 1004, y: 200, z: 1012 }, { x: 1005, y: 200, z: 1012 }, { x: 1006, y: 200, z: 1012 }]
const ROW_B = [{ x: 1004, y: 200, z: 1013 }, { x: 1006, y: 200, z: 1013 }, { x: 1004, y: 200, z: 1014 }]
// (1003,1012), (1003,1013), (1005,1013) et (1002,1013) occupes par du decor existant : rangees decalées mais equivalentes (meme materiau, meme appui, meme effectif).
const STAND_A = { x: 1004.5, y: 200, z: 1011.0 }  // poste de casse rangee A
const STAND_B = { x: 1002.5, y: 200, z: 1012.5 }  // tp recolte upstream (collecte guidee)
const GIVE_START = { x: 1005.5, y: 200, z: 1006.5 } // depart executeur pour le don
const RECV_SPOT = { x: 1008.5, y: 200, z: 1007.5 }  // poste receveur TestProbe2

const TIMEOUTS = { dig: 15000, collect3: 60000, craftLocal: 25000, craftUpstream: 25000, give: 30000, tpWait: 45000 }

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const fmtP = p => p ? `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}` : 'null'
function countOf (bot, name) {
  return bot.inventory.items().reduce((s, it) => s + (it.name === name ? it.count : 0), 0)
}
function snapshotInv (bot) {
  const out = {}
  for (const it of bot.inventory.items()) out[it.name] = (out[it.name] ?? 0) + it.count
  return out
}
function nearestDrop (bot, maxDist) {
  let best = null; let bestD = Infinity
  for (const e of Object.values(bot.entities ?? {})) {
    if (!e?.position || e.name !== 'item') continue
    const d = bot.entity.position.distanceTo(e.position)
    if (d < bestD && d <= maxDist) { best = e; bestD = d }
  }
  return best ? { distance: Number(bestD.toFixed(2)), position: fmtP(best.position) } : null
}

// ---------------------------------------------------------------- receveur --
async function receiverMain () {
  const username = process.argv[2]
  if (username !== RECEIVER) { console.error(`[receiver] username impose : ${RECEIVER}`); process.exit(2) }
  console.log(`[receiver] ${username} -> ${HOST}:${PORT} (silencieux)`)
  const mineflayer = require('mineflayer')
  const bot = mineflayer.createBot({ host: HOST, port: PORT, username, auth: 'offline', version: VERSION })
  let done = false
  const quit = why => { if (done) return; done = true; console.log(`[receiver] arret (${why}) pos=${fmtP(bot.entity?.position)} inv=${JSON.stringify(snapshotInv(bot))}`); try { bot.quit(why) } catch (_) {} }
  process.on('SIGINT', () => quit('SIGINT'))
  process.on('SIGTERM', () => quit('SIGTERM'))
  bot.on('kicked', r => { console.log(`[receiver] kicked : ${r}`); quit('kicked') })
  bot.on('error', e => console.log(`[receiver] error : ${e.message}`))
  bot.once('spawn', () => {
    console.log(`[receiver] spawn ${fmtP(bot.entity.position)} gamemode=${bot.player?.gamemode ?? '?'}`)
    const tick = setInterval(() => {
      if (done) { clearInterval(tick); return }
      console.log(`[receiver] pos=${fmtP(bot.entity.position)} inv=${JSON.stringify(snapshotInv(bot))}`)
    }, 15000)
    setTimeout(() => { clearInterval(tick); quit('garde-fou 9 min') }, 9 * 60 * 1000)
  })
  setTimeout(() => { if (!bot.entity) { console.log('[receiver] spawn timeout'); process.exit(1) } }, 60000)
}

// ---------------------------------------------------------------- executeur --
const results = {
  protocole: 'comparatif apparie local vs mindcraft (passe 2) : meme recette/stock/quantite, don au vrai receveur, recolte 3 blocs',
  passe: 2,
  upstream: { depot: 'mindcraft-bots/mindcraft', commit: '5f3acc87b479864124173de444f31fa5538f94a6' },
  harness: { executant: EXECUTOR, process: '/tmp/mindcraft-compare-h3.js', receveur: RECEIVER, process_receveur: '/tmp/mindcraft-receiver-h2.js', silencieux: true },
  adapters: [
    'bot.modes stubbe {isOn:()=>false, pause:()=>{}} ; bot.output="" ; interrupt_code falsy.',
    'setSettings(src/agent/settings.js) + initBot(src/utils/mcdata.js) : VRAIE fabrique upstream, seuls host/port/auth/version injectes.',
    'mineflayer 4.39.0 + minecraft-data 26.1 de l image (vs 4.33.0 / 3.97.0 eppingles) ; plugins upstream installes en jetable (collectblock 1.4.1, pvp 1.3.2, auto-eat 3.3.6, armor-manager 2.0.1 + transitives).',
    'Succes DON = depot mesure (emetteur -1 + item localise <=8 blocs ou +1 receveur), ramassage par le receveur NON exige.'
  ],
  fixtures: 'RCON setblock oak_log keep : rangee A (1003..1005,200,1012) pour recolte locale, rangee B (1003..1005,200,1013) pour recolte upstream. Aucun /give, aucun inventaire creative.',
  trials: [],
  non_testes: ['construction', 'porte', 'piler', 'smelt/four', 'coffre', 'combat/pvp', 'follow', 'useDoor', 'craft avec etabli', 'craft batch upstream N>1 (risque piege 21, volontairement non execute live)']
}

function record (trial) {
  results.trials.push(trial)
  console.log('[trial] ' + JSON.stringify(trial))
}

async function waitForTp (bot, target, label) {
  const t0 = Date.now()
  while (Date.now() - t0 < TIMEOUTS.tpWait) {
    const p = bot.entity?.position
    if (p && Math.hypot(p.x - target.x, p.z - target.z) <= 3 && Math.abs(p.y - target.y) <= 2) {
      return { ok: true, attente_ms: Date.now() - t0, position: fmtP(p) }
    }
    await sleep(1000)
  }
  console.log(`[BESOIN_TP] ${label} -> tp ${EXECUTOR} ${target.x} ${target.y} ${target.z} (pos ${fmtP(bot.entity?.position)})`)
  const t1 = Date.now()
  while (Date.now() - t1 < TIMEOUTS.tpWait) {
    const q = bot.entity?.position
    if (q && Math.hypot(q.x - target.x, q.z - target.z) <= 3 && Math.abs(q.y - target.y) <= 2) {
      return { ok: true, attente_ms: Date.now() - t0, position: fmtP(q) }
    }
    await sleep(1000)
  }
  return { ok: false, attente_ms: Date.now() - t0, position: fmtP(bot.entity?.position) }
}

async function withTimeout (promise, ms, code) {
  let timer = null
  const gate = new Promise(resolve => { timer = setTimeout(() => resolve({ __timeout: true, code }), ms) })
  const out = await Promise.race([promise.then(v => ({ __timeout: false, value: v }),
    err => ({ __timeout: false, error: err })), gate])
  clearTimeout(timer)
  return out
}

async function main () {
  if (process.argv[2] && process.argv[2] !== EXECUTOR) { console.error(`[compare] username impose : ${EXECUTOR}`); process.exit(2) }
  const startedAll = Date.now()
  console.log(`[compare] passe 2 demarrage ${EXECUTOR} -> ${HOST}:${PORT} (silencieux)`)
  let bot = null; let skills = null; let localNav = null; let localCraft = null
  const setup = {}
  try {
    const mcdata = await import(`${MC_DIR}/src/utils/mcdata.js`)
    const agentSettings = await import(`${MC_DIR}/src/agent/settings.js`)
    agentSettings.setSettings({ host: HOST, port: PORT, auth: 'offline', minecraft_version: VERSION })
    bot = mcdata.initBot(EXECUTOR)
    setup.factory = 'mcdata.initBot (upstream reel)'
    setup.factory_ok = true
  } catch (err) {
    setup.factory_ok = false; setup.factory_erreur = err.message
    bot = require('mineflayer').createBot({ host: HOST, port: PORT, username: EXECUTOR, auth: 'offline', version: VERSION })
  }
  bot.output = ''
  if (!bot.modes) bot.modes = { isOn: () => false, pause: () => {} }
  bot.loadPlugin(require('mineflayer-pathfinder').pathfinder)
  try {
    const mod = await import(`${MC_DIR}/src/agent/library/skills.js`)
    skills = mod
    setup.skills = ['goToPosition', 'collectBlock', 'craftRecipe', 'giveToPlayer'].filter(n => typeof mod[n] === 'function').join(',')
  } catch (err) { setup.skills_erreur = err.message }
  try {
    localNav = require(`${LOCAL_DIR}/navigation.js`)
    localCraft = require(`${LOCAL_DIR}/craft.js`)
    setup.local = 'navigation.js + craft.js (lecture seule)'
  } catch (err) { setup.local_erreur = err.message }
  record({ id: 'T0-import', famille: 'setup', succes: Boolean(setup.factory_ok && !setup.skills_erreur && !setup.local_erreur), preuves: setup })

  let done = false
  const quit = why => { if (done) return; done = true; console.log(`[compare] arret (${why})`); try { bot.quit(why) } catch (_) {} }
  process.on('SIGINT', () => quit('SIGINT'))
  process.on('SIGTERM', () => quit('SIGTERM'))
  bot.on('kicked', r => { console.log(`[compare] kicked : ${r}`); quit('kicked') })
  bot.on('error', e => console.log(`[compare] bot error : ${e.message}`))
  try {
    await new Promise((resolve, reject) => { bot.once('spawn', resolve); setTimeout(() => reject(new Error('spawn timeout')), 60000) })
  } catch (err) { record({ id: 'T0-spawn', famille: 'setup', succes: false, erreur: err.message }); throw err }
  record({ id: 'T0-spawn', famille: 'setup', succes: true, preuves: { position: fmtP(bot.entity.position), inventaire_spawn: snapshotInv(bot) } })
  const invTrace = w => console.log(`[inv] ${w} ${JSON.stringify(snapshotInv(bot))}`)
  const guard = setTimeout(() => finish('garde-fou 9 min'), 9 * 60 * 1000)

  // Attente chargement client des chunks (fixture visible), sans fixture supplementaire.
  const pollFixture = async (c, quoi) => {
    const V = bot.entity.position.constructor
    const t0 = Date.now()
    while (Date.now() - t0 < 25000) {
      const b = bot.blockAt(new V(c.x, c.y, c.z))
      if (b?.name === quoi) return b
      await sleep(1000)
    }
    return null
  }

  // H1 — recolte LOCALE x3 (rangee A, 3 digs verifies).
  {
    const gate = await waitForTp(bot, STAND_A, 'H1')
    invTrace('H1-avant')
    let air = 0
    const t0 = Date.now()
    let erreur
    if (gate.ok) {
      const V = bot.entity.position.constructor
      const first = await pollFixture(ROW_A[0], 'oak_log')
      if (!first) erreur = 'fixture A non chargee cote client apres 25 s'
      else for (const c of ROW_A) {
        const b = bot.blockAt(new V(c.x, c.y, c.z))
        if (!b || b.name !== 'oak_log') { erreur = `fixture absente en ${c.x},${c.y},${c.z} (${b?.name})`; break }
        const r = await withTimeout(bot.dig(b, true), TIMEOUTS.dig, 'timeout')
        if (r.__timeout || r.error) { erreur = r.__timeout ? 'dig timeout' : r.error.message; break }
        await sleep(1200)
        const after = bot.blockAt(new V(c.x, c.y, c.z))
        if (after && after.name !== 'air') { erreur = `bloc non parti en ${c.x},${c.y},${c.z}`; break }
        air += 1
      }
      if (!erreur) { // ramassage : un pas vers la rangee puis pause
        try { bot.setControlState('forward', true); await sleep(1000); bot.clearControlStates(); await sleep(2500) } catch (_) {}
      }
    } else erreur = 'setup tp echoue'
    const duree = Date.now() - t0
    const delta = countOf(bot, 'oak_log')
    invTrace('H1-apres')
    record({ id: 'H1-recolte-locale-x3', famille: 'recolte', variante: 'locale', objectif: '3 digs rangee A', duree_ms: duree, succes: air === 3 && delta === 3, preuves: { blocs_devenus_air: `${air}/3`, buches_ramassees: delta, inventaire: snapshotInv(bot) }, erreur })
  }

  // H2 — recolte UPSTREAM x3 (rangee B, vrai collectBlock num=3).
  {
    const gate = await waitForTp(bot, STAND_B, 'H2')
    invTrace('H2-avant')
    const avant = countOf(bot, 'oak_log')
    const t0 = Date.now()
    let r
    if (gate.ok && skills?.collectBlock) {
      const seen = await pollFixture(ROW_B[0], 'oak_log')
      if (!seen) r = { __timeout: false, error: new Error('fixture B non chargee cote client apres 25 s') }
      else r = await withTimeout(skills.collectBlock(bot, 'oak_log', 3), TIMEOUTS.collect3, 'timeout')
    }
    const duree = Date.now() - t0
    try { bot.pathfinder.setGoal(null); bot.clearControlStates() } catch (_) {}
    const delta = countOf(bot, 'oak_log') - avant
    invTrace('H2-apres')
    const code = !gate.ok ? 'setup tp echoue' : (!skills?.collectBlock ? 'non importe' : (r.__timeout ? 'timeout' : (r.error ? `exception:${r.error.message}` : `retour=${r.value}`)))
    record({ id: 'H2-recolte-upstream-x3', famille: 'recolte', variante: 'upstream', objectif: 'collectBlock num=3 rangee B', duree_ms: duree, succes: code === 'retour=true' && delta === 3, code, preuves: { buches_ramassees: delta, inventaire: snapshotInv(bot), log_upstream: String(bot.output ?? '').slice(-300) }, erreur: r?.error ? r.error.message : undefined })
    bot.output = ''
  }

  // C1 — craft LOCAL, MEME recette/stock/quantite : oak_planks x1 (1 buche).
  {
    const avantL = countOf(bot, 'oak_log'); const avantP = countOf(bot, 'oak_planks')
    const t0 = Date.now()
    let res = null; let erreur
    try { res = await localCraft.make(bot, 'planches', 1) } catch (e) { erreur = e.message }
    const duree = Date.now() - t0
    const dL = countOf(bot, 'oak_log') - avantL; const dP = countOf(bot, 'oak_planks') - avantP
    record({ id: 'C1-craft-local-planches-x1', famille: 'craft', variante: 'locale', objectif: 'oak_planks x1 op (1 buche)', duree_ms: duree, succes: !erreur && dL === -1 && dP === 4, preuves: { buches_delta: dL, planches_delta: dP, inventaire: snapshotInv(bot) }, erreur })
  }

  // C2 — craft UPSTREAM, MEME recette/stock/quantite : craftRecipe oak_planks x1.
  {
    const avantL = countOf(bot, 'oak_log'); const avantP = countOf(bot, 'oak_planks')
    const t0 = Date.now()
    const r = await withTimeout(skills.craftRecipe(bot, 'oak_planks', 1), TIMEOUTS.craftUpstream, 'timeout')
    const duree = Date.now() - t0
    const dL = countOf(bot, 'oak_log') - avantL; const dP = countOf(bot, 'oak_planks') - avantP
    const code = r.__timeout ? 'timeout' : (r.error ? `exception:${r.error.message}` : `retour=${r.value}`)
    record({ id: 'C2-craft-upstream-planches-x1', famille: 'craft', variante: 'upstream', objectif: 'craftRecipe oak_planks x1 (1 buche)', duree_ms: duree, succes: code === 'retour=true' && dL === -1 && dP === 4, code, preuves: { buches_delta: dL, planches_delta: dP, inventaire: snapshotInv(bot), log_upstream: String(bot.output ?? '').slice(-300) }, erreur: r.error ? r.error.message : undefined })
    bot.output = ''
  }

  // C3 — craft LOCAL x2 (2 buches -> 8 planches, unitaire) ; upstream N>1 NON execute (risque piege 21).
  {
    const avantL = countOf(bot, 'oak_log'); const avantP = countOf(bot, 'oak_planks')
    const t0 = Date.now()
    let res = null; let erreur
    try { res = await localCraft.make(bot, 'planches', 2) } catch (e) { erreur = e.message }
    const duree = Date.now() - t0
    const dL = countOf(bot, 'oak_log') - avantL; const dP = countOf(bot, 'oak_planks') - avantP
    record({ id: 'C3-craft-local-planches-x2', famille: 'craft', variante: 'locale', objectif: 'planches x2 ops unitaires (2 buches)', duree_ms: duree, succes: !erreur && dL === -2 && dP === 8, preuves: { buches_delta: dL, planches_delta: dP, inventaire: snapshotInv(bot) }, erreur })
    record({ id: 'C4-craft-upstream-x2', famille: 'craft', variante: 'upstream', succes: false, code: 'non_execute', preuves: { note: 'batch N=2 volontairement non execute live : desync fenetre documentee (piege 21) ; recommandation par contrat, pas par vitesse' } })
  }

  // G1 — don UPSTREAM au vrai receveur TestProbe2 (1 planche). Succes = depot.
  {
    const gate = await waitForTp(bot, GIVE_START, 'G1')
    invTrace('G1-avant')
    const avant = countOf(bot, 'oak_planks')
    const t0 = Date.now()
    let r
    if (gate.ok) r = await withTimeout(skills.giveToPlayer(bot, 'oak_planks', RECEIVER, 1), TIMEOUTS.give, 'timeout')
    const duree = Date.now() - t0
    try { bot.pathfinder.setGoal(null); bot.clearControlStates() } catch (_) {}
    await sleep(1500)
    const dE = countOf(bot, 'oak_planks') - avant
    const drop = nearestDrop(bot, 8)
    const code = !gate.ok ? 'setup tp echoue' : (r.__timeout ? 'timeout' : (r.error ? `exception:${r.error.message}` : `retour=${r.value}`))
    const depot = dE === -1 && drop !== null
    // Re-collecte du depot pour laisser l arene propre (hors mesure).
    let recollecte = null
    if (drop && localNav) {
      try {
        const nav = localNav.createNavigator(() => bot, { timeoutMs: 15000 })
        const [dx, dy, dz] = drop.position.split(',').map(Number)
        await withTimeout(nav.toPosition({ x: dx, y: dy, z: dz }, { radius: 1 }), 15000, 'timeout')
        nav.cancel(); await sleep(2000)
        recollecte = countOf(bot, 'oak_planks') - avant
      } catch (_) { recollecte = 'echec' }
    }
    invTrace('G1-apres')
    record({ id: 'G1-don-upstream-receveur', famille: 'don', variante: 'upstream', objectif: `giveToPlayer 1 planche -> ${RECEIVER}`, duree_ms: duree, succes: depot, code, preuves: { emetteur_delta: dE, item_depose: drop, ramassage_receveur_non_exige: true, recollecte_apres_mesure: recollecte, pos_emetteur: fmtP(bot.entity.position), inventaire: snapshotInv(bot), log_upstream: String(bot.output ?? '').slice(-300) }, erreur: r?.error ? r.error.message : undefined })
    bot.output = ''
  }

  // G2 — don absent (joueur inconnu) : cas negatif attendu.
  {
    const avant = snapshotInv(bot)
    const t0 = Date.now()
    const r = await withTimeout(skills.giveToPlayer(bot, 'oak_planks', 'CapitaineInexistant', 1), 10000, 'timeout')
    const duree = Date.now() - t0
    const code = r.__timeout ? 'timeout' : (r.error ? `exception:${r.error.message}` : `retour=${r.value}`)
    record({ id: 'G2-don-absent', famille: 'don', variante: 'upstream', objectif: 'giveToPlayer joueur inconnu', duree_ms: duree, succes: code === 'retour=false', code, preuves: { inventaire_inchange: JSON.stringify(snapshotInv(bot)) === JSON.stringify(avant), log_upstream: String(bot.output ?? '').slice(-200) } })
    bot.output = ''
  }

  // G3 — don a soi-meme : refus attendu.
  {
    const avant = snapshotInv(bot)
    const r = await withTimeout(skills.giveToPlayer(bot, 'oak_planks', EXECUTOR, 1), 10000, 'timeout')
    const code = r.__timeout ? 'timeout' : (r.error ? `exception:${r.error.message}` : `retour=${r.value}`)
    record({ id: 'G3-don-soi-meme', famille: 'don', variante: 'upstream', objectif: 'giveToPlayer a soi-meme', duree_ms: 0, succes: code === 'retour=false', code, preuves: { inventaire_inchange: JSON.stringify(snapshotInv(bot)) === JSON.stringify(avant), log_upstream: String(bot.output ?? '').slice(-200) } })
    bot.output = ''
  }

  record({ id: 'T8-don-local', famille: 'don', variante: 'locale', succes: false, code: 'non_couvert', preuves: { note: 'aucune action donner/jeter dans bot/skills.js ni bot/mission.js ; adaptation minimale proposee dans le rapport, non implementee' } })

  finish('terminee')

  function finish (why) {
    clearTimeout(guard)
    results.cloture = { pourquoi: why, duree_totale_ms: Date.now() - startedAll, position_finale: fmtP(bot?.entity?.position), inventaire_final: bot ? snapshotInv(bot) : null }
    try { fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2)) } catch (e) { console.log(`[compare] ecriture impossible : ${e.message}`) }
    console.log('[compare] resultats -> ' + RESULTS_FILE)
    quit(why)
    setTimeout(() => process.exit(0), 800).unref()
  }
}

if (process.argv.includes('--receiver')) receiverMain()
else main().catch(err => {
  console.log(`[compare] fatal : ${err?.stack ?? err}`)
  try { fs.writeFileSync(RESULTS_FILE, JSON.stringify({ ...results, fatal: String(err?.stack ?? err) }, null, 2)) } catch (_) {}
  process.exitCode = 1
})
