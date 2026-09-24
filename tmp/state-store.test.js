'use strict'
// Tests du module autonome bot/state-store.js (persistance cible D29/C6-C7).
//
// Conventions : node:test + assert/strict (comme tmp/tree-position.test.js),
// CommonJS, aucune dependance externe, donnees ecrites UNIQUEMENT dans un
// repertoire temporaire de l OS (os.tmpdir) : jamais de /data reel, jamais
// de chemin en dur du projet.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createStateStore } = require('../bot/state-store')

const SECRET_MARKERS = ['opencode-go', 'PLANNER_API_KEY', 'TYPESAFE_API_KEY', 'sk-', 'Bearer']

function freshStore (withEvents = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-store-'))
  const file = path.join(dir, 'snapshot.json')
  const eventFile = path.join(dir, 'events.jsonl')
  const store = createStateStore(withEvents ? { file, eventFile } : { file })
  assert.ok(file.startsWith(os.tmpdir()), 'donnees de test sous tmpdir OS uniquement')
  return { dir, file, eventFile, store }
}

function sampleSnapshot () {
  return {
    objectifs: [{ id: 'obj-1', texte: 'construire un abri', statut: 'en_cours' }],
    inbox: [{ id: 'msg-1', auteur: 'joueur', texte: 'continue', date: '2026-09-24T00:00:00.000Z' }],
    lieux: [{ nom: 'base', x: 10, y: 64, z: -20, provenance: 'mesure', date: '2026-09-24T00:00:00.000Z' }],
    preferences: { bavard: true }
  }
}

test('absent : load() vaut null et readEvents() vaut []', () => {
  const { store } = freshStore()
  assert.equal(store.load(), null)
  assert.deepEqual(store.readEvents(), [])
})

test('chemins explicites : options invalides refusees', () => {
  assert.throws(() => createStateStore(), TypeError)
  assert.throws(() => createStateStore({}), TypeError)
  assert.throws(() => createStateStore({ file: '' }), TypeError)
  assert.throws(() => createStateStore({ file: 42 }), TypeError)
  const { store } = freshStore(false)
  assert.equal(store.eventFile, null)
  assert.throws(() => store.appendEvent({ type: 'x' }), /eventFile/)
  assert.throws(() => store.readEvents(), /eventFile/)
})

test('roundtrip : save/load conserve objectifs, inbox, lieux/provenance, preferences', () => {
  const { store } = freshStore()
  const snapshot = sampleSnapshot()
  store.save(snapshot)
  assert.deepEqual(store.load(), snapshot)
})

test('redemarrage : une nouvelle instance relit le meme fichier', () => {
  const { file, eventFile } = freshStore()
  const first = createStateStore({ file, eventFile })
  first.save(sampleSnapshot())
  first.appendEvent({ type: 'note', texte: 'bonjour' })
  const second = createStateStore({ file, eventFile })
  assert.deepEqual(second.load(), sampleSnapshot())
  assert.equal(second.readEvents().length, 1)
  assert.equal(second.readEvents()[0].texte, 'bonjour')
})

test('copie : muter le resultat de load() ne change pas la donnee stockee', () => {
  const { store } = freshStore()
  store.save(sampleSnapshot())
  const copy = store.load()
  copy.objectifs.push({ id: 'obj-2' })
  copy.preferences.bavard = false
  assert.deepEqual(store.load(), sampleSnapshot())
})

test('validation snapshot : refus des non-objets et des valeurs non JSON', () => {
  const { store } = freshStore()
  for (const bad of [null, 42, 'texte', [1, 2], undefined]) {
    assert.throws(() => store.save(bad), TypeError)
  }
  const circular = { a: 1 }
  circular.self = circular
  assert.throws(() => store.save(circular), TypeError)
})

test('corruption snapshot : load() leve au lieu de remettre a zero en silence', () => {
  const { file, store } = freshStore()
  store.save(sampleSnapshot())
  fs.writeFileSync(file, '{ json casse', 'utf8')
  assert.throws(() => store.load(), /corrompu/)
  fs.writeFileSync(file, '[1,2]', 'utf8')
  assert.throws(() => store.load(), /corrompu/)
})

