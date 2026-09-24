'use strict'
// tmp/capability-runtime-probe.js — vérification LIVE des modules prod
// bot/delivery.js + bot/craft.js (+ recipe-plan.js, build.js) ACTUELS et FIGÉS
// (aucun writer sur bot/*.js pendant la campagne : hashes relevés côté hôte
// avant/après, conteneur NON rebuildé, modules chargés depuis des COPIES
// /tmp/cap-proof/localbot, node_modules de l'image existante).
//
// Dérivé de tmp/probe-bot.js (v1) : même connexion (offline, 26.1), même
// silence (AUCUN bot.chat() vers le serveur), usernames réservés.
// ACTEUR : TestProbe1 (ce process). RECEVEUR : TestProbe2 (probe-bot.js
// inchangé, idle silencieux). JAMAIS TestBot / Rhadamanthe0.
// AUCUN appel à l'API TestBot (ni instruction, ni contrôles, ni reset) :
// l'hôte ne fait que des lectures GET status/mission avant/après.
// Stock de test = apport RCON de l'hôte (give/clear), DÉCLARÉ comme tel :
// on ne prétend jamais crafter depuis rien.
// Arène UNIQUEMENT 1000..1024, y=199 (plateforme fixture RCON déclarée).
// Garde-fou 9 min (< 10 min de jeu exigées). Sortie :
//   /tmp/capability-runtime-results.json (recopié par l'hôte vers
//   tmp/capability-runtime-results.json, seul autre fichier autorisé).

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const mineflayer = require('mineflayer')

const USERNAME = process.argv[2]
const RESULTS_FILE = '/tmp/capability-runtime-results.json'
const PROOF_DIR = '/tmp/cap-proof'
const LOCAL_DIR = path.join(PROOF_DIR, 'localbot')
const HOST = 'minecraft'
const PORT = 25565
const VERSION = '26.1'
const RECEIVER = 'TestProbe2'
const GUARD_MS = 9 * 60 * 1000
// Mode D1 seul : rejoue uniquement les dons réels (craft déjà validé).
// Usage : node /tmp/h1.js TestProbe1 --d1-only
const D1_ONLY = process.argv.includes('--d1-only')

if (USERNAME !== 'TestProbe1') {
  console.error(`[cap-probe] username imposé : TestProbe1 (reçu ${USERNAME})`)
  process.exit(2)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const fmtP = p => p ? `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}` : 'null'

function sha1File (file) {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')
  } catch (_) { return null }
}

// Charge le VRAI module prod : copie TMP d'abord, /app en repli déclaré.
function loadProd (name) {
  const fromTmp = path.join(LOCAL_DIR, name)
  const fromApp = path.join('/app', name)
  let file = null
  if (fs.existsSync(fromTmp)) file = fromTmp
  else if (fs.existsSync(fromApp)) file = fromApp
  else throw new Error(`module prod introuvable : ${name}`)
  const mod = require(file)
  return { mod, file, sha1: sha1File(file) }
}

const results = {
  protocole: 'vérification live modules prod delivery.js/craft.js figés (copies TMP, image non rebuildée), vrais bots silencieux',
  acteur: USERNAME,
  receveur: RECEIVER,
  testBotIntact: { note: 'aucune instruction/contrôle/reset via API pendant la campagne (lectures GET hôte uniquement)' },
  consignes: {
    stockOrigine: 'apport RCON de l hôte (clear/give) déclaré par gate ; jamais de craft prétendu depuis rien',
    arene: '1000..1024, y=199, fixtures RCON uniquement (plateforme déclarée côté hôte)',
    silence: 'aucun bot.chat() dans ce process ni dans le receveur'
  },
  modules: {},
  environnement: {},
  cases: [],
  itemMetaReelVsMocks: null,
  serverSnapshots: null, // rempli côté hôte (RCON data get entity ... Inventory), null = non capturé
  limites: [],
  cloture: null
}

function record (c) {
  results.cases.push(c)
  console.log('[case] ' + JSON.stringify(c))
}

