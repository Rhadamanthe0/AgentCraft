'use strict'
// Tests du module autonome bot/objective-controller.js (D01/D18/D22-D23/D29/D36/D38/D42/D44-D47/D50).
// Conventions : node:test + assert/strict, CommonJS, sans dependance externe.
// Persistance UNIQUEMENT sous os.tmpdir via bot/state-store.js ; timers via
// faux clock injecte (aucun setTimeout reel, aucun scheduler global).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createStateStore } = require('../bot/state-store')
const { createObjectiveController, buildArbitrationQuestion } = require('../bot/objective-controller')

function freshStore () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'objective-ctrl-'))
  const file = path.join(dir, 'snapshot.json')
  const eventFile = path.join(dir, 'events.jsonl')
  const store = createStateStore({ file, eventFile })
  assert.ok(file.startsWith(os.tmpdir()))
  return { dir, file, eventFile, store }
}

function fakeClock (start = 1_700_000_000_000) {
  let t = start
  let seq = 0
  const timers = new Map() // id -> { fn, at }
  const events = []
  return {
    now: () => t,
    advance: (ms) => { t += ms },
    setTimer: (fn, ms) => { seq += 1; timers.set(seq, { fn, at: t + ms, cleared: false }); return seq },
    clearTimer: (id) => { const e = timers.get(id); if (e) e.cleared = true },
    fire: (id) => { const e = timers.get(id); assert.ok(e, 'timer connu'); e.fn() },
    pendingIds: () => [...timers.entries()].filter(([, e]) => !e.cleared).map(([id]) => id),
    lastId: () => seq,
    onEvent: (evt) => { events.push(evt) },
    events
  }
}

function freshController (overrides = {}) {
  const s = freshStore()
  const clock = fakeClock()
  const ctrl = createObjectiveController({
    store: s.store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onEvent: clock.onEvent, arbitrationMs: 60000, ...overrides.clock
  })
  return { ...s, clock, ctrl }
}

test('inbox : messages rapproches sans perte, auteurs conserves', () => {
  const { ctrl } = freshController()
  const a = ctrl.recordMessage({ auteur: 'Alice', texte: 'prends du bois' })
  const b = ctrl.recordMessage({ auteur: 'Bob', texte: 'non, de la pierre' })
  const c = ctrl.recordMessage({ auteur: 'Alice', texte: 'vite ?' })
  const snap = ctrl.snapshot()
  assert.deepEqual(snap.inbox.map((m) => m.texte), ['prends du bois', 'non, de la pierre', 'vite ?'])
  assert.deepEqual(snap.inbox.map((m) => m.auteur), ['Alice', 'Bob', 'Alice'])
  assert.ok(a.id !== b.id && b.id !== c.id)
  for (const m of snap.inbox) assert.ok(m.id && m.date && m.texte)
})

test('contexte et question ne remplacent pas l objectif', () => {
  const { ctrl } = freshController()
  const started = ctrl.proposeObjective({ auteur: 'Alice', texte: 'construire un abri' })
  assert.equal(started.status, 'started')
  const ctx = ctrl.addContext({ auteur: 'Bob', texte: 'le sol est plat au sud' })
  assert.equal(ctx.kind, 'context')
  assert.equal(ctrl.snapshot().current.texte, 'construire un abri')
  assert.equal(ctrl.snapshot().current.statut, 'active')
  const q = ctrl.askQuestion({ auteur: 'Bot', texte: 'quelle hauteur ?' })
  assert.equal(q.texte, 'quelle hauteur ?')
  assert.equal(ctrl.snapshot().current.texte, 'construire un abri')
  assert.equal(ctrl.snapshot().current.statut, 'active')
  assert.equal(ctrl.snapshot().questions.length, 1)
})

test('concurrent : question EXACTE, pause, timeout reprend ancien et garde pending', () => {
  const { ctrl, clock } = freshController()
  ctrl.proposeObjective({ auteur: 'Alice', texte: 'construire un abri' })
  const conflict = ctrl.proposeObjective({ auteur: 'Bob', texte: 'creuser un puits' })
  assert.equal(conflict.status, 'arbitration')
  const snap = ctrl.snapshot()
  assert.equal(snap.current.statut, 'paused')
  assert.equal(snap.current.texte, 'construire un abri')
  const expected = buildArbitrationQuestion(
    { texte: 'construire un abri', auteur: 'Alice' },
    { texte: 'creuser un puits' }, 60000)
  assert.equal(conflict.question, expected)
  assert.match(conflict.question, /pause_reprise/)
  assert.match(conflict.question, /remplacement/)
  assert.match(conflict.question, /60 s/)
  assert.equal(clock.pendingIds().length, 1)
  // Timeout : l ancien reprend, la demande reste en attente.
  clock.fire(clock.lastId())
  const after = ctrl.snapshot()
  assert.equal(after.arbitration, null)
  assert.equal(after.current.texte, 'construire un abri')
  assert.equal(after.current.statut, 'active')
  assert.deepEqual(after.pending.map((o) => o.texte), ['creuser un puits'])
})

