'use strict'

// Outillage de candidates code pour l'atelier D04/D15/D51 (ARCHITECTURE C4/C9).
//
// Perimetre : independant de supervisionbackendprod (aucun import vers
// supervisor/core.js, supervisor/process-backend.js, bot/*, ni vers un reseau).
// Zero dependance externe : uniquement node:fs, node:path, node:crypto,
// node:child_process, node:os.
//
// Role : figer une candidate (copie source bot + patch multi-fichiers) dans un
// repertoire de version unique et prive, avec manifest SHA256, puis reverifier
// (rehash filesystem + protections + checks). La doctrine n'a pas encore de
// fichier canonique : le host injecte un doctrineDescriptor trusted
// { version, path, digest } qui est valide (existence + SHA256 == digest) puis
// recopie en lecture seule dans chaque version. Le patch ne peut JAMAIS
// modifier cette copie.
//
// Portee autorisee (scope bot) : fichiers .js, package.json,
// package-lock.json, config *.json non secrets. Refuses : .env, compose,
// server, ops, doctrine, supervisor, secrets, node_modules, .git, internes
// (.manifest.json, .doctrine.snapshot, .descriptor.json).
// Refus absolus : chemin absolu, traversal (..), drive Windows (C:...), UNC
// (\\... ou //...), NTFS ADS (:), NUL (\0), symlink/reparse (lstat), hardlink
// (nlink > 1, best-effort).
//
// Validation EFFECTUEE : scope, protections, structure/schemas JSON package,
// syntaxe JS via `process.execPath --check` borne SANS shell, manifest SHA256
// de TOUS les fichiers candidats + digest doctrine.
// Validation NON effectuee (limite explicite) : AUCUNE analyse du comportement
// du code genere. Ce store ne pretend pas interdire un comportement par lecture
// du code. Statut toujours `pending-trial`, jamais `lastGood` : la preuve jeu
// (essai reel D05/D15) appartient au futur callback core, pas a ce store.
// Aucune installation de deps, aucune execution de script candidate pendant la
// validation (`--check` parse sans executer ; jamais de require() arbitraire
// du process noyau, chargement futur en sandbox uniquement).
//
// API exacte :
//   createCandidateStore({ versionsRoot, botRoot, doctrine,
//                          syntaxTimeoutMs?, fileSizeMax?, filesMax? })
//     -> { prepare({ baseVersion?, changes, reason, version? }),
//          verify(version),
//          getDescriptor(version) }
// prepare : copie source (botRoot, ou versionsRoot/baseVersion si fournie)
//   puis applique changes [{ path, content } | { path, delete: true }],
//   ecritures atomiques (tmp + rename), manifest + snapshot doctrine readonly.
// verify(version) : rehash filesystem + protections + checks (detecte toute
//   alteration apres validation, doctrine incluse).
// getDescriptor(version) : descripteur immuable (Object.freeze) pour le futur
//   callback core.validate : { version, manifestDigest, checks, proof:
//   { status: 'pending-trial', ... }, status: 'pending-trial', doctrine,
//   baseVersion, reason, createdAt, files, validation, limits }.
//   Le callback core devra remplacer proof par une vraie preuve jeu avant tout
//   activate() ; ce store ne fabrique jamais de preuve jeu.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

const VERSION_RE = /^[A-Za-z0-9._-]{1,64}$/
const SHA256_HEX_RE = /^[0-9a-fA-F]{64}$/

const INTERNAL_FILES = new Set(['.manifest.json', '.doctrine.snapshot', '.descriptor.json'])
const SECRET_HINT_RE = /secret|credential|token|private[_-]?key|passwd/i

const LIMITS = 'validation syntaxe+scope+package+empreinte-doctrine uniquement ; ' +
  'aucune analyse de comportement du code genere ; statut pending-trial, ' +
  'jamais lastGood sans preuve jeu (essai reel D05/D15 via futur callback core).'
const VALIDATION_NOTE = 'scope+syntax+package+doctrine-digest only; no behavioral guarantee'

