'use strict'

// tmp/relay-queue.test.js — Preuve de la file serveur `kernel/relay-queue.js`
// (D53, contrat `bridge/relay-contract.md` §2-§4, worker fige
// `bridge/opencode-relay.ps1`).
//
// Conventions : node:test + assert/strict, CommonJS, zero dependance.
// Reseau REEL mais loopback ephemere uniquement (`http.createServer` +
// `listen(0, '127.0.0.1')`, `fetch` global) : aucun port fixe, aucun Docker
// prod, aucune connexion Minecraft, aucun OpenCode/Desktop reel. Horloge et
// store FACTICES quand le temps ou le restart est en jeu (expiry,
// restart-ambiguity). Secrets fictifs (` Bearer` de test), jamais logues.
//
// Couvre : compat champs relais documentes (claim/result/fail/cancel +
// statuts 200/400/401/404/409/413), vrai HTTP loopback, claim exclusif
// concurrent, idempotence resultat (duplicate vs conflit), malformed/auth,
// quotas + anti proto-pollution, host-cancel tardif non promu,
// worker-cancel restitution, expiry deadline (unknown, pas de success),
// restart pending/leased -> interrupted/unknown sans requeue auto (seul un
// nouveau requestTrusted rejouera), fail (dont dead-letter JOB_EXPIRED),
// status redige + lookup prive, absence d endpoint public enqueue et de
// fs/Docker/listen dans la factory.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const { createRelayQueue, RELAY_MODEL, RELAY_VARIANT, DEFAULTS } = require('../kernel/relay-queue')

const TOKEN = 'fictif-relay-queue-token-test-12345'

function fakeClock (start) {
  let t = start === undefined ? Date.now() : start
  return {
    now: () => t,
    advance: (ms) => { t += ms; return t },
    set: (v) => { t = v; return t }
  }
}

function fakeStore () {
  let data = null
  let saves = 0
  return {
    saves: () => saves,
    load: () => (data === null ? null : JSON.parse(JSON.stringify(data))),
    save: (snap) => {
      saves += 1
      const raw = JSON.stringify(snap)
      // Jamais de secret dans le store (token, Bearer, env).
      assert.ok(!raw.includes(TOKEN), 'store sans token')
      assert.ok(!raw.includes('Bearer'), 'store sans Bearer')
      assert.ok(!raw.includes('OPENCODE_SERVER'), 'store sans credential Desktop')
      data = JSON.parse(raw)
    },
    raw: () => data
  }
}

async function withServer (queue, fn) {
  const server = http.createServer((req, res) => {
    queue.handle(req, res).catch(() => {
      try { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"internal"}') } catch (_) { /* ignore */ }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    return await fn(base)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    try { queue.close() } catch (_) { /* ignore */ }
  }
}

async function post (base, path, body, token = TOKEN) {
  const headers = { 'content-type': 'application/json' }
  if (token !== null) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) })
  let parsed = null
  try { parsed = await res.json() } catch (_) { parsed = null }
  return { status: res.status, body: parsed }
}

async function postRaw (base, path, rawText, token = TOKEN) {
  const headers = { 'content-type': 'application/json' }
  if (token !== null) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: rawText })
  let parsed = null
  try { parsed = await res.json() } catch (_) { parsed = null }
  return { status: res.status, body: parsed }
}

function makeQueue (over = {}) {
  const clock = over.clock || fakeClock()
  const store = over.store === undefined ? null : over.store
  const q = createRelayQueue({
    token: TOKEN,
    now: clock.now,
    directoryEcho: over.directoryEcho === undefined ? '' : over.directoryEcho,
    maxPending: over.maxPending === undefined ? 16 : over.maxPending,
    leaseTtlMs: over.leaseTtlMs === undefined ? 5000 : over.leaseTtlMs,
    maxJobAgeMs: over.maxJobAgeMs === undefined ? 5000 : over.maxJobAgeMs,
    maxMessageBytes: over.maxMessageBytes,
    maxContentBytes: over.maxContentBytes,
    store
  })
  return { q, clock, store }
}

