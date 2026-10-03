'use strict'
// R08 : recover() valide le schema versionne AVANT toute mutation/sauvegarde.
// Version inconnue, mauvais types, hardstop:"true", arbitrage incomplet,
// tableaux remplaces par des objets -> echec lecture seule, fichier preserve,
// aucune reecriture auto. Un snapshot valide recupere toujours (R01-R05).
// Persistance UNIQUEMENT sous os.tmpdir via bot/state-store.js ; faux clock.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createStateStore } = require('../bot/state-store')
const { createObjectiveController } = require('../bot/objective-controller')

function freshStore () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recover-r08-'))
  const file = path.join(dir, 'snapshot.json')
  const eventFile = path.join(dir, 'events.jsonl')
  const store = createStateStore({ file, eventFile })
  assert.ok(file.startsWith(os.tmpdir()))
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

function validSnapshot (store) {
  const clock = fakeClock()
  const ctrl = createObjectiveController({
    store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, arbitrationMs: 60000
  })
  ctrl.proposeObjective({ auteur: 'Alice', texte: 'abri' })
  ctrl.recordProgress({ faits: 2 })
  return store.load()
}

function assertNoRewrite (file, before, ctrl2) {
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'fichier preserve, aucune reecriture auto')
  const snap = ctrl2.snapshot()
  assert.equal(snap.current, null, 'etat in-memoire inchange (lecture seule)')
  assert.equal(snap.arbitration, null)
  assert.deepEqual(snap.pending, [])
}

test('R08 valide : recover recharge sans normalisation (R01-R05 preserves)', () => {
  const s = freshStore()
  const clock = fakeClock()
  const a = createObjectiveController({
    store: s.store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, arbitrationMs: 60000
  })
  a.proposeObjective({ auteur: 'Alice', texte: 'abri' })
  a.proposeObjective({ auteur: 'Bob', texte: 'puits' })
  const b = createObjectiveController({
    store: s.store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, arbitrationMs: 60000
  })
  const snap = b.recover()
  assert.ok(snap.arbitration, 'arbitrage complet recharge')
  assert.equal(snap.current.statut, 'paused')
  assert.equal(snap.hardstop, false)
})

test('R08 version future : echec lecture seule, aucun reecrit', () => {
  const s = freshStore()
  validSnapshot(s.store)
  const raw = s.store.load()
  raw.version = 99
  s.store.save(raw)
  const before = fs.readFileSync(s.file, 'utf8')
  const clock = fakeClock()
  const ctrl2 = createObjectiveController({
    store: s.store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, arbitrationMs: 60000
  })
  assert.throws(() => ctrl2.recover(), /version|corrompu/)
  assertNoRewrite(s.file, before, ctrl2)
})

test('R08 hardstop:"true" : booleen strict exige, aucun reecrit', () => {
  const s = freshStore()
  validSnapshot(s.store)
  const raw = s.store.load()
  raw.hardstop = 'true'
  s.store.save(raw)
  const before = fs.readFileSync(s.file, 'utf8')
  const clock = fakeClock()
  const ctrl2 = createObjectiveController({
    store: s.store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, arbitrationMs: 60000
  })
  assert.throws(() => ctrl2.recover(), /hardstop|corrompu/)
  assertNoRewrite(s.file, before, ctrl2)
  assert.equal(ctrl2.snapshot().hardstop, false, 'pas de "true" devenu false en memoire')
})

test('R08 tableaux remplaces par objets : echec lecture seule', () => {
  for (const field of ['inbox', 'pending', 'pausedStack', 'questions', 'archive', 'facts', 'outbox']) {
    const s = freshStore()
    validSnapshot(s.store)
    const raw = s.store.load()
    raw[field] = { 0: 'piège' }
    s.store.save(raw)
    const before = fs.readFileSync(s.file, 'utf8')
    const clock = fakeClock()
    const ctrl2 = createObjectiveController({
      store: s.store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, arbitrationMs: 60000
    })
    assert.throws(() => ctrl2.recover(), /corrompu/, `champ ${field} objet refuse`)
    assert.equal(fs.readFileSync(s.file, 'utf8'), before, `aucun reecrit pour ${field}`)
  }
})

test('R08 arbitrage incomplet : echec strict, jamais refile en pending', () => {
  const s = freshStore()
  const clock = fakeClock()
  const a = createObjectiveController({
    store: s.store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, arbitrationMs: 60000
  })
  a.proposeObjective({ auteur: 'Alice', texte: 'abri' })
  a.proposeObjective({ auteur: 'Bob', texte: 'puits' })
  const raw = s.store.load()
  assert.ok(raw.arbitration, 'arbitrage complet au depart')
  delete raw.arbitration.previous
  s.store.save(raw)
  const before = fs.readFileSync(s.file, 'utf8')
  const ctrl2 = createObjectiveController({
    store: s.store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, arbitrationMs: 60000
  })
  assert.throws(() => ctrl2.recover(), /arbitration|corrompu/)
  assertNoRewrite(s.file, before, ctrl2)
})

test('R08 mauvais types (seq, objectif, objectifId) : echec lecture seule', () => {
  const s = freshStore()
  validSnapshot(s.store)
  const raw = s.store.load()
  raw.seq = '0'
  raw.current = { id: '', auteur: 'Alice', texte: '', mode: 'bidon', statut: '', version: 0 }
  s.store.save(raw)
  const before = fs.readFileSync(s.file, 'utf8')
  const clock = fakeClock()
  const ctrl2 = createObjectiveController({
    store: s.store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, arbitrationMs: 60000
  })
  assert.throws(() => ctrl2.recover(), /corrompu/)
  assertNoRewrite(s.file, before, ctrl2)
})