function refusal (code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

function isPlainObject (value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sha256Hex (bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function sha256FileHex (filePath) {
  const data = fs.readFileSync(filePath)
  return sha256Hex(data)
}

// Rejette : absolu, traversal, drive Windows, UNC, ADS, NUL, segments vides.
function assertSafeRel (rel) {
  if (typeof rel !== 'string' || rel === '' || rel.length > 256) {
    throw refusal('path', `chemin relatif requis (1..256) : ${String(rel).slice(0, 80)}`)
  }
  if (rel.includes('\0')) throw refusal('path-nul', `NUL refuse : ${rel.slice(0, 80)}`)
  if (rel.includes(':')) throw refusal('path-ads', `drive/ADS ':' refuse : ${rel.slice(0, 80)}`)
  if (/^[A-Za-z]:/.test(rel)) throw refusal('path-drive', `drive Windows refuse : ${rel.slice(0, 80)}`)
  if (rel.startsWith('\\\\') || rel.startsWith('//')) throw refusal('path-unc', `UNC refuse : ${rel.slice(0, 80)}`)
  if (path.isAbsolute(rel) || rel.startsWith('/') || rel.startsWith('\\')) {
    throw refusal('path-absolute', `chemin absolu refuse : ${rel.slice(0, 80)}`)
  }
  const unified = rel.replace(/\\/g, '/')
  if (unified.startsWith('/') || unified.includes('//')) {
    throw refusal('path', `chemin non normalise refuse : ${rel.slice(0, 80)}`)
  }
  const segments = unified.split('/')
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw refusal('path-traversal', `traversal refuse : ${rel.slice(0, 80)}`)
    }
    if (seg.length > 128) throw refusal('path', `segment trop long : ${rel.slice(0, 80)}`)
  }
  return unified
}

function isProtectedRel (unified) {
  const lower = unified.toLowerCase()
  const segments = lower.split('/')
  const base = segments[segments.length - 1]
  if (INTERNAL_FILES.has(base)) return true
  if (base === '.env' || base.startsWith('.env.') || base.startsWith('.env_')) return true
  if (base === 'compose.yaml' || base === 'compose.yml' ||
    base === 'docker-compose.yaml' || base === 'docker-compose.yml' ||
    base.startsWith('compose.')) return true
  if (base === 'ops.json' || base.startsWith('ops.')) return true
  if (segments.includes('supervisor') || base.startsWith('supervisor')) return true
  if (segments.includes('server') || base.startsWith('server')) return true
  if (lower.includes('doctrine')) return true
  if (segments.includes('node_modules') || segments.includes('.git')) return true
  if (SECRET_HINT_RE.test(base)) return true
  return false
}

function isAllowedRel (unified) {
  if (isProtectedRel(unified)) return false
  const base = unified.split('/').pop()
  const lowerBase = base.toLowerCase()
  if (lowerBase.endsWith('.js')) return true
  if (lowerBase === 'package.json' || lowerBase === 'package-lock.json') return true
  if (lowerBase.endsWith('.json')) {
    if (SECRET_HINT_RE.test(base)) return false
    if (base.startsWith('.')) return false
    return true
  }
  return false
}

function assertNoLink (absPath, rootLabel) {
  let lst
  try {
    lst = fs.lstatSync(absPath)
  } catch (err) {
    throw refusal('fs', `${rootLabel} illisible : ${absPath} (${err.message})`)
  }
  if (lst.isSymbolicLink()) throw refusal('link-symlink', `symlink/reparse refuse : ${absPath}`)
  if (typeof lst.nlink === 'number' && lst.nlink > 1 && lst.isFile()) {
    throw refusal('link-hardlink', `hardlink suspect (nlink=${lst.nlink}) refuse : ${absPath}`)
  }
  return lst
}

// Containment reel : le chemin resolu doit rester sous la racine reelle.
function joinRoot (rootReal, relUnified, rootLabel) {
  const abs = path.join(rootReal, relUnified)
  const rel = path.relative(rootReal, abs)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw refusal('path-escape', `echappement ${rootLabel} refuse : ${relUnified.slice(0, 80)}`)
  }
  let real
  try {
    if (fs.existsSync(abs)) {
      assertNoLink(abs, rootLabel)
      real = fs.realpathSync(abs)
    } else {
      // Cible a creer : verifier chaque parent existant (pas de symlink).
      let cursor = abs
      const missing = []
      while (!fs.existsSync(cursor)) {
        missing.push(cursor)
        const parent = path.dirname(cursor)
        if (parent === cursor) break
        cursor = parent
      }
      assertNoLink(cursor, rootLabel)
      const cursorReal = fs.realpathSync(cursor)
      const rootWithSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep
      if (cursorReal !== rootReal && !cursorReal.startsWith(rootWithSep)) {
        throw refusal('path-escape', `parent hors ${rootLabel} refuse : ${relUnified.slice(0, 80)}`)
      }
      for (const candidate of missing) {
        try {
          const st = fs.lstatSync(candidate)
          if (st.isSymbolicLink()) throw refusal('link-symlink', `symlink refuse : ${candidate}`)
        } catch (err) {
          if (err && (err.code === 'link-symlink')) throw err
          // ENOENT attendu pour les niveaux a creer.
        }
      }
      return abs
    }
  } catch (err) {
    if (err && typeof err.code === 'string' && ['link-symlink', 'link-hardlink', 'path-escape'].includes(err.code)) throw err
    throw refusal('fs', `${rootLabel} resolution impossible : ${abs} (${err.message})`)
  }
  const rootWithSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep
  if (real !== rootReal && !real.startsWith(rootWithSep)) {
    throw refusal('path-escape', `chemin reel hors ${rootLabel} refuse : ${relUnified.slice(0, 80)}`)
  }
  return real
}

