'use strict'

// Several silent probe players in ONE node process (CI bench only).
//
//   node probes.js TestProbe2 TestProbe3 ... [--host minecraft] [--port 25565]
//     [--version 26.1] [--idle-secs 1700]
//
// Same rules as tmp/probe-bot.js: silent (never bot.chat), never op, offline
// auth, clean quit on SIGTERM/SIGINT or when --idle-secs elapses. All bots share
// one minecraft-data registry instead of loading it once per process.
// A probe that is kicked or disconnected is logged and never reconnected: the
// state file then marks it dead and `node multi-bot.js health` fails.
const fs = require('node:fs')
const mineflayer = require('mineflayer')

const STATE_FILE = process.env.MULTI_BOT_STATE || '/tmp/multi-bot-state.json'
const FORBIDDEN = ['testbot', 'rhadamanthe0', 'probebot', 'walkerbot']

function arg (name, fallback) {
  const i = process.argv.indexOf(name)
  return i === -1 || i + 1 >= process.argv.length ? fallback : process.argv[i + 1]
}

const options = new Set(['--host', '--port', '--version', '--idle-secs'])
const usernames = process.argv.slice(2).filter((value, i, all) => !value.startsWith('--') && !options.has(all[i - 1]))
const host = arg('--host', 'minecraft')
const port = Number(arg('--port', '25565'))
const version = arg('--version', '26.1')
const idleSecs = Number(arg('--idle-secs', '1700'))

if (!usernames.length) {
  console.error('usage: node probes.js <Username>... [--host h] [--port p] [--version 26.1] [--idle-secs 1700]')
  process.exit(2)
}
for (const name of usernames) {
  if (FORBIDDEN.includes(name.toLowerCase())) {
    console.error(`[probes] username interdit : ${name}`)
    process.exit(2)
  }
}

const probes = new Map()
let stopping = false

function writeState () {
  const state = {
    role: 'probes',
    stopping,
    children: usernames.map(name => ({ name, port: null, pending: !probes.has(name), alive: probes.get(name)?.alive ?? false }))
  }
  try {
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state))
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE)
  } catch (error) {
    console.error(`[probes] state file: ${error.message}`)
  }
}

console.log(`[probes] ${usernames.length} probes -> ${host}:${port} version=${version} idle=${idleSecs}s (silencieux)`)
// A login refused before the first spawn (e.g. Paper's per-IP connection
// throttle, all probes sharing one IP) is retried a few times, logged. Once a
// probe has spawned, losing it is final.
const LOGIN_RETRIES = 4
const LOGIN_RETRY_MS = 4500
const STAGGER_MS = Number(process.env.CONNECT_STAGGER_MS ?? 250)

function connect (name, attempt) {
  if (stopping) return
  const bot = mineflayer.createBot({ host, port, username: name, auth: 'offline', version })
  const entry = { bot, alive: true, spawned: false }
  probes.set(name, entry)
  const log = message => console.log(`[${name}] ${message}`)
  bot.once('spawn', () => {
    entry.spawned = true
    const p = bot.entity.position
    log(`spawn ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}`)
  })
  bot.on('kicked', reason => log(`kicked : ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`))
  bot.on('error', error => console.error(`[${name}] error : ${error.message}`))
  bot.on('end', reason => {
    if (!entry.spawned && !stopping && attempt < LOGIN_RETRIES) {
      log(`login failed (${reason}), retry ${attempt + 1}/${LOGIN_RETRIES} in ${LOGIN_RETRY_MS} ms`)
      setTimeout(() => connect(name, attempt + 1), LOGIN_RETRY_MS)
      return
    }
    entry.alive = false
    log(`end : ${reason}${stopping ? '' : ' - NOT reconnected'}`)
    writeState()
    if (probes.size === usernames.length && [...probes.values()].every(p => !p.alive)) process.exit(stopping ? 0 : 1)
  })
  writeState()
}

usernames.forEach((name, i) => setTimeout(() => connect(name, 0), i * STAGGER_MS))
writeState()

function stop (why) {
  if (stopping) return
  stopping = true
  writeState()
  console.log(`[probes] arret propre (${why})`)
  for (const { bot, alive } of probes.values()) {
    if (alive) try { bot.quit(why) } catch (_) { /* ignore */ }
  }
  setTimeout(() => process.exit(0), 1500).unref()
}
process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))
setTimeout(() => stop('idle ecoule'), idleSecs * 1000).unref()
