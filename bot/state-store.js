'use strict'

// Persistance cible D29/C6-C7 : module autonome, sans cablage.
//
// Ce que le module fait : stocker un snapshot JSON generique (objectifs,
// inbox, lieux/provenance, preferences, ...) et un journal d evenements
// JSONL, sur des chemins explicites fournis par l appelant. Il ne connait
// aucune logique metier : il valide, copie, ecrit de facon atomique et
// refuse la corruption au lieu de la masquer.
//
// Ce que le module ne fait PAS :
//   - aucun chemin par defaut (pas de /data en dur), aucune variable
//     d environnement lue ;
//   - aucune logique metier (pas de normalisation d objectif/inbox/lieu) ;
//   - aucun verrou multi-process : un seul writer suppose par fichier, les
//     erreurs sont exposees a l appelant, pas masquees ;
//   - aucun reset silencieux : un contenu illisible leve, jamais null.
//
// Retour API exact (voir README de la fonction createStateStore) :
//   const store = createStateStore({ file, eventFile? })
//   store.load() -> copie du snapshot (objet) ou null si fichier absent
//   store.save(snapshot) -> undefined (leve en cas d echec, l ancienne
//     donnee reste en place : l ecriture est atomique par rename)
//   store.appendEvent(event) -> copie de l evenement stocke, avec `id` et
//     `date` preserves s ils sont fournis, attribues sinon
//   store.readEvents({ limit, beforeId } = {}) -> tableau (copies) des
//     evenements dans l ordre d ajout, eventuellement borne aux `limit`
//     derniers et/ou aux evenements precedant `beforeId` (exclu). Le
//     stockage n est jamais tronque par cette lecture.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

let tmpCounter = 0

function isPlainObject (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function requireFileOption (value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`state-store: option ${name} explicite attendue (chaine non vide), recu : ${String(value)}`)
  }
  return value
}

function ensureDirFor (file) {
  const dir = path.dirname(file)
  if (!dir || dir === '.') return
  // Creation prudente : seulement a l ecriture, jamais en lecture.
  // Le mode restreint est une intention (ignore sur Windows) : les erreurs
  // reelles (permission, chemin invalide) restent exposees a l appelant.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
}

// Ecriture atomique crash-safe : le fichier cible n est remplace que par le
// rename final. Tant que le rename n a pas eu lieu, l ancienne donnee reste
// intacte ; un crash avant laisse au pire un .tmp orphelin, jamais un
// fichier tronque a la place de l original.
function writeFileAtomic (file, text) {
  ensureDirFor(file)
  const dir = path.dirname(file)
  const base = path.basename(file)
  tmpCounter += 1
  const tmp = path.join(dir === '.' ? process.cwd() : dir,
    `.${base}.tmp-${process.pid}-${Date.now().toString(36)}-${tmpCounter.toString(36)}`)
  let fd = null
  try {
    fd = fs.openSync(tmp, 'w', 0o600)
    fs.writeFileSync(fd, text, 'utf8')
    try { fs.fsyncSync(fd) } catch (_) { /* fsync indisponible : l atomicite par rename reste */ }
    fs.closeSync(fd)
    fd = null
    try { fs.chmodSync(tmp, 0o600) } catch (_) { /* Windows : droits non POSIX, ignore */ }
    fs.renameSync(tmp, file)
    // Fsync du repertoire : best-effort (indisponible sous Windows, ou
    // l ouverture d un repertoire echoue). Un echec ici ne remet pas en
    // cause le rename deja effectue.
    try {
      const dfd = fs.openSync(dir === '.' ? process.cwd() : dir, 'r')
      try { fs.fsyncSync(dfd) } catch (_) { /* ignore */ }
      fs.closeSync(dfd)
    } catch (_) { /* ignore */ }
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd) } catch (_) { /* ignore */ } }
    try { fs.unlinkSync(tmp) } catch (_) { /* ignore */ }
    throw err
  }
}

function attributionId () {
  if (typeof crypto.randomUUID === 'function') return `evt-${crypto.randomUUID()}`
  return `evt-${Date.now().toString(36)}-${process.pid.toString(36)}-${Math.floor(Math.random() * 0xffffffff).toString(36)}`
}

function normalizeId (value, { field, allowAbsent }) {
  if (value === undefined || value === null || value === '') {
    if (allowAbsent) return null
    throw new TypeError(`state-store: champ ${field} attendu (chaine non vide), recu : ${String(value)}`)
  }
  if ((typeof value === 'string' && value !== '') || (typeof value === 'number' && Number.isFinite(value))) {
    return value
  }
  throw new TypeError(`state-store: champ ${field} attendu (chaine non vide ou nombre fini), recu : ${String(value)}`)
}