// Gate RCON côté hôte : l'hôte lit [BESOIN_RCON] dans les logs, exécute le
// RCON (harness uniquement), puis `touch /tmp/cap-proof/ack-<token>`.
async function besoinRcon (token, label) {
  console.log(`[BESOIN_RCON] ${label} (token ${token}) -> touch ${PROOF_DIR}/ack-${token}`)
  const t0 = Date.now()
  while (Date.now() - t0 < 120000) {
    try {
      await fs.promises.access(path.join(PROOF_DIR, `ack-${token}`))
      console.log(`[BESOIN_RCON] ack ${token} reçu après ${Date.now() - t0} ms`)
      return true
    } catch (_) { /* attente */ }
    await sleep(1000)
  }
  throw new Error(`ack RCON timeout (${token} : ${label})`)
}

function snapInv (bot) {
  const out = {}
  for (const it of bot.inventory.items()) out[it.name] = (out[it.name] ?? 0) + it.count
  return out
}

function itemMeta (bot) {
  return bot.inventory.items().map(it => ({
    name: it.name, type: it.type, metadata: it.metadata, count: it.count
  }))
}

function registryMatch (bot, sample) {
  return sample.map(s => {
    const reg = bot.registry.itemsByName?.[s.name]
    return { name: s.name, itemType: s.type, registryId: reg?.id ?? null, coherent: reg ? reg.id === s.type : null }
  })
}

function dropsPres (bot, feet, rayon = 8) {
  const out = []
  for (const [id, e] of Object.entries(bot.entities ?? {})) {
    if (!e || e.name !== 'item' || !e.position) continue
    const dxz = Math.hypot(e.position.x - feet.x, e.position.z - feet.z)
    if (dxz > rayon) continue
    out.push({
      id: String(id),
      dxz: Number(dxz.toFixed(2)),
      dy: Number(Math.abs(e.position.y - feet.y).toFixed(2)),
      pos: fmtP(e.position)
    })
  }
  out.sort((a, b) => a.dxz - b.dxz)
  return out
}

function recvPos (bot) {
  try {
    const p = bot.players?.[RECEIVER]?.entity?.position
    return p ? { x: p.x, y: p.y, z: p.z } : null
  } catch (_) { return null }
}

// Metadata RÉELLE d'une goutte (entité mineflayer, pas mock) : identité,
// position et slot d'objet brut (borné). Le slot porte {itemId,itemCount}
// quand le serveur l'a envoyé ; sinon on expose le brut sans inventer.
function dropEntityMeta (bot, id) {
  const bound = v => {
    try { return JSON.stringify(v).slice(0, 400) } catch (_) { return String(v).slice(0, 120) }
  }
  const e = bot?.entities?.[id] ?? bot?.entities?.[String(id)] ?? null
  if (!e) return { found: false, id: String(id) }
  const arr = Array.isArray(e.metadata) ? e.metadata : []
  let slot = null
  try {
    const s = arr.find(m => m && typeof m === 'object' && m.value && typeof m.value === 'object' &&
      ('itemId' in m.value || 'itemCount' in m.value))
    if (s) slot = bound(s.value)
  } catch (_) { /* lecture best-effort */ }
  return {
    found: true, id: String(id),
    name: e.name ?? null, displayName: e.displayName ?? null,
    entityType: e.entityType ?? null, type: e.type ?? null, objectType: e.objectType ?? null,
    pos: fmtP(e.position),
    itemName: e.itemName ?? e?.item?.name ?? null,
    itemCount: e.count ?? e?.item?.count ?? null,
    slot,
    metadata: arr.slice(0, 24).map(m => ({ key: m?.key ?? null, type: m?.type ?? null, value: bound(m?.value) }))
  }
}

async function withTimeout (promise, ms, code) {
  let timer = null
  const gate = new Promise(resolve => { timer = setTimeout(() => resolve({ __timeout: true, code }), ms) })
  const out = await Promise.race([
    promise.then(v => ({ __timeout: false, value: v }), err => ({ __timeout: false, error: err })),
    gate
  ])
  if (timer) clearTimeout(timer)
  return out
}

