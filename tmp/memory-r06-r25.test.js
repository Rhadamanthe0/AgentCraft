'use strict'
// R06 (concurrence de compaction : revision/CAS, aucun resume obsolete
// n ecrase note/reset/effacement) + R25 (memoire transitoire scopee par
// objectif : travail+pending par contexte, long terme global).
// Conventions : node:test + assert/strict, CommonJS, persistance UNIQUEMENT
// sous os.tmpdir (jamais de /data reel). Chaque test recharge bot/memory.js
// avec MEMORY_FILE pointe sur son fichier (module a etat, seuils figes au
// require) ; les seuils de compaction sont abaisses par env pour les tests
// R06 (une note isolee ne peut pas depasser NOTE_MAX).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const MEMORY_ENV_KEYS = [
  'MEMORY_FILE',
  'MEMORY_LONG_TERM_TOKENS',
  'MEMORY_WORK_TOKENS',
  'MEMORY_WORK_COMPACT_AT',
  'MEMORY_WORK_COMPACT_TO',
  'MEMORY_NOTE_MAX'
]

function freshMemory (file, env = {}) {
  const id = require.resolve('../bot/memory')
  delete require.cache[id]
  const saved = {}
  for (const key of MEMORY_ENV_KEYS) saved[key] = process.env[key]
  process.env.MEMORY_FILE = file
  for (const [key, value] of Object.entries(env)) process.env[key] = String(value)
  const mem = require('../bot/memory')
  for (const key of MEMORY_ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  return mem
}

function tmpFile (prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  assert.ok(dir.startsWith(os.tmpdir()))
  return path.join(dir, 'memory.json')
}

// Seuils bas : 100 caracteres ~= 29 jetons. note1 (100) sous le seuil (50),
// note1 + grosse note (201 car. ~= 58) au-dela, resume court (<= 25) accepte.
const PETITS_SEUILS = {
  MEMORY_WORK_TOKENS: 1000,
  MEMORY_WORK_COMPACT_AT: 50,
  MEMORY_WORK_COMPACT_TO: 25
}
const NOTE1 = 'x'.repeat(100)
const GROSSE_NOTE = 'y'.repeat(100)
const PETITE_NOTE = 'note concurrente'

// Compacteur a ecluse : la promesse ne se resout que sur release(), pour
// glisser une mutation concurrente PENDANT l attente.
function compactorAEcluse () {
  let release = null
  const appels = []
  const fn = (texte) => new Promise((resolve) => {
    appels.push(String(texte))
    release = resolve
  })
  return { fn, appels, release: (resume) => release(resume) }
}

async function ecrireAuDelaDuSeuil (mem) {
  const r1 = await mem.write('travail', NOTE1)
  assert.equal(r1.ok, true, 'note initiale sous le seuil')
  assert.equal(r1.compacte ?? false, false)
  return r1
}

test('R06 compaction normale sans concurrence : le resume est publie', async () => {
  const mem = freshMemory(tmpFile('memory-r06-ok-'), PETITS_SEUILS)
  mem.load()
  mem.setCompactor(async () => 'resume court')
  await ecrireAuDelaDuSeuil(mem)
  const res = await mem.write('travail', GROSSE_NOTE)
  assert.equal(res.ok, true)
  assert.equal(res.compacte, true)
  assert.equal(mem.snapshot().travail, 'resume court')
})

test('R06 nouvelle note pendant compaction : abandon, pas d ecrasement', async () => {
  const mem = freshMemory(tmpFile('memory-r06-note-'), PETITS_SEUILS)
  mem.load()
  const ecluse = compactorAEcluse()
  mem.setCompactor(ecluse.fn)
  await ecrireAuDelaDuSeuil(mem)
  const enVol = mem.write('travail', GROSSE_NOTE)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(ecluse.appels.length, 1, 'le compacteur attend')
  const concurrente = await mem.write('travail', PETITE_NOTE)
  assert.equal(concurrente.ok, true, 'la note concurrente passe')
  ecluse.release('resume perime du compacteur')
  const res = await enVol
  assert.equal(res.ok, false, 'ecriture obsolete abandonnee')
  assert.equal(res.conflit, true)
  assert.match(res.error, /concurrence/)
  const snap = mem.snapshot()
  assert.match(snap.travail, /note concurrente/, 'la note intervenue est gardee')
  assert.match(snap.travail, /x{10}/, 'le fil d avant est garde')
  assert.doesNotMatch(snap.travail, /perime/, 'le resume obsolete n a rien ecrit')
})

test('R06 resetWork pendant compaction : abandon, vidage preserve', async () => {
  const mem = freshMemory(tmpFile('memory-r06-reset-'), PETITS_SEUILS)
  mem.load()
  const ecluse = compactorAEcluse()
  mem.setCompactor(ecluse.fn)
  await ecrireAuDelaDuSeuil(mem)
  const enVol = mem.write('travail', GROSSE_NOTE)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(ecluse.appels.length, 1)
  mem.resetWork()
  ecluse.release('resume perime du compacteur')
  const res = await enVol
  assert.equal(res.ok, false)
  assert.equal(res.conflit, true)
  assert.equal(mem.snapshot().travail, null, 'le vidage n est pas re-ecrase')
})

test('R06 clear total pendant compaction : abandon, effacement preserve', async () => {
  const mem = freshMemory(tmpFile('memory-r06-clear-'), PETITS_SEUILS)
  mem.load()
  const ecluse = compactorAEcluse()
  mem.setCompactor(ecluse.fn)
  await ecrireAuDelaDuSeuil(mem)
  const enVol = mem.write('travail', GROSSE_NOTE)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(ecluse.appels.length, 1)
  const efface = mem.clear('tout')
  assert.equal(efface.ok, true)
  ecluse.release('resume perime du compacteur')
  const res = await enVol
  assert.equal(res.ok, false)
  assert.equal(res.conflit, true)
  assert.equal(mem.snapshot().travail, null)
  assert.equal(mem.snapshot().long_terme, null)
})

test('R06 aller-retour de scope sans mutation : pas de faux conflit', async () => {
  const mem = freshMemory(tmpFile('memory-r06-scope-'), PETITS_SEUILS)
  mem.load()
  const ecluse = compactorAEcluse()
  mem.setCompactor(ecluse.fn)
  mem.setActiveScope('A')
  await ecrireAuDelaDuSeuil(mem)
  const enVol = mem.write('travail', GROSSE_NOTE)
  await new Promise((resolve) => setImmediate(resolve))
  mem.setActiveScope('B')
  const noteB = await mem.write('travail', 'note de B')
  assert.equal(noteB.ok, true)
  mem.setActiveScope('A')
  ecluse.release('resume court de A')
  const res = await enVol
  assert.equal(res.ok, true, 'rien n a mute le contexte A : pas de conflit')
  assert.equal(mem.snapshot().travail, 'resume court de A')
  mem.setActiveScope('B')
  assert.equal(mem.snapshot().travail, 'note de B', 'B intact, sans contamination de A')
})

test('R25 A suspend -> B -> B termine -> A reprend : contexte A intact', async () => {
  const mem = freshMemory(tmpFile('memory-r25-'))
  mem.load()
  // A travaille : fil + tampon long terme.
  mem.setActiveScope('A')
  assert.equal(await mem.write('travail', 'fil de A').then((r) => r.ok), true)
  assert.equal(await mem.write({ texte: 'souvenir de A', portee: 'long_terme' }).then((r) => r.ok), true)
  const scopeA = mem.getActiveScope()
  assert.equal(scopeA, 'A')
  // Suspension : aucun commit force — le long terme est encore vide et le
  // changement de scope n ecrit rien.
  mem.setActiveScope('B')
  assert.equal(mem.snapshot().long_terme, null)
  // B demarre : nouveau contexte, resetWork cible (A intact).
  mem.resetWork()
  assert.equal(mem.snapshot().travail, null)
  assert.equal(mem.snapshot().a_retenir, null)
  assert.equal(await mem.write('travail', 'fil de B').then((r) => r.ok), true)
  assert.equal(await mem.write({ texte: 'souvenir de B', portee: 'long_terme' }).then((r) => r.ok), true)
  assert.equal(mem.snapshot().long_terme, null, 'toujours rien de committe')
  // B termine : commit selon les regles (tampon de B dans le long terme global).
  const genAvant = mem.generation
  const commitB = mem.commitLongTerm()
  assert.equal(commitB.ok, true)
  assert.equal(mem.generation, genAvant + 1)
  assert.equal(mem.snapshot().long_terme, 'souvenir de B')
  assert.equal(mem.snapshot().a_retenir, null)
  // A reprend : exactement son contexte, pas de contamination B.
  mem.setActiveScope(scopeA)
  const snapA = mem.snapshot()
  assert.match(snapA.travail, /fil de A/)
  assert.doesNotMatch(snapA.travail, /fil de B/)
  assert.match(snapA.a_retenir, /souvenir de A/)
  assert.doesNotMatch(snapA.a_retenir ?? '', /souvenir de B/)
  // Long terme global partage : le commit de B y est visible depuis A.
  assert.equal(snapA.long_terme, 'souvenir de B')
})

test('R25 resetWork ne vide que le contexte actif', async () => {
  const mem = freshMemory(tmpFile('memory-r25-reset-'))
  mem.load()
  mem.setActiveScope('A')
  await mem.write('travail', 'fil de A')
  await mem.write({ texte: 'souvenir de A', portee: 'long_terme' })
  mem.setActiveScope('B')
  await mem.write('travail', 'fil de B')
  mem.resetWork()
  assert.equal(mem.snapshot().travail, null)
  assert.equal(mem.snapshot().a_retenir, null)
  mem.setActiveScope('A')
  assert.match(mem.snapshot().travail, /fil de A/, 'A intact apres resetWork de B')
  assert.match(mem.snapshot().a_retenir, /souvenir de A/)
})

test('R25 imbrique A -> B -> C : chaque reprise retrouve son contexte', async () => {
  const mem = freshMemory(tmpFile('memory-r25-nest-'))
  mem.load()
  mem.setActiveScope('A')
  await mem.write('travail', 'fil de A')
  await mem.write({ texte: 'souvenir de A', portee: 'long_terme' })
  mem.setActiveScope('B')
  mem.resetWork()
  await mem.write('travail', 'fil de B')
  await mem.write({ texte: 'souvenir de B', portee: 'long_terme' })
  mem.setActiveScope('C')
  mem.resetWork()
  await mem.write('travail', 'fil de C')
  await mem.write({ texte: 'souvenir de C', portee: 'long_terme' })
  // C termine puis B reprend : B intact, sans trace de C.
  assert.equal(mem.commitLongTerm().ok, true)
  assert.equal(mem.snapshot().long_terme, 'souvenir de C')
  mem.setActiveScope('B')
  assert.match(mem.snapshot().travail, /fil de B/)
  assert.doesNotMatch(mem.snapshot().travail, /fil de C/)
  assert.match(mem.snapshot().a_retenir, /souvenir de B/)
  // B termine puis A reprend : A intact, sans trace de B ni C.
  assert.equal(mem.commitLongTerm().ok, true)
  assert.equal(mem.snapshot().long_terme, 'souvenir de C\nsouvenir de B')
  mem.setActiveScope('A')
  const snapA = mem.snapshot()
  assert.match(snapA.travail, /fil de A/)
  assert.doesNotMatch(snapA.travail, /fil de [BC]/)
  assert.match(snapA.a_retenir, /souvenir de A/)
  assert.doesNotMatch(snapA.a_retenir ?? '', /souvenir de [BC]/)
  // A termine : le long terme global porte les trois commits, dans l ordre.
  assert.equal(mem.commitLongTerm().ok, true)
  assert.equal(mem.snapshot().long_terme, 'souvenir de C\nsouvenir de B\nsouvenir de A')
  assert.equal(mem.snapshot().a_retenir, null)
})