function atomicWriteFile (absTarget, bytes) {
  const dir = path.dirname(absTarget)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${absTarget}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, bytes)
  try {
    fs.renameSync(tmp, absTarget)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    throw err
  }
}

function validatePackageJson (bytes, relLabel) {
  let data
  try {
    data = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw refusal('package-json', `${relLabel} : JSON invalide`)
  }
  if (!isPlainObject(data)) throw refusal('package-schema', `${relLabel} : objet JSON requis`)
  if (typeof data.name !== 'string' || data.name.trim() === '') {
    throw refusal('package-schema', `${relLabel} : champ "name" (chaine non vide) requis`)
  }
  if (data.version != null && typeof data.version !== 'string') {
    throw refusal('package-schema', `${relLabel} : champ "version" chaine requis si present`)
  }
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
    if (data[key] != null) {
      if (!isPlainObject(data[key])) throw refusal('package-schema', `${relLabel} : "${key}" objet requis`)
      for (const [name, range] of Object.entries(data[key])) {
        if (typeof range !== 'string' || range === '') {
          throw refusal('package-schema', `${relLabel} : version de "${name}" chaine requise`)
        }
      }
    }
  }
  if (data.scripts != null) {
    if (!isPlainObject(data.scripts)) throw refusal('package-schema', `${relLabel} : "scripts" objet requis`)
    for (const [name, cmd] of Object.entries(data.scripts)) {
      if (typeof cmd !== 'string') throw refusal('package-schema', `${relLabel} : script "${name}" chaine requise`)
    }
  }
}

function validatePackageLock (bytes, relLabel) {
  let data
  try {
    data = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw refusal('package-json', `${relLabel} : JSON invalide`)
  }
  if (!isPlainObject(data)) throw refusal('package-schema', `${relLabel} : objet JSON requis`)
  if (typeof data.lockfileVersion !== 'number' || ![1, 2, 3].includes(data.lockfileVersion)) {
    throw refusal('package-schema', `${relLabel} : "lockfileVersion" 1/2/3 requis`)
  }
  if (data.name != null && typeof data.name !== 'string') {
    throw refusal('package-schema', `${relLabel} : "name" chaine requis si present`)
  }
  if (data.packages == null && data.dependencies == null) {
    throw refusal('package-schema', `${relLabel} : "packages" ou "dependencies" requis`)
  }
}

function validateGenericJson (bytes, relLabel) {
  try {
    JSON.parse(bytes.toString('utf8'))
  } catch {
    throw refusal('package-json', `${relLabel} : JSON invalide`)
  }
}

function validateStagedJson (relUnified, bytes) {
  const base = relUnified.split('/').pop().toLowerCase()
  if (base === 'package.json') validatePackageJson(bytes, relUnified)
  else if (base === 'package-lock.json') validatePackageLock(bytes, relUnified)
  else if (base.endsWith('.json')) validateGenericJson(bytes, relUnified)
}

// Syntaxe JS bornee, SANS shell, SANS require/execution : `node --check` parse only.
function syntaxCheckFiles (absFiles, timeoutMs) {
  const failures = []
  for (const abs of absFiles) {
    let result
    try {
      result = spawnSync(process.execPath, ['--check', abs], {
        shell: false,
        timeout: timeoutMs,
        encoding: 'utf8',
        windowsHide: true
      })
    } catch (err) {
      throw refusal('syntax-spawn', `syntax spawn impossible : ${err.message}`)
    }
    if (result.error && (result.error.code === 'ETIMEDOUT' || /timed out/i.test(String(result.error.message)))) {
      throw refusal('syntax-timeout', `syntax --check borne depassee (${timeoutMs} ms) : ${path.basename(abs)}`)
    }
    if (result.signal) {
      throw refusal('syntax-timeout', `syntax --check interrompu (${result.signal}) : ${path.basename(abs)}`)
    }
    const status = typeof result.status === 'number' ? result.status : null
    if (status !== 0) {
      const detail = String((result.stderr || result.stdout || result.error || 'erreur syntaxe')).split('\n').slice(0, 3).join(' ').slice(0, 300)
      failures.push(`${path.basename(abs)}: ${detail}`)
    }
  }
  if (failures.length > 0) {
    throw refusal('syntax', `JS invalide : ${failures.slice(0, 3).join(' ; ').slice(0, 500)}`)
  }
}

