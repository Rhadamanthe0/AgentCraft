'use strict'
// Tests backend lifecycle Docker isole : `kernel/docker-backend.js`.
//
// Conventions : node:test + assert/strict, CommonJS, zero dependance.
// Ecriture EXCLUSIVE : seuls kernel/docker-backend.js et ce test existent.
// Aucun conteneur reel (request + httpProbe mocks), aucune connexion bot,
// aucun RCON, aucun require bot/*, supervisor/* (contrat core re-decrit en
// local, pas importe). Fixtures en memoire uniquement.
//
// Preuves : config create FORCEE (nonroot/caps/readonly/tmpfs/mounts/env),
// imageResolver digest immuable, propriete owner (forgery refusee, service=bot
// seul insuffisant, pas de list/proxy), sante via IP trusted (pas d URL
// caller, version mismatch/hang/huge), stop grace->kill + waitExit preuve
// Running==false (timeout unknown, jamais de liveness factice), logs bornes
// redacted.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createDockerBackend, ALLOWED_ENV } = require('../kernel/docker-backend')

const FAKE_ID = '0123456789abcdef'.repeat(4)
assert.equal(FAKE_ID.length, 64)
const OTHER_ID = 'fedcba9876543210'.repeat(4)
const VERSION = 'v12'
const DIGEST = 'manifest-digest-v12'
const IMAGE = 'registry.local/bot@sha256:' + 'ab'.repeat(32)
const PROJECT = 'proj-test'
const NETWORK = 'proj-test_net'
const VOLUME = 'bot-data-test'
const INSTANCE = 'owner-1'

function goodLabels (over) {
  return {
    'kernel.managed': 'true',
    'kernel.project': PROJECT,
    'kernel.version': VERSION,
    'kernel.manifest': DIGEST,
    'kernel.instance': INSTANCE,
    ...(over || {})
  }
}

function goodInspect (over) {
  return {
    Id: FAKE_ID,
    Name: '/proj-test-kernel-v12-abc',
    Config: { Labels: goodLabels((over && over.labels) || null), Image: IMAGE },
    State: { Running: true, ExitCode: 0 },
    NetworkSettings: { Networks: { [NETWORK]: { IPAddress: '172.18.0.5' } } },
    ...(over || {})
  }
}

// Mock docker Engine : file d appels, reponses pilotables par test.
function makeDockerMock (handlers) {
  const calls = []
  const state = { inspectCalls: 0, ...(handlers && handlers.state) }
  async function request (args) {
    calls.push({ method: args.method, path: args.path, body: args.body })
    const path = args.path
    if (args.method === 'POST' && path.startsWith('/containers/create')) {
      if (handlers && handlers.onCreate) handlers.onCreate(args)
      return { status: 201, body: { Id: FAKE_ID } }
    }
    if (args.method === 'POST' && path === `/containers/${FAKE_ID}/start`) {
      return { status: 204, body: null }
    }
    if (args.method === 'GET' && path === `/containers/${FAKE_ID}/json`) {
      state.inspectCalls += 1
      if (handlers && typeof handlers.inspect === 'function') {
        return { status: 200, body: handlers.inspect(state.inspectCalls) }
      }
      return { status: 200, body: goodInspect() }
    }
    if (args.method === 'POST' && path.startsWith(`/containers/${FAKE_ID}/stop`)) {
      if (handlers && handlers.onStop) handlers.onStop(args)
      return { status: 204, body: null }
    }
    if (args.method === 'POST' && path.startsWith(`/containers/${FAKE_ID}/kill`)) {
      if (handlers && handlers.onKill) handlers.onKill(args)
      return { status: 204, body: null }
    }
    if (args.method === 'DELETE' && path.startsWith(`/containers/${FAKE_ID}`)) {
      return { status: 204, body: null }
    }
    if (args.method === 'GET' && path.startsWith(`/containers/${FAKE_ID}/logs`)) {
      if (handlers && handlers.logs != null) {
        return { status: 200, body: typeof handlers.logs === 'function' ? handlers.logs() : handlers.logs }
      }
      return { status: 200, body: 'ligne-ok-1\nligne-ok-2\n' }
    }
    throw Object.assign(new Error(`route mock inattendue : ${args.method} ${path}`), { code: 'mock-route' })
  }
  return { calls, request, state }
}

function baseOpts (dockerMock, over) {
  return {
    request: dockerMock.request,
    imageResolver: async (d) => ({ image: IMAGE, manifestDigest: d.manifestDigest }),
    project: PROJECT,
    networkName: NETWORK,
    dataVolume: VOLUME,
    instanceId: INSTANCE,
    workerEnv: {},
    probe: { port: 3000, path: '/api/status' },
    httpProbe: async () => ({ version: VERSION, spawned: true }),
    stopGraceMs: 200,
    stopWaitMs: 800,
    opTimeoutMs: 1000,
    probeTimeoutMs: 100,
    responseMaxBytes: 8192,
    logBytesMax: 8192,
    ...(over || {})
  }
}

