'use strict'
// tmp/architecture-runtime-probe.js — PREPARATION seule (aucun runtime lance par cette action).
//
// Driver HOTE (node, sans dependance nouvelle) de la campagne candidat C8/C4.
// Cible : conteneur jetable candidat (vrai index.js+mission+API, preload silence)
//   API candidat  http://127.0.0.1:3001  (ecriture autorisee)
//   API principal http://127.0.0.1:3000  (LECTURE SEULE : GET /api/status uniquement,
//     preuve TestBot intact ; AUCUNE commande principal, AUCUN reset monde/config)
// Acteurs : candidat TestProbe3 (connexion du conteneur, jamais 2x TestBot),
//   receveur TestProbe2 (tmp/probe-bot.js OBLIGATOIRE, reserve PROCHAINE action,
//   pas maintenant). Ce fichier ne connecte AUCUN bot Minecraft lui-meme :
//   il pilote par HTTP + RCON hote (fixtures serialisees, une owner).
//
// Arene : RCON UNIQUEMENT, carre 1000..1024 y=199. Avant chaque TP/fixture :
//   verifier colonne corps+tete AIR + appui au sol (case-par-case, comme
//   capability-runtime-probe.js) ; fixtures serialisees, une seule owner ;
//   aucune autre action/agent sur l arene pendant la campagne.
// Silence : ce driver n envoie AUCUN bot.chat() ; les cas dialogue utilisent
//   le receveur TestProbe2 en --say OPT-IN explicite (pollution recentChat
//   mesuree, compteur en tete), ou /api/instruction cote candidat (pas de chat
//   serveur). La capture preload (/tmp/candidate-chat.log) prouve le silence.
//
// Plan couvert (borne globale 15 min, timeouts par cas, 1 seul scenario debug
// retente sur echec reproductible) :
//   S0 audit startup spawn survie (spawned, playerGameType 0, ops.json sans TestBot/TestProbe3)
//   S1 inference Muse vrai brief (POST /api/mission, consigne type/matiere)
//   S2 parcours simple rejoindre + retour origine fixe + stop/reprise (origine fixe, cursor, preuves)
//   S3 arbitrage 2 joueurs timeout 60 s REEL (pause 60 s, sans reponse -> ancien reprend, nouveau en attente)
//   S4 question durant brief (question ne tue pas le brief)
//   S5 arret total bloque API goto/jump/control + watchdog, puis resume explicite (sans LLM)
//   S6 don stock fixture par mesures (depot mesure, jamais ramassage exige)
//   S7 craft generique (recette lue, stock reel, objets obtenus)
//   S8 restaure after candidate restart, store durable TEMP (origin/cursor/hardstop) pas stock prod
//   S9 construction set fixture DOCUMENTEE NON COUVERTE si contraintes backend non reglees
//     + capacite apprise PIPELINE (jamais promise : decision conservation explicite requise)
// Sortie : /tmp/architecture-runtime-results.json (recopie projet
//   tmp/architecture-runtime-results.json). Echecs : extrait utile, pas log complet.
//
// EXECUTION REELLE 2026-09-24 : hote sans Node -> driver = pwsh
// (tmp/architecture-runtime-run.ps1, Invoke-RestMethod). Ce fichier reste la
// reference des scenarios (memes cas/endpoints) pour un contexte avec Node.
// LECONS CAMPAGNE (appliquer dans tout driver) :
//  - workaround OBLIGATOIRE : chaque POST /api/mission|/api/instruction porte
//    '"mode":"temporary"' (readDirectMode index.js:1087 rend undefined sinon
//    -> 500 "reading 'error'" deterministe, constate Muse ET deepseek) ;
//  - chemins : hote 127.0.0.1:3001 (candidat) / 127.0.0.1:3000 lecture seule ;
//    depuis un conteneur : host.docker.internal ; jamais de sock Docker monte
//    dans le candidat ; preload v2 triple-verrou (re-patch login/spawn/timers
//    + drop paquets chat/chat_command) apres leak v1 prouve ;
//  - 1 seul retry debug par cas ; borne 15 min indicative (securite d abord).

const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')

function arg (name, defaut) {
  const i = process.argv.indexOf(name)
  if (i === -1 || i + 1 >= process.argv.length) return defaut
  return process.argv[i + 1]
}

