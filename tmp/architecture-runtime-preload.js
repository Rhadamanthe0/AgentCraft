'use strict'
// tmp/architecture-runtime-preload.js — PREPARATION + CAMPAGNE (v2, triple verrou).
//
// Role : faire tourner le VRAI bot/prod (bot/index.js + mission + API, code fige)
// dans un conteneur jetable candidat, SANS remplacer prod TestBot, avec silence
// serveur absolu mais actions observables en logs.
//
// CAUSE PROUVEE (campagne 2026-09-24, conteneur node --check + test empirique) :
// `bot.chat` vaut `undefined` au retour de mineflayer.createBot ; le plugin chat
// de mineflayer assigne `bot.chat = realSend` PLUS TARD (async, au login).
// La v1 patchait trop tot et se faisait ECARSER : le candidat a parle en public
// (~1 msg/s en boucle avec TestBot, preuve log serveur Paper). D'ou triple verrou :
//   1. patch `bot.chat` a la creation (capture locale immediate) ;
//   2. RE-patch sur evenements `login` + `spawn` + timers (2 s / 6 s), car le
//      plugin ecrase la propriete apres coup ;
//   3. filet catch-all : `bot._client.write` intercepte les paquets serveur
//      `chat` / `chat_command` et les DETRUIT (capture locale, jamais envoyes).
// Derive de tmp/probe-bot.js (v1) : meme connexion offline 26.1, meme silence,
// memes usernames reserves (jamais 2x TestBot : TestProbe3 seul autorise).
// Ne connecte RIEN seul : il attend index.js.
//
// Usage candidat : NODE_OPTIONS="--require /app/architecture-runtime-preload.js"
//   node /app/index.js avec BOT_USERNAME=TestProbe3, API_PORT=3000 (mappe hote 3001).

const fs = require('node:fs')

const CHAT_LOG = process.env.CANDIDATE_CHAT_LOG || '/tmp/candidate-chat.log'
const EXPECTED = process.env.BOT_USERNAME || 'TestProbe3'
const FORBIDDEN = ['testbot', 'rhadamanthe0', 'probebot', 'walkerbot']
const DROP_PACKETS = new Set(['chat', 'chat_command'])

function logLine (tag, msg) {
  const line = `[candidate-preload] ${tag} ${msg}`
  try { console.log(line) } catch (_) { /* ignore */ }
  if (tag === 'chat-capture' || tag === 'chat-drop') {
    try { fs.appendFileSync(CHAT_LOG, `${new Date().toISOString()} [${tag}] ${msg}\n`) } catch (_) { /* ignore */ }
  }
}

let mineflayer
try {
  mineflayer = require('mineflayer')
} catch (err) {
  console.error(`[candidate-preload] mineflayer introuvable : ${err.message}`)
  throw err
}

if (FORBIDDEN.includes(String(EXPECTED).toLowerCase())) {
  console.error(`[candidate-preload] BOT_USERNAME interdit : ${EXPECTED} (candidat = TestProbe3, jamais TestBot)`)
  process.exit(2)
}

const origCreateBot = mineflayer.createBot.bind(mineflayer)

// Remplace bot.chat par une capture locale. A REAPPLIQUER car le plugin chat
// l'ecrase au login (cause prouvee v1).
function patchChat (bot, why) {
  const captured = bot.capturedChat || []
  bot.capturedChat = captured
  bot.chat = function (message) {
    const text = String(message || '').slice(0, 200)
    captured.push({ at: new Date().toISOString(), text, via: `chat:${why}` })
    logLine('chat-capture', `CAPTURE (non envoye) [${why}] : ${text}`)
    return undefined
  }
}

// Filet catch-all : detruit les paquets chat sortants au niveau transport.
// Reentrance gardee par drapeau (le plugin ne remplace pas _client.write,
// mais on reverifie a chaque repatch).
function patchTransport (bot, why) {
  const client = bot._client
  if (!client || typeof client.write !== 'function') return false
  if (client.__silenceWrapped) return true
  const origWrite = client.write.bind(client)
  client.write = function (name, params) {
    if (DROP_PACKETS.has(String(name))) {
      const text = String((params && (params.message ?? params.command)) || '').slice(0, 200)
      const captured = bot.capturedChat || (bot.capturedChat = [])
      captured.push({ at: new Date().toISOString(), text, via: `drop:${why}:${name}` })
      logLine('chat-drop', `PAQUET DETRUIT [${why}] ${name} : ${text}`)
      return undefined
    }
    return origWrite(name, params)
  }
  client.__silenceWrapped = true
  return true
}

function silence (bot, why) {
  try { patchChat(bot, why) } catch (err) { logLine('error', `patchChat ${why} : ${String(err.message).slice(0, 120)}`) }
  try {
    if (!patchTransport(bot, why)) {
      // _client pas encore pret : reessaie court (creation synchrone du client
      // normalement immediate, mais jamais de pari).
      setTimeout(() => { try { patchTransport(bot, `${why}+retry`) } catch (_) {} }, 1500).unref?.()
    }
  } catch (err) { logLine('error', `patchTransport ${why} : ${String(err.message).slice(0, 120)}`) }
}

mineflayer.createBot = function (opts = {}) {
  const username = String(opts.username || EXPECTED)
  if (FORBIDDEN.includes(username.toLowerCase())) {
    throw new Error(`[candidate-preload] username interdit : ${username}`)
  }
  if (username !== 'TestProbe3') {
    logLine('guard', `username candidat force a TestProbe3 (demande ${username})`)
    opts = { ...opts, username: 'TestProbe3' }
  }
  // Meme transport que tmp/probe-bot.js : offline, 26.1.
  opts = { host: opts.host || process.env.MC_HOST || 'minecraft', port: opts.port || Number(process.env.MC_PORT || 25565), auth: 'offline', version: opts.version || process.env.MC_VERSION || '26.1', ...opts, username: 'TestProbe3' }
  const bot = origCreateBot(opts)

  silence(bot, 'create')
  try { bot.on('login', () => silence(bot, 'login')) } catch (_) {}
  try { bot.once('spawn', () => silence(bot, 'spawn')) } catch (_) {}
  try { bot.on('spawn', () => silence(bot, 'spawn')) } catch (_) {}
  // Ceinture : le plugin peut s'injecter avec retard ; on repatche large.
  try { setTimeout(() => silence(bot, 't+2s'), 2000).unref?.() } catch (_) {}
  try { setTimeout(() => silence(bot, 't+6s'), 6000).unref?.() } catch (_) {}

  bot.once('spawn', () => {
    try {
      const p = bot.entity.position
      logLine('spawn', `TestProbe3 spawn ${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)} chat=${typeof bot.chat} wrapped=${Boolean(bot._client?.__silenceWrapped)}`)
    } catch (_) { logLine('spawn', 'spawn (position illisible)') }
  })
  bot.on('kicked', reason => logLine('kicked', String(reason).slice(0, 200)))
  bot.on('error', err => logLine('error', String((err && err.message) || err).slice(0, 200)))
  bot.on('end', reason => logLine('end', String(reason || '').slice(0, 200)))
  return bot
}

// Exposition lecture seule pour la sonde (require cache partage dans le conteneur).
try {
  globalThis.__candidatePreload = { chatLog: CHAT_LOG, username: 'TestProbe3', version: 2, at: new Date().toISOString() }
} catch (_) { /* ignore */ }

logLine('ready', `preload v2 actif (candidat TestProbe3, triple verrou silence, capture vers ${CHAT_LOG})`)
