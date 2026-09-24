'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { harness, until } = require('./mission-context-fixture')
const { createConversation } = require('../bot/conversation')

function fixtureDir (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-context-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('conversation -> disque avant fin action -> processus neuf -> reprise explicite -> prompt', t => {
  const dir = fixtureDir(t)
  for (const mode of ['write', 'read']) {
    const child = spawnSync(process.execPath, [path.join(__dirname, 'mission-context-fixture.js'), mode, dir],
      { encoding: 'utf8', timeout: 10000 })
    assert.equal(child.status, 0, `${mode}: ${child.stderr}\n${child.stdout}`)
    assert.match(child.stdout, new RegExp(`CONTEXT_${mode.toUpperCase()}_OK`))
  }
})

test('panne de commit contexte : ancien contexte RAM/disque garde, aucun accuse positif', async t => {
  const f = harness(fixtureDir(t))
  t.after(() => f.close())
  await f.start()
  await f.conversation.receive('Alice', 'premiere precision')
  const before = f.runner.status()
  const originalSave = f.store.save
  f.store.save = snapshot => {
    if (snapshot.current?.progression?.contexte?.some(e => e.message === 'refusee')) throw new Error('fixture disk unavailable')
    return originalSave(snapshot)
  }
  f.messages.length = 0
  const result = await f.conversation.receive('Bob', 'refusee')
  assert.match(result.error, /disk unavailable/)
  assert.deepEqual(f.runner.status().precisions, before.precisions)
  assert.deepEqual(f.runner.status().autorisations, before.autorisations)
  assert.deepEqual(f.store.load().current.progression.contexte, before.precisions)
  assert.ok(f.store.load().inbox.some(m => m.texte === 'refusee'), 'historique conserve meme si admission refusee')
  assert.ok(f.messages.some(m => /precision.*(?:impossible|refusee|pas)/i.test(m)))
  assert.ok(!f.messages.includes('Precision acceptee.'))
  assert.throws(() => f.runner.addContext('refusee', 'Bob', { clearanceBlocks: 1 }), /disk unavailable/)
  assert.deepEqual(f.runner.status().autorisations, before.autorisations)
})

test('objectif obsolete : contexte refuse sans contaminer le nouvel engagement', async t => {
  const f = harness(fixtureDir(t))
  t.after(() => f.close())
  await f.start()
  await f.conversation.receive('Alice', 'ancienne precision')
  const before = f.runner.status().precisions
  f.controller.complete('fixture transition')
  f.controller.proposeObjective({ auteur: 'Bob', texte: 'nouvel objectif' })
  f.messages.length = 0
  const result = await f.conversation.receive('Alice', 'obsolete')
  assert.match(result.error, /stale/)
  assert.deepEqual(f.runner.status().precisions, before)
  assert.equal(f.controller.snapshot().current.progression?.contexte, undefined)
  assert.ok(!f.messages.includes('Precision acceptee.'))
})

test('refus admission et panne historique restent visibles dans la conversation', async () => {
  for (const context of [() => false, () => { throw new Error('inbox indisponible') }]) {
    const said = []
    const conversation = createConversation({ status: () => ({ id: 'mission', etat: 'running' }),
      interpret: async () => ({ relation: 'context', response: 'Precision acceptee.' }),
      context, say: text => said.push(text) })
    const result = await conversation.receive('Alice', 'precision')
    assert.equal(typeof result.error, 'string')
    assert.equal(said.length, 1)
    assert.match(said[0], /Precision refusee/)
    assert.ok(!said.includes('Precision acceptee.'))
  }
})

test('snapshots anciens sans contexte et contexte valide clone a la reprise', async t => {
  for (const context of [undefined, [{ de: 'Alice', message: 'reste pres du chene' }]]) {
    const f = harness(fixtureDir(t), { holdPlan: true })
    t.after(() => f.close())
    const admitted = f.controller.proposeObjective({ auteur: 'Alice', texte: 'ramasse du sable' })
    const progression = { descripteur: { kind: 'recolte', resource: 'sable', quota: 10, route: null } }
    if (context !== undefined) progression.contexte = context
    f.controller.recordProgress({ objectifId: admitted.objective.id, ...progression })
    const input = f.controller.snapshot().current
    f.runner.rehydrate(input)
    if (context) input.progression.contexte[0].message = 'mutation externe'
    await until(() => f.plans.length > 0)
    assert.deepEqual(f.runner.status().precisions, context ?? [])
    assert.deepEqual(f.plans[0].consigne.precisions, context ?? [])
    assert.deepEqual(f.runner.status().autorisations.degagement, { limite: 0, consomme: 0 })
  }
})

test('champ contexte present mais corrompu : erreur explicite avant creation ou boucle', t => {
  const invalid = [null, {}, 'texte', [null], [{ de: 1, message: 'texte' }],
    [{ de: 'Alice', message: 2 }], [{ de: 'Alice', message: 'x'.repeat(301) }],
    Array.from({ length: 9 }, () => ({ de: 'Alice', message: 'texte' }))]
  for (const contexte of invalid) {
    const f = harness(fixtureDir(t), { holdPlan: true })
    t.after(() => f.close())
    f.controller.proposeObjective({ auteur: 'Alice', texte: 'ramasse du sable' })
    f.controller.recordProgress({ contexte, descripteur: { kind: 'recolte', resource: 'sable', quota: 10 } })
    f.controller.totalStop('fixture')
    assert.throws(() => f.runner.rehydrate(f.controller.snapshot().current), /contexte.*(?:invalide|corrompu)/)
    assert.equal(f.runner.status(), null)
    assert.equal(f.plans.length, 0)
    assert.equal(f.controller.snapshot().hardstop, true)
  }
})

test('revision et rapport de progression conservent les huit precisions', async t => {
  const f = harness(fixtureDir(t))
  t.after(() => f.close())
  await f.start()
  for (let n = 0; n < 8; n++) f.runner.addContext(`precision ${n}`, 'Alice')
  const before = f.runner.status().precisions
  f.runner.suspend('preuve snapshot complet')
  assert.deepEqual(f.store.load().current.progression.contexte, before)
  const result = await f.runner.revise('ramasse encore du sable', 'Alice')
  assert.equal(result.ok, true)
  assert.deepEqual(f.runner.status().precisions, before)
})
