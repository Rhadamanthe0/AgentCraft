'use strict'

// R19 : parsing central des variables d environnement numeriques / enumerees.
// Contexte : `Number(process.env.X || defaut)` rend NaN sur une valeur non
// numerique ('abc'), et tout garde-fou compare ensuite a NaN (`steps >= NaN`)
// est toujours faux : le garde-fou est desactive en silence. memory.js avait
// deja son `positiveNumber` local ; ce module est l equivalent partage par
// mission.js, planner.js, index.js et build.js.
//
// Regle :
// - garde-fou critique (borne de securite, port d ecoute) : variable renseignee
//   mais invalide => le demarrage est REFUSE avec un message clair (variantes
//   `OrThrow`). Variable absente => defaut, sans erreur.
// - reglage non critique : variable renseignee mais invalide => REPLI explicite
//   sur le defaut + `console.warn`, jamais de NaN / infini silencieux.
// - `logEffectiveConfig()` affiche la config effective au demarrage, sans les
//   secrets (noms *KEY* / *TOKEN* / *SECRET* / *PASSWORD* / *SESSION* exclus).
//
// R10 : parseurs stricts des corps de requetes HTTP (bool / nombre / enum /
// structures), utilises par api.js AVANT tout effet de bord : une requete qui
// rend 4xx ne doit jamais avoir modifie le runtime. Ici, pas de repli : un
// resultat `{ ok: false }` et la route repond 400.

const registry = new Map() // nom -> { valeur, defaut, statut, critique }

function isSecretName (name) {
  return /KEY|TOKEN|SECRET|PASSWORD|SESSION/i.test(String(name ?? ''))
}

// Absent = variable non renseignee : defaut silencieux, ni warning ni refus.
function isUnset (raw) {
  return raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')
}

function note (name, value, fallback, status, critical) {
  if (!name || isSecretName(name)) return
  registry.set(String(name), { valeur: value, defaut: fallback, statut: status, critique: Boolean(critical) })
}

function warnInvalid (name, raw, fallback) {
  try {
    const shown = isSecretName(name) ? '<redacted>' : String(raw)
    console.warn(`[config] ${name} invalide (${shown.length > 60 ? shown.slice(0, 60) + '...' : shown}) : repli ${fallback}`)
  } catch (_) {}
}

function throwInvalid (name, raw, attendu) {
  const shown = isSecretName(name) ? '<redacted>' : JSON.stringify(String(raw))
  throw new Error(`Configuration invalide : ${name}=${shown} (${attendu}) : demarrage refuse`)
}

// Number() : les booleens ne sont jamais des nombres d env (Number(true)
// vaut 1) ; les chaines vides sont traitees par isUnset en amont.
function toFinite (raw) {
  if (typeof raw === 'boolean') return NaN
  const n = Number(raw)
  return Number.isFinite(n) ? n : NaN
}

function finiteNumber (raw, fallback, name, opts = {}) {
  const min = opts.min ?? -Infinity
  const max = opts.max ?? Infinity
  if (isUnset(raw)) {
    if (name) note(name, fallback, fallback, 'defaut', false)
    return fallback
  }
  const n = toFinite(raw)
  if (Number.isFinite(n) && n >= min && n <= max) {
    if (name) note(name, n, fallback, 'env', false)
    return n
  }
  if (name) warnInvalid(name, raw, fallback)
  if (name) note(name, fallback, fallback, 'repli-invalide', false)
  return fallback
}

function positiveInt (raw, fallback, name) {
  if (isUnset(raw)) {
    if (name) note(name, fallback, fallback, 'defaut', false)
    return fallback
  }
  const n = toFinite(raw)
  if (Number.isInteger(n) && n >= 1) {
    if (name) note(name, n, fallback, 'env', false)
    return n
  }
  if (name) warnInvalid(name, raw, fallback)
  if (name) note(name, fallback, fallback, 'repli-invalide', false)
  return fallback
}

function positiveIntOrThrow (raw, fallback, name) {
  if (isUnset(raw)) {
    note(name, fallback, fallback, 'defaut', true)
    return fallback
  }
  const n = toFinite(raw)
  if (Number.isInteger(n) && n >= 1) {
    note(name, n, fallback, 'env', true)
    return n
  }
  throwInvalid(name, raw, 'entier positif attendu')
  return fallback // inatteignable
}

function boundedNumber (raw, fallback, min, max, name, opts = {}) {
  if (isUnset(raw)) {
    if (name) note(name, fallback, fallback, 'defaut', false)
    return fallback
  }
  const n = toFinite(raw)
  const entierOk = opts.integer ? Number.isInteger(n) : true
  if (Number.isFinite(n) && entierOk && n >= min && n <= max) {
    if (name) note(name, n, fallback, 'env', false)
    return n
  }
  if (name) warnInvalid(name, raw, fallback)
  if (name) note(name, fallback, fallback, 'repli-invalide', false)
  return fallback
}

function boundedNumberOrThrow (raw, fallback, min, max, name, opts = {}) {
  if (isUnset(raw)) {
    note(name, fallback, fallback, 'defaut', true)
    return fallback
  }
  const n = toFinite(raw)
  const entierOk = opts.integer ? Number.isInteger(n) : true
  if (Number.isFinite(n) && entierOk && n >= min && n <= max) {
    note(name, n, fallback, 'env', true)
    return n
  }
  throwInvalid(name, raw, `nombre entre ${min} et ${max}${opts.integer ? ' (entier)' : ''} attendu`)
  return fallback // inatteignable
}

