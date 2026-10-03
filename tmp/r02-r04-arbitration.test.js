'use strict'
// R02 (live vs journal) + R04 (machine d etat arbitrage).
// Conventions : node:test + assert/strict, CommonJS, persistance sous
// os.tmpdir via bot/state-store.js, faux clock injecte (aucun timer reel).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createStateStore } = require('../bot/state-store')
const { createObjectiveController } = require('../bot/objective-controller')

function freshStore () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r02-r04-'))
  const file = path.join(dir, 'snapshot.json')
  const eventFile = path.join(dir, 'events.jsonl')
  const store = createStateStore({ file, eventFile })
  return { dir, file, eventFile, store }
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
    pendingIds: () => [...timers.entries()].filter(([, e]) => !e.cleared).map(([id]) => id),
    lastId: () => seq
  }
}

function countType (lives, type) {
  return lives.filter((e) => e && e.type === type).length
}

function invariantNoActiveWithArbitration (snap) {
  if (snap.arbitration) {
    assert.notEqual(snap.current && snap.current.statut, 'active', 'invariant R04 : ancien jamais active tant que arbitration!=null')
  }
}

test('R02 : panne journal + timeout + stop recent + rejeu -> flush sans reprise physique', () => {
  const s = freshStore()
  const clock = fakeClock()
  const lives = []
  let journalOk = false
  const flaky = {
    load: s.store.load,
    save: s.store.save,
    readEvents: s.store.readEvents,
    appendEvent: (evt) => {
      if (!journalOk) throw new Error('journal hs')
      return s.store.appendEvent(evt)
    }
  }
  const ctrl = createObjectiveController({
    store: flaky, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onEvent: (e) => { lives.push(e) }, arbitrationMs: 60000
  })
  ctrl.proposeObjective({ auteur: 'Alice', texte: 'abri' })
  ctrl.proposeObjective({ auteur: 'Bob', texte: 'puits' })
  // Live emis une seule fois a la transition validee, meme en panne journal.
  assert.equal(countType(lives, 'arbitration-started'), 1)
  assert.ok(ctrl.snapshot().arbitration)
  invariantNoActiveWithArbitration(ctrl.snapshot())

  const timerId = clock.lastId()
  clock.fire(timerId) // expiration validee (save ok), live unique
  assert.equal(countType(lives, 'arbitration-timeout'), 1)
  assert.equal(ctrl.snapshot().arbitration, null)
  assert.equal(ctrl.snapshot().current.statut, 'active')

  // Decision humaine plus recente : stop (persiste, live stop).
  ctrl.totalStop('stop humain')
  const snapStopped = ctrl.snapshot()
  assert.equal(snapStopped.hardstop, true)
  assert.equal(snapStopped.current.statut, 'stopped')
  const timeoutLivesBeforeFlush = countType(lives, 'arbitration-timeout')

  // Rejeu journal : persiste sans nouveau live, donc sans reprise physique.
  journalOk = true
  const outboxBefore = ctrl.snapshot().outbox.length
  assert.ok(outboxBefore > 0)
  const res = ctrl.flushOutbox()
  assert.equal(res.remaining, 0)
  assert.equal(countType(lives, 'arbitration-timeout'), timeoutLivesBeforeFlush)
  const snap = ctrl.snapshot()
  assert.equal(snap.hardstop, true)
  assert.equal(snap.current.statut, 'stopped')
  assert.equal(snap.arbitration, null)
  // Journal complet, sans perte ni doublon.
  const events = s.store.readEvents()
  const ids = events.map((e) => e.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(events.some((e) => e.type === 'arbitration-timeout'))
  assert.ok(events.some((e) => e.type === 'stop'))
})

test('R04 : pause pendant arbitrage gele, resume garde en pause et rearm delai restant', () => {
  const s = freshStore()
  const clock = fakeClock()
  const lives = []
  const ctrl = createObjectiveController({
    store: s.store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onEvent: (e) => { lives.push(e) }, arbitrationMs: 60000
  })
  ctrl.proposeObjective({ auteur: 'Alice', texte: 'abri' })
  ctrl.proposeObjective({ auteur: 'Bob', texte: 'puits' })
  const deadline = ctrl.snapshot().arbitration.deadline
  clock.advance(10000)
  ctrl.pauseWork('attente')
  let snap = ctrl.snapshot()
  assert.ok(snap.arbitration)
  assert.equal(snap.current.statut, 'paused')
  assert.deepEqual(clock.pendingIds(), [])
  invariantNoActiveWithArbitration(snap)

  ctrl.resume()
  snap = ctrl.snapshot()
  assert.ok(snap.arbitration)
  assert.equal(snap.current.statut, 'paused')
  assert.equal(snap.workPaused, false)
  invariantNoActiveWithArbitration(snap)
  // Un seul timer, delai restant (~50 s), pas plein arbitrageMs.
  assert.equal(clock.pendingIds().length, 1)
  const remaining = deadline - clock.now()
  assert.ok(remaining > 39000 && remaining <= 50000)
})

test('R04 : double resume -> un seul timer, ancien callback tardif sans effet', () => {
  const s = freshStore()
  const clock = fakeClock()
  const ctrl = createObjectiveController({
    store: s.store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    arbitrationMs: 60000
  })
  ctrl.proposeObjective({ auteur: 'Alice', texte: 'abri' })
  ctrl.proposeObjective({ auteur: 'Bob', texte: 'puits' })
  const oldId = clock.lastId()
  ctrl.pauseWork('attente')
  ctrl.resume()
  const firstRearm = clock.lastId()
  assert.equal(clock.pendingIds().length, 1)
  ctrl.resume() // double reprise
  const snap = ctrl.snapshot()
  assert.ok(snap.arbitration)
  assert.equal(snap.current.statut, 'paused')
  invariantNoActiveWithArbitration(snap)
  assert.equal(clock.pendingIds().length, 1)
  // Ancien callback (pre-pause puis premier rearm) : jamais de active avec arbitrage.
  clock.fire(oldId)
  assert.ok(ctrl.snapshot().arbitration)
  assert.equal(ctrl.snapshot().current.statut, 'paused')
  invariantNoActiveWithArbitration(ctrl.snapshot())
  clock.fire(firstRearm) // token obsolete apres double resume (generation)
  assert.ok(ctrl.snapshot().arbitration)
  assert.equal(ctrl.snapshot().current.statut, 'paused')
  invariantNoActiveWithArbitration(ctrl.snapshot())
})

test('R04 : timeout gele en pause (pas de transition), expiration au resume si echeance depassee', () => {
  const s = freshStore()
  const clock = fakeClock()
  const ctrl = createObjectiveController({
    store: s.store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    arbitrationMs: 10000
  })
  ctrl.proposeObjective({ auteur: 'Alice', texte: 'abri' })
  ctrl.proposeObjective({ auteur: 'Bob', texte: 'puits' })
  const timerId = clock.lastId()
  ctrl.pauseWork('attente')
  clock.advance(20000) // echeance depassee pendant la pause
  clock.fire(timerId) // gele : aucun effet
  assert.ok(ctrl.snapshot().arbitration)
  assert.equal(ctrl.snapshot().current.statut, 'paused')
  invariantNoActiveWithArbitration(ctrl.snapshot())
  ctrl.resume() // echeance depassee hors interruption -> expiration autorisee
  const snap = ctrl.snapshot()
  assert.equal(snap.arbitration, null)
  assert.equal(snap.current.statut, 'active')
  assert.equal(snap.current.texte, 'abri')
  assert.deepEqual(snap.pending.map((o) => o.texte), ['puits'])
})

test('R04 : recover respecte workPaused/hardstop (gele), expire seulement hors interruption', () => {
  // Cas gele : pause avant recover, echeance depassee -> preserve, aucun timer.
  const s = freshStore()
  const clock = fakeClock()
  const ctrl = createObjectiveController({
    store: s.store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    arbitrationMs: 10000
  })
  ctrl.proposeObjective({ auteur: 'Alice', texte: 'abri' })
  ctrl.proposeObjective({ auteur: 'Bob', texte: 'puits' })
  ctrl.pauseWork('attente')
  clock.advance(20000)
  let scheduled = 0
  const ctrl2 = createObjectiveController({
    store: s.store, now: clock.now,
    setTimer: () => { scheduled += 1; return 999 }, clearTimer: () => {}, arbitrationMs: 10000
  })
  const rs = ctrl2.recover()
  assert.ok(rs.arbitration)
  assert.equal(rs.current.statut, 'paused')
  assert.equal(scheduled, 0)
  invariantNoActiveWithArbitration(rs)

  // Cas hors interruption, echeance depassee -> expiration sur snapshot courant.
  const s2 = freshStore()
  const c2 = fakeClock()
  const a = createObjectiveController({
    store: s2.store, now: c2.now, setTimer: c2.setTimer, clearTimer: c2.clearTimer, arbitrationMs: 10000
  })
  a.proposeObjective({ auteur: 'Alice', texte: 'abri' })
  a.proposeObjective({ auteur: 'Bob', texte: 'puits' })
  c2.advance(20000)
  const b = createObjectiveController({
    store: s2.store, now: c2.now, setTimer: c2.setTimer, clearTimer: c2.clearTimer, arbitrationMs: 10000
  })
  const rb = b.recover()
  assert.equal(rb.arbitration, null)
  assert.equal(rb.current.statut, 'active')
  assert.equal(rb.current.texte, 'abri')

  // Cas avant echeance -> rearm delai restant uniquement.
  const s3 = freshStore()
  const c3 = fakeClock()
  const cA = createObjectiveController({
    store: s3.store, now: c3.now, setTimer: c3.setTimer, clearTimer: c3.clearTimer, arbitrationMs: 60000
  })
  cA.proposeObjective({ auteur: 'Alice', texte: 'abri' })
  cA.proposeObjective({ auteur: 'Bob', texte: 'puits' })
  const c4 = fakeClock(c3.now() + 10000)
  let fired = 0
  const cB = createObjectiveController({
    store: s3.store, now: c4.now,
    setTimer: (fn, ms) => { fired += 1; assert.ok(ms > 40000 && ms <= 50000); return 99 },
    clearTimer: () => {}, arbitrationMs: 60000
  })
  cB.recover()
  assert.equal(fired, 1)
  assert.ok(cB.snapshot().arbitration)
  invariantNoActiveWithArbitration(cB.snapshot())
})