test('tiers : la troisieme demande ne perd pas la deuxieme', () => {
  const { ctrl, clock } = freshController()
  ctrl.proposeObjective({ auteur: 'Alice', texte: 'abri' })
  ctrl.proposeObjective({ auteur: 'Bob', texte: 'puits' })
  const third = ctrl.proposeObjective({ auteur: 'Cara', texte: 'pont' })
  assert.equal(third.status, 'queued')
  assert.equal(third.question, ctrl.snapshot().arbitration.question)
  clock.fire(clock.lastId())
  assert.deepEqual(ctrl.snapshot().pending.map((o) => o.texte), ['puits', 'pont'])
})

test('arbitrage : pause_reprise et remplacement, acteur nouveau demandeur', () => {
  const f = freshController()
  f.ctrl.proposeObjective({ auteur: 'Alice', texte: 'abri' })
  f.ctrl.proposeObjective({ auteur: 'Bob', texte: 'puits' })
  assert.throws(() => f.ctrl.resolveArbitration({ choice: 'pause_reprise', actor: 'Alice' }), /nouveau demandeur/)
  const r1 = f.ctrl.resolveArbitration({ choice: 'pause_reprise', actor: 'Bob' })
  assert.equal(r1.status, 'resumed-new')
  assert.equal(r1.objective.texte, 'puits')
  assert.equal(f.ctrl.snapshot().pausedPrevious.texte, 'abri')

  const g = freshController()
  g.ctrl.proposeObjective({ auteur: 'Alice', texte: 'abri' })
  g.ctrl.proposeObjective({ auteur: 'Bob', texte: 'puits' })
  const r2 = g.ctrl.resolveArbitration({ choice: 'remplacement', actor: 'Bob' })
  assert.equal(r2.status, 'replaced')
  assert.equal(g.ctrl.snapshot().current.texte, 'puits')
  assert.equal(g.ctrl.snapshot().pausedPrevious, null)
  assert.equal(g.ctrl.snapshot().archive.length, 1)

  // Timer obsolete apres resolution : double resolution refusee, pas de double effet.
  assert.throws(() => g.ctrl.resolveArbitration({ choice: 'remplacement', actor: 'Bob' }), /aucun arbitrage/)
})

test('stop total pendant arbitrage l emporte sur le timer ancien', () => {
  const { ctrl, clock } = freshController()
  ctrl.proposeObjective({ auteur: 'Alice', texte: 'abri' })
  ctrl.proposeObjective({ auteur: 'Bob', texte: 'puits' })
  const timerId = clock.lastId()
  ctrl.totalStop('urgence')
  assert.deepEqual(clock.pendingIds(), [])
  const snap = ctrl.snapshot()
  assert.equal(snap.hardstop, true)
  assert.equal(snap.arbitration, null)
  assert.deepEqual(snap.pending.map((o) => o.texte), ['puits'])
  // L ancien timer ne doit rien faire (ignore silencieusement).
  clock.fire(timerId) // cleared serait une erreur ; totalStop l a annule : on verifie l etat, pas le tir
  assert.equal(ctrl.snapshot().hardstop, true)
  assert.throws(() => ctrl.resolveArbitration({ choice: 'remplacement', actor: 'Bob' }), /aucun arbitrage|arret total/)
  // Reprise explicite : le courant se reveille, le pending ne demarre pas tout seul.
  ctrl.resume()
  assert.equal(ctrl.snapshot().hardstop, false)
  assert.equal(ctrl.snapshot().current.statut, 'active')
  assert.deepEqual(ctrl.snapshot().pending.map((o) => o.texte), ['puits'])
})

test('pause du travail conserve la progression, resume explicite', () => {
  const { ctrl } = freshController()
  ctrl.proposeObjective({ auteur: 'Alice', texte: 'abri' })
  ctrl.recordProgress({ faits: 3 })
  ctrl.pauseWork('attente')
  const snap = ctrl.snapshot()
  assert.equal(snap.current.statut, 'paused')
  assert.deepEqual(snap.current.progression, { faits: 3 })
  ctrl.resume()
  assert.equal(ctrl.snapshot().current.statut, 'active')
  assert.deepEqual(ctrl.snapshot().current.progression, { faits: 3 })
})

