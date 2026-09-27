'use strict'

// Several bot processes in one container (CI bench only).
//
//   node multi-bot.js bots     real bots: `node index.js` in /work/bot, TreeBotN
//                              on API_PORT 3000+N, state under /data/botN/.
//                              POOL_SIZE are started at once (0 in the bench);
//                              CONTROL_PORT serves the pool of ci/pool.py:
//                                GET  /workers              states
//                                POST /workers/N/start      start TreeBotN
//                                POST /workers/N/stop       retire it (voluntary)
//   node multi-bot.js health   healthcheck of the launcher (or of ci/probes.js,
//                              which writes the same state file) in this container
//
// States: starting (process up, not in the world yet), ready, retiring,
// retired (stopped on request), dead (exited on its own). Every child line is
// prefixed with its username. A dead child is logged and never restarted: the
// healthcheck then fails and the bench sees it. SIGTERM/SIGINT are forwarded.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const readline = require('node:readline')

// Paths are fixed by ci/Dockerfile; overridable only to test the launcher offline.
const STATE_FILE = process.env.MULTI_BOT_STATE || '/tmp/multi-bot-state.json'
const BOT_DIR = process.env.MULTI_BOT_DIR || '/work/bot'
const DATA_ROOT = process.env.MULTI_BOT_DATA || '/data'
const POOL_SIZE = Number(process.env.POOL_SIZE || 0)
const POOL_MAX = Number(process.env.POOL_MAX || 32)
const CONTROL_PORT = Number(process.env.CONTROL_PORT || 0)
const API_BASE_PORT = Number(process.env.API_BASE_PORT || 3000)
// V8 heap cap per real bot (MB): 16 bots share one container and its mem_limit.
const BOT_MAX_OLD_SPACE_MB = Number(process.env.BOT_MAX_OLD_SPACE_MB || 256)
const STOP_GRACE_MS = 8000
// Delay between two child starts: spreads the module loading CPU burst.
const CONNECT_STAGGER_MS = Number(process.env.CONNECT_STAGGER_MS ?? 1000)

function botSpec (i) {
  const name = `TreeBot${i}`
  const dir = `${DATA_ROOT}/bot${i}`
  fs.mkdirSync(dir, { recursive: true })
  return {
    index: i,
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
  }
}

function writeState (state) {
  const tmp = STATE_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(state))
  fs.renameSync(tmp, STATE_FILE)
}