const DESCRIPTOR = Object.freeze({ version: VERSION, manifestDigest: DIGEST })

test('contrat core : methodes + sante pre-start compatible responsiveEnough', async () => {
  const mock = makeDockerMock()
  const backend = createDockerBackend(baseOpts(mock))
  for (const name of ['start', 'stop', 'waitExit', 'checkHealth', 'getExit', 'isChildAlive', 'destroy', 'getLogs']) {
    assert.equal(typeof backend[name], 'function', `backend.${name} requis`)
  }
  assert.equal(backend.getExit(), null)
  assert.equal(backend.isChildAlive(), false)
  assert.equal(backend.getPid(), null)
  const health = await backend.checkHealth()
  assert.equal(health.alive, false)
  assert.equal(health.version, null)
  assert.equal(health.pid, null)
  assert.equal(health.heartbeatAgeMs, null)
  assert.equal(health.probeOk, null)
  assert.ok('heartbeatSeq' in health && 'readyCount' in health)
  backend.destroy()
})

test('create FORCEE : nonroot/caps/readonly/tmpfs/mounts/env, ignore pieges worker', async () => {
  let createBody = null
  const mock = makeDockerMock({ onCreate: (args) => { createBody = args.body } })
  const hostileDescriptor = Object.freeze({
    version: VERSION,
    manifestDigest: DIGEST,
    image: 'evil:latest',
    source: '/tmp/evil',
    env: { RCON_PASSWORD: 'x', EVIL: '1' },
    mounts: [{ Source: '/var/run/docker.sock', Target: '/sock' }],
    network: 'host',
    url: 'http://caller-evil:9999/pwn'
  })
  const backend = createDockerBackend(baseOpts(mock, {
    workerEnv: {
      PLANNER_MODEL: 'deepseek-v4.1-flash',
      PLANNER_API_KEY: 'opencode-go-SECRET-KEEP',
      RCON_PASSWORD: 'ne-doit-jamais-passer',
      DOCKER_HOST: 'unix:///var/run/docker.sock',
      KERNEL_TOKEN: 'privilege'
    }
  }))
  const out = await backend.start(hostileDescriptor)
  assert.equal(out.id, FAKE_ID)
  assert.ok(createBody, 'create emis')
  assert.equal(createBody.Image, IMAGE, 'image resolver immutable, pas descriptor.image')
  assert.equal(createBody.User, '1000:1000')
  assert.equal(createBody.HostConfig.Privileged, false)
  assert.equal(createBody.HostConfig.ReadonlyRootfs, true)
  assert.deepEqual(createBody.HostConfig.CapDrop, ['ALL'])
  assert.deepEqual(createBody.HostConfig.CapAdd, [])
  assert.deepEqual(createBody.HostConfig.SecurityOpt, ['no-new-privileges'])
  assert.ok(createBody.HostConfig.Tmpfs && createBody.HostConfig.Tmpfs['/tmp'], 'tmpfs /tmp')
  assert.deepEqual(createBody.HostConfig.Binds, [])
  assert.deepEqual(createBody.HostConfig.Devices, [])
  assert.equal(createBody.HostConfig.PidMode, '')
  assert.equal(createBody.HostConfig.IpcMode, '')
  assert.equal(createBody.HostConfig.NetworkMode, NETWORK, 'reseau projet trusted, pas host caller')
  assert.deepEqual(createBody.NetworkingConfig, { EndpointsConfig: { [NETWORK]: {} } })
  assert.equal(createBody.HostConfig.Mounts.length, 1, 'un seul mount : data')
  assert.equal(createBody.HostConfig.Mounts[0].Type, 'volume')
  assert.equal(createBody.HostConfig.Mounts[0].Source, VOLUME)
  assert.equal(createBody.HostConfig.Mounts[0].Target, '/data')
  const raw = JSON.stringify(createBody)
  assert.ok(!raw.includes('/var/run/docker.sock'), 'jamais de socket Docker')
  assert.ok(!raw.includes('RCON_PASSWORD'), 'jamais de credential rcon/control')
  assert.ok(!raw.includes('DOCKER_HOST') && !raw.includes('KERNEL_TOKEN'), 'hors allowlist jete')
  assert.ok(raw.includes('PLANNER_API_KEY='), 'cle pilote admise (allowlist)')
  assert.ok(raw.includes('PLANNER_MODEL='), 'jeu model public admis')
  assert.deepEqual(createBody.Labels, goodLabels())
  backend.destroy()
})