test('permanent -> maintaining meme but ; temporaire terminee reprend l ancien en pause', () => {
  const { ctrl } = freshController()
  const p = ctrl.proposeObjective({ auteur: 'Alice', texte: 'entretenir le jardin', mode: 'permanent' })
  const done1 = ctrl.complete()
  assert.equal(done1.objectif.statut, 'maintaining')
  assert.equal(done1.objectif.id, p.objective.id)
  assert.equal(ctrl.snapshot().current.statut, 'maintaining')
  assert.equal(ctrl.snapshot().current.id, p.objective.id)

  const f = freshController()
  f.ctrl.proposeObjective({ auteur: 'Alice', texte: 'abri' })
  f.ctrl.proposeObjective({ auteur: 'Bob', texte: 'puits' })
  f.ctrl.resolveArbitration({ choice: 'pause_reprise', actor: 'Bob' })
  assert.equal(f.ctrl.snapshot().current.texte, 'puits')
  const done2 = f.ctrl.complete()
  assert.equal(done2.objectif.statut, 'done')
  assert.equal(done2.restaure.texte, 'abri')
  assert.equal(f.ctrl.snapshot().current.texte, 'abri')
  assert.equal(f.ctrl.snapshot().current.statut, 'active')
})

test('restart : preserve id/progress/hardstop, deadline relancee, faits revalides', () => {
  const s = freshStore()
  const clock = fakeClock()
  const a = createObjectiveController({
    store: s.store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, arbitrationMs: 60000
  })
  a.proposeObjective({ auteur: 'Alice', texte: 'abri' })
  a.recordProgress({ faits: 5 })
  const before = a.snapshot()
  // Rechargement simple : meme instance, faits marques stale.
  s.store.save({ ...before, facts: [{ id: 'f1', type: 'lieu', x: 1 }] })
  const reloaded = a.recover()
  assert.equal(reloaded.current.id, before.current.id)
  assert.deepEqual(reloaded.current.progression, { faits: 5 })
  assert.deepEqual(reloaded.facts, [{ id: 'f1', type: 'lieu', x: 1, stale: true, requiresObservation: true }])

  // Deadline persistee : nouveau controleur relance le timer restant.
  const s2 = freshStore()
  const c1 = fakeClock()
  const ctrl1 = createObjectiveController({
    store: s2.store, now: c1.now, setTimer: c1.setTimer, clearTimer: c1.clearTimer, arbitrationMs: 60000
  })
  ctrl1.proposeObjective({ auteur: 'Alice', texte: 'abri' })
  ctrl1.proposeObjective({ auteur: 'Bob', texte: 'puits' })
  const persisted = s2.store.load()
  assert.ok(persisted.arbitration && persisted.arbitration.deadline)
  const c2 = fakeClock(c1.now() + 10000) // 10 s plus tard
  let fired = 0
  const ctrl2 = createObjectiveController({
    store: s2.store, now: c2.now,
    setTimer: (fn, ms) => { fired += 1; assert.ok(ms > 40000 && ms <= 50000, `delai restant respecte (${ms})`); return 99 },
    clearTimer: () => {},
    arbitrationMs: 60000
  })
  ctrl2.recover()
  assert.equal(fired, 1)
  assert.ok(ctrl2.snapshot().arbitration)

  // Hardstop preserve : aucun timer relance, aucune auto-activite.
  const s3 = freshStore()
  const c3 = fakeClock()
  const ctrl3 = createObjectiveController({
    store: s3.store, now: c3.now, setTimer: c3.setTimer, clearTimer: c3.clearTimer, arbitrationMs: 60000
  })
  ctrl3.proposeObjective({ auteur: 'Alice', texte: 'abri' })
  ctrl3.proposeObjective({ auteur: 'Bob', texte: 'puits' })
  ctrl3.totalStop('urgence')
  let scheduled = 0
  const ctrl4 = createObjectiveController({
    store: s3.store, now: c3.now,
    setTimer: () => { scheduled += 1; return 1 }, clearTimer: () => {}, arbitrationMs: 60000
  })
  const rs = ctrl4.recover()
  assert.equal(rs.hardstop, true)
  assert.equal(scheduled, 0)
  assert.deepEqual(rs.pending.map((o) => o.texte), ['puits'])
})