function launch (role) {
  const children = new Map() // index -> { spec, child, state, since }
  let stopping = false
  let lastStart = -Infinity
  const startQueue = []
  const state = () => ({
    role,
    stopping,
    children: [...children.values()].map(c => ({
      name: c.spec.name, index: c.spec.index, port: c.spec.port, state: c.state,
      // Older readers (healthcheck): pending = not started, alive = process up.
      pending: false, alive: ['starting', 'ready', 'retiring'].includes(c.state),
      dead: c.state === 'dead', sinceMs: Date.now() - c.since, exit: c.exit || null
    }))
  })
  const log = message => console.log(`[multi-bot] ${message}`)
  const save = () => writeState(state())
  const setState = (entry, value) => { entry.state = value; entry.since = Date.now(); save() }

  const spawnChild = entry => {
    const { spec } = entry
    const child = spawn(process.execPath, spec.argv, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    entry.child = child
    for (const [stream, out] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      readline.createInterface({ input: stream }).on('line', line => out.write(`[${spec.name}] ${line}\n`))
    }
    child.on('error', error => log(`${spec.name} failed to start: ${error.message}`))
    child.on('exit', (code, signal) => {
      entry.exit = { code, signal }
      const voluntary = stopping || entry.state === 'retiring'
      // Never restarted: a dead bot must show up as a failed healthcheck.
      log(`${spec.name} exited (code ${code}, signal ${signal})${voluntary ? '' : ' - NOT restarted'}`)
      setState(entry, voluntary ? 'retired' : 'dead')
      if (stopping && ![...children.values()].some(c => c.state === 'retiring' || c.state === 'ready' || c.state === 'starting')) process.exit(0)
    })
    log(`${spec.name} started on port ${spec.port}`)
    setState(entry, 'starting')
    watchReady(entry)
  }
  // `ready` once the bot answers its own API and is in the world.
  const watchReady = entry => {
    const tick = async () => {
      if (entry.state !== 'starting') return
      try {
        const response = await fetch(`http://127.0.0.1:${entry.spec.port}/api/status`, { signal: AbortSignal.timeout(2000) })
        if ((await response.json()).spawned) return setState(entry, 'ready')
      } catch { /* not listening yet */ }
      setTimeout(tick, 500)
    }
    setTimeout(tick, 500)
  }
  // All children share this container's IP. Paper refuses a second login from
  // one IP within bukkit.yml `connection-throttle` (4000 ms by default): the
  // bench server disables it (ci/paper/bukkit.yml), and a throttled bot would
  // still get in through bot/index.js's own reconnect (3 s). Starts are still
  // spaced by CONNECT_STAGGER_MS to spread the module-loading CPU burst.
  const pump = () => {
    if (!startQueue.length || stopping) return
    const wait = lastStart + CONNECT_STAGGER_MS - Date.now()
    if (wait > 0) return void setTimeout(pump, wait)
    lastStart = Date.now()
    spawnChild(startQueue.shift())
    if (startQueue.length) setTimeout(pump, CONNECT_STAGGER_MS)
  }
  const start = index => {
    if (!Number.isInteger(index) || index < 1 || index > POOL_MAX) return { ok: false, error: 'index hors pool' }
    const current = children.get(index)
    if (current && ['starting', 'ready', 'retiring', 'queued'].includes(current.state)) return { ok: false, error: `${current.spec.name} ${current.state}` }
    if (current?.state === 'dead') return { ok: false, error: `${current.spec.name} mort : jamais relance` }
    const entry = { spec: botSpec(index), state: 'queued', since: Date.now() }
    children.set(index, entry)
    startQueue.push(entry)
    save()
    pump()
    return { ok: true, name: entry.spec.name }
  }
  const stop = index => {
    const entry = children.get(index)
    if (!entry || !['starting', 'ready', 'queued'].includes(entry.state)) return { ok: false, error: 'rien a retirer' }
    if (entry.state === 'queued') {
      startQueue.splice(startQueue.indexOf(entry), 1)
      setState(entry, 'retired')
      return { ok: true }
    }
    setState(entry, 'retiring')
    entry.child.kill('SIGTERM')
    setTimeout(() => { if (entry.state === 'retiring') entry.child.kill('SIGKILL') }, STOP_GRACE_MS).unref()
    return { ok: true }
  }

  for (let i = 1; i <= POOL_SIZE; i++) start(i)
  save()
  log(`${role}: ${POOL_SIZE} processes at start, up to ${POOL_MAX}, one every ${CONNECT_STAGGER_MS} ms` +
      (CONTROL_PORT ? `, control on ${CONTROL_PORT}` : ''))

  if (CONTROL_PORT) {
    http.createServer((req, res) => {
      const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
      const match = /^\/workers(?:\/(\d+)\/(start|stop))?$/.exec(req.url)
      if (!match) return reply(404, { ok: false })
      if (!match[1]) return req.method === 'GET' ? reply(200, state()) : reply(405, { ok: false })
      if (req.method !== 'POST') return reply(405, { ok: false })
      const result = match[2] === 'start' ? start(Number(match[1])) : stop(Number(match[1]))
      reply(result.ok ? 200 : 409, result)
    }).listen(CONTROL_PORT, '0.0.0.0')
  }

  const shutdown = signal => {
    if (stopping) return
    stopping = true
    startQueue.length = 0
    save()
    const alive = [...children.values()].filter(c => ['starting', 'ready', 'retiring'].includes(c.state))
    log(`${signal} received, stopping ${alive.length} processes`)
    for (const entry of alive) entry.child.kill('SIGTERM')
    if (!alive.length) process.exit(0)
    setTimeout(() => {
      for (const entry of alive) if (entry.child.exitCode === null) entry.child.kill('SIGKILL')
      process.exit(0)
    }, STOP_GRACE_MS).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

async function health () {
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  if (state.stopping) throw new Error('stopping')
  // Retired on request is fine; a child that exited on its own is not.
  const dead = state.children.filter(c => c.dead || (c.state === undefined && !c.alive && !c.pending)).map(c => c.name)
  if (dead.length) throw new Error('dead: ' + dead.join(', '))
  const pending = state.children.filter(c => c.pending).map(c => c.name)
  if (pending.length) throw new Error('not started yet: ' + pending.join(', '))
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