async function main () {
  const tAll = Date.now()
  console.log(`[cap-probe] ${USERNAME} -> ${HOST}:${PORT} version=${VERSION} (silencieux, sans chat serveur)`)

  // --- Modules prod figés (copies TMP prioritaires) ---
  const dDelivery = loadProd('delivery.js')
  const dCraft = loadProd('craft.js')
  const dPlan = loadProd('recipe-plan.js')
  const dBuild = loadProd('build.js')
  const delivery = dDelivery.mod
  const craft = dCraft.mod
  results.modules = {
    'delivery.js': dDelivery,
    'craft.js': dCraft,
    'recipe-plan.js': dPlan,
    'build.js': dBuild
  }
  console.log('[cap-probe] modules : ' + JSON.stringify(results.modules))

  const bot = mineflayer.createBot({ host: HOST, port: PORT, username: USERNAME, auth: 'offline', version: VERSION })
  results.environnement.botVersion = VERSION

  let done = false
  const quit = why => {
    if (done) return
    done = true
    console.log(`[cap-probe] arrêt (${why})`)
    try { bot.quit(String(why)) } catch (_) { /* ignore */ }
  }
  process.on('SIGINT', () => quit('SIGINT'))
  process.on('SIGTERM', () => quit('SIGTERM'))
  bot.on('kicked', r => { console.log(`[cap-probe] kicked : ${r}`); quit('kicked') })
  bot.on('error', e => console.log(`[cap-probe] error : ${e.message}`))

  const guard = setTimeout(() => finish('garde-fou 9 min'), GUARD_MS)

  function finish (why) {
    clearTimeout(guard)
    results.cloture = {
      pourquoi: why,
      duree_totale_ms: Date.now() - tAll,
      position_finale: fmtP(bot.entity?.position),
      inventaire_final: bot.entity ? snapInv(bot) : null
    }
    try { fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2)) } catch (e) {
      console.log(`[cap-probe] écriture impossible : ${e.message}`)
    }
    console.log('[PROBE_DONE] résultats -> ' + RESULTS_FILE)
    quit(why)
    setTimeout(() => process.exit(0), 800).unref()
  }

  try {
    await new Promise((resolve, reject) => {
      bot.once('spawn', resolve)
      setTimeout(() => reject(new Error('spawn timeout 60 s')), 60000)
    })
  } catch (err) {
    record({ id: 'T0-spawn', famille: 'setup', succes: false, erreur: err.message })
    finish('spawn impossible')
    return
  }
  // Silence absolu : vérifier qu'on n'émet jamais vers le chat serveur.
  let chatEmis = 0
  const origChat = bot.chat.bind(bot)
  bot.chat = (...args) => { chatEmis += 1; return origChat(...args) }

  results.environnement.spawn = fmtP(bot.entity.position)
  results.environnement.registreRecettes = Boolean(bot.registry?.recipes)
  try {
    const mcdata = require('minecraft-data')(VERSION)
    results.environnement.minecraftDataDispo = Boolean(mcdata?.recipes)
  } catch (_) { results.environnement.minecraftDataDispo = false }
  record({
    id: 'T0-spawn', famille: 'setup', succes: true,
    preuves: {
      position: fmtP(bot.entity.position),
      inventaire_spawn: snapInv(bot),
      datasetRegistre: results.environnement.registreRecettes,
      minecraftData: results.environnement.minecraftDataDispo
    }
  })

  // --- Instrumentation d'appels (comptes + latences, sans modifier le prod) ---
  const craftCalls = []
  const origCraftFn = bot.craft.bind(bot)
  bot.craft = async function (...args) {
    const t0 = Date.now()
    const entry = { at: t0, ok: null, ms: null }
    craftCalls.push(entry)
    try {
      const r = await origCraftFn(...args)
      entry.ms = Date.now() - t0
      entry.ok = true
      return r
    } catch (err) {
      entry.ms = Date.now() - t0
      entry.ok = false
      entry.error = String(err?.message ?? err).slice(0, 160)
      throw err
    }
  }
  const tossCalls = []
  for (const k of ['toss', 'tossStack']) {
    if (typeof bot[k] !== 'function') continue
    const orig = bot[k].bind(bot)
    bot[k] = async function (...args) {
      const t0 = Date.now()
      const entry = { fn: k, at: t0, ok: null, ms: null }
      tossCalls.push(entry)
      try {
        const r = await orig(...args)
        entry.ms = Date.now() - t0
        entry.ok = true
        return r
      } catch (err) {
        entry.ms = Date.now() - t0
        entry.ok = false
        entry.error = String(err?.message ?? err).slice(0, 160)
        throw err
      }
    }
  }

  // Gate initiale : l'hôte TP les deux probes sur la plateforme fixture.
  await besoinRcon('go', 'setup arène : TP TestProbe1/TestProbe2 sur plateforme 1008..1014/y199 + forceload')
  await sleep(2000) // retombee / chunks client
  const p0 = bot.entity.position
  const r0 = recvPos(bot)
  record({
    id: 'T0-arene', famille: 'setup', succes: Boolean(r0),
    preuves: { acteur: fmtP(p0), receveur: r0 ? fmtP(r0) : null, receveurVu: Boolean(r0) }
  })
  if (!r0) {
    results.limites.push('receveur TestProbe2 non visible : suite don impossible, crafts seuls')
  }

  // ================= MODE D1 SEUL (rejeu don réel, fix Vec3) =================
  // Rejeu ciblé SANS refaire le craft (déjà validé) : deux dons réels au vrai
  // receveur, quantités différentes (4 sur stock 4 = tossStack ; 2 sur stock 6
  // = toss partiel), preuve anti-overshoot (delta == -demande, jamais plus).
  if (D1_ONLY) {
    results.protocole = 'rejeu D1 don réel seul (fix Vec3 lookAt/blockAt, erreurs préservées) : 2 dons quantités différentes, anti-overshoot'
    results.environnement.mode = 'd1-only'
    const stubNavD1 = { toPlayer: async () => ({ reached: true, code: 'stub_arrived' }) }

    const gift = async (id, count, token, setupLabel) => {
      await besoinRcon(token, setupLabel)
      await sleep(1500)
      const rpos = recvPos(bot)
      const posA = fmtP(bot.entity?.position)
      if (!rpos) {
        record({ id, famille: 'don', succes: false, erreur: 'receveur invisible', preuves: { pos_acteur: posA } })
        console.log(`[CASE_DONE] ${id} (receveur invisible)`)
        return false
      }
      const avant = snapInv(bot)
      const metaAvant = itemMeta(bot)
      const recvAvant = fmtP(rpos)
      const nTossAvant = tossCalls.length
      const events = []
      let eventTotal = 0
      const onActivity = evt => {
        eventTotal += 1
        if (events.length < 40) {
          let s = ''
          try { s = JSON.stringify(evt) } catch (_) { s = String(evt ?? '') }
          events.push(s.slice(0, 220))
        }
      }
      const annonces = []
      const t0 = Date.now()
      const r = await withTimeout(delivery.giveToPlayer(bot, {
        player: RECEIVER, item: 'oak_planks', count,
        navigator: stubNavD1, onActivity,
        announce: texte => { annonces.push(String(texte).slice(0, 160)) }
      }), 60000, 'don-timeout')
      const duree = Date.now() - t0
      const apres = snapInv(bot)
      const dEm = (apres.oak_planks ?? 0) - (avant.oak_planks ?? 0)
      const feet = bot.entity.position
      const gouttes = dropsPres(bot, feet, 8)
      if (r.__timeout) {
        record({ id, famille: 'don', succes: false, duree_ms: duree, erreur: 'timeout', preuves: { avant, apres } })
      } else {
        const v = r.value
        const dropIds = (v.evidence?.drops ?? []).map(d => d.id).filter(x => x !== null && x !== undefined)
        const dropMetas = dropIds.map(x => dropEntityMeta(bot, x))
        const ok = v.status === 'succeeded' && v.deposited === count && dEm === -count
        record({
          id, famille: 'don', succes: ok, duree_ms: duree,
          preuves: {
            status: v.status, raison: v.reason, demande: v.requested, depose: v.deposited, restant: v.remaining,
            emetteur_delta: dEm, overshootAbsent: dEm === -count,
            inventaire_avant: avant, inventaire_apres: apres,
            itemMetaAvant: metaAvant, registre: registryMatch(bot, metaAvant),
            pos_emetteur: posA, pos_emetteur_apres: fmtP(bot.entity?.position),
            pos_receveur: recvAvant, pos_receveur_apres: fmtP(recvPos(bot)),
            regard: v.evidence?.look ?? null, ligne: v.evidence?.line ?? null,
            navigation: v.evidence?.navigation ?? null,
            distances: v.evidence?.distances ?? null, distancesPost: v.evidence?.distancesPost ?? null,
            tosses: v.evidence?.tosses ?? null, dropsEvidence: v.evidence?.drops ?? null,
            pickups: v.evidence?.pickups ?? null,
            gouttes_proches: gouttes, dropEntites: dropMetas,
            appelsToss: tossCalls.length - nTossAvant,
            latencesTossMs: tossCalls.slice(nTossAvant).map(c => ({ fn: c.fn, ms: c.ms, ok: c.ok, error: c.error ?? null })),
            onActivityTotal: eventTotal, onActivity: events, annonces,
            ramassageNonExige: true
          }
        })
      }
      console.log(`[CASE_DONE] ${id}`)
      return true
    }

    await gift('D1a-don-4-stock4', 4, 'd1a', 'D1a : clear both + give TestProbe1 4 oak_planks + TP vérifiés intra-carré')
    await gift('D1b-don-2-stock6', 2, 'd1b', 'D1b : clear acteur + give TestProbe1 6 oak_planks + TP vérifiés intra-carré')
    results.environnement.chatEmisServeur = chatEmis
    results.environnement.appelsCraftTotal = craftCalls.length
    results.environnement.appelsTossTotal = tossCalls.length
    results.itemMetaReelVsMocks = {
      echantillon: itemMeta(bot).slice(0, 6),
      registre: registryMatch(bot, itemMeta(bot).slice(0, 6)),
      methode: 'bot.inventory.items() -> {name, type, metadata, count} + bot.registry.itemsByName[name].id ; gouttes via bot.entities (metadata slot reelle)',
      contrasteMocks: 'mocks : type 100+i fictif, kind drop ad hoc ; réel : ids registre 26.1, entités name=item'
    }
    finish('D1-only terminé')
    return
  }

  // ================= CRAFT =================
  // C1 : planches x1 (1 op) — stock apport RCON 1 bûche.
  {
    await besoinRcon('c1', 'C1 : clear TestProbe1 + give 1 oak_log')
    const avant = snapInv(bot)
    const metaAvant = itemMeta(bot)
    const nCraftAvant = craftCalls.length
    const t0 = Date.now()
    const r = await withTimeout(craft.make(bot, 'planches', 1), 60000, 'craft-timeout')
    const duree = Date.now() - t0
    const apres = snapInv(bot)
    const dLog = (apres.oak_log ?? 0) - (avant.oak_log ?? 0)
    const dPlank = (apres.oak_planks ?? 0) - (avant.oak_planks ?? 0)
    const calls = craftCalls.length - nCraftAvant
    if (r.__timeout) {
      record({ id: 'C1-planches-x1', famille: 'craft', succes: false, duree_ms: duree, erreur: 'timeout', preuves: { avant, apres } })
    } else if (r.error) {
      record({ id: 'C1-planches-x1', famille: 'craft', succes: false, duree_ms: duree, erreur: String(r.error.message ?? r.error).slice(0, 200), preuves: { avant, apres, appelsCraft: calls } })
    } else {
      const v = r.value
      record({
        id: 'C1-planches-x1', famille: 'craft', succes: dLog === -1 && dPlank === 4 && v.produced === 4,
        duree_ms: duree,
        preuves: {
          buches_delta: dLog, planches_delta: dPlank,
          produit: v.produced, demande: v.wanted, operations: v.operations, repeats: v.repeats,
          ackMs: v.ackMs, usedTable: v.usedTable,
          appelsCraft: calls, latencesCraftMs: craftCalls.slice(nCraftAvant).map(c => c.ms),
          itemMetaAvant: metaAvant, registre: registryMatch(bot, metaAvant),
          inventaire: apres
        }
      })
    }
  }

  // C2 : planches x8 (2 ops unitaires, N>2 partiel éventuel) — stock 2 bûches.
  {
    await besoinRcon('c2', 'C2 : clear TestProbe1 + give 2 oak_log')
    const avant = snapInv(bot)
    const nCraftAvant = craftCalls.length
    const t0 = Date.now()
    const r = await withTimeout(craft.make(bot, 'planches', 8), 90000, 'craft-timeout')
    const duree = Date.now() - t0
    const apres = snapInv(bot)
    const dLog = (apres.oak_log ?? 0) - (avant.oak_log ?? 0)
    const dPlank = (apres.oak_planks ?? 0) - (avant.oak_planks ?? 0)
    const calls = craftCalls.slice(nCraftAvant)
    if (r.__timeout) {
      record({ id: 'C2-planches-x8-2ops', famille: 'craft', succes: false, duree_ms: duree, erreur: 'timeout', preuves: { avant, apres, appelsCraft: calls.length } })
    } else if (r.error) {
      record({
        id: 'C2-planches-x8-2ops', famille: 'craft', succes: false, duree_ms: duree,
        erreur: String(r.error.message ?? r.error).slice(0, 200),
        preuves: {
          avant, apres, buches_delta: dLog, planches_delta: dPlank,
          appelsCraft: calls.length, latencesDetailleesMs: calls.map(c => ({ ms: c.ms, ok: c.ok, error: c.error ?? null })),
          partielEventuel: 'échec = fait brut (fenêtre 26.1 incertaine possible), sans rejouée'
        }
      })
    } else {
      const v = r.value
      record({
        id: 'C2-planches-x8-2ops', famille: 'craft', succes: dLog === -2 && dPlank === 8,
        duree_ms: duree,
        preuves: {
          buches_delta: dLog, planches_delta: dPlank,
          produit: v.produced, demande: v.wanted, planifie: v.planned, partiel: v.partial,
          operations: v.operations, repeats: v.repeats, ackMs: v.ackMs,
          appelsCraft: calls.length,
          latencesDetailleesMs: calls.map(c => ({ ms: c.ms, ok: c.ok })),
          inventaire: apres
        }
      })
    }
  }

  // C3 : bâtons depuis bûche générique (chaîne 2 ops) — stock 1 bûche.
  {
    await besoinRcon('c3', 'C3 : clear TestProbe1 + give 1 oak_log')
    const avant = snapInv(bot)
    const nCraftAvant = craftCalls.length
    const t0 = Date.now()
    const r = await withTimeout(craft.make(bot, 'stick', 4), 90000, 'craft-timeout')
    const duree = Date.now() - t0
    const apres = snapInv(bot)
    const calls = craftCalls.slice(nCraftAvant)
    if (r.__timeout) {
      record({ id: 'C3-batons-chaine', famille: 'craft', succes: false, duree_ms: duree, erreur: 'timeout', preuves: { avant, apres } })
    } else if (r.error) {
      record({ id: 'C3-batons-chaine', famille: 'craft', succes: false, duree_ms: duree, erreur: String(r.error.message ?? r.error).slice(0, 200), preuves: { avant, apres, appelsCraft: calls.length } })
    } else {
      const v = r.value
      record({
        id: 'C3-batons-chaine', famille: 'craft', succes: v.item === 'stick' && v.produced >= 4 && v.operations >= 2,
        duree_ms: duree,
        preuves: {
          produit: v.produced, item: v.item, operations: v.operations, repeats: v.repeats,
          ackMs: v.ackMs, usedTable: v.usedTable,
          appelsCraft: calls.length, latencesDetailleesMs: calls.map(c => ({ ms: c.ms, ok: c.ok })),
          inventaire: apres
        }
      })
    }
  }

  // C4 : ingrédients absents => missing SANS consommation.
  {
    await besoinRcon('c4', 'C4 : clear TestProbe1 (stock vide)')
    const avant = snapInv(bot)
    const nCraftAvant = craftCalls.length
    const t0 = Date.now()
    const r = await withTimeout(craft.make(bot, 'stick', 4), 60000, 'craft-timeout')
    const duree = Date.now() - t0
    const apres = snapInv(bot)
    const inchange = JSON.stringify(avant) === JSON.stringify(apres)
    if (!r.__timeout && r.error && (r.error.code === 'missing' || /manquant/i.test(r.error.message ?? ''))) {
      record({
        id: 'C4-manquant-sans-conso', famille: 'craft',
        succes: inchange && (craftCalls.length - nCraftAvant) === 0,
        duree_ms: duree,
        preuves: {
          code: r.error.code ?? null, message: String(r.error.message ?? '').slice(0, 200),
          missing: r.error.missing ?? null, stockInchange: inchange, appelsCraft: craftCalls.length - nCraftAvant
        }
      })
    } else if (r.__timeout) {
      record({ id: 'C4-manquant-sans-conso', famille: 'craft', succes: false, duree_ms: duree, erreur: 'timeout inattendu', preuves: { avant, apres } })
    } else {
      record({ id: 'C4-manquant-sans-conso', famille: 'craft', succes: false, duree_ms: duree, erreur: 'succès inattendu sur stock vide (fait brut)', preuves: { avant, apres, valeur: r.value ?? null } })
    }
  }

  // Photo item metadata réelle vs mocks (contraste explicite).
  {
    const sample = itemMeta(bot)
    results.itemMetaReelVsMocks = {
      echantillon: sample.slice(0, 6),
      registre: registryMatch(bot, sample.slice(0, 6)),
      methode: 'bot.inventory.items() -> {name, type, metadata, count} + bot.registry.itemsByName[name].id',
      contrasteMocks: 'mocks delivery.test.js/craft.test.js : type 100+i fictif, metadata 0, kind drop ad hoc ; réel : ids numériques du registre 26.1, metadata serveur, entités name=item'
    }
  }

  // ================= DON =================
  const stubNav = { toPlayer: async () => ({ reached: true, code: 'stub_arrived' }) }
  // D1 : donne 4 planches au VRAI receveur.
  if (recvPos(bot)) {
    await besoinRcon('d1', 'D1 : clear both + give TestProbe1 4 oak_planks + TP adjacent (2 blocs)')
    await sleep(1500)
    const avant = snapInv(bot)
    const posAvant = fmtP(bot.entity.position)
    const recvAvant = fmtP(recvPos(bot))
    const nTossAvant = tossCalls.length
    const events = []
    const t0 = Date.now()
    const r = await withTimeout(delivery.giveToPlayer(bot, {
      player: RECEIVER, item: 'oak_planks', count: 4,
      navigator: stubNav,
      onActivity: evt => { events.push(evt) },
      announce: texte => { events.push({ announced: texte }) }
    }), 60000, 'don-timeout')
    const duree = Date.now() - t0
    const apres = snapInv(bot)
    const dEm = (apres.oak_planks ?? 0) - (avant.oak_planks ?? 0)
    const feet = bot.entity.position
    const gouttes = dropsPres(bot, feet, 8)
    if (r.__timeout) {
      record({ id: 'D1-don-4-receveur', famille: 'don', succes: false, duree_ms: duree, erreur: 'timeout', preuves: { avant, apres } })
    } else {
      const v = r.value
      record({
        id: 'D1-don-4-receveur', famille: 'don',
        succes: v.status === 'succeeded' && v.deposited === 4 && dEm === -4,
        duree_ms: duree,
        preuves: {
          status: v.status, raison: v.reason, demande: v.requested, depose: v.deposited, restant: v.remaining,
          emetteur_delta: dEm, inventaire: apres,
          pos_emetteur: posAvant, pos_emetteur_apres: fmtP(bot.entity.position),
          pos_receveur: recvAvant, pos_receveur_apres: fmtP(recvPos(bot)),
          gouttes_proches: gouttes, dropsEvidence: v.evidence?.drops ?? null,
          tosses: v.evidence?.tosses ?? null, distances: v.evidence?.distances ?? null,
          distancesPost: v.evidence?.distancesPost ?? null, navigation: v.evidence?.navigation ?? null,
          regard: v.evidence?.look ?? null, ligne: v.evidence?.line ?? null,
          appelsToss: tossCalls.length - nTossAvant,
          latencesTossMs: tossCalls.slice(nTossAvant).map(c => ({ fn: c.fn, ms: c.ms, ok: c.ok })),
          ramassageNonExige: true
        }
      })
    }
    await sleep(2000) // laisse la goutte éventuelle se stabiliser / être ramassée
    record({
      id: 'D1-suivi-2s', famille: 'don', succes: true,
      preuves: { inventaire_2s: snapInv(bot), gouttes_2s: dropsPres(bot, bot.entity.position, 8) }
    })
  } else {
    record({ id: 'D1-don-4-receveur', famille: 'don', succes: false, erreur: 'receveur invisible', preuves: {} })
  }

  // D2 : destinataire absent => refus propre, 0 toss, stock intact.
  {
    await besoinRcon('d2', 'D2 : clear TestProbe1 + give 1 oak_planks (carburant refus)')
    const avant = snapInv(bot)
    const nTossAvant = tossCalls.length
    const t0 = Date.now()
    const r = await withTimeout(delivery.giveToPlayer(bot, {
      player: 'Fantome99', item: 'oak_planks', count: 1, navigator: stubNav
    }), 30000, 'don-timeout')
    const duree = Date.now() - t0
    const apres = snapInv(bot)
    if (r.__timeout) {
      record({ id: 'D2-absent-refus', famille: 'don', succes: false, duree_ms: duree, erreur: 'timeout', preuves: {} })
    } else {
      const v = r.value
      record({
        id: 'D2-absent-refus', famille: 'don',
        succes: v.status === 'failed' && v.reason === 'player_absent' && v.deposited === 0 &&
          (tossCalls.length - nTossAvant) === 0 && JSON.stringify(avant) === JSON.stringify(apres),
        duree_ms: duree,
        preuves: {
          status: v.status, raison: v.reason, depose: v.deposited,
          appelsToss: tossCalls.length - nTossAvant, stockInchange: JSON.stringify(avant) === JSON.stringify(apres)
        }
      })
    }
  }

  // D3 : livraison interrompue AVANT toss => cancelled, 0 toss, aucun retry.
  // (L'interruption en vol + non-libération est couverte en unitaire par
  // tmp/delivery.test.js LATE TOSS / ABORT EN VOL ; non rejouée live pour ne
  // pas risquer un double débit réel.)
  {
    const avant = snapInv(bot)
    const nTossAvant = tossCalls.length
    const ctl = new AbortController()
    ctl.abort()
    const t0 = Date.now()
    const r = await withTimeout(delivery.giveToPlayer(bot, {
      player: RECEIVER, item: 'oak_planks', count: 1, navigator: stubNav, signal: ctl.signal
    }), 30000, 'don-timeout')
    const duree = Date.now() - t0
    const apres = snapInv(bot)
    if (r.__timeout) {
      record({ id: 'D3-interrompu-sans-retry', famille: 'don', succes: false, duree_ms: duree, erreur: 'timeout', preuves: {} })
    } else {
      const v = r.value
      record({
        id: 'D3-interrompu-sans-retry', famille: 'don',
        succes: v.status === 'cancelled' && (tossCalls.length - nTossAvant) === 0 &&
          JSON.stringify(avant) === JSON.stringify(apres),
        duree_ms: duree,
        preuves: {
          status: v.status, raison: v.reason, appelsToss: tossCalls.length - nTossAvant,
          stockInchange: JSON.stringify(avant) === JSON.stringify(apres),
          note: 'aucun retry : un seul appel, 0 toss ; en-vol couvert en unitaire (mocks)'
        }
      })
    }
    results.limites.push('D3 live = abort avant toss uniquement ; abort en vol + late-toss prouvés en unitaire tmp/delivery.test.js, non rejoués live (risque double débit)')
  }

  results.environnement.chatEmisServeur = chatEmis
  results.environnement.appelsCraftTotal = craftCalls.length
  results.environnement.appelsTossTotal = tossCalls.length
  if (chatEmis !== 0) results.limites.push(`chat serveur émis ${chatEmis} fois : silence rompu (fait brut)`)
  finish('campagne terminée')
}

main().catch(err => {
  console.log(`[cap-probe] fatal : ${err?.stack ?? err}`)
  try { fs.writeFileSync(RESULTS_FILE, JSON.stringify({ ...results, fatal: String(err?.stack ?? err) }, null, 2)) } catch (_) { /* ignore */ }
  process.exitCode = 1
})
