// tmp/probe-bot.js — template versionne du harness multi-bots (v1).
//
// Usage (depuis l hote, PowerShell) :
//   docker compose cp tmp/probe-bot.js bot:/tmp/h1.js
//   docker compose exec -T -d -e NODE_PATH=/app/node_modules bot node /tmp/h1.js TestProbe1
//   docker compose exec -T -d -e NODE_PATH=/app/node_modules bot node /tmp/h2.js TestProbe2
// Sous Git Bash, prefixer chaque commande Docker par MSYS_NO_PATHCONV=1.
//
// Usage (argv) :
//   node probe-bot.js <Username> [--host minecraft] [--port 25565]
//     [--version 26.1] [--idle-secs 60] [--tick-secs 10] [--say ...]
//
// Regles (voir CLAUDE.md « Harness multi-bots ») :
// - usernames distincts : TestProbe1/2/3. JAMAIS TestBot, Rhadamanthe0,
//   ProbeBot/WalkerBot (pollution ops.json). Jamais ops, survie.
// - SILENCIEUX par defaut : aucun bot.chat(). --say est opt-in explicite,
//   a n utiliser qu avec un compteur recentChat en tete (max 8 cote bot
//   principal) — en pratique, ne jamais s en servir pendant une preuve
//   de non-pollution.
// - TP rcon = harness uniquement, jamais une capacite du bot.
// - Arret propre : SIGINT/SIGTERM -> bot.quit(), un seul process par fichier
//   /tmp/hN.js, kill par `pkill -f /tmp/hN.js` cote conteneur bot.
'use strict'

const mineflayer = require('mineflayer')

function arg (name, defaut) {
  const i = process.argv.indexOf(name)
  if (i === -1 || i + 1 >= process.argv.length) return defaut
  return process.argv[i + 1]
}

function has (name) {
  return process.argv.includes(name)
}

const username = process.argv[2]
const host = arg('--host', 'minecraft')
const port = Number(arg('--port', '25565'))
const version = arg('--version', '26.1')
const idleSecs = Number(arg('--idle-secs', '60'))
const tickSecs = Number(arg('--tick-secs', '10'))
const sayText = has('--say') ? arg('--say', '') : ''

const FORBIDDEN = ['testbot', 'rhadamanthe0', 'probebot', 'walkerbot']
if (!username || username.startsWith('-')) {
  console.error('usage: node probe-bot.js <Username> [--host h] [--port p] [--version 26.1] [--idle-secs 60] [--tick-secs 10] [--say ...]')
  process.exit(2)
}
if (FORBIDDEN.includes(String(username).toLowerCase())) {
  console.error(`[harness] username interdit : ${username} (ne jamais reutiliser TestBot/Rhadamanthe0/ProbeBot/WalkerBot)`)
  process.exit(2)
}

console.log(`[harness] ${username} -> ${host}:${port} version=${version} idle=${idleSecs}s (silencieux${sayText ? ', --say OPT-IN' : ''})`)

const bot = mineflayer.createBot({ host, port, username, auth: 'offline', version })

let done = false
function stop (code, why) {
  if (done) return
  done = true
  console.log(`[harness] ${username} arret propre (${why})`)
  try { bot.quit(why || 'harness done') } catch (_) { /* ignore */ }
  setTimeout(() => process.exit(code || 0), 500).unref()
}
process.on('SIGINT', () => stop(0, 'SIGINT'))
process.on('SIGTERM', () => stop(0, 'SIGTERM'))

bot.once('spawn', () => {
  const p = bot.entity.position
  console.log(`[harness] ${username} spawn ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}`)
  if (sayText) {
    // OPT-IN uniquement : chaque phrase pollue recentChat (max 8) du bot
    // principal via chat_recent. Ne pas utiliser pendant une preuve.
    console.log(`[harness] ${username} --say OPT-IN : envoi explicite`)
    try { bot.chat(String(sayText).slice(0, 120)) } catch (err) { console.error(`[harness] chat refuse : ${err.message}`) }
  }
  const t0 = Date.now()
  const tick = setInterval(() => {
    if (done) { clearInterval(tick); return }
    try {
      const q = bot.entity.position
      console.log(`[harness] ${username} t+${Math.round((Date.now() - t0) / 1000)}s ${q.x.toFixed(1)} ${q.y.toFixed(1)} ${q.z.toFixed(1)}`)
    } catch (_) { /* ignore */ }
    if (Date.now() - t0 > idleSecs * 1000) { clearInterval(tick); stop(0, 'idle ecoule') }
  }, Math.max(2, tickSecs) * 1000)
})

bot.on('kicked', reason => { console.log(`[harness] ${username} kicked : ${reason}`); stop(1, 'kicked') })
bot.on('error', err => console.error(`[harness] ${username} error : ${err.message}`))
bot.on('end', reason => { console.log(`[harness] ${username} end : ${reason}`); stop(0, 'end') })

// Les scenarios de verification reutilisent cette connexion et ce cycle de vie.
module.exports = { bot, stop }
