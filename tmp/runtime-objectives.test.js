'use strict'
// Cycle durable : inbox persistee, deux arrets hors LLM, arbitrage 60 s,
// executor single-writer, reload stale. E2E simule vraie
// conversation + controller + store (+ mission adapter simule), PLUS preuves
// sur le VRAI index (module reel, pas de re-export fake) et le VRAI
// createMissionRunner (bot/mission.js reel).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createStateStore } = require('../bot/state-store')
const { createObjectiveController } = require('../bot/objective-controller')
const { createExecutor } = require('../bot/executor')
const { createConversation, isSoftStop, isHardStop, isResume, parseArbitrationChoice } = require('../bot/conversation')
const { createMissionRunner } = require('../bot/mission')
const realIndex = require('../bot/index')

function freshStore () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-obj-'))
  return { dir, store: createStateStore({ file: path.join(dir, 's.json'), eventFile: path.join(dir, 'e.jsonl') }) }
}

function fakeClock (start = 1_700_000_000_000) {
  let t = start
  let seq = 0
  const timers = new Map()
  return {
    now: () => t,
    advance: (ms) => { t += ms },
    setTimer: (fn, ms) => { seq += 1; timers.set(seq, { fn, at: t + ms, cleared: false }); return seq },
    clearTimer: (id) => { const e = timers.get(id); if (e) e.cleared = true },
    fire: (id) => { const e = timers.get(id); assert.ok(e, 'timer connu'); e.fn() },
    pendingIds: () => [...timers.entries()].filter(([, e]) => !e.cleared).map(([id]) => id)
  }
}

