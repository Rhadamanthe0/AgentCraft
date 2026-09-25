'use strict'

// Several bot processes in one container (CI bench only).
//
//   node multi-bot.js bots     POOL_SIZE real bots: `node index.js` in /work/bot,
//                              TreeBotN on API_PORT 3000+N, state under /data/botN/
//   node multi-bot.js health   healthcheck of the launcher (or of ci/probes.js,
//                              which writes the same state file) in this container
//
// Every child line is prefixed with its username. A child that exits is logged
// and never restarted: the healthcheck then fails and the bench sees it.
// SIGTERM/SIGINT are forwarded to every child.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')

// Paths are fixed by ci/Dockerfile; overridable only to test the launcher offline.
const STATE_FILE = process.env.MULTI_BOT_STATE || '/tmp/multi-bot-state.json'
const BOT_DIR = process.env.MULTI_BOT_DIR || '/work/bot'
const DATA_ROOT = process.env.MULTI_BOT_DATA || '/data'
const POOL_SIZE = Number(process.env.POOL_SIZE || 16)
const API_BASE_PORT = Number(process.env.API_BASE_PORT || 3000)
// V8 heap cap per real bot (MB): 16 bots share one container and its mem_limit.
const BOT_MAX_OLD_SPACE_MB = Number(process.env.BOT_MAX_OLD_SPACE_MB || 256)
const STOP_GRACE_MS = 8000
// Delay between two child starts: spreads the module loading CPU burst.
const CONNECT_STAGGER_MS = Number(process.env.CONNECT_STAGGER_MS ?? 1000)

function botSpecs () {
  const specs = []
  for (let i = 1; i <= POOL_SIZE; i++) {
    const name = `TreeBot${i}`
    const dir = `${DATA_ROOT}/bot${i}`
    fs.mkdirSync(dir, { recursive: true })
    specs.push({
      name,
      port: API_BASE_PORT + i,
      cwd: BOT_DIR,
      argv: ['index.js'],
      env: {
        BOT_USERNAME: name,
        API_PORT: String(API_BASE_PORT + i),
        PLANNER_SESSION_ID: `minecraft-bot-ci-${name}`,
        MEMORY_FILE: `${dir}/memory.json`,
        ACTIONS_DOC_FILE: `${dir}/actions-doc.json`,
        OBJECTIVES_FILE: `${dir}/objectives.json`,
        OBJECTIVES_EVENTS_FILE: `${dir}/objectives-events.jsonl`,
        LOG_FILE: `${dir}/bot.log`,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=${BOT_MAX_OLD_SPACE_MB}`.trim()
      }
    })
  }
  return specs
}

function writeState (state) {
  const tmp = STATE_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(state))
  fs.renameSync(tmp, STATE_FILE)
}

function launch (role) {
  const specs = botSpecs()
  const children = new Map()
  let stopping = false
  // A child not started yet is `pending` (healthcheck waits), a started one
  // that exited is dead (healthcheck fails for good).
  const state = () => ({
    role,
    stopping,
    children: specs.map(s => {
      const entry = children.get(s.name)
      return { name: s.name, port: s.port || null, pending: !entry, alive: entry ? entry.alive : false }
    })
  })
  const log = message => console.log(`[multi-bot] ${message}`)

  const start = spec => {
    if (stopping) return
    const child = spawn(process.execPath, spec.argv, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const entry = { child, alive: true }
    children.set(spec.name, entry)
    for (const [stream, out] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      readline.createInterface({ input: stream }).on('line', line => out.write(`[${spec.name}] ${line}\n`))
    }
    child.on('error', error => log(`${spec.name} failed to start: ${error.message}`))
    child.on('exit', (code, signal) => {
      entry.alive = false
      // Never restarted: a dead bot must show up as a failed healthcheck.
      log(`${spec.name} exited (code ${code}, signal ${signal})${stopping ? '' : ' - NOT restarted'}`)
      writeState(state())
      if (children.size === specs.length && [...children.values()].every(c => !c.alive)) process.exit(stopping ? 0 : 1)
    })
    log(`${spec.name} started${spec.port ? ' on port ' + spec.port : ''}`)
    writeState(state())
  }
  // All children share this container's IP. Paper refuses a second login from
  // one IP within bukkit.yml `connection-throttle` (4000 ms by default): the
  // bench server disables it (ci/paper/bukkit.yml), and a throttled bot would
  // still get in through bot/index.js's own reconnect (3 s).
  specs.forEach((spec, i) => setTimeout(() => start(spec), i * CONNECT_STAGGER_MS))
  writeState(state())
  log(`${role}: ${specs.length} processes, one every ${CONNECT_STAGGER_MS} ms`)

  const shutdown = signal => {
    if (stopping) return
    stopping = true
    writeState(state())
    log(`${signal} received, stopping ${children.size} processes`)
    for (const { child, alive } of children.values()) if (alive) child.kill('SIGTERM')
    if (![...children.values()].some(c => c.alive)) process.exit(0)
    setTimeout(() => {
      for (const { child, alive } of children.values()) if (alive) child.kill('SIGKILL')
      process.exit(0)
    }, STOP_GRACE_MS).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

async function health () {
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  const dead = state.children.filter(c => !c.alive && !c.pending).map(c => c.name)
  if (state.stopping) throw new Error('stopping')
  if (dead.length) throw new Error('dead: ' + dead.join(', '))
  const pending = state.children.filter(c => c.pending).map(c => c.name)
  if (pending.length) throw new Error('not started yet: ' + pending.join(', '))
  if (state.role !== 'bots') return
  // Every real bot must answer its own API and be in the world.
  const results = await Promise.all(state.children.map(async c => {
    try {
      const response = await fetch(`http://127.0.0.1:${c.port}/api/status`, { signal: AbortSignal.timeout(2500) })
      return (await response.json()).spawned ? null : c.name
    } catch {
      return c.name
    }
  }))
  const waiting = results.filter(Boolean)
  if (waiting.length) throw new Error('not spawned: ' + waiting.join(', '))
}

const role = process.argv[2]
if (role === 'bots') {
  launch(role)
} else if (role === 'health') {
  health().then(() => process.exit(0), error => {
    console.error(error.message)
    process.exit(1)
  })
} else {
  console.error(`usage: node ${path.basename(__filename)} bots|health`)
  process.exit(2)
}