test('snapshot rend une copie : muter ne change pas l etat', () => {
  const { ctrl } = freshController()
  ctrl.proposeObjective({ auteur: 'Alice', texte: 'abri' })
  const snap = ctrl.snapshot()
  snap.current.texte = 'mute'
  snap.inbox.push({ id: 'faux' })
  snap.pending.push({ id: 'faux' })
  const fresh = ctrl.snapshot()
  assert.equal(fresh.current.texte, 'abri')
  assert.equal(fresh.inbox.length, 1)
  assert.equal(fresh.pending.length, 0)
})

test('save fail : admission refusee, memoire+disque inchanges', () => {
  const s = freshStore()
  const clock = fakeClock()
  const ctrl = createObjectiveController({
    store: s.store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer
  })
  ctrl.recordMessage({ auteur: 'Alice', texte: 'bonjour' })
  const diskBefore = s.store.load()
  const failingSave = {
    load: s.store.load,
    save: () => { throw new Error('disque plein') },
    appendEvent: s.store.appendEvent,
    readEvents: s.store.readEvents
  }
  const ctrl2 = createObjectiveController({
    store: failingSave, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer
  })
  // L admission echoue et ne touche ni la memoire (reste vide) ni le disque.
  assert.throws(() => ctrl2.recordMessage({ auteur: 'Bob', texte: 'perdu ?' }), /disque plein/)
  assert.throws(() => ctrl2.proposeObjective({ auteur: 'Bob', texte: 'puits' }), /disque plein/)
  assert.equal(ctrl2.snapshot().inbox.length, 0)
  assert.equal(ctrl2.snapshot().current, null)
  assert.deepEqual(s.store.load(), diskBefore)
})

test('journal fail : admission durable reussie, outbox visible, flush retry sans doublon', () => {
  const s = freshStore()
  const clock = fakeClock()
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
    onEvent: clock.onEvent
  })
  // Pas de throw : l admission est durable (save a committe), seule la copie journal echoue.
  const msg = ctrl.recordMessage({ auteur: 'Bob', texte: 'durable ?' })
  assert.equal(msg.texte, 'durable ?')
  assert.equal(ctrl.snapshot().inbox.length, 1)
  assert.equal(ctrl.snapshot().outbox.length, 1)
  assert.ok(clock.events.some((e) => e.type === 'journal-flush-error'))
  // Le disque (snapshot) contient deja l inbox : pas de fausse admission, pas de perte.
  assert.equal(s.store.load().inbox.length, 1)
  assert.equal(s.store.load().outbox.length, 1)
  // Restart intermediaire : le disque porte l outbox, le journal ne l a pas.
  assert.equal(s.store.readEvents().length, 0)
  journalOk = true
  const ctrl2 = createObjectiveController({
    store: s.store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer
  })
  ctrl2.recover() // reflush l outbox persistee
  const events = s.store.readEvents()
  const ids = events.map((e) => e.id)
  assert.equal(new Set(ids).size, ids.length) // aucun doublon
  assert.ok(events.some((e) => e.type === 'message' && e.message && e.message.texte === 'durable ?'))
  assert.equal(ctrl2.snapshot().outbox.length, 0)
  // Reflush idempotent : recover suivant ne duplique pas.
  const n = s.store.readEvents().length
  ctrl2.recover()
  assert.equal(s.store.readEvents().length, n + 1) // seul le nouveau 'recovered', pas de doublon message
})

test('stop latch meme sur panne save : stoppe en memoire, timer jamais repris', () => {
  const s = freshStore()
  const clock = fakeClock()
  const ctrl = createObjectiveController({
    store: s.store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onEvent: clock.onEvent
  })
  ctrl.proposeObjective({ auteur: 'Alice', texte: 'abri' })
  ctrl.proposeObjective({ auteur: 'Bob', texte: 'puits' })
  const timerId = clock.lastId()
  // Panne save au moment du stop : l erreur est visible MAIS le latch tient.
  const realSave = s.store.save
  s.store.save = () => { throw new Error('disque plein au pire moment') }
  assert.throws(() => ctrl.totalStop('urgence'), /disque plein/)
  assert.equal(ctrl.snapshot().hardstop, true)
  assert.equal(ctrl.snapshot().current.statut, 'stopped')
  assert.equal(ctrl.snapshot().arbitration, null)
  assert.deepEqual(clock.pendingIds(), [])
  // L ancien timer ne reprend rien, meme tire a la main.
  clock.fire(timerId)
  assert.equal(ctrl.snapshot().hardstop, true)
  assert.equal(ctrl.snapshot().current.statut, 'stopped')
  // Reparation : le latch se persiste au prochain flush, restart le retrouve.
  s.store.save = realSave
  ctrl.flushOutbox()
  const ctrl2 = createObjectiveController({
    store: s.store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer
  })
  const rs = ctrl2.recover()
  assert.equal(rs.hardstop, true)
  assert.deepEqual(rs.pending.map((o) => o.texte), ['puits'])
})