function listFilesRecursive (rootReal) {
  const out = []
  const stack = [rootReal]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name)
      let lst
      try {
        lst = fs.lstatSync(abs)
      } catch {
        continue
      }
      if (lst.isSymbolicLink()) {
        throw refusal('link-symlink', `symlink/reparse refuse pendant copie : ${abs}`)
      }
      if (lst.isDirectory()) {
        const base = entry.name.toLowerCase()
        if (base === 'node_modules' || base === '.git') continue
        stack.push(abs)
      } else if (lst.isFile()) {
        if (typeof lst.nlink === 'number' && lst.nlink > 1) {
          throw refusal('link-hardlink', `hardlink suspect (nlink=${lst.nlink}) refuse : ${abs}`)
        }
        const rel = path.relative(rootReal, abs).replace(/\\/g, '/')
        out.push({ abs, rel })
      }
    }
  }
  return out
}

function canonicalManifestDigest ({ version, baseVersion, doctrine, files }) {
  const canonical = JSON.stringify({ version, baseVersion: baseVersion || null, doctrine, files })
  return sha256Hex(Buffer.from(canonical, 'utf8'))
}

function freezeDescriptor (descriptor) {
  const files = Object.freeze(descriptor.files.map((file) => Object.freeze({ ...file })))
  const checks = Object.freeze(descriptor.checks.map((check) => Object.freeze({ ...check })))
  return Object.freeze({
    ...descriptor,
    doctrine: Object.freeze({ ...descriptor.doctrine }),
    proof: Object.freeze({ ...descriptor.proof }),
    files,
    checks
  })
}