function normalizeDate (value) {
  if (value === undefined || value === null || value === '') return new Date().toISOString()
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('state-store: champ date invalide (Date NaN)')
    return value.toISOString()
  }
  if (typeof value === 'string' && value !== '') return value
  throw new TypeError(`state-store: champ date attendu (chaine ISO ou Date), recu : ${String(value)}`)
}

function deepCopy (value) {
  return JSON.parse(JSON.stringify(value))
}

function createStateStore (options = {}) {
  if (!isPlainObject(options)) {
    throw new TypeError('state-store: options attendues sous forme d objet { file, eventFile? }')
  }
  const file = requireFileOption(options.file, 'file')
  const eventFile = options.eventFile === undefined || options.eventFile === null
    ? null
    : requireFileOption(options.eventFile, 'eventFile')

  function load () {
    let raw
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch (err) {
      if (err && err.code === 'ENOENT') return null
      throw err
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new Error(`state-store: snapshot corrompu (${file}) : JSON illisible (${err.message})`)
    }
    if (!isPlainObject(parsed)) {
      throw new Error(`state-store: snapshot corrompu (${file}) : objet JSON attendu`)
    }
    return parsed
  }

  function save (snapshot) {
    if (!isPlainObject(snapshot)) {
      throw new TypeError('state-store: snapshot attendu sous forme d objet JSON (pas de tableau, pas de primitif)')
    }
    let text
    try {
      text = JSON.stringify(snapshot, null, 2) + '\n'
    } catch (err) {
      throw new TypeError(`state-store: snapshot non serialisable en JSON (${err.message})`)
    }
    writeFileAtomic(file, text)
  }

  function appendEvent (event) {
    if (eventFile === null) {
      throw new Error('state-store: aucun fichier d evenements configure (option eventFile absente)')
    }
    if (!isPlainObject(event)) {
      throw new TypeError('state-store: evenement attendu sous forme d objet JSON')
    }
    const stored = { ...event }
    const id = normalizeId(stored.id, { field: 'id', allowAbsent: true })
    stored.id = id === null ? attributionId() : id
    stored.date = normalizeDate(stored.date)
    let line
    try {
      line = JSON.stringify(stored) + '\n'
    } catch (err) {
      throw new TypeError(`state-store: evenement non serialisable en JSON (${err.message})`)
    }
    ensureDirFor(eventFile)
    let fd = null
    try {
      fd = fs.openSync(eventFile, 'a', 0o600)
      fs.writeFileSync(fd, line, 'utf8')
      try { fs.fsyncSync(fd) } catch (_) { /* durabilite best-effort */ }
      fs.closeSync(fd)
      fd = null
      try { fs.chmodSync(eventFile, 0o600) } catch (_) { /* Windows : ignore */ }
    } catch (err) {
      if (fd !== null) { try { fs.closeSync(fd) } catch (_) { /* ignore */ } }
      throw err
    }
    return deepCopy(stored)
  }

  function readEvents (options = {}) {
    if (eventFile === null) {
      throw new Error('state-store: aucun fichier d evenements configure (option eventFile absente)')
    }
    const opts = options === undefined ? {} : options
    if (!isPlainObject(opts)) {
      throw new TypeError('state-store: options de lecture attendues sous forme d objet { limit?, beforeId? }')
    }
    let limit = null
    if (opts.limit !== undefined && opts.limit !== null) {
      if (!Number.isInteger(opts.limit) || opts.limit < 1) {
        throw new TypeError('state-store: option limit attendue comme entier >= 1')
      }
      limit = opts.limit
    }
    const hasBefore = opts.beforeId !== undefined && opts.beforeId !== null
    const beforeId = hasBefore ? normalizeId(opts.beforeId, { field: 'beforeId', allowAbsent: false }) : null

    let raw
    try {
      raw = fs.readFileSync(eventFile, 'utf8')
    } catch (err) {
      if (err && err.code === 'ENOENT') return []
      throw err
    }
    if (raw.trim() === '') return []
    const events = []
    const lines = raw.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line === '') continue
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch (err) {
        throw new Error(`state-store: journal corrompu (${eventFile}, ligne ${i + 1}) : JSON illisible (${err.message})`)
      }
      if (!isPlainObject(parsed)) {
        throw new Error(`state-store: journal corrompu (${eventFile}, ligne ${i + 1}) : objet JSON attendu`)
      }
      events.push(parsed)
    }
    let filtered = events
    if (hasBefore) {
      const idx = events.findIndex((e) => e.id === beforeId)
      if (idx === -1) throw new Error(`state-store: evenement inconnu (beforeId=${String(beforeId)})`)
      filtered = events.slice(0, idx)
    }
    if (limit !== null) filtered = filtered.slice(-limit)
    return filtered.map(deepCopy)
  }

  return { file, eventFile, load, save, appendEvent, readEvents }
}

module.exports = { createStateStore }