test('pause_reprise imbriquee : pile, aucun ancetre perdu', () => {
  const { ctrl } = freshController()
  ctrl.proposeObjective({ auteur: 'Alice', texte: 'A-abri' })
  ctrl.proposeObjective({ auteur: 'Bob', texte: 'B-puits' })
  ctrl.resolveArbitration({ choice: 'pause_reprise', actor: 'Bob' })
  ctrl.proposeObjective({ auteur: 'Cara', texte: 'C-pont' })
  ctrl.resolveArbitration({ choice: 'pause_reprise', actor: 'Cara' })
  assert.equal(ctrl.snapshot().current.texte, 'C-pont')
  assert.deepEqual(ctrl.snapshot().pausedStack.map((o) => o.texte), ['A-abri', 'B-puits'])
  assert.equal(ctrl.snapshot().pausedPrevious.texte, 'B-puits')
  const d1 = ctrl.complete()
  assert.equal(d1.restaure.texte, 'B-puits')
  assert.deepEqual(ctrl.snapshot().pausedStack.map((o) => o.texte), ['A-abri'])
  const d2 = ctrl.complete()
  assert.equal(d2.restaure.texte, 'A-abri')
  assert.deepEqual(ctrl.snapshot().pausedStack, [])
  assert.equal(ctrl.snapshot().current.texte, 'A-abri')
})

test('timeout en panne save ne crash pas : arbitrage preserve, resolution possible apres', () => {
  const s = freshStore()
  const clock = fakeClock()
  const warns = []
  const ctrl = createObjectiveController({
    store: s.store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onEvent: (e) => { warns.push(e) }
  })
  ctrl.proposeObjective({ auteur: 'Alice', texte: 'abri' })
  ctrl.proposeObjective({ auteur: 'Bob', texte: 'puits' })
  const timerId = clock.lastId()
  const realSave = s.store.save
  s.store.save = () => { throw new Error('disque plein pendant timeout') }
  let threw = null
  try { clock.fire(timerId) } catch (err) { threw = err }
  assert.equal(threw, null) // le callback timer ne propage jamais vers l horloge
  assert.ok(ctrl.snapshot().arbitration) // arbitrage preserve, pas d admission fantome
  assert.ok(warns.some((e) => e.type === 'arbitration-timeout-error'))
  s.store.save = realSave
  const r = ctrl.resolveArbitration({ choice: 'remplacement', actor: 'Bob' })
  assert.equal(r.status, 'replaced')
})

test('recordProgress correle : objectifId divergent refuse stale, absent herite', () => {
  const { ctrl } = freshController()
  const started = ctrl.proposeObjective({ auteur: 'Alice', texte: 'abri' })
  const ok = ctrl.recordProgress({ objectifId: started.objective.id, faits: 2 })
  assert.deepEqual(ok.progression, { faits: 2 })
  assert.ok(!('objectifId' in ctrl.snapshot().current.progression), 'correlation non persistee comme donnee')
  // Progression d un ancien objectif apres arbitrage : refusee, pas d ecrasement.
  assert.throws(() => ctrl.recordProgress({ objectifId: 'obj-999', faits: 9 }), /stale/)
  assert.deepEqual(ctrl.snapshot().current.progression, { faits: 2 })
  assert.equal(ctrl.snapshot().current.version, ok.version)
  // Sans objectifId : repli heritage, sans controle.
  const ok2 = ctrl.recordProgress({ faits: 3 })
  assert.deepEqual(ok2.progression, { faits: 3 })
  const okn = ctrl.recordProgress(4)
  assert.deepEqual(okn.progression, { faits: 4 })
})

test('progression invalide : vrai rollback deep, etat et outbox intacts', () => {
  const { ctrl } = freshController()
  ctrl.proposeObjective({ auteur: 'Alice', texte: 'abri' })
  ctrl.recordProgress({ faits: 2 })
  const before = ctrl.snapshot()
  assert.throws(() => ctrl.recordProgress('n importe quoi'), /progression attendue/)
  const after = ctrl.snapshot()
  assert.deepEqual(after.current.progression, { faits: 2 })
  assert.deepEqual(after.outbox, before.outbox)
  assert.equal(after.current.version, before.current.version)
})
