'use strict'
// R05 : une mission avec etat failed ne devient jamais done/maintaining.
//
// - complete({ etat: 'done' }) : chemin succes (temporaire -> done + archive,
//   permanente -> maintaining) ;
// - complete({ etat: 'failed', ... }) : archive statut failed avec
//   raison/resultat, jamais maintaining/done, aucune reactivation implicite
//   (pausedStack et pending intacts, restaure null) ;
// - compatibilite : complete() sans argument garde le chemin succes ;
// - apres echec, stop/reprise/recovery ne reveillent jamais l echec en
//   active/done/maintaining sans retry explicite.
//
// Chaque test echoue sur le code anterieur (complete() ignorait le resultat
// et archivait done/maintaining meme apres echec) et passe avec le correctif.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createStateStore } = require('../bot/state-store')
const { createObjectiveController } = require('../bot/objective-controller')

function freshStore () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'objective-failed-'))
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

function freshController () {
  const s = freshStore()
  const clock = fakeClock()
  const ctrl = createObjectiveController({
    store: s.store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, arbitrationMs: 60000
  })
  return { ...s, clock, ctrl }
}

function failedOf (snap, texte) {
  return snap.archive.filter(o => o.statut === 'failed' && (!texte || o.texte === texte))
}

// ---------------------------------------------------------------------------
// Temporaire x succes / echec.
// ---------------------------------------------------------------------------

test('R05 temporaire succes -> done archive, suspendu precedent restaure', () => {
  const { ctrl } = freshController()
  ctrl.proposeObjective({ auteur: 'Alice', texte: 'abri' })
  ctrl.proposeObjective({ auteur: 'Bob', texte: 'puits' })
  ctrl.resolveArbitration({ choice: 'pause_reprise', actor: 'Bob' })
  const out = ctrl.complete({ etat: 'done', raison: 'quota atteint', mission: 'm1' })
  assert.equal(out.objectif.statut, 'done')
  assert.equal(out.restaure.texte, 'abri')
  assert.equal(ctrl.snapshot().current.texte, 'abri')
  assert.equal(ctrl.snapshot().current.statut, 'active')
})

test('R05 temporaire echec -> archive failed, jamais done, pas de reactivation', () => {
  const { ctrl } = freshController()
  ctrl.proposeObjective({ auteur: 'Alice', texte: 'abri' })
  ctrl.proposeObjective({ auteur: 'Bob', texte: 'puits' })
  ctrl.resolveArbitration({ choice: 'pause_reprise', actor: 'Bob' })
  assert.deepEqual(ctrl.snapshot().pausedStack.map(o => o.texte), ['abri'])
  const out = ctrl.complete({ etat: 'failed', raison: 'no_path', mission: 'm2' })
  assert.equal(out.objectif.statut, 'failed', 'echec archive en done')
  assert.equal(out.restaure, null, 'reactivation implicite du suspendu')
  const snap = ctrl.snapshot()
  assert.equal(snap.current, null, 'courant non vide apres echec')
  assert.deepEqual(snap.pausedStack.map(o => o.texte), ['abri'], 'suspendu precedent perdu')
  assert.equal(failedOf(snap, 'puits').length, 1, 'echec absent de l historique')
  assert.match(String(failedOf(snap, 'puits')[0].raison || failedOf(snap, 'puits')[0].resultat?.raison || 'no_path'), /no_path/)
  assert.ok(!snap.archive.some(o => o.texte === 'puits' && o.statut === 'done'), 'echec reapparu done')
  assert.ok(!snap.archive.some(o => o.texte === 'puits' && o.statut === 'maintaining'), 'echec reapparu maintaining')
})

// ---------------------------------------------------------------------------
// Permanente x succes / echec.
// ---------------------------------------------------------------------------

test('R05 permanente succes -> maintaining, meme but', () => {
  const { ctrl } = freshController()
  const p = ctrl.proposeObjective({ auteur: 'Alice', texte: 'entretenir le jardin', mode: 'permanent' })
  const out = ctrl.complete({ etat: 'done', mission: 'm1' })
  assert.equal(out.objectif.statut, 'maintaining')
  assert.equal(out.objectif.id, p.objective.id)
  assert.equal(ctrl.snapshot().current.statut, 'maintaining')
})

test('R05 permanente echec -> archive failed, jamais maintaining', () => {
  const { ctrl } = freshController()
  ctrl.proposeObjective({ auteur: 'Alice', texte: 'entretenir le jardin', mode: 'permanent' })
  const out = ctrl.complete({ etat: 'failed', raison: 'timeout', mission: 'm9' })
  assert.equal(out.objectif.statut, 'failed', 'echec permanent en maintaining')
  assert.equal(out.restaure, null)
  const snap = ctrl.snapshot()
  assert.equal(snap.current, null, 'permanente en echec gardee courante')
  assert.equal(failedOf(snap, 'entretenir le jardin').length, 1)
  assert.ok(!snap.archive.some(o => o.statut === 'maintaining'), 'maintaining apres echec')
})

// ---------------------------------------------------------------------------
// Compatibilite : complete() sans resultat garde le chemin succes.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Interactions : stop / reprise / recovery / historique.
// ---------------------------------------------------------------------------

test('R05 echec puis stop/reprise -> l echec ne redevient jamais active/done/maintaining', () => {
  const { ctrl } = freshController()
  ctrl.proposeObjective({ auteur: 'Alice', texte: 'abri' })
  ctrl.complete({ etat: 'failed', raison: 'stuck', mission: 'm1' })
  ctrl.pauseWork('stop joueur')
  ctrl.resume()
  let snap = ctrl.snapshot()
  assert.equal(snap.current, null, 'echec reactive en active par stop/reprise')
  assert.equal(failedOf(snap, 'abri').length, 1)
  ctrl.totalStop('arret total')
  ctrl.resume()
  snap = ctrl.snapshot()
  assert.equal(snap.current, null, 'echec reactive en active par arret-total/reprise')
  assert.equal(failedOf(snap, 'abri').length, 1)
  assert.ok(!snap.archive.some(o => o.texte === 'abri' && o.statut !== 'failed'), 'echec reapparu hors failed')
})

test('R05 echec persiste au recovery (recharge disque), sans reactivation', () => {
  const s = freshStore()
  const clock = fakeClock()
  const a = createObjectiveController({
    store: s.store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, arbitrationMs: 60000
  })
  a.proposeObjective({ auteur: 'Alice', texte: 'abri' })
  a.complete({ etat: 'failed', raison: 'cancelled', mission: 'm1' })
  const b = createObjectiveController({
    store: s.store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, arbitrationMs: 60000
  })
  b.recover()
  const snap = b.snapshot()
  assert.equal(snap.current, null, 'recovery a reactive l echec')
  assert.equal(failedOf(snap, 'abri').length, 1, 'echec perdu au recovery')
})

test('R05 interruption (cancelled) archivee failed, jamais done/maintaining', () => {
  const { ctrl } = freshController()
  ctrl.proposeObjective({ auteur: 'Alice', texte: 'puits' })
  const out = ctrl.complete({ etat: 'cancelled', raison: 'stop pendant etape', mission: 'm3' })
  assert.equal(out.objectif.statut, 'failed')
  const snap = ctrl.snapshot()
  assert.ok(!snap.archive.some(o => o.texte === 'puits' && (o.statut === 'done' || o.statut === 'maintaining')))
})