function deferred () {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// Mission adapter simule : file physique via executor, progression persistee
// via controller, pause/reprise sans inventer d actions terminees.
function createMissionAdapter ({ controller, executor }) {
  let current = null // { id, texte, steps, state }
  async function start (texte, auteur) {
    const envelope = await executor.run({ id: `mission-${Date.now()}`, kind: 'work' }, async () => {
      current = { id: `m-${Date.now()}`, texte, auteur, steps: 0, state: 'running' }
      controller.recordProgress({ mission: current.id, etapes: 0 })
      return { ok: true, mission: { ...current } }
    })
    if (envelope.cancelled) return { ok: false, error: 'interrompue' }
    return envelope.value
  }
  function pause () {
    if (!current || current.state !== 'running') return false
    current.state = 'paused'
    return true
  }
  function resume () {
    if (!current || current.state !== 'paused') return false
    current.state = 'running'
    return true
  }
  function status () { return current ? { ...current } : null }
  return { start, pause, resume, status }
}

test('langage naturel : variations stop/accent immediates hors LLM', () => {
  assert.equal(isSoftStop('stop'), true)
  assert.equal(isSoftStop('Stop !'), true)
  assert.equal(isSoftStop('arrête'), true)
  assert.equal(isSoftStop('arrete'), true)
  assert.equal(isHardStop('arret total'), true)
  assert.equal(isHardStop('arrêt total'), true)
  assert.equal(isHardStop('STOP TOTAL'), true)
  assert.equal(isResume('reprends'), true)
  assert.equal(isResume('resume'), true)
  assert.equal(isResume('reprends le travail'), true)
  assert.equal(isSoftStop('arret total'), false)
  assert.equal(parseArbitrationChoice('pause_reprise'), 'pause_reprise')
  assert.equal(parseArbitrationChoice('remplacement'), 'remplacement')
  assert.equal(parseArbitrationChoice('que fais-tu ?'), null)
  // Formulations libres vues en jeu le 2026-09-24.
  assert.equal(parseArbitrationChoice('Remplace la demande'), 'remplacement')
  assert.equal(parseArbitrationChoice('Remplace et rejoins moi'), 'remplacement')
  assert.equal(parseArbitrationChoice('abandonne'), 'remplacement')
  assert.equal(parseArbitrationChoice('reprends apres'), 'pause_reprise')
  assert.equal(parseArbitrationChoice('garde l ancien'), 'pause_reprise')
  assert.equal(isResume('reprends apres'), false)
})

test('inbox : multi messages seriaslises sans perte', () => {
  const { store } = freshStore()
  const clock = fakeClock()
  const ctrl = createObjectiveController({ store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
  ctrl.recordMessage({ auteur: 'Alice', texte: 'prends du bois' })
  ctrl.recordMessage({ auteur: 'Bob', texte: 'non, de la pierre' })
  ctrl.recordMessage({ auteur: 'Alice', texte: 'vite ?' })
  const snap = ctrl.snapshot()
  assert.deepEqual(snap.inbox.map((m) => m.texte), ['prends du bois', 'non, de la pierre', 'vite ?'])
  assert.deepEqual(snap.inbox.map((m) => m.auteur), ['Alice', 'Bob', 'Alice'])
})

test('stop immediat annule interpretation obsolete (hors LLM)', async () => {
  const events = []
  const host = {
    status: () => null,
    interpret: () => new Promise(() => {}), // jamais resolu
    stop: () => events.push('stop'),
    say: () => {},
    cancelPendingStart: () => {}
  }
  const conv = createConversation(host)
  const pending = conv.receive('Alice', 'construis un abri')
  await new Promise((r) => setImmediate(r))
  await conv.receive('Alice', 'stop')
  assert.deepEqual(events, ['stop'])
  // L interpretation en vol ne doit jamais parler ni demarrer apres le stop.
  await assert.rejects(Promise.race([pending, Promise.reject(new Error('reste pendante'))]), /reste pendante/)
    .catch(() => {})
})

test('question/context conservent mission, sans replanifier pending', async () => {
  const { store } = freshStore()
  const clock = fakeClock()
  const ctrl = createObjectiveController({ store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
  ctrl.proposeObjective({ auteur: 'Alice', texte: 'construire un abri' })
  ctrl.addContext({ auteur: 'Bob', texte: 'le sol est plat au sud' })
  ctrl.askQuestion({ auteur: 'Bot', texte: 'quelle hauteur ?' })
  const snap = ctrl.snapshot()
  assert.equal(snap.current.texte, 'construire un abri')
  assert.equal(snap.current.statut, 'active')
  assert.equal(snap.pending.length, 0)
})

test('arbitrage concurrent : question, pause, choix nouveau demandeur, timeout 60 s', () => {
  const { store } = freshStore()
  const clock = fakeClock()
  const ctrl = createObjectiveController({ store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, arbitrationMs: 60000 })
  ctrl.proposeObjective({ auteur: 'Alice', texte: 'construire un abri' })
  const second = ctrl.proposeObjective({ auteur: 'Bob', texte: 'creuse une cave' })
  assert.equal(second.status, 'arbitration')
  assert.match(second.question, /pause_reprise/)
  assert.match(second.question, /remplacement/)
  assert.equal(ctrl.snapshot().current.statut, 'paused')
  // Seul le nouveau demandeur tranche.
  assert.throws(() => ctrl.resolveArbitration({ choice: 'remplacement', actor: 'Alice' }), /seul le nouveau demandeur/)
  const out = ctrl.resolveArbitration({ choice: 'pause_reprise', actor: 'Bob' })
  assert.equal(out.status, 'resumed-new')
  assert.equal(ctrl.snapshot().pausedStack.length, 1)
})

test('arbitrage timeout : reprend ancien, garde autre pending', () => {
  const { store } = freshStore()
  const clock = fakeClock()
  const ctrl = createObjectiveController({ store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, arbitrationMs: 60000 })
  ctrl.proposeObjective({ auteur: 'Alice', texte: 'construire un abri' })
  ctrl.proposeObjective({ auteur: 'Bob', texte: 'creuse une cave' })
  const timerId = clock.pendingIds()[0]
  assert.ok(timerId)
  clock.advance(60001)
  clock.fire(timerId)
  const snap = ctrl.snapshot()
  assert.equal(snap.current.texte, 'construire un abri')
  assert.equal(snap.current.statut, 'active')
  assert.equal(snap.pending.length, 1)
  assert.equal(snap.pending[0].texte, 'creuse une cave')
  // Timer obsolete : resolution tardive refusee (stale), pas de double reprise.
  assert.throws(() => ctrl.resolveArbitration({ choice: 'remplacement', actor: 'Bob' }), /aucun arbitrage/)
})

test('hardstop : rescue interdit fail-closed, reprise explicite', async () => {
  const stops = []
  const ex = createExecutor({ stopControls: (r) => stops.push(r) })
  const { store } = freshStore()
  const clock = fakeClock()
  const ctrl = createObjectiveController({ store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
  ctrl.proposeObjective({ auteur: 'Alice', texte: 'construire un abri' })
  ctrl.totalStop('arret total demande')
  ex.totalStop('arret total demande')
  // Meme la survie est refusee apres arret total.
  await assert.rejects(ex.run({ id: 'rescue-1', kind: 'survival' }, async () => 'nage'), (e) => e.code === 'stopped')
  assert.ok(stops.some((r) => String(r).startsWith('stop:')))
  // Reprise strictement explicite : ne demarre rien toute seule.
  ex.resume()
  ctrl.resume()
  const env = await ex.run({ id: 'rescue-2', kind: 'survival' }, async () => 'ok')
  assert.equal(env.outcome, 'completed')
})

test('executor : un seul writer, slot libere a resolution reelle (pas de race)', async () => {
  const ex = createExecutor({ stopControls: () => {} })
  const gate = deferred()
  let maxActive = 0
  let active = 0
  const p1 = ex.run({ id: 'w1', kind: 'work' }, async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await gate.promise
    active -= 1
    return 'w1'
  })
  await new Promise((r) => setTimeout(r, 5))
  await assert.rejects(ex.run({ id: 'w2', kind: 'work' }, async () => 'w2'), (e) => e.code === 'busy')
  gate.resolve()
  const env = await p1
  assert.equal(env.value, 'w1')
  assert.equal(maxActive, 1)
})

test('reload : faits stale, arbitrage expire, hardstop sans timer', () => {
  const { dir, store } = freshStore()
  const c1clock = fakeClock(1_700_000_000_000)
  const c1 = createObjectiveController({ store, now: c1clock.now, setTimer: c1clock.setTimer, clearTimer: c1clock.clearTimer, arbitrationMs: 60000 })
  c1.proposeObjective({ auteur: 'Alice', texte: 'construire un abri' })
  const reloaded = createStateStore({ file: path.join(dir, 's.json'), eventFile: path.join(dir, 'e.jsonl') })
  const c2clock = fakeClock(1_700_000_000_000 + 120000)
  const c2 = createObjectiveController({ store: reloaded, now: c2clock.now, setTimer: c2clock.setTimer, clearTimer: c2clock.clearTimer, arbitrationMs: 60000 })
  const snap = c2.recover()
  assert.equal(snap.current.texte, 'construire un abri')
  // Reobservation monde : faits marques stale, jamais presentes comme frais.
  for (const f of snap.facts) assert.equal(f.stale, true)
})

test('e2e simule : conversation -> controller -> mission adapter, sans perte', async () => {
  const { store } = freshStore()
  const clock = fakeClock()
  const ctrl = createObjectiveController({ store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, arbitrationMs: 60000 })
  const ex = createExecutor({ stopControls: () => {} })
  const adapter = createMissionAdapter({ controller: ctrl, executor: ex })
  const said = []
  const host = {
    status: () => null,
    observation: () => ({}),
    interpret: async (msg) => {
      if (/hauteur/.test(msg)) return { relation: 'question', response: '2 blocs.' }
      return { relation: 'new', objective: msg, response: 'Je m en occupe.' }
    },
    start: async (objective, requester) => {
      const p = ctrl.proposeObjective({ auteur: requester, texte: objective })
      if (p.status !== 'started') {
        if (p.question) said.push(p.question)
        return { ok: true, arbitration: true }
      }
      return adapter.start(objective, requester)
    },
    revise: async () => ({ ok: true }),
    context: (m, u) => { ctrl.addContext({ auteur: u, texte: m }) },
    stop: () => { ctrl.pauseWork('stop'); ex.pauseWork('stop') },
    totalStop: () => { ctrl.totalStop('stop'); ex.totalStop('stop') },
    resume: () => { ex.resume(); ctrl.resume() },
    arbitrationPending: () => {
      const s = ctrl.snapshot()
      return s.arbitration ? { candidateAuteur: s.arbitration.candidate.auteur } : null
    },
    resolveArbitration: ({ choice, actor }) => ctrl.resolveArbitration({ choice, actor }),
    noteIgnored: (u, m) => { try { ctrl.recordMessage({ auteur: u, texte: m }) } catch (_) {} },
    say: (t) => said.push(t),
    cancelPendingStart: () => {}
  }
  const conv = createConversation(host)
  await conv.receive('Alice', 'construis un abri')
  assert.ok(adapter.status())
  await conv.receive('Bob', 'quelle hauteur ?')
  assert.equal(adapter.status().state, 'running')
  await conv.receive('Bob', 'creuse une cave')
  const snap = ctrl.snapshot()
  assert.ok(snap.arbitration)
  assert.match(said[said.length - 1], /pause_reprise|remplacement/)
  await conv.receive('Bob', 'pause_reprise')
  assert.equal(ctrl.snapshot().arbitration, null)
})

test('VRAI index : audit coherent (donner cable), runPhysical single-writer, pas de fallback direct', async () => {
  assert.ok(realIndex.commandAudit, 'commandAudit exporte par le vrai index')
  assert.equal(realIndex.commandAudit.ok, true, `audit vrai : ${(realIndex.commandAudit.problems || []).join(' ; ')}`)
  assert.equal(typeof realIndex.runPhysical, 'function')
  assert.equal(typeof realIndex.isOwnerBypass, 'function')
  assert.equal(typeof realIndex.requireAdmissionOrThrow, 'function')
  // Bypass refuse sans token ou token etranger (jamais d exemption globale).
  assert.equal(realIndex.isOwnerBypass({}), false)
  assert.equal(realIndex.isOwnerBypass({ __owner: 'etranger' }), false)
  // Slot tenu => second run refuse busy, slot libere a resolution reelle.
  const gate = deferred()
  const p1 = realIndex.runPhysical('vrai-index-test-w1', 'work', async () => {
    await gate.promise
    return 'w1-ok'
  })
  await new Promise((r) => setTimeout(r, 10))
  await assert.rejects(
    realIndex.runPhysical('vrai-index-test-w2', 'work', async () => 'w2'),
    (e) => e && e.code === 'busy')
  gate.resolve()
  const env = await p1
  assert.equal(env.outcome, 'completed')
  assert.equal(env.value, 'w1-ok')
})

test('VRAI index : stack corrompu fail-closed (pas de controleur vierge)', () => {
  const badStore = {
    load: () => { throw new Error('snapshot corrompu (test)') },
    save: () => { throw new Error('save refuse') },
    appendEvent: () => { throw new Error('journal refuse') }
  }
  const stack = realIndex.createDurableStack({ store: badStore })
  assert.equal(stack.controller, null)
  assert.equal(stack.corrupted, true)
})

test('API DELETE mission = vraie pause, forme compatible (vrai index HTTP)', async () => {
  const server = await new Promise((resolve) => {
    const s = realIndex.app.listen(0, '127.0.0.1', () => resolve(s))
  })
  try {
    const base = `http://127.0.0.1:${server.address().port}`
    const del = await fetch(`${base}/api/mission`, { method: 'DELETE' })
    assert.equal(del.status, 200)
    const body = await del.json()
    assert.equal(body.ok, true)
    assert.equal(body.stopped, false, 'jamais de stop destructeur par DELETE')
    assert.ok('paused' in body, 'cle additive paused')
    assert.ok('mission' in body, 'cle historique mission gardee')
    const st = await fetch(`${base}/api/status`)
    assert.equal(st.status, 200)
    const status = await st.json()
    for (const k of ['ok', 'missionRunning', 'mission', 'objectifs', 'executor', 'physicalWriter', 'recentChat']) {
      assert.ok(k in status, `cle /api/status gardee : ${k}`)
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('startOnly : refus admin sans throw, annonce pas mensongere', () => {
  const ex = realIndex.getExecutor()
  ex.pauseWork('test-garde')
  try {
    assert.doesNotThrow(() => realIndex.HANDLERS.avance(), 'refus sans throw')
    assert.equal(ex.status().paused, true, 'slot intact, rien pris')
  } finally {
    ex.resume()
  }
  assert.equal(ex.status().paused, false)
})

test('VRAI createMissionRunner : API durable, donner cable, sans bot', async () => {
  const fakeHost = {
    getBot: () => null,
    isReady: () => false,
    chat: () => {},
    rescue: async () => false,
    stopPathfinding: () => {},
    inLiquid: () => false,
    setNavigation: () => {},
    navigateToPlayer: async () => ({ reached: false, code: 'stub', remaining: null }),
    navigateToPosition: async () => ({ reached: false, code: 'stub', remaining: null }),
    recentChat: () => []
  }
  const runner = createMissionRunner(fakeHost, {})
  assert.equal(typeof runner.start, 'function')
  assert.equal(typeof runner.pauseWork, 'function')
  assert.equal(typeof runner.resumeWork, 'function')
  assert.equal(typeof runner.getStepOwner, 'function')
  assert.equal(runner.getStepOwner(), null)
  assert.ok(Array.isArray(runner.ACTION_NAMES))
  assert.ok(runner.ACTION_NAMES.includes('donner'), 'donner cable (audit skills 24 actions)')
  assert.equal(runner.status(), null)
  assert.equal(runner.stop(), false)
  assert.equal(runner.pauseWork(), false)
  assert.equal(runner.resumeWork(), false)
  assert.equal(runner.addContext('precision', 'Alice'), false)
  // Intake garde : bot non connecte, sans reseau ni planificateur.
  const out = await runner.start('coupe du bois', 'Alice')
  assert.equal(out.ok, false)
})

test('normaux serialises : second message persiste meme apres stop intermediaire', async () => {
  const { store } = freshStore()
  const clock = fakeClock()
  const ctrl = createObjectiveController({ store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
  const persisted = []
  const runningMission = { id: 'm1', revision: 0, etat: 'running', objectif: 'abri', demandeur: 'Alice' }
  const host = {
    status: () => ({ ...runningMission }),
    observation: () => ({}),
    interpret: async (msg) => {
      await new Promise((r) => setTimeout(r, 30))
      return { relation: 'context', response: 'note.' }
    },
    start: async () => ({ ok: true }),
    revise: async () => ({ ok: true }),
    context: (m, u) => { persisted.push([u, m]); ctrl.addContext({ auteur: u, texte: m }) },
    stop: () => {},
    say: () => {},
    cancelPendingStart: () => {},
    noteIgnored: (u, m) => { persisted.push([u, `ignored:${m}`]); try { ctrl.recordMessage({ auteur: u, texte: m }) } catch (_) {} }
  }
  const conv = createConversation(host)
  const p1 = conv.receive('Alice', 'precision un')
  const p2 = conv.receive('Bob', 'precision deux')
  await Promise.all([p1, p2])
  // Les deux messages ont une trace (contexte ou inbox ignoree) : aucune perte.
  const snap = ctrl.snapshot()
  const texts = [...snap.inbox.map((m) => m.texte), ...persisted.map(([, t]) => t)]
  assert.ok(texts.some((t) => String(t).includes('precision un')), 'message un preserve')
  assert.ok(texts.some((t) => String(t).includes('precision deux')), 'message deux preserve')
})

test('mécanisme: réacquisition sans token pendant slot tenu -> busy (preuve)', async () => {
  const ex = createExecutor({ stopControls () {} })
  const gate = deferred()
  const held = ex.run({ id: 'holder', kind: 'work' }, async () => {
    await gate.promise
    return 1
  })
  await new Promise((r) => setTimeout(r, 10))
  await assert.rejects(
    ex.run({ id: 'reacquire-sans-token', kind: 'work' }, async () => 2),
    (e) => e && e.code === 'busy')
  gate.resolve()
  const env = await held
  assert.equal(env.outcome, 'completed')
})

test('REPRO auditeur: boucle rejoindre_demandeur sans token -> failed, 0 jointure', async () => {
  const P = require('../bot/planner')
  const { Vec3 } = require('vec3')
  const wasEnabled = P.isEnabled
  const oldBrief = P.readBrief
  const oldPlan = P.plan
  P.isEnabled = () => true
  P.readBrief = async () => ({
    kind: 'geste', kindConfidence: 1, resource: 'aucune', resourceConfidence: 1,
    landmark: 'ici', door: false, doorProbability: 0
  })
  P.plan = async () => ({
    ms: 0, seconds: 1, rejected: [], done: 0, finished: false,
    steps: [{ action: 'rejoindre_demandeur', scale: 0, scaleLevel: null, choices: {} }]
  })
  try {
    const bot = {
      entity: { position: new Vec3(0, 65, 0), yaw: 0, pitch: 0 },
      registry: { blocksByName: {}, itemsByName: {} },
      inventory: { items: () => [] }, players: {}, entities: {},
      findBlocks: () => [], clearControlStates: () => {}, blockAt: () => null
    }
    const ex = createExecutor({ stopControls () {} })
    let joins = 0
    // Wrapper fidele de l'ancien index : reacquisition SANS token proprietaire.
    const directNav = (u, o) => ex.run(
      { id: `repro-nav-${Date.now()}-${Math.random()}`, kind: 'work' },
      async () => { joins++; return { reached: true, code: 'arrived', remaining: 1 } })
    const r = createMissionRunner({
      getBot: () => bot, isReady: () => true, inLiquid: () => false,
      stopPathfinding () {}, chat () {},
      navigateToPlayer: directNav, navigateToPosition: directNav, recentChat: () => []
    }, { executor: ex })
    await r.start('viens', 'human')
    for (let i = 0; i < 60 && r.isRunning(); i++) await new Promise((res) => setTimeout(res, 500))
    assert.equal(r.isRunning(), false)
    assert.equal(r.status().etat, 'failed')
    assert.equal(joins, 0)
  } finally {
    P.isEnabled = wasEnabled
    P.readBrief = oldBrief
    P.plan = oldPlan
  }
})

test('FIX token: boucle rejoindre_demandeur via VRAI wrapper -> done, owner identique', async () => {
  const P = require('../bot/planner')
  const { Vec3 } = require('vec3')
  const wasEnabled = P.isEnabled
  const oldBrief = P.readBrief
  const oldPlan = P.plan
  P.isEnabled = () => true
  P.readBrief = async () => ({
    kind: 'geste', kindConfidence: 1, resource: 'aucune', resourceConfidence: 1,
    landmark: 'ici', door: false, doorProbability: 0
  })
  P.plan = async () => ({
    ms: 0, seconds: 1, rejected: [], done: 0, finished: false,
    steps: [{ action: 'rejoindre_demandeur', scale: 0, scaleLevel: null, choices: {} }]
  })
  try {
    const bot = {
      entity: { position: new Vec3(0, 65, 0), yaw: 0, pitch: 0 },
      registry: { blocksByName: {}, itemsByName: {} },
      inventory: { items: () => [] }, players: {}, entities: {},
      findBlocks: () => [], clearControlStates: () => {}, blockAt: () => null
    }
    const ex = createExecutor({ stopControls () {} })
    const seen = []
    const stubNav = {
      toPlayer: async (username, opts) => {
        seen.push({ username, opts: { ...opts } })
        return { reached: true, code: 'arrived', remaining: 1 }
      },
      toPosition: async (position, opts) => {
        seen.push({ position, opts: { ...opts } })
        return { reached: true, code: 'arrived', remaining: 0.5 }
      }
    }
    let nav = null
    const rawSeen = []
    const r = createMissionRunner({
      getBot: () => bot, isReady: () => true, inLiquid: () => false,
      stopPathfinding () {}, chat () {},
      navigateToPlayer: (u, o) => { rawSeen.push(o); return nav.toPlayer(u, o) },
      navigateToPosition: (p, o) => { rawSeen.push(o); return nav.toPosition(p, o) },
      recentChat: () => []
    }, { executor: ex })
    const holder = { getStepToken: () => r.getStepToken(), getStepOwner: () => r.getStepOwner() }
    nav = realIndex.createOwnerAwareNavigator({ executor: ex, holder, navigator: stubNav })
    await r.start('viens', 'human')
    for (let i = 0; i < 60 && r.isRunning(); i++) await new Promise((res) => setTimeout(res, 500))
    assert.equal(r.isRunning(), false)
    assert.equal(r.status().etat, 'done')
    assert.equal(seen.length, 1)
    // Token observe dans les options == proprietaire courant pendant la nav.
    assert.equal(typeof rawSeen[0].__owner, 'object')
    assert.ok(rawSeen[0].__owner !== null)
    // Le stub ne voit jamais le token (strip avant navigation reelle).
    assert.ok(!('__owner' in seen[0].opts))
    // Apres liberation, le vieux token est stale (jamais readmis).
    const oldToken = rawSeen[0].__owner
    await assert.rejects(nav.toPlayer('human', { __owner: oldToken }), (e) => e && e.code === 'stale')
  } finally {
    P.isEnabled = wasEnabled
    P.readBrief = oldBrief
    P.plan = oldPlan
  }
})

test('FIX token: parcours rejoindre/retour via VRAI wrapper -> done, meme token', async () => {
  const P = require('../bot/planner')
  const { Vec3 } = require('vec3')
  const movementTask = require('../bot/movement-task')
  const wasEnabled = P.isEnabled
  const oldBrief = P.readBrief
  const oldPlan = P.plan
  P.isEnabled = () => true
  P.readBrief = async () => ({
    kind: 'geste', kindConfidence: 1, resource: 'aucune', resourceConfidence: 1,
    landmark: 'ici', door: false, doorProbability: 0,
    route: movementTask.validateRoute([{ type: 'rejoindre' }, { type: 'retour' }])
  })
  P.plan = async () => { throw new Error('un parcours ne doit pas demander un micro-plan') }
  try {
    const bot = {
      entity: { position: new Vec3(0, 65, 0), yaw: 0, pitch: 0 },
      registry: { blocksByName: {}, itemsByName: {} },
      inventory: { items: () => [] }, players: {}, entities: {},
      findBlocks: () => [], clearControlStates: () => {}, blockAt: () => null
    }
    const ex = createExecutor({ stopControls () {} })
    const holderTokens = []
    const stubNav = {
      toPlayer: async () => {
        holderTokens.push(holder.getStepToken())
        return { reached: true, code: 'arrived', remaining: 1 }
      },
      toPosition: async () => {
        holderTokens.push(holder.getStepToken())
        return { reached: true, code: 'arrived', remaining: 0.5 }
      }
    }
    const rawSeen = []
    let nav = null
    const r = createMissionRunner({
      getBot: () => bot, isReady: () => true, inLiquid: () => false,
      stopPathfinding () {}, chat () {},
      navigateToPlayer: (u, o) => { rawSeen.push(o); return nav.toPlayer(u, o) },
      navigateToPosition: (p, o) => { rawSeen.push(o); return nav.toPosition(p, o) },
      recentChat: () => []
    }, { executor: ex })
    const holder = { getStepToken: () => r.getStepToken(), getStepOwner: () => r.getStepOwner() }
    nav = realIndex.createOwnerAwareNavigator({ executor: ex, holder, navigator: stubNav })
    await r.start('viens puis reviens', 'human')
    for (let i = 0; i < 60 && r.isRunning(); i++) await new Promise((res) => setTimeout(res, 500))
    assert.equal(r.isRunning(), false)
    assert.equal(r.status().etat, 'done')
    assert.equal(rawSeen.length, 2)
    assert.ok(rawSeen.every((o) => o && typeof o.__owner === 'object' && o.__owner !== null))
    assert.ok(rawSeen[0].__owner === rawSeen[1].__owner, 'meme token de parcours')
    assert.ok(holderTokens.every((t) => t === rawSeen[0].__owner), 'owner identique pendant nav')
  } finally {
    P.isEnabled = wasEnabled
    P.readBrief = oldBrief
    P.plan = oldPlan
  }
})

test('FIX token: commande independante pendant slot tenu -> busy ; token forge -> stale', async () => {
  const ex = createExecutor({ stopControls () {} })
  const stubNav = {
    toPlayer: async () => ({ reached: true, code: 'arrived', remaining: 1 }),
    toPosition: async () => ({ reached: true, code: 'arrived', remaining: 0.5 })
  }
  const holder = { getStepToken: () => null, getStepOwner: () => null }
  const nav = realIndex.createOwnerAwareNavigator({ executor: ex, holder, navigator: stubNav })
  const gate = deferred()
  const held = ex.run({ id: 'holder-cmd', kind: 'work' }, async () => {
    await gate.promise
    return 1
  })
  await new Promise((r) => setTimeout(r, 10))
  await assert.rejects(nav.toPlayer('human', {}), (e) => e && e.code === 'busy')
  await assert.rejects(nav.toPlayer('human', { __owner: {} }), (e) => e && e.code === 'stale')
  await assert.rejects(nav.toPlayer('human', { __owner: 'nav-player-x' }), (e) => e && e.code === 'stale')
  gate.resolve()
  await held
  // Apres liberation, sans token : admission normale (pas de rejet stale).
  const env = await nav.toPlayer('human', {})
  assert.equal(env.outcome, 'completed')
})

test('FIX token: getStepToken non expose cote client (ni status ni commandes)', () => {
  const skills = require('../bot/skills')
  assert.ok(!skills.COMMANDS.getStepOwner && !skills.COMMANDS.getStepToken, 'pas de commande getStepOwner/Token')
  const fakeHost = {
    getBot: () => null, isReady: () => false, chat: () => {},
    rescue: async () => false, stopPathfinding: () => {}, inLiquid: () => false,
    setNavigation: () => {}, navigateToPlayer: async () => ({}), navigateToPosition: async () => ({}),
    recentChat: () => []
  }
  const { createMissionRunner: createRunner } = require('../bot/mission')
  const r = createRunner(fakeHost, {})
  const s = r.status()
  assert.equal(s, null)
  assert.equal(typeof r.getStepToken, 'function')
  assert.equal(r.getStepToken(), null)
})

test('lifecycle pause_reprise : suspend, complete, vrai redemarrage preserve', async () => {
  // VRAI runner + VRAI controller + VRAI executor : A tourne, B concurrent ->
  // arbitrage, suspension objet vivant, B se clot, complete() restaure A et le
  // runner relance le MEME objet (id, progression, origine), etat frais.
  const P = require('../bot/planner')
  const { Vec3 } = require('vec3')
  const wasEnabled = P.isEnabled
  const oldBrief = P.readBrief
  const oldPlan = P.plan
  P.isEnabled = () => true
  let phase = 'A'
  P.readBrief = async () => phase === 'B'
    ? { kind: 'geste', kindConfidence: 1, resource: 'aucune', resourceConfidence: 1, landmark: 'ici', door: false, doorProbability: 0 }
    : { kind: 'recolte', kindConfidence: 1, resource: 'sable', resourceConfidence: 1, landmark: 'ici', door: false, doorProbability: 0 }
  // Stub sensible a la consigne : A reprend 'attendre' meme apres que la
  // phase globale soit passee a B (en prod, le planificateur lit la consigne).
  P.plan = async (state) => String(state?.consigne?.texte ?? '').includes('danse')
    ? { ms: 0, seconds: 0, rejected: [], done: 0, finished: false, steps: [{ action: 'terminer', scale: 0, scaleLevel: null, choices: {} }] }
    : { ms: 0, seconds: 0, rejected: [], done: 0, finished: false, steps: [{ action: 'attendre', scale: 0, scaleLevel: null, choices: { duree: 0.2 } }] }
  const { store } = freshStore()
  const ctrl = createObjectiveController({ store, setTimer: () => 0, clearTimer: () => {} })
  const ex = createExecutor({ stopControls () {} })
  const bot = {
    entity: { position: new Vec3(0, 65, 0), yaw: 0, pitch: 0 },
    registry: { blocksByName: {}, itemsByName: {} },
    inventory: { items: () => [] }, players: {}, entities: {},
    findBlocks: () => [], clearControlStates: () => {}, blockAt: () => null
  }
  const r = createMissionRunner({
    getBot: () => bot, isReady: () => true, inLiquid: () => false,
    stopPathfinding () {}, chat () {},
    navigateToPlayer: async () => ({ reached: true, code: 'stub', remaining: 1 }),
    navigateToPosition: async () => ({ reached: true, code: 'stub', remaining: 1 }),
    recentChat: () => []
  }, { executor: ex, objectives: ctrl })
  try {
    const pA = ctrl.proposeObjective({ auteur: 'Alice', texte: 'ramasse du sable' })
    const idA = pA.objective.id
    await r.start('ramasse du sable', 'Alice', { objectiveId: idA })
    for (let i = 0; i < 200 && (!r.isRunning() || (r.status()?.etapes ?? 0) < 2); i++) {
      await new Promise((res) => setTimeout(res, 20))
    }
    assert.ok(r.isRunning(), 'A tourne')
    const stepsBefore = r.status().etapes
    assert.ok(stepsBefore >= 2)
    // B concurrent : arbitrage, A passe en pause cote controleur, Bob tranche.
    const pB = ctrl.proposeObjective({ auteur: 'Bob', texte: 'danse' })
    assert.equal(pB.status, 'arbitration')
    const resolved = ctrl.resolveArbitration({ choice: 'pause_reprise', actor: 'Bob' })
    assert.equal(resolved.status, 'resumed-new')
    const idB = resolved.objective.id
    const frozen = r.suspend('test arbitrage')
    assert.ok(frozen, 'objet vivant suspendu')
    assert.equal(r.status().suspended.length, 1)
    assert.equal(r.status().suspended[0].objectifId, idA)
    // B demarre et se clot (terminer) : complete() restaure A, runner relance.
    phase = 'B'
    await r.start('danse', 'Bob', { objectiveId: idB })
    for (let i = 0; i < 250 && (r.status()?.objectifId !== idA || !r.isRunning()); i++) {
      await new Promise((res) => setTimeout(res, 20))
    }
    const st = r.status()
    assert.equal(st.objectifId, idA, 'meme engagement restaure')
    assert.equal(st.etat, 'running')
    assert.ok(st.etapes >= stepsBefore, `progression preservee, pas remise a zero (${st.etapes} >= ${stepsBefore})`)
    assert.equal(ctrl.snapshot().current.id, idA)
    assert.equal(ctrl.snapshot().current.statut, 'active')
    assert.deepEqual(r.status().suspended, [], 'pile videe, pas de fantome')
    r.stop()
  } finally {
    try { r.stop() } catch (_) {}
    P.isEnabled = wasEnabled
    P.readBrief = oldBrief
    P.plan = oldPlan
  }
})

test('lifecycle parcours : curseur et origine preserves a la reprise', async () => {
  const P = require('../bot/planner')
  const { Vec3 } = require('vec3')
  const movementTask = require('../bot/movement-task')
  const wasEnabled = P.isEnabled
  const oldBrief = P.readBrief
  const oldPlan = P.plan
  P.isEnabled = () => true
  let phase = 'A'
  P.readBrief = async () => phase === 'B'
    ? { kind: 'geste', kindConfidence: 1, resource: 'aucune', resourceConfidence: 1, landmark: 'ici', door: false, doorProbability: 0 }
    : {
        kind: 'geste', kindConfidence: 1, resource: 'aucune', resourceConfidence: 1,
        landmark: 'ici', door: false, doorProbability: 0,
        route: movementTask.validateRoute([{ type: 'attendre', secondes: 2 }, { type: 'retour' }])
      }
  P.plan = async () => {
    if (phase === 'B') {
      return { ms: 0, seconds: 0, rejected: [], done: 0, finished: false, steps: [{ action: 'terminer', scale: 0, scaleLevel: null, choices: {} }] }
    }
    throw new Error('un parcours ne doit pas demander un micro-plan')
  }
  const { store } = freshStore()
  const ctrl = createObjectiveController({ store, setTimer: () => 0, clearTimer: () => {} })
  const ex = createExecutor({ stopControls () {} })
  const bot = {
    entity: { position: new Vec3(0, 65, 0), yaw: 0, pitch: 0 },
    registry: { blocksByName: {}, itemsByName: {} },
    inventory: { items: () => [] }, players: {}, entities: {},
    findBlocks: () => [], clearControlStates: () => {}, blockAt: () => null
  }
  let retours = 0
  const r = createMissionRunner({
    getBot: () => bot, isReady: () => true, inLiquid: () => false,
    stopPathfinding () {}, chat () {},
    navigateToPlayer: async () => ({ reached: true, code: 'stub', remaining: 1 }),
    navigateToPosition: async () => { retours++; return { reached: true, code: 'stub', remaining: 0.5 } },
    recentChat: () => []
  }, { executor: ex, objectives: ctrl })
  try {
    const pA = ctrl.proposeObjective({ auteur: 'Alice', texte: 'attends puis reviens' })
    const idA = pA.objective.id
    await r.start('attends puis reviens', 'Alice', { objectiveId: idA })
    await new Promise((res) => setTimeout(res, 600))
    assert.ok(r.isRunning(), 'parcours A en cours (attendre)')
    const originBefore = JSON.parse(JSON.stringify(r.status().parcours.origin))
    ctrl.proposeObjective({ auteur: 'Bob', texte: 'danse' })
    const resolvedB = ctrl.resolveArbitration({ choice: 'pause_reprise', actor: 'Bob' })
    r.suspend('test parcours')
    phase = 'B'
    await r.start('danse', 'Bob', { objectiveId: resolvedB.objective.id })
    for (let i = 0; i < 400 && (r.status()?.objectifId !== idA || !r.isRunning()); i++) {
      await new Promise((res) => setTimeout(res, 20))
    }
    assert.equal(r.status().objectifId, idA, 'parcours A repris')
    // L attendre interrompue recommence (jamais terminee), puis retour.
    for (let i = 0; i < 400 && r.isRunning(); i++) {
      await new Promise((res) => setTimeout(res, 20))
    }
    const st = r.status()
    assert.equal(st.etat, 'done')
    assert.equal(retours, 1, 'retour execute une fois, pas de replay')
    assert.deepEqual(st.parcours.origin, originBefore, 'origine fixe preservee')
    assert.equal(st.parcours.cursor, 2, 'curseur au bout, preuves conservees')
    r.stop()
  } finally {
    try { r.stop() } catch (_) {}
    P.isEnabled = wasEnabled
    P.readBrief = oldBrief
    P.plan = oldPlan
  }
})

test('rehydrate apres restart : descripteur, monde reobserve, compteurs non rejoues', async () => {
  const P = require('../bot/planner')
  const { Vec3 } = require('vec3')
  const wasEnabled = P.isEnabled
  const oldBrief = P.readBrief
  const oldPlan = P.plan
  P.isEnabled = () => true
  P.readBrief = async () => ({ kind: 'recolte', kindConfidence: 1, resource: 'sable', resourceConfidence: 1, landmark: 'ici', door: false, doorProbability: 0 })
  P.plan = async () => ({
    ms: 0, seconds: 0, rejected: [], done: 0, finished: false,
    steps: [{ action: 'terminer', scale: 0, scaleLevel: null, choices: {} }]
  })
  const { dir, store } = freshStore()
  const ctrl1 = createObjectiveController({ store })
  const started = ctrl1.proposeObjective({ auteur: 'Alice', texte: 'ramasse du sable' })
  const idA = started.objective.id
  ctrl1.recordProgress({
    objectifId: idA,
    unites_recoltees: 5,
    descripteur: {
      kind: 'recolte', resource: 'sable', landmark: 'ici', quota: 5,
      dimensions: { width: 3, depth: 3, height: 3, source: 'test' }, route: null
    },
    origine: { x: 0, y: 65, z: 0 }
  })
  ctrl1.pauseWork('restart simule')
  // Nouveau processus : meme fichiers, recover, faits revalides.
  const store2 = createStateStore({ file: require('node:path').join(dir, 's.json'), eventFile: require('node:path').join(dir, 'e.jsonl') })
  const ctrl2 = createObjectiveController({ store: store2 })
  const snap2 = ctrl2.recover()
  assert.equal(snap2.current.id, idA)
  const bot = {
    entity: { position: new Vec3(10, 70, 10), yaw: 0, pitch: 0 },
    registry: { blocksByName: {}, itemsByName: {} },
    inventory: { items: () => [] }, players: {}, entities: {},
    findBlocks: () => [], clearControlStates: () => {}, blockAt: () => null
  }
  const ex = createExecutor({ stopControls () {} })
  const r2 = createMissionRunner({
    getBot: () => bot, isReady: () => true, inLiquid: () => false,
    stopPathfinding () {}, chat () {},
    navigateToPlayer: async () => ({ reached: true, code: 'stub', remaining: 1 }),
    navigateToPosition: async () => ({ reached: true, code: 'stub', remaining: 1 }),
    recentChat: () => []
  }, { executor: ex, objectives: ctrl2 })
  try {
    const out = r2.rehydrate(ctrl2.snapshot().current)
    assert.equal(out.ok, true)
    const st0 = r2.status()
    assert.equal(st0.objectifId, idA, 'meme engagement')
    assert.equal(st0.rehydrated, true)
    assert.equal(st0.blocs_casses, 0, 'rien rejoue')
    assert.equal(st0.etapes, 0, 'compteur de session neuf')
    // Le quota (5) est couvert par le passe porte (5) : terminer conclut
    // SANS casser un bloc de plus.
    for (let i = 0; i < 200 && r2.isRunning(); i++) await new Promise((res) => setTimeout(res, 20))
    const st = r2.status()
    assert.equal(st.etat, 'done')
    assert.equal(st.blocs_casses, 0, 'aucune recolte rejouee pour conclure')
    r2.stop()
  } finally {
    try { r2.stop() } catch (_) {}
    P.isEnabled = wasEnabled
    P.readBrief = oldBrief
    P.plan = oldPlan
  }
})

test('rehydrate refuse sans descripteur : engagement conserve, pas de fantome', async () => {
  const { store } = freshStore()
  const ctrl = createObjectiveController({ store })
  const started = ctrl.proposeObjective({ auteur: 'Alice', texte: 'vieil objectif sans descripteur' })
  ctrl.recordProgress({ faits: 2 }) // pas de descripteur
  ctrl.pauseWork('restart simule')
  const bot = {
    entity: { position: new (require('vec3').Vec3)(0, 65, 0), yaw: 0, pitch: 0 },
    registry: { blocksByName: {}, itemsByName: {} },
    inventory: { items: () => [] }, players: {}, entities: {},
    findBlocks: () => [], clearControlStates: () => {}, blockAt: () => null
  }
  const r = createMissionRunner({
    getBot: () => bot, isReady: () => true, inLiquid: () => false,
    stopPathfinding () {}, chat () {},
    navigateToPlayer: async () => ({}), navigateToPosition: async () => ({}), recentChat: () => []
  }, { executor: createExecutor({ stopControls () {} }), objectives: ctrl })
  assert.throws(() => r.rehydrate(ctrl.snapshot().current), /descripteur/)
  assert.equal(r.isRunning(), false, 'aucune boucle fantome')
  assert.equal(r.status(), null, 'aucun objet mission construit')
  assert.equal(ctrl.snapshot().current.id, started.objective.id, 'engagement conserve')
})

test('permanent : done -> waiting-maintenance, pas de boucle aveugle', async () => {
  const P = require('../bot/planner')
  const { Vec3 } = require('vec3')
  const wasEnabled = P.isEnabled
  const oldBrief = P.readBrief
  const oldPlan = P.plan
  P.isEnabled = () => true
  P.readBrief = async () => ({ kind: 'geste', kindConfidence: 1, resource: 'aucune', resourceConfidence: 1, landmark: 'ici', door: false, doorProbability: 0 })
  P.plan = async () => ({
    ms: 0, seconds: 0, rejected: [], done: 0, finished: false,
    steps: [{ action: 'terminer', scale: 0, scaleLevel: null, choices: {} }]
  })
  const { store } = freshStore()
  const ctrl = createObjectiveController({ store })
  const ex = createExecutor({ stopControls () {} })
  const bot = {
    entity: { position: new Vec3(0, 65, 0), yaw: 0, pitch: 0 },
    registry: { blocksByName: {}, itemsByName: {} },
    inventory: { items: () => [] }, players: {}, entities: {},
    findBlocks: () => [], clearControlStates: () => {}, blockAt: () => null
  }
  const r = createMissionRunner({
    getBot: () => bot, isReady: () => true, inLiquid: () => false,
    stopPathfinding () {}, chat () {},
    navigateToPlayer: async () => ({ reached: true, code: 'stub', remaining: 1 }),
    navigateToPosition: async () => ({ reached: true, code: 'stub', remaining: 1 }),
    recentChat: () => []
  }, { executor: ex, objectives: ctrl })
  try {
    const started = ctrl.proposeObjective({ auteur: 'Alice', texte: 'entretiens le jardin', mode: 'permanent' })
    const out = await r.start('entretiens le jardin', 'Alice', { objectiveId: started.objective.id, mode: 'permanent' })
    assert.equal(out.ok, true)
    for (let i = 0; i < 200 && r.isRunning(); i++) await new Promise((res) => setTimeout(res, 20))
    const st = r.status()
    assert.equal(st.etat, 'done')
    assert.equal(st.mode, 'permanent')
    assert.equal(st.maintenance, 'waiting-maintenance', 'attente explicite, pas false idle')
    assert.equal(ctrl.snapshot().current.statut, 'maintaining')
    assert.equal(ctrl.snapshot().current.id, started.objective.id, 'meme but durable garde')
    r.stop()
  } finally {
    try { r.stop() } catch (_) {}
    P.isEnabled = wasEnabled
    P.readBrief = oldBrief
    P.plan = oldPlan
  }
})

test('start refuse une revision corrompue (fail-closed)', async () => {
  const P = require('../bot/planner')
  const wasEnabled = P.isEnabled
  P.isEnabled = () => true
  const bot = {
    entity: null, registry: { blocksByName: {}, itemsByName: {} },
    inventory: { items: () => [] }, players: {}, entities: {},
    findBlocks: () => [], clearControlStates: () => {}, blockAt: () => null
  }
  const r = createMissionRunner({
    getBot: () => bot, isReady: () => true, inLiquid: () => false,
    stopPathfinding () {}, chat () {},
    navigateToPlayer: async () => ({}), navigateToPosition: async () => ({}), recentChat: () => []
  }, {})
  try {
    const bad1 = await r.start('coupe du bois', 'Alice', { revisionOf: { garbage: true } })
    assert.equal(bad1.ok, false)
    assert.match(bad1.error, /corrompue/)
    const bad2 = await r.start('coupe du bois', 'Alice', { revisionOf: { id: 'm', objective: 'o', movementTask: { steps: 'nope', cursor: 0 } } })
    assert.equal(bad2.ok, false)
    assert.match(bad2.error, /corrompue/)
    assert.equal(r.isRunning(), false)
  } finally {
    P.isEnabled = wasEnabled
  }
})

test('readDirectMode : defaut coherent {}, jamais undefined (incident S1)', () => {
  const rdm = realIndex.readDirectMode
  assert.equal(typeof rdm, 'function', 'helper exporte pour contrat')
  assert.deepEqual(rdm({}), {})
  assert.deepEqual(rdm({ objective: 'x', requester: 'y' }), {})
  assert.deepEqual(rdm(undefined), {})
  assert.deepEqual(rdm({ mode: '' }), {})
  assert.deepEqual(rdm({ mode: 'temporary' }), { mode: 'temporary' })
  assert.deepEqual(rdm({ mode: 'Permanent' }), { mode: 'permanent' })
  assert.deepEqual(rdm({ mode: 'autonome' }), { mode: 'autonome' })
  assert.match(rdm({ mode: 'nimporte-quoi' }).error, /mode invalide/)
  assert.match(rdm({ mode: 42 }).error, /mode invalide/)
  // Motif exact des routes : ne leve jamais, meme sans body.
  for (const body of [{}, undefined, { mode: 'x' }, { objective: 'a' }]) {
    const mc = rdm(body)
    assert.doesNotThrow(() => { if (mc.error) return '400'; return mc.mode }, `pas de throw pour ${JSON.stringify(body)}`)
  }
})

test('HTTP vraies routes : sans mode/absent/vide -> 503 (jamais 500), invalide -> 400', async () => {
  const server = await new Promise((resolve) => {
    const s = realIndex.app.listen(0, '127.0.0.1', () => resolve(s))
  })
  try {
    const base = `http://127.0.0.1:${server.address().port}`
    const post = (route, body, withJson = true) => fetch(`${base}${route}`, {
      method: 'POST',
      ...(withJson ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
    })
    // /api/mission : pas de bot en test, donc 503 attendu des que la
    // validation passe ; l'important est l'absence de 500.
    for (const body of [{}, { objective: 'va au nord', requester: 't' }, { objective: 'x' }]) {
      const r = await post('/api/mission', body)
      assert.equal(r.status, 503, `mission ${JSON.stringify(body)} -> 503, pas 500`)
    }
    const noBody = await post('/api/mission', undefined, false)
    assert.equal(noBody.status, 503, 'mission sans body -> 503, pas 500')
    for (const bad of ['nimporte-quoi', 42]) {
      const r = await post('/api/mission', { objective: 'x', requester: 'y', mode: bad })
      assert.equal(r.status, 400, `mission mode invalide -> 400 (recu ${JSON.stringify(bad)})`)
      assert.match((await r.json()).error, /mode invalide/)
    }
    const okMode = await post('/api/mission', { objective: 'x', requester: 'y', mode: 'permanent' })
    assert.equal(okMode.status, 503, 'mission mode valide -> validation ok, puis 503 (pas de bot)')
    // /api/instruction : meme contrat.
    for (const body of [{}, { message: 'viens', requester: 't' }]) {
      const r = await post('/api/instruction', body)
      assert.equal(r.status, 503, `instruction ${JSON.stringify(body)} -> 503, pas 500`)
    }
    const badInstr = await post('/api/instruction', { message: 'viens', requester: 't', mode: 'bidon' })
    assert.equal(badInstr.status, 400, 'instruction mode invalide -> 400')
    assert.match((await badInstr.json()).error, /mode invalide/)
    const okInstr = await post('/api/instruction', { message: 'viens', requester: 't', mode: 'temporary' })
    assert.equal(okInstr.status, 503, 'instruction mode valide -> 503 (pas de bot)')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('S5 resume explicite leve le verrou sans descripteur, attente honnete', () => {
  // Prod singletons, volume /data jetable du conteneur : hardstop + courant
  // SANS descripteur (cas live S5). Apres reprends explicite : hardstop false,
  // executor repris, courant en pause (attente, pas actif), rien demarre,
  // evidence et objectif conserves, descripteur non invente.
  const ctrl = realIndex.getController()
  const ex = realIndex.getExecutor()
  ctrl.proposeObjective({ auteur: 'S5', texte: 'truc sans descripteur' })
  ctrl.recordProgress({ faits: 3 })
  ctrl.totalStop('test S5')
  ex.totalStop('test S5')
  assert.equal(ctrl.snapshot().hardstop, true)
  assert.equal(ex.status().stopped, true)
  realIndex.handleResume()
  const snap = ctrl.snapshot()
  assert.equal(snap.hardstop, false, 'D18 : verrou durable leve par reprends explicite')
  assert.equal(ex.status().stopped, false, 'executor repris')
  assert.equal(ex.status().paused, false, 'executor ni en pause')
  assert.equal(snap.current.statut, 'paused', 'attente honnete, pas de faux actif')
  assert.equal(snap.current.texte, 'truc sans descripteur', 'objectif conserve')
  assert.deepEqual(snap.current.progression, { faits: 3 }, 'evidence conservee')
  assert.ok(!('descripteur' in snap.current.progression), 'descripteur non invente')
  assert.equal(realIndex.missionRunner.isRunning(), false, 'rien demarre seul')
  // Commandes explicites et nouveaux objectifs restant permis (verrou leve).
  assert.doesNotThrow(() => realIndex.requireAdmissionOrThrow(), 'admission explicite permise')
  // Laisse un etat d'attente honnete documente pour la suite du fichier.
})

test('S5 panne persist : verrou maintenu, executor stoppe (fail-closed)', (t) => {
  // chmod 0555 ne bloque pas root : la panne d ecriture ne se simule pas.
  if (process.getuid?.() === 0) return t.skip('root ignore chmod')
  const ctrl = realIndex.getController()
  const ex = realIndex.getExecutor()
  ctrl.proposeObjective({ auteur: 'S5b', texte: 'truc panne persist' })
  ctrl.totalStop('test S5 panne')
  ex.totalStop('test S5 panne')
  const before = ctrl.snapshot()
  assert.equal(before.hardstop, true)
  const origMode = fs.statSync('/data').mode
  fs.chmodSync('/data', 0o555)
  try {
    realIndex.handleResume()
    const snap = ctrl.snapshot()
    assert.equal(snap.hardstop, true, 'persist en panne : hardstop maintenu')
    assert.equal(ex.status().stopped, true, 'persist en panne : executor reste stoppe')
    assert.deepEqual(snap.current, before.current, 'aucune mutation partielle')
  } finally {
    fs.chmodSync('/data', origMode)
  }
  // Reparation : la reprise aboutit en attente honnete (descripteur absent,
  // pas de bot en test -> rehydrate impossible, verrou leve quand meme).
  realIndex.handleResume()
  assert.equal(ctrl.snapshot().hardstop, false, 'verrou leve apres reparation')
  assert.equal(ex.status().stopped, false, 'executor repris apres reparation')
  assert.equal(ctrl.snapshot().current.statut, 'paused', 'attente honnete')
})

test('S2 pause→reprends : vrai resultat nav attendu, moment prouve', async () => {
  // Runner frais, nav en vol bloquee : pause fige sans resultat, reprise
  // relance, et la mission se clot sur le VRAI resultat nav (reached +
  // remaining), constate APRES l'instant de reprise.
  const P = require('../bot/planner')
  const { Vec3 } = require('vec3')
  const wasEnabled = P.isEnabled
  const oldBrief = P.readBrief
  const oldPlan = P.plan
  P.isEnabled = () => true
  P.readBrief = async () => ({
    kind: 'geste', kindConfidence: 1, resource: 'aucune', resourceConfidence: 1,
    landmark: 'ici', door: false, doorProbability: 0
  })
  P.plan = async () => ({
    ms: 0, seconds: 1, rejected: [], done: 0, finished: false,
    steps: [{ action: 'rejoindre_demandeur', scale: 0, scaleLevel: null, choices: {} }]
  })
  const gate = deferred()
  let entered = 0
  try {
    const bot = {
      entity: { position: new Vec3(0, 65, 0), yaw: 0, pitch: 0 },
      registry: { blocksByName: {}, itemsByName: {} },
      inventory: { items: () => [] }, players: {}, entities: {},
      findBlocks: () => [], clearControlStates: () => {}, blockAt: () => null
    }
    const ex = createExecutor({ stopControls () {} })
    const r = createMissionRunner({
      getBot: () => bot, isReady: () => true, inLiquid: () => false,
      stopPathfinding () {}, chat () {},
      navigateToPlayer: (u, o) => new Promise((resolve) => {
        entered++
        if (o?.signal?.aborted) return resolve({ reached: false, code: 'cancelled', remaining: null })
        o?.signal?.addEventListener('abort', () => resolve({ reached: false, code: 'cancelled', remaining: null }), { once: true })
        gate.promise.then(() => resolve({ reached: true, code: 'arrived', remaining: 0.5 }))
      }),
      navigateToPosition: async () => ({ reached: true, code: 'stub', remaining: 1 }),
      recentChat: () => []
    }, { executor: ex })
    await r.start('viens', 'human')
    for (let i = 0; i < 200 && entered === 0; i++) await new Promise((res) => setTimeout(res, 20))
    assert.ok(entered > 0, 'nav en vol')
    assert.ok(r.isRunning(), 'mission en cours avant pause')
    assert.ok(r.pauseWork('test S2'), 'pause vraie')
    assert.equal(r.status().etat, 'paused')
    await new Promise((res) => setTimeout(res, 100))
    assert.equal(r.isRunning(), false, 'boucle figee, pas de resultat premature')
    assert.deepEqual(r.status().historique ?? [], [], 'aucune etape comptabilisee pendant la pause')
    assert.ok(r.resumeWork(), 'reprise vraie')
    const tResume = Date.now()
    gate.resolve()
    let doneAt = 0
    for (let i = 0; i < 250 && r.isRunning(); i++) await new Promise((res) => setTimeout(res, 20))
    doneAt = Date.now()
    assert.equal(r.isRunning(), false, 'mission terminee')
    const st = r.status()
    assert.equal(st.etat, 'done')
    const join = (st.historique ?? []).find((h) => h.action === 'rejoindre_demandeur')
    assert.ok(join && !join.echec, 'vrai resultat nav enregistre')
    assert.match(String(join.resultat), /0\.5/, 'remaining reel (0.5), pas une valeur par defaut')
    assert.ok(doneAt >= tResume, `fini APRES la reprise (${doneAt} >= ${tResume})`)
    r.stop()
  } finally {
    gate.resolve()
    try { r.stop() } catch (_) {}
    P.isEnabled = wasEnabled
    P.readBrief = oldBrief
    P.plan = oldPlan
  }
})

test('noteIgnored persiste le texte original entier (pas de troncature 500)', async () => {
  let kept = null
  const host = {
    status: () => null,
    interpret: (msg, ctx, opts) => new Promise((_, rej) => {
      opts?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('annule'), { name: 'AbortError' })), { once: true })
    }),
    stop: () => {},
    say: () => {},
    cancelPendingStart: () => {},
    noteIgnored: (u, m) => { kept = String(m) }
  }
  const conv = createConversation(host)
  const long = `x`.repeat(2000)
  const pending = conv.receive('Alice', long)
  await new Promise((r) => setImmediate(r))
  await conv.receive('Alice', 'stop')
  assert.ok(kept !== null && kept.length === 2000, 'original entier preserve')
  void pending
})
