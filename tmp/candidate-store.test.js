'use strict'
// Tests outillage candidates D04/D15/D51 : `supervisor/candidate-store.js`.
//
// Conventions : node:test + assert/strict, CommonJS, zero dependance externe.
// Ecriture EXCLUSIVE : seuls supervisor/candidate-store.js et ce test existent.
// Tous les fichiers (botRoot source, versionsRoot, doctrine) vivent sous
// os.tmpdir(). Aucune install deps, aucune execution candidate (un fichier
// `process.exit(99)` valide prouve le non-exec pendant validation).

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { createCandidateStore } = require('../supervisor/candidate-store')

function sha256 (bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function freshDir (prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  assert.ok(dir.startsWith(os.tmpdir()), 'fixtures sous tmpdir OS uniquement')
  return dir
}

function writeFile (abs, content) {
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

const GOOD_PACKAGE = JSON.stringify({ name: 'bot-fixture', version: '0.0.1', dependencies: {} }, null, 2)
const GOOD_LOCK = JSON.stringify({ name: 'bot-fixture', lockfileVersion: 3, packages: { '': { name: 'bot-fixture' } } }, null, 2)

function makeBotRoot (dir) {
  writeFile(path.join(dir, 'index.js'), `'use strict'\nmodule.exports = 1\n`)
  writeFile(path.join(dir, 'lib', 'util.js'), `'use strict'\nmodule.exports = { ok: true }\n`)
  writeFile(path.join(dir, 'package.json'), GOOD_PACKAGE)
  writeFile(path.join(dir, 'package-lock.json'), GOOD_LOCK)
  writeFile(path.join(dir, 'config.json'), JSON.stringify({ level: 1 }))
  // Fichiers hors scope presents a la source : ne doivent jamais etre copies.
  writeFile(path.join(dir, '.env'), 'PLANNER_API_KEY=secret-ne-pas-copier')
  writeFile(path.join(dir, 'compose.yaml'), 'services: {}')
  return dir
}

function makeDoctrine (dir, content) {
  const abs = path.join(dir, 'doctrine.txt')
  writeFile(abs, content == null ? 'doctrine-courante-v3 : stop prioritaire\n' : content)
  const bytes = fs.readFileSync(abs)
  return { path: abs, version: 'doctrine-v3', digest: sha256(bytes) }
}

function makeStore (over) {
  const base = freshDir('cand-')
  const botRoot = path.join(base, 'bot')
  const versionsRoot = path.join(base, 'versions')
  fs.mkdirSync(botRoot, { recursive: true })
  fs.mkdirSync(versionsRoot, { recursive: true })
  makeBotRoot(botRoot)
  const doctrineDir = path.join(base, 'host')
  fs.mkdirSync(doctrineDir, { recursive: true })
  const doctrine = makeDoctrine(doctrineDir)
  const store = createCandidateStore({ versionsRoot, botRoot, doctrine, ...(over || {}).storeOpts })
  return { base, botRoot, versionsRoot, doctrine, store }
}

async function rejectsCode (promise, ...codes) {
  await assert.rejects(promise, (err) => err && codes.includes(err.code),
    `attendu code ${codes.join('/')} (recu autre)`)
}

test('chemin nominal : prepare copie+patch, manifest, verify ok, descripteur pending-trial fige', async (t) => {
  const { store, versionsRoot } = makeStore()
  const descriptor = await store.prepare({
    reason: 'corrige util',
    changes: [
      { path: 'lib/util.js', content: `'use strict'\nmodule.exports = { ok: 2 }\n` },
      { path: 'lib/nouveau.js', content: `'use strict'\nmodule.exports = 3\n` }
    ]
  })
  assert.match(descriptor.version, /^[A-Za-z0-9._-]{1,64}$/)
  assert.equal(descriptor.status, 'pending-trial')
  assert.equal(descriptor.proof.status, 'pending-trial')
  assert.ok(descriptor.manifestDigest.length >= 8)
  assert.ok(descriptor.checks.length > 0 && descriptor.checks.every((c) => c.ok === true))
  assert.ok(Object.isFrozen(descriptor) && Object.isFrozen(descriptor.checks) && Object.isFrozen(descriptor.files))
  assert.equal(descriptor.files.some((f) => f.path === '.env'), false, '.env source jamais copie')
  assert.equal(descriptor.files.some((f) => f.path.includes('compose')), false, 'compose jamais copie')
  // Fichiers reels presents, snapshot doctrine readonly present.
  const versionDir = path.join(versionsRoot, descriptor.version)
  assert.ok(fs.existsSync(path.join(versionDir, 'lib', 'nouveau.js')))
  assert.ok(fs.existsSync(path.join(versionDir, '.manifest.json')))
  assert.ok(fs.existsSync(path.join(versionDir, '.doctrine.snapshot')))
  // Forme compatible futur callback core.validate : version/manifestDigest/checks/proof.
  assert.ok(typeof descriptor.version === 'string')
  assert.ok(typeof descriptor.manifestDigest === 'string')
  assert.ok(Array.isArray(descriptor.checks))
  assert.ok(descriptor.proof && typeof descriptor.proof === 'object')
  const verified = await store.verify(descriptor.version)
  assert.equal(verified.ok, true)
  assert.equal(verified.manifestDigest, descriptor.manifestDigest)
  const again = store.getDescriptor(descriptor.version)
  assert.deepEqual(again.files, descriptor.files)
  assert.throws(() => { again.version = 'x' }, 'descripteur immuable')
})

test('non-execution candidate : process.exit(99) valide ne tue pas le noyau', async (t) => {
  const { store } = makeStore()
  const descriptor = await store.prepare({
    reason: 'preuve non-exec',
    changes: [{ path: 'lib/bombe.js', content: `'use strict'\nprocess.exit(99)\n` }]
  })
  const verified = await store.verify(descriptor.version)
  assert.equal(verified.ok, true, 'valide syntaxiquement mais jamais execute')
  assert.equal(process.exitCode, undefined, 'le process de test vit toujours')
  void t
})

test('echappements et astuces refuses avant tout effet', async (t) => {
  const { store, versionsRoot } = makeStore()
  const before = new Set(fs.readdirSync(versionsRoot))
  const evilPaths = [
    '/absolu.js',
    '../echappe.js',
    'sous/../../echappe.js',
    'C:\\evil.js',
    'D:evil.js',
    '\\\\serveur\\partage.js',
    '//serveur/partage.js',
    'flux.js:stream',
    'nul\0.js',
    '..\\win.js'
  ]
  for (const evil of evilPaths) {
    await rejectsCode(store.prepare({ reason: 'evil', changes: [{ path: evil, content: 'x' }] }),
      'path', 'path-nul', 'path-ads', 'path-drive', 'path-unc', 'path-absolute', 'path-traversal', 'path-escape', 'scope')
  }
  const protectedPaths = [
    '.env', '.env.local', 'compose.yaml', 'docker-compose.yml',
    'ops.json', 'server.js', 'server/config.js',
    'supervisor/core.js', 'doctrine.txt', 'ma-doctrine-v1.js',
    'config.secret.json', '.manifest.json', '.doctrine.snapshot'
  ]
  for (const evil of protectedPaths) {
    await rejectsCode(store.prepare({ reason: 'protege', changes: [{ path: evil, content: 'x' }] }),
      'protected', 'scope')
  }
  await rejectsCode(store.prepare({ reason: 'scope', changes: [{ path: 'notes.txt', content: 'x' }] }), 'scope')
  await rejectsCode(store.prepare({ reason: 'vide', changes: [] }), 'changes')
  await rejectsCode(store.prepare({ reason: '', changes: [{ path: 'a.js', content: 'x' }] }), 'reason')
  assert.deepEqual(new Set(fs.readdirSync(versionsRoot)), before, 'aucune version creee sur refus')
})

test('symlink source refuse (risque reparse/hardlink)', async (t) => {
  const ctx = makeStore()
  const outside = path.join(ctx.base, 'outside.txt')
  writeFile(outside, 'dehors')
  const link = path.join(ctx.botRoot, 'lib', 'lien.js')
  try {
    fs.symlinkSync(outside, link)
  } catch {
    t.skip('symlink impossible sur cet OS/contexte')
    return
  }
  await rejectsCode(ctx.store.prepare({ reason: 'lien', changes: [{ path: 'lib/autre.js', content: `'use strict'\n1\n` }] }),
    'link-symlink', 'link-hardlink')
})

test('package et syntaxe : schemas/structure rejects', async (t) => {
  const { store } = makeStore()
  await rejectsCode(store.prepare({
    reason: 'mauvais json',
    changes: [{ path: 'package.json', content: '{ pas du json' }]
  }), 'package-json')
  await rejectsCode(store.prepare({
    reason: 'schema package',
    changes: [{ path: 'package.json', content: JSON.stringify({ version: 'x' }) }]
  }), 'package-schema')
  await rejectsCode(store.prepare({
    reason: 'schema lock',
    changes: [{ path: 'package-lock.json', content: JSON.stringify({ name: 'x' }) }]
  }), 'package-schema')
  await rejectsCode(store.prepare({
    reason: 'config cassee',
    changes: [{ path: 'config.json', content: '{oups' }]
  }), 'package-json')
  await rejectsCode(store.prepare({
    reason: 'syntaxe cassee',
    changes: [{ path: 'lib/casse.js', content: `'use strict'\nfunction ({\n` }]
  }), 'syntax')
})

test('alteration apres validation detectee (fichiers + doctrine + manifest)', async (t) => {
  const { store, versionsRoot, doctrine } = makeStore()
  const descriptor = await store.prepare({
    reason: 'a surveiller',
    changes: [{ path: 'lib/surveille.js', content: `'use strict'\nmodule.exports = 1\n` }]
  })
  const versionDir = path.join(versionsRoot, descriptor.version)
  // 1. Modification contenu.
  writeFile(path.join(versionDir, 'lib', 'surveille.js'), `'use strict'\nmodule.exports = 999\n`)
  await rejectsCode(store.verify(descriptor.version), 'tamper')
  writeFile(path.join(versionDir, 'lib', 'surveille.js'), `'use strict'\nmodule.exports = 1\n`)
  // 2. Ajout fichier.
  writeFile(path.join(versionDir, 'lib', 'intrus.js'), `'use strict'\n1\n`)
  await rejectsCode(store.verify(descriptor.version), 'tamper')
  fs.unlinkSync(path.join(versionDir, 'lib', 'intrus.js'))
  // 3. Suppression fichier.
  fs.unlinkSync(path.join(versionDir, 'lib', 'surveille.js'))
  await rejectsCode(store.verify(descriptor.version), 'tamper')
  writeFile(path.join(versionDir, 'lib', 'surveille.js'), `'use strict'\nmodule.exports = 1\n`)
  // 4. Snapshot doctrine altere.
  const snapshot = path.join(versionDir, '.doctrine.snapshot')
  try { fs.chmodSync(snapshot, 0o666) } catch { /* windows best-effort */ }
  writeFile(snapshot, 'doctrine-falsifiee')
  await rejectsCode(store.verify(descriptor.version), 'doctrine-tamper')
  writeFile(snapshot, fs.readFileSync(doctrine.path))
  // 5. Manifest corrompu.
  writeFile(path.join(versionDir, '.manifest.json'), '{ corrompu')
  await assert.rejects(store.verify(descriptor.version),
    (err) => err && ['manifest-corrupt', 'manifest-missing', 'tamper'].includes(err.code))
})

test('doctrine trusted : digest faux refuse, host modifie detecte', async (t) => {
  const base = freshDir('cand-doctrine-')
  const botRoot = path.join(base, 'bot')
  const versionsRoot = path.join(base, 'versions')
  fs.mkdirSync(botRoot, { recursive: true })
  fs.mkdirSync(versionsRoot, { recursive: true })
  makeBotRoot(botRoot)
  const doctrineDir = path.join(base, 'host')
  fs.mkdirSync(doctrineDir, { recursive: true })
  const good = makeDoctrine(doctrineDir)
  assert.throws(() => createCandidateStore({
    versionsRoot, botRoot, doctrine: { ...good, digest: '0'.repeat(64) }
  }), (err) => err && err.code === 'doctrine-digest')
  // Patch ciblant la copie doctrine : refuse comme protege.
  const store = createCandidateStore({ versionsRoot, botRoot, doctrine: good })
  await rejectsCode(store.prepare({
    reason: 'touche doctrine', changes: [{ path: '.doctrine.snapshot', content: 'x' }]
  }), 'protected', 'scope')
  const descriptor = await store.prepare({
    reason: 'ok', changes: [{ path: 'lib/ok.js', content: `'use strict'\n1\n` }]
  })
  await store.verify(descriptor.version)
  // Host modifie apres injection => verify refuse.
  fs.appendFileSync(good.path, 'ajout-pirate\n')
  await rejectsCode(store.verify(descriptor.version), 'doctrine-changed')
  void t
})

test('baseVersion : copie puis patch multi-fichiers add/delete, delete inconnu refuse', async (t) => {
  const { store } = makeStore()
  const base = await store.prepare({
    reason: 'base',
    changes: [{ path: 'lib/base.js', content: `'use strict'\nmodule.exports = 1\n` }]
  })
  const derived = await store.prepare({
    reason: 'derive multi',
    baseVersion: base.version,
    changes: [
      { path: 'lib/base.js', content: `'use strict'\nmodule.exports = 2\n` },
      { path: 'lib/ajout.js', content: `'use strict'\nmodule.exports = 3\n` },
      { path: 'lib/util.js', delete: true }
    ]
  })
  assert.equal(derived.baseVersion, base.version)
  const files = new Set(derived.files.map((f) => f.path))
  assert.ok(files.has('lib/ajout.js') && files.has('lib/base.js') && !files.has('lib/util.js'))
  await store.verify(derived.version)
  await rejectsCode(store.prepare({
    reason: 'delete inconnu', baseVersion: base.version,
    changes: [{ path: 'lib/absent.js', delete: true }]
  }), 'change-not-found')
  await rejectsCode(store.prepare({
    reason: 'base inconnue', baseVersion: 'cand-inexistante-zzz',
    changes: [{ path: 'lib/x.js', content: `'use strict'\n1\n` }]
  }), 'base-missing')
})

test('bornes : timeouts usine + syntaxe bornee sans pendre', async (t) => {
  const base = freshDir('cand-bornes-')
  const botRoot = path.join(base, 'bot')
  const versionsRoot = path.join(base, 'versions')
  fs.mkdirSync(botRoot, { recursive: true })
  fs.mkdirSync(versionsRoot, { recursive: true })
  makeBotRoot(botRoot)
  const doctrineDir = path.join(base, 'host')
  fs.mkdirSync(doctrineDir, { recursive: true })
  const doctrine = makeDoctrine(doctrineDir)
  assert.throws(() => createCandidateStore({ versionsRoot, botRoot, doctrine, syntaxTimeoutMs: 1 }),
    TypeError, 'syntaxTimeoutMs borne 50..30000')
  const store = createCandidateStore({ versionsRoot, botRoot, doctrine, syntaxTimeoutMs: 3000 })
  const big = `'use strict'\nconst a = [${Array.from({ length: 2000 }, (_, i) => i).join(',')}]\nmodule.exports = a\n`
  const begun = Date.now()
  const descriptor = await store.prepare({ reason: 'gros mais borne', changes: [{ path: 'lib/gros.js', content: big }] })
  const elapsed = Date.now() - begun
  assert.ok(elapsed < 15000, `borne syntaxe respectee (mesure ${elapsed} ms)`)
  await store.verify(descriptor.version)
})

test('concurrence : N prepares paralleles => versions uniques et verifiables', async (t) => {
  const { store } = makeStore()
  const count = 8
  const results = await Promise.all(Array.from({ length: count }, (_, i) => store.prepare({
    reason: `parallele ${i}`,
    changes: [{ path: `lib/conc${i}.js`, content: `'use strict'\nmodule.exports = ${i}\n` }]
  })))
  const versions = new Set(results.map((d) => d.version))
  assert.equal(versions.size, count, 'identifiants uniques sous concurrence')
  for (const descriptor of results) {
    const verified = await store.verify(descriptor.version)
    assert.equal(verified.manifestDigest, descriptor.manifestDigest)
  }
  void t
})