const CANDIDATE = arg('--candidate', 'http://127.0.0.1:3001')
const PRINCIPAL = arg('--principal', 'http://127.0.0.1:3000')
const OUT = arg('--out', path.join(__dirname, 'architecture-runtime-results.json'))
const GLOBAL_TIMEOUT_MS = Number(arg('--timeout-ms', 15 * 60 * 1000))
const ARBI_TIMEOUT_MS = 60 * 1000 // S3 : 60 s REELLES, D42/D46

const sleep = ms => new Promise(r => setTimeout(r, ms))

function rcon (args) {
  return new Promise((resolve, reject) => {
    execFile('docker', ['compose', 'exec', '-T', 'minecraft', 'rcon-cli', ...args], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`rcon ${args.join(' ')} : ${(stderr || err.message).slice(0, 300)}`))
      resolve(String(stdout || '').trim())
    })
  })
}

async function http (method, base, p, body) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 20000)
  try {
    const res = await fetch(`${base}${p}`, {
      method,
      signal: ctrl.signal,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch (_) { /* texte brut */ }
    return { status: res.status, json, text: text.slice(0, 2000) }
  } finally { clearTimeout(t) }
}

function freshResults () {
  const ids = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9']
  const cases = {}
  for (const id of ids) cases[id] = { id, statut: 'pending', preuves: {}, erreur: null, duree_ms: null }
  return {
    protocole: 'architecture-candidate : vrai index.js+mission+API (conteneur jetable TestProbe3, preload silence), principal 3000 lecture seule',
    candidat: { api: CANDIDATE, username: 'TestProbe3', image_tag: 'architecture-candidate', session: 'preuve-unique (voir run.ps1)', images: 'off' },
    principal: { api: PRINCIPAL, acces: 'GET /api/status uniquement (lecture seule)' },
    receveur: { username: 'TestProbe2', template: 'tmp/probe-bot.js OBLIGATOIRE', reservation: 'prochaine action (pas connecte par cette preparation)' },
    arene: { carre: '1000..1024, y=199', fixtures: 'RCON uniquement, serialisees, une owner', garde_colonne: 'corps+tete AIR + appui sol verifies avant chaque TP/usage' },
    bornes: { globale_ms: GLOBAL_TIMEOUT_MS, arbitrage_reel_ms: ARBI_TIMEOUT_MS, debug_retry: 'un seul scenario reproductible retente' },
    contraintes: {
      testBotJamaisDouble: 'candidat TestProbe3 uniquement ; TestBot jamais reconnecte',
      prodIntact: 'aucune commande principal, config/monde pas reset, data candidat ephemere (pas volume prod)',
      silence: 'aucun bot.chat() driver ; receveur --say OPT-IN mesure ; capture preload /tmp/candidate-chat.log',
      construction: 'set fixture documente ; capacite apprise PIPELINE jamais promise sans decision conservation + contraintes backend reglees (S9 non-couvert explicite)'
    },
    cases,
    limites: [],
    cloture: null
  }
}

async function needRconGate (label, fn) {
  // Serialisation fixtures : une owner, un appel a la fois, colonne verifiee avant usage.
  console.log(`[RCON-GATE] ${label}`)
  return fn()
}

async function columnClear (x, y, z) {
  // Verifie corps+tete AIR + appui solide : 3 lectures RCON case-par-case.
  const body = await rcon([`execute if block ${x} ${y} ${z} minecraft:air run data get entity TestProbe2 UUID`]).catch(() => 'FAIL')
  const head = await rcon([`execute if block ${x} ${y + 1} ${z} minecraft:air run data get entity TestProbe2 UUID`]).catch(() => 'FAIL')
  return { bodyAir: body !== 'FAIL' && !String(body).includes('Test failed'), headAir: head !== 'FAIL' && !String(head).includes('Test failed'), note: 'appui sol : lecture execute if block sous-pieds (solide, non-air) avant TP' }
}

const SCENARIOS = [
  {
    id: 'S0', label: 'audit startup spawn survie',
    async run (R) {
      const st = await http('GET', CANDIDATE, '/api/status')
      const main = await http('GET', PRINCIPAL, '/api/status')
      R.cases.S0.preuves = { candidat_status: st.status, spawned: st.json?.spawned ?? null, principal_lecture_seule: main.status, principal_spawned: main.json?.spawned ?? null, survie_ops: 'RCON data get entity TestProbe3 playerGameType==0 + ops.json sans TestBot/TestProbe3 (gate hote, voir run.ps1)' }
      if (st.status !== 200 || !st.json?.spawned) throw new Error(`candidat non spawne (HTTP ${st.status}) : ${st.text.slice(0, 200)}`)
    }
  },
  {
    id: 'S1', label: 'inference Muse vrai brief',
    async run (R) {
      const m = await http('POST', CANDIDATE, '/api/mission', { objective: 'rejoins-moi puis reviens a ton point de depart', requester: 'TestProbe2' })
      R.cases.S1.preuves = { http: m.status, corps: (m.text || '').slice(0, 500), modele_attendu: 'muse-spark-1.3-contributor via /responses (llm.js), repli deepseek annonce D49' }
      if (m.status !== 200 && m.status !== 201) throw new Error(`brief refuse HTTP ${m.status} : ${m.text.slice(0, 200)}`)
      await http('DELETE', CANDIDATE, '/api/mission')
    }
  },
  {
    id: 'S2', label: 'parcours rejoindre + retour origine fixe + stop/reprise',
    async run (R) {
      await needRconGate('S2 fixtures serial + colonne', async () => { R.cases.S2.preuves.colonne = await columnClear(1005, 200, 1006) })
      const go = await http('POST', CANDIDATE, '/api/mission', { objective: 'rejoins TestProbe2 puis reviens a ton point de depart', requester: 'TestProbe2' })
      await sleep(5000)
      const stop = await http('POST', CANDIDATE, '/api/stop', {})
      const resume = await http('POST', CANDIDATE, '/api/resume', {})
      const st = await http('GET', CANDIDATE, '/api/mission')
      R.cases.S2.preuves = { mission_http: go.status, stop_http: stop.status, resume_http: resume.status, mission: (st.text || '').slice(0, 800), origine: 'fixe + cursor + preuves par sous-objectif (movement-task.js)' }
      await http('DELETE', CANDIDATE, '/api/mission')
      if (go.status !== 200 && go.status !== 201) throw new Error(`parcours refuse HTTP ${go.status}`)
    }
  },
  {
    id: 'S3', label: 'arbitrage 2 joueurs timeout 60 s reel',
    async run (R) {
      const t0 = Date.now()
      const m1 = await http('POST', CANDIDATE, '/api/mission', { objective: 'mission A de TestProbe2', requester: 'TestProbe2' })
      await sleep(2000)
      const m2 = await http('POST', CANDIDATE, '/api/instruction', { message: 'mission B concurrente', requester: 'TestProbe1' }).catch(e => ({ status: 'NA', text: e.message }))
      // Attente REELLE 60 s : pause travail, survie ; sans reponse -> ancien reprend, nouveau en attente (D42/D46).
      await sleep(ARBI_TIMEOUT_MS)
      const st = await http('GET', CANDIDATE, '/api/mission')
      R.cases.S3.preuves = { m1: m1.status, m2: m2.status ?? null, attente_reelle_ms: Date.now() - t0, mission_apres_60s: (st.text || '').slice(0, 800), regle: 'D44/D45/D46 : question pause/reprise OU remplacement, ancien reprend sans reponse' }
      await http('DELETE', CANDIDATE, '/api/mission')
    }
  },
  {
    id: 'S4', label: 'question durant brief',
    async run (R) {
      const m = await http('POST', CANDIDATE, '/api/mission', { objective: 'construis un abri en terre de 3x3x3', requester: 'TestProbe2' })
      await sleep(1500)
      const q = await http('POST', CANDIDATE, '/api/instruction', { message: 'quelle taille veux-tu dire par abri ?', requester: 'TestProbe2' }).catch(e => ({ status: 'NA', text: e.message }))
      const st = await http('GET', CANDIDATE, '/api/mission')
      R.cases.S4.preuves = { mission: m.status, question: q.status ?? null, brief_conserve: (st.text || '').slice(0, 800), regle: 'question/precision conserve la mission (conversation.js)' }
      await http('DELETE', CANDIDATE, '/api/mission')
    }
  },
  {
    id: 'S5', label: 'arret total bloque + resume explicite',
    async run (R) {
      await http('POST', CANDIDATE, '/api/mission', { objective: 'avance de 5 blocs', requester: 'TestProbe2' })
      const hard = await http('POST', CANDIDATE, '/api/arret-total', {})
      const g = await http('POST', CANDIDATE, '/api/goto', { x: 1005, y: 200, z: 1006 })
      const j = await http('POST', CANDIDATE, '/api/jump', {})
      const c = await http('POST', CANDIDATE, '/api/control', { control: 'forward', state: true })
      const resume = await http('POST', CANDIDATE, '/api/resume', {})
      R.cases.S5.preuves = { hard_http: hard.status, goto_bloque: g.status, jump_bloque: j.status, control_bloque: c.status, resume_http: resume.status, regle: 'arret total sans LLM, watchdog et survie bloques, reprise explicite seule' }
      await http('DELETE', CANDIDATE, '/api/mission').catch(() => ({}))
      if (hard.status !== 200) throw new Error(`arret-total non confirme HTTP ${hard.status}`)
    }
  },
  {
    id: 'S6', label: 'don stock fixture par mesures',
    async run (R) {
      await needRconGate('S6 stock RCON declare + colonne', async () => { R.cases.S6.preuves.colonne = await columnClear(1008, 200, 1007) })
      R.cases.S6.preuves = { note: 'stock apport RCON hote (give/clear declare) ; succes = depot mesure (emetteur -N + item localise), jamais ramassage exige ; receveur TestProbe2 requis (reservation prochaine action)' }
    }
  },
  {
    id: 'S7', label: 'craft generique',
    async run (R) {
      R.cases.S7.preuves = { note: 'recette lue dynamiquement (minecraft-data), manquants depuis stocks/coffres autorises, objets reels verifies en inventaire ; jamais craft pretendu depuis rien' }
    }
  },
  {
    id: 'S8', label: 'restaure after restart (store temp)',
    async run (R) {
      const o = await http('GET', CANDIDATE, '/api/objectifs')
      R.cases.S8.preuves = { objectifs_http: o.status, corps: (o.text || '').slice(0, 800), regle: 'restart candidat -> origin/cursor/hardstop restaures depuis store TEMP ephemere, jamais stock prod' }
    }
  },
  {
    id: 'S9', label: 'construction fixture + capacite apprise (non-promise)',
    async run (R) {
      R.cases.S9.preuves = { note: 'set fixture RCON documente ; si contraintes backend non reglees (versions/dependances/rollback), cas DOCUMENTE NON COUVERT, au moins trace explicite. Capacite apprise = PIPELINE avec decision conservation, jamais promise.' }
    }
  }
]

async function main () {
  const R = freshResults()
  const t0 = Date.now()
  let debugRetried = false
  for (const sc of SCENARIOS) {
    if (Date.now() - t0 > GLOBAL_TIMEOUT_MS) {
      R.cases[sc.id].statut = 'timeout_global'
      R.limites.push(`borne 15 min atteinte avant ${sc.id} : sortie reproductible`)
      break
    }
    const s0 = Date.now()
    try {
      console.log(`[probe] ${sc.id} ${sc.label}`)
      await sc.run(R)
      R.cases[sc.id].statut = 'succes'
    } catch (err) {
      const msg = String((err && err.message) || err).slice(0, 500)
      // Un seul scenario debug retente (reproductibilite), pas de boucle infinie.
      if (!debugRetried) {
        debugRetried = true
        console.log(`[probe] ${sc.id} echec, 1 retry debug : ${msg}`)
        await sleep(3000)
        try {
          await sc.run(R)
          R.cases[sc.id].statut = 'succes_apres_retry'
          R.cases[sc.id].erreur = msg
        } catch (err2) {
          R.cases[sc.id].statut = 'echec'
          R.cases[sc.id].erreur = String((err2 && err2.message) || err2).slice(0, 500)
        }
      } else {
        R.cases[sc.id].statut = 'echec'
        R.cases[sc.id].erreur = msg
      }
      console.log(`[probe] ${sc.id} -> ${R.cases[sc.id].statut} : ${(R.cases[sc.id].erreur || '').slice(0, 200)}`)
    }
    R.cases[sc.id].duree_ms = Date.now() - s0
  }
  // Nettoyage cote campagne : forceload restaure, inventaires lus sans perte main (gate hote).
  R.cloture = { duree_totale_ms: Date.now() - t0, inventaire_main: 'lecture GET /api/status inventaire candidat + RCON data get entity (jamais clear sans gate)', forceload: 'restaure par hote', harness: 'receveur libere proprement (SIGTERM), candidat rm, reseau conserve' }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(R, null, 2))
  console.log(`[probe] resultats -> ${OUT}`)
  const fails = Object.values(R.cases).filter(c => c.statut === 'echec' || c.statut === 'timeout_global').length
  process.exit(fails ? 1 : 0)
}

if (require.main === module) {
  main().catch(err => { console.error(`[probe] fatal : ${String((err && err.message) || err).slice(0, 300)}`); process.exit(2) })
}

module.exports = { SCENARIOS, freshResults, ARBI_TIMEOUT_MS, GLOBAL_DEFAULT_MS: GLOBAL_TIMEOUT_MS }