// Enum d env : comparaison sur la chaine rognée (et en minuscules si demandé).
// Hors liste => repli + warning, jamais la valeur brute.
function parseEnum (raw, allowed, fallback, name, opts = {}) {
  const norm = value => {
    if (typeof value !== 'string') return value
    let out = opts.trim === false ? value : value.trim()
    if (opts.lower) out = out.toLowerCase()
    return out
  }
  if (isUnset(raw)) {
    if (name) note(name, fallback, fallback, 'defaut', false)
    return fallback
  }
  const candidate = norm(raw)
  if (allowed.includes(candidate)) {
    if (name) note(name, candidate, fallback, 'env', false)
    return candidate
  }
  if (name) warnInvalid(name, raw, fallback)
  if (name) note(name, fallback, fallback, 'repli-invalide', false)
  return fallback
}

// Booleen explicite, jamais Boolean() (qui faisait de 'false' un true et d une
// absence un release, R23). Conversion volontairement bornee (R10) : les vrais
// booleens JSON plus 'true'/'false'/1/0/'1'/'0' ; tout le reste vaut null et la
// route repond 400 SANS effet de bord.
function strictBoolean (raw) {
  if (raw === true || raw === 'true' || raw === 1 || raw === '1') return true
  if (raw === false || raw === 'false' || raw === 0 || raw === '0') return false
  return null
}

// --- Parseurs de requetes HTTP (R10) : { ok: true, value } ou { ok: false, error } ---

function parseRequestNumber (value, opts = {}) {
  const { min = -Infinity, max = Infinity, integer = false, name = 'nombre' } = opts
  let n = NaN
  if (typeof value === 'number') {
    n = value
  } else if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    n = Number(value.trim())
  } else {
    return { ok: false, error: `${name} doit etre un nombre fini` }
  }
  if (!Number.isFinite(n)) return { ok: false, error: `${name} doit etre un nombre fini` }
  if (integer && !Number.isInteger(n)) return { ok: false, error: `${name} doit etre un entier` }
  if (n < min || n > max) return { ok: false, error: `${name} doit etre entre ${min} et ${max}` }
  return { ok: true, value: n }
}

function parseRequestString (value, opts = {}) {
  const { minLen = 1, maxLen = 240, name = 'texte' } = opts
  if (typeof value !== 'string') return { ok: false, error: `${name} doit etre une chaine` }
  const text = value.trim()
  if (text.length < minLen) return { ok: false, error: `${name} doit contenir au moins ${minLen} caractere(s)` }
  if (text.length > maxLen) return { ok: false, error: `${name} doit contenir au plus ${maxLen} caracteres` }
  return { ok: true, value: text }
}

function parseRequestEnum (value, allowed, opts = {}) {
  const { name = 'valeur' } = opts
  if (typeof value !== 'string' || !allowed.includes(value)) {
    return { ok: false, error: `${name} doit etre parmi : ${allowed.join(', ')}` }
  }
  return { ok: true, value }
}

function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseRequestObject (value, opts = {}) {
  const { name = 'objet' } = opts
  if (!isPlainObject(value)) return { ok: false, error: `${name} doit etre un objet JSON` }
  return { ok: true, value }
}

// Tableau JSON borne ; `item: 'object'` exige des objets JSON non tableaux.
function parseRequestArray (value, opts = {}) {
  const { minLen = 1, maxLen = 200, item = null, name = 'liste' } = opts
  if (!Array.isArray(value)) return { ok: false, error: `${name} doit etre un tableau` }
  if (value.length < minLen || value.length > maxLen) {
    return { ok: false, error: `${name} doit contenir entre ${minLen} et ${maxLen} element(s)` }
  }
  if (item === 'object') {
    for (const element of value) {
      if (!isPlainObject(element)) return { ok: false, error: `${name} ne doit contenir que des objets JSON` }
    }
  }
  return { ok: true, value }
}

// Config effective lue jusqu ici, sans les secrets. A appeler au demarrage.
function effectiveConfig () {
  const out = {}
  for (const [name, entry] of registry) {
    if (isSecretName(name)) continue
    out[name] = { ...entry }
  }
  return out
}

function logEffectiveConfig () {
  try {
    const entries = Object.entries(effectiveConfig())
    const shown = entries.map(([name, entry]) =>
      `${name}=${JSON.stringify(entry.valeur)}${entry.statut === 'env' ? '' : ` (${entry.statut})`}`).join(', ')
    console.log(`[config] effective (${entries.length}) : ${shown}`)
  } catch (_) {}
}

// Réservé aux tests : repart d un registre vide entre deux cas.
function _clearRegistry () {
  registry.clear()
}

module.exports = {
  finiteNumber,
  positiveInt,
  positiveIntOrThrow,
  boundedNumber,
  boundedNumberOrThrow,
  parseEnum,
  strictBoolean,
  parseRequestNumber,
  parseRequestString,
  parseRequestEnum,
  parseRequestObject,
  parseRequestArray,
  isPlainObject,
  isSecretName,
  effectiveConfig,
  logEffectiveConfig,
  _clearRegistry
}