function createCandidateStore (opts) {
  if (!isPlainObject(opts)) throw new TypeError('options objet requises')
  const { versionsRoot, botRoot, doctrine } = opts
  if (typeof versionsRoot !== 'string' || versionsRoot === '') throw new TypeError('versionsRoot requis')
  if (typeof botRoot !== 'string' || botRoot === '') throw new TypeError('botRoot requis')
  if (!isPlainObject(doctrine)) throw new TypeError('doctrine { version, path, digest } requise (host trusted)')

  const syntaxTimeoutMs = Number(opts.syntaxTimeoutMs == null ? 5000 : opts.syntaxTimeoutMs)
  const fileSizeMax = Number(opts.fileSizeMax == null ? 524288 : opts.fileSizeMax)
  const filesMax = Number(opts.filesMax == null ? 300 : opts.filesMax)
  if (!Number.isFinite(syntaxTimeoutMs) || syntaxTimeoutMs < 50 || syntaxTimeoutMs > 30000) {
    throw new TypeError('syntaxTimeoutMs borne 50..30000 requise')
  }
  if (!Number.isFinite(fileSizeMax) || fileSizeMax < 1024 || fileSizeMax > 8 * 1024 * 1024) {
    throw new TypeError('fileSizeMax borne 1K..8M requise')
  }
  if (!Number.isFinite(filesMax) || filesMax < 1 || filesMax > 1000) {
    throw new TypeError('filesMax borne 1..1000 requise')
  }

  // Racines : doivent exister, etre des repertoires reels distincts et non imbriques.
  for (const [label, candidate] of [['versionsRoot', versionsRoot], ['botRoot', botRoot]]) {
    if (candidate.includes('\0')) throw new TypeError(`${label} NUL refuse`)
    let st
    try {
      st = fs.lstatSync(candidate)
    } catch {
      throw new TypeError(`${label} inexistant : ${candidate}`)
    }
    if (st.isSymbolicLink()) throw new TypeError(`${label} symlink refuse`)
    if (!st.isDirectory()) throw new TypeError(`${label} non repertoire : ${candidate}`)
  }
  const versionsReal = fs.realpathSync(versionsRoot)
  const botReal = fs.realpathSync(botRoot)
  if (versionsReal === botReal) throw new TypeError('versionsRoot et botRoot doivent etre distincts')
  const withSep = (value) => (value.endsWith(path.sep) ? value : value + path.sep)
  if (versionsReal.startsWith(withSep(botReal)) || botReal.startsWith(withSep(versionsReal))) {
    throw new TypeError('versionsRoot et botRoot non imbriques requis')
  }

  // Doctrine trusted injectee par le host, validee ici (existence + SHA256).
  if (typeof doctrine.version !== 'string' || !VERSION_RE.test(doctrine.version)) {
    throw new TypeError('doctrine.version identifiant requis (1..64, [A-Za-z0-9._-])')
  }
  if (typeof doctrine.path !== 'string' || doctrine.path === '' || doctrine.path.includes('\0')) {
    throw new TypeError('doctrine.path fichier trusted requis')
  }
  if (typeof doctrine.digest !== 'string' || !SHA256_HEX_RE.test(doctrine.digest)) {
    throw new TypeError('doctrine.digest SHA256 hex requis')
  }
  let doctrineStat
  try {
    doctrineStat = fs.lstatSync(doctrine.path)
  } catch {
    throw new TypeError(`doctrine.path introuvable : ${doctrine.path}`)
  }
  if (doctrineStat.isSymbolicLink()) throw new TypeError('doctrine.path symlink refuse')
  if (!doctrineStat.isFile()) throw new TypeError('doctrine.path non fichier')
  const doctrineReal = fs.realpathSync(doctrine.path)
  const doctrineBytes = fs.readFileSync(doctrineReal)
  const doctrineDigestActual = sha256Hex(doctrineBytes)
  if (doctrineDigestActual.toLowerCase() !== doctrine.digest.toLowerCase()) {
    throw refusal('doctrine-digest', 'doctrine.digest ne correspond pas au fichier trusted')
  }
  const doctrineTrusted = Object.freeze({
    version: doctrine.version,
    path: doctrineReal,
    digest: doctrine.digest.toLowerCase()
  })

  function versionDirOf (version) {
    if (typeof version !== 'string' || !VERSION_RE.test(version)) {
      throw refusal('candidate-version', 'version identifiant requise (1..64, [A-Za-z0-9._-])')
    }
    return joinRoot(versionsReal, version, 'versionsRoot')
  }

  function readManifest (versionDir) {
    const manifestPath = path.join(versionDir, '.manifest.json')
    assertNoLink(manifestPath, 'version')
    let raw
    try {
      raw = fs.readFileSync(manifestPath, 'utf8')
    } catch {
      throw refusal('manifest-missing', 'manifest absent (version corrompue ou inconnue)')
    }
    let manifest
    try {
      manifest = JSON.parse(raw)
    } catch {
      throw refusal('manifest-corrupt', 'manifest JSON invalide')
    }
    if (!isPlainObject(manifest) || !Array.isArray(manifest.files) ||
      !isPlainObject(manifest.doctrine) || typeof manifest.manifestDigest !== 'string') {
      throw refusal('manifest-corrupt', 'manifest structure invalide')
    }
    return manifest
  }

  function buildChecks () {
    return [
      { name: 'scope', ok: true },
      { name: 'manifest', ok: true },
      { name: 'doctrine', ok: true },
      { name: 'package', ok: true },
      { name: 'syntax', ok: true }
    ]
  }

  function newVersionId () {
    const stamp = Date.now().toString(36)
    const rand = crypto.randomBytes(4).toString('hex')
    return `cand-${stamp}-${rand}`.slice(0, 64)
  }

  function createVersionDirExclusive (wanted) {
    if (wanted != null) {
      if (typeof wanted !== 'string' || !VERSION_RE.test(wanted)) {
        throw refusal('candidate-version', 'version explicite invalide (1..64, [A-Za-z0-9._-])')
      }
      const dir = path.join(versionsReal, wanted)
      try {
        fs.mkdirSync(dir, { recursive: false })
      } catch (err) {
        if (err && err.code === 'EEXIST') throw refusal('version-exists', `version existante : ${wanted}`)
        throw refusal('fs', `creation version impossible : ${err.message}`)
      }
      try { fs.chmodSync(dir, 0o700) } catch { /* best-effort */ }
      return { version: wanted, dir }
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const version = newVersionId()
      const dir = path.join(versionsReal, version)
      try {
        fs.mkdirSync(dir, { recursive: false })
        try { fs.chmodSync(dir, 0o700) } catch { /* best-effort */ }
        return { version, dir }
      } catch (err) {
        if (err && err.code === 'EEXIST') continue
        throw refusal('fs', `creation version impossible : ${err.message}`)
      }
    }
    throw refusal('version-exists', 'impossible de generer un identifiant unique (concurrence)')
  }

  function removeDirQuiet (dir) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch { /* nettoyage best-effort */ }
  }

  async function prepare (args) {
    if (!isPlainObject(args)) throw refusal('args', 'prepare({ baseVersion?, changes, reason }) requis')
    const { baseVersion = null, changes, reason } = args
    if (typeof reason !== 'string' || reason.trim() === '' || reason.length > 500) {
      throw refusal('reason', 'reason motif requis (1..500 caracteres)')
    }
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > filesMax) {
      throw refusal('changes', `changes tableau non vide requis (1..${filesMax})`)
    }
    if (baseVersion != null && (typeof baseVersion !== 'string' || !VERSION_RE.test(baseVersion))) {
      throw refusal('candidate-version', 'baseVersion identifiant invalide')
    }
    const wanted = args.version != null ? args.version : null

    // Valider TOUS les changes AVANT tout effet filesystem.
    const staged = []
    const seen = new Set()
    for (const change of changes) {
      if (!isPlainObject(change) || typeof change.path !== 'string') {
        throw refusal('change', 'chaque change exige { path, content } ou { path, delete: true }')
      }
      const unified = assertSafeRel(change.path)
      if (isProtectedRel(unified)) throw refusal('protected', `chemin protege exclu : ${change.path}`)
      if (!isAllowedRel(unified)) throw refusal('scope', `hors scope bot autorise : ${change.path}`)
      if (seen.has(unified)) throw refusal('change-duplicate', `change duplique : ${change.path}`)
      seen.add(unified)
      if (change.delete === true) {
        if ('content' in change && change.content != null) {
          throw refusal('change', `delete et content exclusifs : ${change.path}`)
        }
        staged.push({ rel: unified, delete: true })
      } else {
        if (typeof change.content !== 'string' && !Buffer.isBuffer(change.content)) {
          throw refusal('change', `content texte requis : ${change.path}`)
        }
        const bytes = Buffer.isBuffer(change.content) ? change.content : Buffer.from(change.content, 'utf8')
        if (bytes.length === 0 || bytes.length > fileSizeMax) {
          throw refusal('change-size', `content borne 1..${fileSizeMax} requis : ${change.path}`)
        }
        validateStagedJson(unified, bytes)
        staged.push({ rel: unified, bytes })
      }
    }

    // Source : baseVersion figee si fournie, sinon botRoot courant.
    let sourceFiles = []
    if (baseVersion) {
      const baseDir = versionDirOf(baseVersion)
      let baseStat
      try {
        baseStat = fs.lstatSync(baseDir)
      } catch {
        throw refusal('base-missing', `baseVersion inconnue : ${baseVersion}`)
      }
      if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) {
        throw refusal('base-missing', `baseVersion invalide : ${baseVersion}`)
      }
      const baseManifest = readManifest(fs.realpathSync(baseDir))
      for (const entry of baseManifest.files) {
        const unified = assertSafeRel(entry.path)
        const abs = joinRoot(fs.realpathSync(baseDir), unified, 'baseVersion')
        assertNoLink(abs, 'baseVersion')
        const bytes = fs.readFileSync(abs)
        sourceFiles.push({ rel: unified, bytes })
      }
    } else {
      const found = listFilesRecursive(botReal)
      for (const { abs, rel } of found) {
        let unified
        try {
          unified = assertSafeRel(rel)
        } catch {
          continue
        }
        if (!isAllowedRel(unified)) continue
        const bytes = fs.readFileSync(abs)
        if (bytes.length === 0 || bytes.length > fileSizeMax) {
          throw refusal('source-size', `source hors borne 1..${fileSizeMax} : ${rel}`)
        }
        validateStagedJson(unified, bytes)
        sourceFiles.push({ rel: unified, bytes })
      }
      if (sourceFiles.length === 0) throw refusal('source-empty', 'aucun fichier bot autorise a figer')
      if (sourceFiles.length > filesMax) throw refusal('source-size', `trop de fichiers source (${sourceFiles.length} > ${filesMax})`)
    }

    const { version, dir: versionDir } = createVersionDirExclusive(wanted)
    try {
      // 1. Copie source (privee, atomique par fichier).
      for (const { rel, bytes } of sourceFiles) {
        const abs = path.join(versionDir, rel)
        atomicWriteFile(abs, bytes)
      }
      // 2. Patch multi-fichiers (add/modify/delete metier, protected deja exclu).
      for (const change of staged) {
        const abs = path.join(versionDir, change.rel)
        if (change.delete === true) {
          let lst
          try {
            lst = fs.lstatSync(abs)
          } catch {
            throw refusal('change-not-found', `delete introuvable : ${change.rel}`)
          }
          if (lst.isSymbolicLink()) throw refusal('link-symlink', `symlink refuse : ${change.rel}`)
          if (!lst.isFile()) throw refusal('change-not-found', `delete non fichier : ${change.rel}`)
          fs.unlinkSync(abs)
        } else {
          joinRoot(versionDir, change.rel, 'version')
          atomicWriteFile(abs, change.bytes)
        }
      }
      // 3. Refuser tout protege residuel (defense en profondeur).
      const after = listFilesRecursive(versionDir)
      for (const { rel } of after) {
        const unified = assertSafeRel(rel)
        if (isProtectedRel(unified)) throw refusal('protected', `protege residuel exclu : ${rel}`)
        if (!isAllowedRel(unified)) throw refusal('scope', `hors scope residuel : ${rel}`)
      }
      if (after.length === 0) throw refusal('source-empty', 'candidate vide apres patch')
      if (after.length > filesMax) throw refusal('source-size', `trop de fichiers candidats (${after.length})`)
      // 4. Revalider TOUS les JSON packages presents (source + patch).
      for (const { abs, rel } of after) {
        const unified = rel.replace(/\\/g, '/')
        if (unified.toLowerCase().endsWith('.json')) {
          validateStagedJson(unified, fs.readFileSync(abs))
        }
      }
      // 5. Syntaxe JS bornee, sans shell, sans execution.
      const jsFiles = after
        .filter(({ rel }) => rel.toLowerCase().endsWith('.js'))
        .map(({ abs }) => abs)
        .sort()
      syntaxCheckFiles(jsFiles, syntaxTimeoutMs)
      // 6. Snapshot doctrine readonly (jamais patchable : INTERNAL + protected).
      const snapshotAbs = path.join(versionDir, '.doctrine.snapshot')
      atomicWriteFile(snapshotAbs, doctrineBytes)
      try { fs.chmodSync(snapshotAbs, 0o444) } catch { /* best-effort */ }
      // 7. Manifest SHA256 de TOUS les fichiers + doctrine.
      const files = after
        .map(({ abs, rel }) => {
          const unified = rel.replace(/\\/g, '/')
          const bytes = fs.readFileSync(abs)
          return { path: unified, sha256: sha256Hex(bytes), bytes: bytes.length }
        })
        .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      const manifest = {
        version,
        baseVersion: baseVersion || null,
        reason: reason.trim(),
        createdAt: new Date().toISOString(),
        doctrine: { version: doctrineTrusted.version, digest: doctrineTrusted.digest },
        files,
        manifestDigest: null,
        validation: VALIDATION_NOTE
      }
      manifest.manifestDigest = canonicalManifestDigest(manifest)
      atomicWriteFile(path.join(versionDir, '.manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'))
      atomicWriteFile(
        path.join(versionDir, '.descriptor.json'),
        Buffer.from(JSON.stringify({
          version,
          manifestDigest: manifest.manifestDigest,
          status: 'pending-trial',
          doctrine: manifest.doctrine,
          baseVersion: manifest.baseVersion,
          reason: manifest.reason,
          createdAt: manifest.createdAt,
          validation: VALIDATION_NOTE,
          limits: LIMITS
        }, null, 2), 'utf8')
      )
      return getDescriptor(version)
    } catch (err) {
      removeDirQuiet(versionDir)
      throw err
    }
  }

  async function verify (version) {
    const versionDir = versionDirOf(version)
    let dirStat
    try {
      dirStat = fs.lstatSync(versionDir)
    } catch {
      throw refusal('version-unknown', `version inconnue : ${version}`)
    }
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
      throw refusal('version-unknown', `version invalide : ${version}`)
    }
    const versionReal = fs.realpathSync(versionDir)
    const manifest = readManifest(versionReal)

    // Doctrine host toujours trusted : le fichier host doit encore matcher.
    let hostBytes
    try {
      const hostStat = fs.lstatSync(doctrineTrusted.path)
      if (hostStat.isSymbolicLink() || !hostStat.isFile()) {
        throw refusal('doctrine-tamper', 'doctrine host invalide (symlink/non-fichier)')
      }
      hostBytes = fs.readFileSync(doctrineTrusted.path)
    } catch (err) {
      if (err && typeof err.code === 'string' && err.code.startsWith('doctrine')) throw err
      throw refusal('doctrine-tamper', `doctrine host illisible : ${err.message}`)
    }
    if (sha256Hex(hostBytes).toLowerCase() !== doctrineTrusted.digest) {
      throw refusal('doctrine-changed', 'doctrine host modifiee depuis injection trusted')
    }
    if (!manifest.doctrine || manifest.doctrine.digest !== doctrineTrusted.digest ||
      manifest.doctrine.version !== doctrineTrusted.version) {
      throw refusal('doctrine-mismatch', 'manifest doctrine differente de la trusted injectee')
    }
    const snapshotAbs = path.join(versionReal, '.doctrine.snapshot')
    try {
      assertNoLink(snapshotAbs, 'version')
      const snapshotBytes = fs.readFileSync(snapshotAbs)
      if (sha256Hex(snapshotBytes).toLowerCase() !== doctrineTrusted.digest) {
        throw refusal('doctrine-tamper', 'copie doctrine candidate alteree')
      }
    } catch (err) {
      if (err && typeof err.code === 'string' && err.code.startsWith('doctrine')) throw err
      throw refusal('doctrine-tamper', `snapshot doctrine absent/illisible : ${err.message}`)
    }

    // Fichiers reels vs manifest (detecte add/delete/modify apres validation).
    const actual = listFilesRecursive(versionReal)
      .map(({ abs, rel }) => ({ abs, rel: rel.replace(/\\/g, '/') }))
      .filter(({ rel }) => !INTERNAL_FILES.has(rel.split('/').pop()))
    for (const { rel } of actual) {
      const unified = assertSafeRel(rel)
      if (isProtectedRel(unified)) throw refusal('protected', `protege residuel : ${rel}`)
      if (!isAllowedRel(unified)) throw refusal('scope', `hors scope : ${rel}`)
    }
    const manifestByPath = new Map(manifest.files.map((entry) => [entry.path, entry]))
    if (actual.length !== manifest.files.length) {
      throw refusal('tamper', `nombre de fichiers different (${actual.length} vs ${manifest.files.length})`)
    }
    for (const { abs, rel } of actual) {
      const expected = manifestByPath.get(rel)
      if (!expected) throw refusal('tamper', `fichier ajoute apres validation : ${rel}`)
      assertNoLink(abs, 'version')
      const bytes = fs.readFileSync(abs)
      if (bytes.length !== expected.bytes || sha256Hex(bytes) !== expected.sha256) {
        throw refusal('tamper', `fichier altere apres validation : ${rel}`)
      }
      if (rel.toLowerCase().endsWith('.json')) validateStagedJson(rel, bytes)
    }
    // Digest canonique : fichiers + doctrine.
    const recomputed = canonicalManifestDigest({
      version: manifest.version,
      baseVersion: manifest.baseVersion,
      doctrine: manifest.doctrine,
      files: manifest.files
    })
    if (recomputed !== manifest.manifestDigest) {
      throw refusal('manifest-corrupt', 'manifestDigest incoherent (manifest altere)')
    }
    // Syntaxe re-jouee (bornee, sans shell, sans execution).
    const jsFiles = actual
      .filter(({ rel }) => rel.toLowerCase().endsWith('.js'))
      .map(({ abs }) => abs)
      .sort()
    syntaxCheckFiles(jsFiles, syntaxTimeoutMs)

    return Object.freeze({
      version: manifest.version,
      ok: true,
      manifestDigest: manifest.manifestDigest,
      checks: Object.freeze(buildChecks().map((check) => Object.freeze({ ...check }))),
      checkedAt: new Date().toISOString()
    })
  }

  function getDescriptor (version) {
    const versionDir = versionDirOf(version)
    const versionReal = fs.realpathSync(versionDir)
    const manifest = readManifest(versionReal)
    const checks = buildChecks()
    return freezeDescriptor({
      version: manifest.version,
      manifestDigest: manifest.manifestDigest,
      checks,
      proof: { status: 'pending-trial', by: 'candidate-store', at: manifest.createdAt },
      status: 'pending-trial',
      doctrine: { version: manifest.doctrine.version, digest: manifest.doctrine.digest },
      baseVersion: manifest.baseVersion,
      reason: manifest.reason,
      createdAt: manifest.createdAt,
      files: manifest.files.map((entry) => ({ path: entry.path, sha256: entry.sha256, bytes: entry.bytes })),
      validation: VALIDATION_NOTE,
      limits: LIMITS
    })
  }

  return { prepare, verify, getDescriptor, LIMITS, VALIDATION_NOTE }
}

module.exports = { createCandidateStore, LIMITS, VALIDATION_NOTE }