test('imageResolver : tag flottant et digest mismatch refuses, pas de build/npm', async () => {
  const mock = makeDockerMock()
  let backend = createDockerBackend(baseOpts(mock, {
    imageResolver: async () => ({ image: 'repo/bot:latest', manifestDigest: DIGEST })
  }))
  await assert.rejects(() => backend.start(DESCRIPTOR), /IMMUABLE/)
  backend.destroy()
  backend = createDockerBackend(baseOpts(mock, {
    imageResolver: async () => ({ image: IMAGE, manifestDigest: 'autre-digest' })
  }))
  await assert.rejects(() => backend.start(DESCRIPTOR), /digest-mismatch|manifestDigest/)
  backend.destroy()
  const probed = createDockerBackend(baseOpts(mock))
  assert.equal(typeof probed.start, 'function')
  assert.equal(probed.build, undefined, 'pas de build ici')
  assert.equal(probed.npm, undefined, 'pas de npm ici')
  probed.destroy()
})

test('propriete : forgery labels refusee, service=bot seul insuffisant, pas de list/proxy', async () => {
  const mock = makeDockerMock({
    inspect: () => goodInspect({ Config: { Labels: { service: 'bot' }, Image: IMAGE } })
  })
  const backend = createDockerBackend(baseOpts(mock))
  await backend.start(DESCRIPTOR)
  await assert.rejects(() => backend.stop('test'), /forgery/)
  const health = await backend.checkHealth()
  assert.equal(health.alive, false, 'forgery => pas vivant')
  assert.equal(health.probeOk, false)
  const stats = backend.getStats()
  assert.ok(stats.forgeriesRefused >= 1)
  for (const call of mock.calls) {
    assert.ok(!call.path.includes('/containers/json?') && call.path !== '/containers/json',
      `pas de liste conteneurs : ${call.path}`)
    assert.ok(call.path.includes(FAKE_ID) || call.path.startsWith('/containers/create'),
      `pas de conteneur tiers : ${call.path}`)
  }
  // Registre owner : le wrapper refuse tout id hors registre avant HTTP.
  // Ici, seule la preuve negative est observable : aucune route listee ni
  // conteneur tiers dans les appels (ids adverses jamais emis).
  backend.destroy()
  // heritage minecraft/legacy : meme verdict (labels exacts exiges).
  const legacy = makeDockerMock({
    inspect: () => goodInspect({ Config: { Labels: goodLabels({ 'kernel.project': 'minecraft-autre' }), Image: IMAGE } })
  })
  const backend2 = createDockerBackend(baseOpts(legacy))
  await backend2.start(DESCRIPTOR)
  await assert.rejects(() => backend2.stop('test'), /forgery/)
  backend2.destroy()
  assert.notEqual(OTHER_ID, FAKE_ID, 'ids distincts en fixtures')
})

test('sante via IP trusted : pas d URL caller, version mismatch/hang/huge', async () => {
  const seen = []
  const mock = makeDockerMock()
  const backend = createDockerBackend(baseOpts(mock, {
    httpProbe: async (ip, port, probePath) => {
      seen.push({ ip, port, path: probePath })
      assert.equal(ip, '172.18.0.5', 'IP decouverte via inspect, pas caller')
      assert.equal(port, 3000, 'port trusted, pas caller')
      assert.equal(probePath, '/api/status', 'path trusted, pas caller')
      return { version: VERSION, spawned: true, audit: { ok: true } }
    }
  }))
  await backend.start(DESCRIPTOR)
  const health = await backend.checkHealth()
  assert.equal(health.alive, true)
  assert.equal(health.version, VERSION)
  assert.equal(health.probeOk, true)
  assert.equal(typeof health.heartbeatAgeMs, 'number')
  assert.ok(health.heartbeatAgeMs < 100, 'fraicheur sonde fraiche')
  assert.equal(health.heartbeatSeq, 1)
  // Contrat core local : alive + version + heartbeat frais.
  const responsive = health.alive === true && health.version === VERSION &&
    typeof health.heartbeatAgeMs === 'number' && health.heartbeatAgeMs <= 1500
  assert.equal(responsive, true, 'core responsiveEnough equivalent OK')
  assert.equal(backend.isChildAlive(), true, 'conteneur spawn != preuve mission')
  backend.destroy()

  // Mismatch : version observee exposee (core tranche wrong-version).
  const mock2 = makeDockerMock()
  const backend2 = createDockerBackend(baseOpts(mock2, {
    httpProbe: async () => ({ version: 'v99', spawned: true })
  }))
  await backend2.start(DESCRIPTOR)
  const mismatch = await backend2.checkHealth()
  assert.equal(mismatch.version, 'v99')
  assert.notEqual(mismatch.version, VERSION)
  assert.equal(mismatch.probeOk, false)
  backend2.destroy()

  // Hang : timeout borne => pas vivant, jamais de succes factice.
  const mock3 = makeDockerMock()
  const backend3 = createDockerBackend(baseOpts(mock3, {
    httpProbe: () => new Promise(() => {})
  }))
  await backend3.start(DESCRIPTOR)
  const hung = await backend3.checkHealth()
  assert.equal(hung.alive, false)
  assert.equal(hung.probeOk, false)
  backend3.destroy()

  // Huge : reponse > borne => refusee.
  const mock4 = makeDockerMock()
  const backend4 = createDockerBackend(baseOpts(mock4, {
    responseMaxBytes: 2048,
    httpProbe: async () => ({ version: VERSION, spawned: true, blob: 'x'.repeat(8192) })
  }))
  await backend4.start(DESCRIPTOR)
  const huge = await backend4.checkHealth()
  assert.equal(huge.alive, false, 'reponse huge bornee')
  assert.equal(huge.probeOk, false)
  backend4.destroy()
})

