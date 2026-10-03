'use strict'
// R07 (commit/clear atomiques, jamais ok:true mensonger) + R24 (corruption
// lecture seule, reparation explicite, status).
// Conventions : node:test + assert/strict, CommonJS, persistance UNIQUEMENT
// sous os.tmpdir (jamais de /data reel). Chaque test recharge bot/memory.js
// avec MEMORY_FILE pointe sur son fichier (module a etat, FILE fige au require).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function freshMemory (file) {
  const id = require.resolve('../bot/memory')
  delete require.cache[id]
  process.env.MEMORY_FILE = file
  const mem = require('../bot/memory')
  delete process.env.MEMORY_FILE
  return mem
}

function tmpFile (prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  assert.ok(dir.startsWith(os.tmpdir()))
  return path.join(dir, 'memory.json')
}

const ORIG = {
  openSync: fs.openSync,
  writeFileSync: fs.writeFileSync,
  fsyncSync: fs.fsyncSync,
  renameSync: fs.renameSync
}

function stubThrow (name, message) {
  fs[name] = () => { throw new Error(message) }
}

function restoreFs () {
  fs.openSync = ORIG.openSync
  fs.writeFileSync = ORIG.writeFileSync
  fs.fsyncSync = ORIG.fsyncSync
  fs.renameSync = ORIG.renameSync
}

test('R07 commit : publie seulement apres ecriture atomique reussie', async () => {
  const file = tmpFile('memory-r07-ok-')
  const mem = freshMemory(file)
  mem.load()
  const w = await mem.write({ texte: 'souvenir du monde', portee: 'long_terme' })
  assert.equal(w.ok, true)
  const genBefore = mem.generation
  const res = mem.commitLongTerm()
  assert.equal(res.ok, true)
  assert.equal(mem.generation, genBefore + 1)
  assert.equal(mem.snapshot().a_retenir, null)
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(raw.long_terme, 'souvenir du monde')
  restoreFs()
})

test('R07 echec persistance (open/write/fsync/rename) : jamais ok:true, tampon conserve, ancien fichier valide', async () => {
  const file = tmpFile('memory-r07-fail-')
  const seed = freshMemory(file)
  seed.load()
  await seed.write({ texte: 'premiere note', portee: 'long_terme' })
  assert.equal(seed.commitLongTerm().ok, true)
  const before = fs.readFileSync(file, 'utf8')
  assert.match(before, /premiere note/)

  for (const name of ['openSync', 'writeFileSync', 'fsyncSync', 'renameSync']) {
    const mem = freshMemory(file)
    mem.load()
    const genBefore = mem.generation
    await mem.write({ texte: 'seconde note', portee: 'long_terme' })
    stubThrow(name, `panne injectee ${name}`)
    let res
    try {
      res = mem.commitLongTerm()
    } finally {
      restoreFs()
    }
    assert.equal(res.ok, false, `commit doit echouer sur panne ${name}`)
    assert.ok(res.error, `erreur exposee sur panne ${name}`)
    assert.match(String(mem.snapshot().a_retenir), /seconde note/, `tampon conserve sur panne ${name}`)
    assert.equal(mem.generation, genBefore, `generation inchangee sur panne ${name}`)
    const after = fs.readFileSync(file, 'utf8')
    assert.equal(after, before, `ancien fichier intact sur panne ${name}`)
    assert.equal(JSON.parse(after).long_terme, 'premiere note')
  }
})

test('R07 clear : echec persistance sans mutation, succes atomique', async () => {
  const file = tmpFile('memory-r07-clear-')
  const mem = freshMemory(file)
  mem.load()
  await mem.write({ texte: 'a oublier', portee: 'long_terme' })
  assert.equal(mem.commitLongTerm().ok, true)
  const before = fs.readFileSync(file, 'utf8')
  const genBefore = mem.generation

  stubThrow('renameSync', 'panne injectee rename')
  let failed
  try {
    failed = mem.clear('long_terme')
  } finally {
    restoreFs()
  }
  assert.equal(failed.ok, false)
  assert.match(String(mem.snapshot().long_terme), /a oublier/)
  assert.equal(mem.generation, genBefore)
  assert.equal(fs.readFileSync(file, 'utf8'), before)

  const ok = mem.clear('long_terme')
  assert.equal(ok.ok, true)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).long_terme, '')
  assert.equal(mem.snapshot().long_terme, null)
})

test('R24 absent : init silencieuse, pas corrompue', () => {
  const file = tmpFile('memory-r24-absent-')
  const target = path.join(path.dirname(file), 'n-existe-pas.json')
  const mem = freshMemory(target)
  mem.load()
  assert.equal(mem.status().corrompue, false)
  assert.equal(mem.snapshot().long_terme, null)
  assert.equal(mem.commitLongTerm().ok, true)
})

test('R24 JSON tronque : corrompue lecture seule, fichier preserve', async () => {
  const file = tmpFile('memory-r24-tronque-')
  fs.writeFileSync(file, '{ "long_terme": "souvenir cou', 'utf8')
  const before = fs.readFileSync(file, 'utf8')
  const mem = freshMemory(file)
  mem.load()
  assert.equal(mem.status().corrompue, true)
  assert.ok(mem.status().erreur)
  await mem.write({ texte: 'note apres corruption', portee: 'long_terme' })
  const c = mem.commitLongTerm()
  assert.equal(c.ok, false)
  assert.equal(mem.clear('long_terme').ok, false)
  assert.equal(mem.clear('tout').ok, false)
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'aucune reecriture auto du corrompu')
})

test('R24 mauvais schema et lecture impossible : corrompues, seul absent est silencieux', () => {
  const bad = tmpFile('memory-r24-schema-')
  fs.writeFileSync(bad, JSON.stringify({ long_terme: 42 }), 'utf8')
  const m1 = freshMemory(bad)
  m1.load()
  assert.equal(m1.status().corrompue, true)
  assert.equal(m1.commitLongTerm().ok, false)
  assert.equal(fs.readFileSync(bad, 'utf8'), JSON.stringify({ long_terme: 42 }))

  const dirAsFile = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-r24-dir-'))
  const m2 = freshMemory(dirAsFile)
  m2.load()
  assert.equal(m2.status().corrompue, true, 'lecture impossible (dossier) = corrompue, pas vide silencieuse')
})

test('R24 reparation explicite : backup .corrupt-* puis commit a nouveau possible', async () => {
  const file = tmpFile('memory-r24-repare-')
  const original = '{ "long_terme": "tronque'
  fs.writeFileSync(file, original, 'utf8')
  const mem = freshMemory(file)
  mem.load()
  assert.equal(mem.status().corrompue, true)
  const rep = mem.repairCorrupted()
  assert.equal(rep.ok, true)
  assert.ok(rep.backup && rep.backup.includes('.corrupt-'), 'backup horodate')
  assert.equal(fs.readFileSync(rep.backup, 'utf8'), original)
  assert.equal(mem.status().corrompue, false)
  await mem.write({ texte: 'note saine', portee: 'long_terme' })
  assert.equal(mem.commitLongTerm().ok, true)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).long_terme, 'note saine')
})