describe('relay-queue : contrat exact, zero dep, pas de bypass', () => {
  test('exports + scope fixe + zero fs/Docker/listen + pas d enqueue public', async () => {
    const { q } = makeQueue()
    try {
      assert.equal(RELAY_MODEL, 'openai/gpt-6-astra')
      assert.equal(RELAY_VARIANT, 'high')
      for (const k of ['requestTrusted', 'cancelRequest', 'handle', 'status', 'lookupJob', 'checkExpiries', 'close']) {
        assert.equal(typeof q[k], 'function', `methode ${k}`)
      }
      const src = fs.readFileSync(require.resolve('../kernel/relay-queue'), 'utf8')
      assert.ok(!src.includes("require('node:fs')") && !src.includes('require("node:fs")'), 'aucun fs')
      assert.ok(!src.includes('child_process'), 'aucun shell/spawn')
      assert.ok(!src.includes('docker'), 'aucun Docker')
      assert.ok(!src.includes('.listen('), 'factory ne listen jamais (handle seul)')
      assert.ok(!src.includes('eval(') && !src.includes('new Function'), 'jamais de JSON execute')
      // Compat documentee : aucun endpoint d ecriture hors contrat.
      await withServer(q, async (base) => {
        const notFound = await post(base, '/relay/jobs', { system: 's', user: 'u' })
        assert.equal(notFound.status, 404, 'pas de route publique enqueue')
        const get = await fetch(`${base}/relay/jobs/claim`, { headers: { authorization: `Bearer ${TOKEN}` } })
        assert.equal(get.status, 404, 'claim GET refuse (POST seul)')
        const statusHttp = await post(base, '/relay/status', {})
        assert.equal(statusHttp.status, 404, 'pas de status HTTP (status() in-process seul)')
        const lookupHttp = await post(base, '/relay/jobs/job-1/lookup', {})
        assert.equal(lookupHttp.status, 404, 'pas de lookup HTTP (lookupJob prive seul)')
      })
    } finally {
      q.close()
    }
  })

  test('compat champs claim : cles exactes, echo fixe malgre job pirate, Bearer jamais logue', async () => {
    const { q } = makeQueue({ directoryEcho: 'echo-hote' })
    try {
      const pending = q.requestTrusted({ system: 'sys-test', user: 'jeu-test', model: 'modele-pirate', variant: 'low', directory: 'C:\\evil' })
      const jobId = pending.jobId
      assert.ok(jobId, 'promesse porte jobId (non HTTP)')
      pending.catch(() => {})
      await withServer(q, async (base) => {
        const claimed = await post(base, '/relay/jobs/claim', { workerId: 'WINBOX-1' })
        assert.equal(claimed.status, 200)
        const job = claimed.body.job
        assert.deepEqual(Object.keys(job).sort(), ['directory', 'expiresAt', 'id', 'leaseId', 'model', 'system', 'user', 'variant'].sort(), 'cles claim exactes contrat §2.1')
        assert.equal(job.id, jobId)
        assert.match(job.leaseId, /^[A-Za-z0-9_-]{1,128}$/)
        assert.equal(job.system, 'sys-test')
        assert.equal(job.user, 'jeu-test')
        assert.equal(job.model, 'openai/gpt-6-astra', 'echo fixe, job pirate ignore')
        assert.equal(job.variant, 'high', 'echo fixe, job pirate ignore')
        assert.equal(job.directory, 'echo-hote', 'echo hote, jamais une URL du job')
        assert.ok(!Number.isNaN(Date.parse(job.expiresAt)), 'expiresAt ISO-8601')
        // File vide apres claim exclusif.
        const empty = await post(base, '/relay/jobs/claim', { workerId: 'WINBOX-2' })
        assert.equal(empty.status, 200)
        assert.equal(empty.body.job, null, 'lease exclusif : second claim => null')
      })
      q.cancelRequest(jobId)
      await assert.rejects(pending, (e) => e && e.code === 'RELAY_ABORTED')
    } finally {
      q.close()
    }
  })

  test('nominal bout en bout HTTP : claim -> result -> promesse hote resolue', async () => {
    const { q } = makeQueue()
    try {
      const pending = q.requestTrusted({ system: 'sys', user: 'aide ?' })
      pending.catch(() => {})
      await withServer(q, async (base) => {
        const c = await post(base, '/relay/jobs/claim', { workerId: 'w1' })
        assert.equal(c.status, 200)
        const r = await post(base, `/relay/jobs/${c.body.job.id}/result`, {
          leaseId: c.body.job.leaseId, content: '{"fini":0}', usage: { tokens: 12 }, ms: 42, cleanupFailed: false, sessionId: null
        })
        assert.equal(r.status, 200)
        assert.deepEqual(r.body, { stored: true, duplicate: false })
      })
      const done = await pending
      assert.equal(done.content, '{"fini":0}')
      assert.deepEqual(done.usage, { tokens: 12 })
      assert.equal(done.cleanupFailed, false)
      const st = q.status()
      assert.deepEqual(st.counts.completed, 1)
      assert.ok(!JSON.stringify(st).includes('sys-test') && !JSON.stringify(st).includes('{"fini"'), 'status redige : compteurs, pas de prompts')
    } finally {
      q.close()
    }
  })

  test('idempotence resultat : meme lease+fingerprint duplicate, divergent 409', async () => {
    const { q } = makeQueue()
    try {
      const pending = q.requestTrusted({ system: 's', user: 'u' })
      pending.catch(() => {})
      await withServer(q, async (base) => {
        const c = await post(base, '/relay/jobs/claim', { workerId: 'w' })
        const id = c.body.job.id
        const lease = c.body.job.leaseId
        const first = await post(base, `/relay/jobs/${id}/result`, { leaseId: lease, content: 'texte-A', usage: null, ms: 1, cleanupFailed: false, sessionId: null })
        assert.equal(first.status, 200)
        const dup = await post(base, `/relay/jobs/${id}/result`, { leaseId: lease, content: 'texte-A', usage: null, ms: 1, cleanupFailed: false, sessionId: null })
        assert.equal(dup.status, 200)
        assert.deepEqual(dup.body, { stored: true, duplicate: true }, 're-emission identique idempotente')
        const conflict = await post(base, `/relay/jobs/${id}/result`, { leaseId: lease, content: 'texte-B-divergent', usage: null, ms: 1, cleanupFailed: false, sessionId: null })
        assert.equal(conflict.status, 409, 'divergent sous meme lease => 409 (premier gagne)')
        const stale = await post(base, `/relay/jobs/${id}/result`, { leaseId: 'lease-inconnu-xyz', content: 'texte-A', usage: null, ms: 1, cleanupFailed: false, sessionId: null })
        assert.equal(stale.status, 409, 'stale lease => 409')
      })
      const done = await pending
      assert.equal(done.content, 'texte-A', 'premier upload seul promu')
    } finally {
      q.close()
    }
  })

  test('concurrent : deux jobs, deux workers, leases distincts et exclusifs', async () => {
    const { q } = makeQueue()
    try {
      const p1 = q.requestTrusted({ system: 's1', user: 'u1' }); p1.catch(() => {})
      const p2 = q.requestTrusted({ system: 's2', user: 'u2' }); p2.catch(() => {})
      await withServer(q, async (base) => {
        const a = await post(base, '/relay/jobs/claim', { workerId: 'wA' })
        const b = await post(base, '/relay/jobs/claim', { workerId: 'wB' })
        assert.equal(a.status, 200); assert.equal(b.status, 200)
        assert.ok(a.body.job && b.body.job, 'deux jobs reclames')
        assert.notEqual(a.body.job.id, b.body.job.id, 'jobs distincts')
        assert.notEqual(a.body.job.leaseId, b.body.job.leaseId, 'leases opaques distincts')
        const c = await post(base, '/relay/jobs/claim', { workerId: 'wC' })
        assert.equal(c.body.job, null, 'plus de job queued => null')
      })
      q.cancelRequest(p1.jobId); q.cancelRequest(p2.jobId)
      await assert.rejects(p1, (e) => e && e.code === 'RELAY_ABORTED')
      await assert.rejects(p2, (e) => e && e.code === 'RELAY_ABORTED')
    } finally {
      q.close()
    }
  })

  test('malformed + auth : 401 neutre, 400 corps, 404 inconnu, 409 lease, 413 contenu', async () => {
    const { q } = makeQueue({ maxContentBytes: 64 })
    try {
      const pending = q.requestTrusted({ system: 's', user: 'u' })
      pending.catch(() => {})
      await withServer(q, async (base) => {
        const noAuth = await post(base, '/relay/jobs/claim', { workerId: 'w' }, null)
        assert.equal(noAuth.status, 401)
        assert.deepEqual(noAuth.body, { error: 'unauthorized' }, '401 neutre sans detail')
        const badAuth = await post(base, '/relay/jobs/claim', { workerId: 'w' }, 'mauvais-token')
        assert.equal(badAuth.status, 401)
        assert.ok(!JSON.stringify(badAuth.body).includes('mauvais-token'), 'echo token jamais renvoye')
        const noWorker = await post(base, '/relay/jobs/claim', {})
        assert.equal(noWorker.status, 400, 'workerId manquant => 400')
        const badJson = await postRaw(base, '/relay/jobs/claim', '{ json casse')
        assert.equal(badJson.status, 400)
        const unknown = await post(base, '/relay/jobs/job-inexistant-xyz/result', { leaseId: 'lease-1', content: 'x', usage: null, ms: 1, cleanupFailed: false, sessionId: null })
        assert.equal(unknown.status, 404, 'job inconnu => 404')
        const badIdPath = await post(base, '/relay/jobs/http%3A%2F%2Fevil%2Fx/result', { leaseId: 'lease-1', content: 'x', usage: null, ms: 1, cleanupFailed: false, sessionId: null })
        assert.equal(badIdPath.status, 404, 'id non conforme => 404, jamais interprete')
        const c = await post(base, '/relay/jobs/claim', { workerId: 'w' })
        const id = c.body.job.id
        const tooBig = await post(base, `/relay/jobs/${id}/result`, { leaseId: c.body.job.leaseId, content: 'x'.repeat(200), usage: null, ms: 1, cleanupFailed: false, sessionId: null })
        assert.equal(tooBig.status, 413, 'content > borne => 413')
        const proto = await post(base, `/relay/jobs/${id}/result`, { leaseId: c.body.job.leaseId, content: 'ok', usage: JSON.parse('{"__proto__":{"pollue":1}}'), ms: 1, cleanupFailed: false, sessionId: null })
        assert.equal(proto.status, 400, 'proto-pollution dans usage => 400')
        const longFail = await post(base, `/relay/jobs/${id}/fail`, { leaseId: c.body.job.leaseId, code: 'RELAY_MODEL_ERROR', message: 'm'.repeat(5000), cleanupFailed: false, sessionId: null })
        assert.equal(longFail.status, 400, 'message fail hors borne => 400')
      })
      q.cancelRequest(pending.jobId)
      await assert.rejects(pending, (e) => e && e.code === 'RELAY_ABORTED')
    } finally {
      q.close()
    }
  })

  test('host-cancel : aborts state, futur claim refuse, resultat tardif non promu', async () => {
    const clock = fakeClock()
    const { q } = makeQueue({ clock })
    try {
      const ctrl = new AbortController()
      const pending = q.requestTrusted({ system: 's', user: 'u' }, { signal: ctrl.signal })
      const jobId = pending.jobId
      const done = pending.then(() => 'resolved', (e) => e)
      ctrl.abort()
      const err = await done
      assert.equal(err.code, 'RELAY_ABORTED', 'abort hote => cancelled')
      await withServer(q, async (base) => {
        const c = await post(base, '/relay/jobs/claim', { workerId: 'w' })
        assert.equal(c.body.job, null, 'job hote-cancelled jamais reclame')
        const late = await post(base, `/relay/jobs/${jobId}/result`, { leaseId: 'lease-tardif', content: 'tardif', usage: null, ms: 1, cleanupFailed: false, sessionId: null })
        assert.equal(late.status, 409, 'resultat tardif sur cancelled => 409 non promu')
        const lateCancel = await post(base, `/relay/jobs/${jobId}/cancel`, { leaseId: 'lease-tardif' })
        assert.equal(lateCancel.status, 409, 'cancel worker sur job hote-cancelled => 409 refus')
      })
      assert.equal(q.status().counts.cancelled, 1)
      assert.equal(q.lookupJob(jobId).status, 'cancelled')
    } finally {
      q.close()
    }
  })

  test('worker-cancel : restitution sans resultat, meme id nouveau lease, ancien lease stale', async () => {
    const { q } = makeQueue()
    try {
      const pending = q.requestTrusted({ system: 's', user: 'u' })
      pending.catch(() => {})
      await withServer(q, async (base) => {
        const c1 = await post(base, '/relay/jobs/claim', { workerId: 'w' })
        const id = c1.body.job.id
        const oldLease = c1.body.job.leaseId
        const cancelled = await post(base, `/relay/jobs/${id}/cancel`, { leaseId: oldLease })
        assert.equal(cancelled.status, 200)
        assert.deepEqual(cancelled.body, { cancelled: true })
        const c2 = await post(base, '/relay/jobs/claim', { workerId: 'w' })
        assert.equal(c2.body.job.id, id, 'meme job redevient reclamable')
        assert.notEqual(c2.body.job.leaseId, oldLease, 'nouveau lease opaque')
        const stale = await post(base, `/relay/jobs/${id}/result`, { leaseId: oldLease, content: 'ancien', usage: null, ms: 1, cleanupFailed: false, sessionId: null })
        assert.equal(stale.status, 409, 'ancien lease => 409 stale')
        const ok = await post(base, `/relay/jobs/${id}/result`, { leaseId: c2.body.job.leaseId, content: 'nouveau', usage: null, ms: 1, cleanupFailed: false, sessionId: null })
        assert.equal(ok.status, 200)
      })
      const done = await pending
      assert.equal(done.content, 'nouveau', 'seul le nouveau lease promeut')
    } finally {
      q.close()
    }
  })

  test('deadline : expire unknown, reject pas success, dead-letter JOB_EXPIRED toleree', async () => {
    const clock = fakeClock()
    const { q } = makeQueue({ clock, leaseTtlMs: 10000, maxJobAgeMs: 10000 })
    try {
      const pending = q.requestTrusted({ system: 's', user: 'u' }, { timeoutMs: 2000 })
      const jobId = pending.jobId
      const done = pending.then(() => 'resolved', (e) => e)
      let claimed
      await withServer(q, async (base) => {
        const c = await post(base, '/relay/jobs/claim', { workerId: 'w' })
        claimed = c.body.job
        assert.equal(c.status, 200)
      })
      clock.advance(3000)
      q.checkExpiries()
      const err = await done
      assert.equal(err.code, 'JOB_EXPIRED', 'deadline => expired unknown, reject')
      await withServer(q, async (base) => {
        // Le claim suivant ne refile pas le job expire (pas de requeue auto).
        const c2 = await post(base, '/relay/jobs/claim', { workerId: 'w' })
        assert.equal(c2.body.job, null)
        const lateResult = await post(base, `/relay/jobs/${jobId}/result`, { leaseId: claimed.leaseId, content: 'perime', usage: null, ms: 1, cleanupFailed: false, sessionId: null })
        assert.equal(lateResult.status, 409, 'resultat perime jamais success')
        const deadLetter = await post(base, `/relay/jobs/${jobId}/fail`, { leaseId: claimed.leaseId, code: 'JOB_EXPIRED', message: 'job expire pendant inference (dead-letter)', cleanupFailed: false, sessionId: null })
        assert.equal(deadLetter.status, 200, 'dead-letter JOB_EXPIRED acceptee sur lease connu')
      })
      assert.equal(q.status().counts.expired, 1)
    } finally {
      q.close()
    }
  })

  test('fail nominal : RELAY_MODEL_ERROR rejette hote, orpheline exposee sans secret', async () => {
    const { q } = makeQueue()
    try {
      const pending = q.requestTrusted({ system: 's', user: 'u' })
      const done = pending.then(() => 'resolved', (e) => e)
      await withServer(q, async (base) => {
        const c = await post(base, '/relay/jobs/claim', { workerId: 'w' })
        const f = await post(base, `/relay/jobs/${c.body.job.id}/fail`, {
          leaseId: c.body.job.leaseId, code: 'RELAY_MODEL_ERROR', message: 'inference erreur modele [redacted]', cleanupFailed: true, sessionId: 'sess-orpheline'
        })
        assert.equal(f.status, 200)
        assert.deepEqual(f.body, { stored: true })
      })
      const err = await done
      assert.equal(err.code, 'RELAY_MODEL_ERROR')
      assert.equal(err.failure.cleanupFailed, true)
      assert.equal(err.failure.sessionId, 'sess-orpheline', 'orpheline exposee pour nettoyage, sans secret')
      assert.equal(q.status().counts.failed, 1)
    } finally {
      q.close()
    }
  })

  test('quotas hote : maxPending, 1 Mo messages, store sans secret', async () => {
    const store = fakeStore()
    const { q } = makeQueue({ store, maxPending: 1 })
    try {
      const p1 = q.requestTrusted({ system: 's', user: 'u' })
      p1.catch(() => {})
      await assert.rejects(q.requestTrusted({ system: 's', user: 'u2' }), (e) => e && e.code === 'QUEUE_FULL', 'maxPending borne')
      await assert.rejects(q.requestTrusted({ system: 'x'.repeat(700000), user: 'y'.repeat(700000) }), (e) => e && (e.code === 'JOB_TOO_LARGE' || e.code === 'too_large'), '1 Mo system+user borne')
      q.cancelRequest(p1.jobId)
      await assert.rejects(p1, (e) => e && e.code === 'RELAY_ABORTED')
      assert.ok(store.saves() >= 1, 'persistance active')
    } finally {
      q.close()
    }
  })

  test('restart : pending/leased -> interrupted/unknown, pas de requeue, rerun explicite seul', async () => {
    const clock = fakeClock()
    const store = fakeStore()
    const q1 = createRelayQueue({ token: TOKEN, now: clock.now, store, leaseTtlMs: 60000, maxJobAgeMs: 60000 })
    let oldId
    let oldLease
    try {
      const p1 = q1.requestTrusted({ system: 'sys-avant-crash', user: 'jeu-avant-crash' })
      p1.catch(() => {})
      oldId = p1.jobId
      // Claim pre-crash (lease actif) : simule inference en cours puis crash
      // relai avant upload (ambigu : resultat peut-etre calcule, perdu).
      await withServer(q1, async (base) => {
        const c = await post(base, '/relay/jobs/claim', { workerId: 'w' })
        oldLease = c.body.job.leaseId
        assert.equal(c.body.job.id, oldId)
      })
      // q1 abandonne sans close des waiters (crash) : on coupe les timers.
      try { q1.close() } catch (_) { /* ignore */ }
    } catch (e) {
      try { q1.close() } catch (_) { /* ignore */ }
      throw e
    }
    // Redemarrage : meme store, nouvelle factory.
    const q2 = createRelayQueue({ token: TOKEN, now: clock.now, store, leaseTtlMs: 60000, maxJobAgeMs: 60000 })
    try {
      const rec = q2.lookupJob(oldId)
      assert.equal(rec.status, 'interrupted', 'leased pre-crash => interrupted')
      assert.equal(rec.failure.code, 'RELAY_RESTART')
      assert.match(rec.failure.message, /unknown|rerun hote explicite/i, 'resultat unknown documente')
      await withServer(q2, async (base) => {
        const c = await post(base, '/relay/jobs/claim', { workerId: 'w' })
        assert.equal(c.body.job, null, 'aucune requeue auto, aucune nouvelle inference sans signal hote')
        const late = await post(base, `/relay/jobs/${oldId}/result`, { leaseId: oldLease, content: 'apres-crash', usage: null, ms: 1, cleanupFailed: false, sessionId: null })
        assert.equal(late.status, 409, 'upload ambigu post-restart refuse (pas de double inference)')
        // Seul un nouveau requestTrusted rejouera (nouvel id).
        const p2 = q2.requestTrusted({ system: 'sys-apres-crash', user: 'rejouer explicitement' })
        p2.catch(() => {})
        const c2 = await post(base, '/relay/jobs/claim', { workerId: 'w' })
        assert.equal(c2.body.job.id, p2.jobId)
        assert.notEqual(c2.body.job.id, oldId, 'rerun = nouveau job, jamais resurrection')
        q2.cancelRequest(p2.jobId)
        await assert.rejects(p2, (e) => e && e.code === 'RELAY_ABORTED')
      })
      assert.equal(q2.status().counts.interrupted, 1)
    } finally {
      q2.close()
    }
  })

  test('status redige + lookup prive (jamais HTTP) + limites exposees', async () => {
    const { q } = makeQueue()
    try {
      const p = q.requestTrusted({ system: 'secret-systeme-fictif', user: 'secret-jeu-fictif' })
      p.catch(() => {})
      const st = q.status()
      assert.deepEqual(Object.keys(st.counts).sort(), ['cancelled', 'claimed', 'completed', 'expired', 'failed', 'interrupted', 'queued'].sort())
      assert.ok(!JSON.stringify(st).includes('secret-systeme-fictif'), 'status sans prompts')
      assert.ok(!JSON.stringify(st).includes(TOKEN), 'status sans token')
      const rec = q.lookupJob(p.jobId)
      assert.equal(rec.system, 'secret-systeme-fictif', 'lookup prive hote voit tout (in-process)')
      assert.throws(() => createRelayQueue({ token: TOKEN, store: {} }), TypeError, 'store invalide refuse')
      assert.throws(() => createRelayQueue({ token: TOKEN, store: { load: () => ({ corrupt: true }), save: () => {} } }), /corrompu/, 'snapshot corrompu refuse, pas de reset silencieux')
      q.cancelRequest(p.jobId)
      await assert.rejects(p, (e) => e && e.code === 'RELAY_ABORTED')
      void DEFAULTS
    } finally {
      q.close()
    }
  })
})