test('echec write : l ancienne donnee reste lisible', () => {
  const { store } = freshStore()
  const before = sampleSnapshot()
  store.save(before)
  const circular = { a: 1 }
  circular.self = circular
  assert.throws(() => store.save(circular), TypeError)
  assert.deepEqual(store.load(), before)
})

test('appendEvent : id+date attribues si absents, preserves si fournis', () => {
  const { store } = freshStore()
  const attributed = store.appendEvent({ type: 'note', texte: 'sans identite' })
  assert.ok(typeof attributed.id === 'string' && attributed.id !== '')
  assert.ok(typeof attributed.date === 'string' && attributed.date !== '')
  const kept = store.appendEvent({ id: 'evt-fixe', date: '2026-01-02T03:04:05.000Z', type: 'note' })
  assert.equal(kept.id, 'evt-fixe')
  assert.equal(kept.date, '2026-01-02T03:04:05.000Z')
  assert.throws(() => store.appendEvent(null), TypeError)
  assert.throws(() => store.appendEvent('texte'), TypeError)
  const circular = { type: 'x' }
  circular.self = circular
  assert.throws(() => store.appendEvent(circular), TypeError)
})

test('historique : ordre d ajout, borne limit sans tronquer le stockage, beforeId', () => {
  const { eventFile, store } = freshStore()
  const ids = []
  for (let i = 1; i <= 5; i++) {
    ids.push(store.appendEvent({ id: `e${i}`, type: 'note', rang: i }).id)
  }
  const all = store.readEvents()
  assert.deepEqual(all.map((e) => e.id), ['e1', 'e2', 'e3', 'e4', 'e5'])
  const last2 = store.readEvents({ limit: 2 })
  assert.deepEqual(last2.map((e) => e.id), ['e4', 'e5'])
  // Stockage non tronque : le fichier contient toujours les 5 lignes.
  const lines = fs.readFileSync(eventFile, 'utf8').split('\n').filter((l) => l !== '')
  assert.equal(lines.length, 5)
  assert.deepEqual(store.readEvents().map((e) => e.id), ids)
  const before = store.readEvents({ beforeId: 'e4' })
  assert.deepEqual(before.map((e) => e.id), ['e1', 'e2', 'e3'])
  const combined = store.readEvents({ beforeId: 'e5', limit: 2 })
  assert.deepEqual(combined.map((e) => e.id), ['e3', 'e4'])
  assert.throws(() => store.readEvents({ beforeId: 'inconnu' }), /inconnu/)
  assert.throws(() => store.readEvents({ limit: 0 }), TypeError)
  assert.throws(() => store.readEvents({ limit: 'beaucoup' }), TypeError)
})

test('historique : copies rendues, muter le resultat ne change pas le stockage', () => {
  const { store } = freshStore()
  store.appendEvent({ id: 'e1', type: 'note', texte: 'origine' })
  const first = store.readEvents()
  first[0].texte = 'mute'
  first.push({ id: 'faux' })
  const second = store.readEvents()
  assert.equal(second.length, 1)
  assert.equal(second[0].texte, 'origine')
})

test('corruption journal : readEvents() leve avec la ligne fautive', () => {
  const { eventFile, store } = freshStore()
  store.appendEvent({ id: 'e1', type: 'note' })
  fs.appendFileSync(eventFile, '{ ligne cassee\n', 'utf8')
  assert.throws(() => store.readEvents(), /corrompu/)
})

test('aucune donnee secrete dans les fichiers de test', () => {
  const { dir, file, eventFile, store } = freshStore()
  store.save(sampleSnapshot())
  store.appendEvent({ type: 'note', texte: 'lieu mesure a la base' })
  assert.ok(!dir.includes('data'), 'pas de /data reel utilise')
  for (const f of [file, eventFile]) {
    const raw = fs.readFileSync(f, 'utf8')
    for (const marker of SECRET_MARKERS) {
      assert.ok(!raw.includes(marker), `marqueur secret absent : ${marker}`)
    }
  }
})