test('stop grace->kill + waitExit : preuve Running==false horodatee, timeout unknown', async () => {
  let stops = 0
  let kills = 0
  let polls = 0
  const mock = makeDockerMock({
    inspect: () => {
      polls += 1
      if (polls <= 2) return goodInspect()
      return goodInspect({ State: { Running: false, ExitCode: 0 } })
    },
    onStop: () => { stops += 1 },
    onKill: () => { kills += 1 }
  })
  const backend = createDockerBackend(baseOpts(mock, { stopGraceMs: 100, stopWaitMs: 2000 }))
  await backend.start(DESCRIPTOR)
  const stopped = await backend.stop('test-grace')
  assert.equal(stopped.stopped, true)
  assert.equal(stops, 1, 'HTTP stop d abord')
  const exit = backend.getExit()
  assert.ok(exit && typeof exit.at === 'string', 'WAIT horodatee')
  assert.equal(exit.code, 0)
  const waited = await backend.waitExit()
  assert.equal(waited.code, 0)
  backend.destroy()

  // Timeout : Running toujours true => unknown, jamais stopped:true factice.
  const stuck = makeDockerMock({ inspect: () => goodInspect() })
  const backendStuck = createDockerBackend(baseOpts(stuck, { stopGraceMs: 100, stopWaitMs: 400 }))
  await backendStuck.start(DESCRIPTOR)
  const timeout = await backendStuck.stop('test-stuck')
  assert.equal(timeout.stopped, false)
  assert.equal(timeout.unknown, true)
  assert.equal(backendStuck.getExit(), null, 'pas de preuve fabriquee')
  assert.equal(backendStuck.isChildAlive(), true, 'toujours vivant cache, pas blanchi')
  backendStuck.destroy()
})

test('logs bornes + redacted, jamais stdout full ni secret', async () => {
  const secret = 'opencode-go-SECRET-KEEP-12345678'
  const mock = makeDockerMock({
    logs: `demarrage ok\nPLANNER_API_KEY=${secret}\nBearer abcdef123456\n` + 'x'.repeat(20000)
  })
  const backend = createDockerBackend(baseOpts(mock, {
    workerEnv: { PLANNER_API_KEY: secret },
    logBytesMax: 4096
  }))
  await backend.start(DESCRIPTOR)
  const logs = await backend.getLogs(1024)
  assert.ok(logs.redacted, 'flag redacted')
  assert.ok(logs.logsTail.length <= 1024, 'borne maxBytes')
  assert.ok(!logs.logsTail.includes(secret), 'valeur exacte redacted')
  assert.ok(!logs.logsTail.includes('abcdef123456'), 'bearer redacted')
  assert.ok(logs.logsTail.includes('[redacted]'), 'marqueur redaction')
  backend.destroy()
})

test('aucun endpoint arbitraire : que les 7 routes du conteneur gere', async () => {
  const mock = makeDockerMock()
  const backend = createDockerBackend(baseOpts(mock))
  await backend.start(DESCRIPTOR)
  await backend.checkHealth()
  await backend.getLogs(100)
  await backend.stop('fin')
  await backend.waitExit()
  backend.destroy()
  for (const call of mock.calls) {
    const ok = call.path.startsWith('/containers/create') || call.path.includes(FAKE_ID)
    assert.ok(ok, `route autorisee uniquement : ${call.method} ${call.path}`)
    assert.ok(!call.path.includes('/images/') && !call.path.includes('/exec/'),
      `pas de build/exec : ${call.path}`)
  }
  assert.ok(!ALLOWED_ENV.includes('RCON_PASSWORD'), 'RCON jamais allowlist')
  assert.ok(ALLOWED_ENV.includes('PLANNER_API_KEY'), 'pilote admis documente')
})
