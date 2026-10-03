'use strict'

// Journalisation des erreurs et avertissements vers un FICHIER **et** vers le
// chat Minecraft, systematiquement.
//
// Pourquoi encapsuler console.error/console.warn plutot que reecrire les appels
// du projet : il y en a une vingtaine repartis dans les modules, et la capture
// reste vraie pour du code de dependances qu on ne controle pas. La sortie
// d origine (stderr) est toujours emise, donc `docker compose logs bot` continue
// de fonctionner comme avant ; le fichier est le complement persistant (volume
// `bot-data`), le chat previent le joueur connecte.
//
// Trois regles de conception, parce qu un logger ne doit jamais devenir la panne
// qu il est cense rapporter :
//   - toute defaillance interne est avalee (jamais d exception propagee) ;
//   - un drapeau de reentrance empeche le logger de se rappeler lui-meme ;
//   - le chat est dedoublonne et plafonne, le fichier ne l est jamais.

const fs = require('fs')
const path = require('path')
const util = require('util')
// R19 : parsing central des plafonds (bot/config.js) : reglages non
// critiques, valeur invalide => repli + warning, jamais de NaN silencieux.
const config = require('./config')

const LOG_FILE = process.env.LOG_FILE || '/data/bot.log'
const DEDUP_MS = config.positiveInt(process.env.LOG_DEDUP_MS, 30000, 'LOG_DEDUP_MS')
const CHAT_MAX_PER_MIN = config.positiveInt(process.env.LOG_CHAT_MAX_PER_MIN, 5, 'LOG_CHAT_MAX_PER_MIN')
const CHAT_MAX_LEN = config.positiveInt(process.env.LOG_CHAT_MAX_LEN, 200, 'LOG_CHAT_MAX_LEN')
// Laisse au chat le temps de partir avant process.exit(1) sur une exception non
// capturee. Le fichier, lui, est ecrit en synchrone : rien a vider de ce cote.
const CRASH_DRAIN_MS = config.positiveInt(process.env.LOG_CRASH_DRAIN_MS, 250, 'LOG_CRASH_DRAIN_MS')

// Les appels du projet sont prefixes `[source]`. On s en sert pour le champ
// source de la ligne ; a defaut, la source vaut `app`.
const SOURCE_RE = /^\[([^\]\s]+)\]\s*(.*)$/
const DEDUP_MAP_MAX = 200

const originalError = console.error.bind(console)
const originalWarn = console.warn.bind(console)

let installed = false
let bot = null
let recording = false
let fileErrorLogged = false
const lastChatAt = new Map()
let chatSentAt = []

// Une seule ligne par entree : on neutralise les retours a la ligne (notamment
// les piles d erreur) sans perdre l information.
function oneLine (text) {
  return String(text).replace(/\r?\n/g, '\\n')
}

function writeLine (level, source, message) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${level} ${source} ${oneLine(message)}\n`, 'utf8')
  } catch (err) {
    // Le fichier est un confort : son echec ne doit jamais faire planter le bot,
    // et une seule trace suffit (sinon une panne de disque noie stderr).
    if (!fileErrorLogged) {
      fileErrorLogged = true
      try { originalError(`[log] ecriture impossible dans ${LOG_FILE} : ${err.message}`) } catch (_) {}
    }
  }
}

// Le bot n est joignable que s il est connecte et apparu. Sinon on se contente
// du fichier : mieux vaut un log sans chat qu une exception dans le vide.
function botReady () {
  return Boolean(bot && typeof bot.chat === 'function' && bot.player)
}

function chatAllowed (text, now) {
  const last = lastChatAt.get(text)
  if (last !== undefined && now - last < DEDUP_MS) {
    // On repousse l echeance : une rafale identique reste silencieuse tant
    // qu elle se repete, au lieu de reemettre toutes les DEDUP_MS.
    lastChatAt.set(text, now)
    return false
  }
  lastChatAt.set(text, now)

  if (lastChatAt.size > DEDUP_MAP_MAX) {
    for (const [key, at] of lastChatAt) {
      if (now - at >= DEDUP_MS) lastChatAt.delete(key)
    }
  }

  chatSentAt = chatSentAt.filter(at => now - at < 60000)
  if (chatSentAt.length >= CHAT_MAX_PER_MIN) return false
  chatSentAt.push(now)
  return true
}

function say (text) {
  try { bot.chat(text) } catch (_) {}
}

// Point d entree unique de la journalisation. Toute la mecanique est enveloppee
// dans un try/finally : rien ne sort d ici, jamais.
function record (level, source, message) {
  if (recording) return
  recording = true

  try {
    const text = message === undefined || message === null ? '' : String(message)
    writeLine(level, source, text)

    const chatText = `[${level === 'WARN' ? 'warning' : 'erreur'}] ${source}: ${oneLine(text)}`.slice(0, CHAT_MAX_LEN)
    const now = Date.now()
    if (botReady() && chatAllowed(chatText, now)) say(chatText)
  } catch (_) {
    // Defaillance interne du logger : avalee. Ne jamais casser l appelant.
  } finally {
    recording = false
  }
}

// Extrait `[source]` du message formate comme le ferait console. `util.format`
// reproduit exactement la concatenation des arguments de console.*.
function parse (args) {
  let raw = ''
  try { raw = util.format(...args) } catch (_) { raw = '[message non affichable]' }

  const match = SOURCE_RE.exec(raw)
  if (match) return { source: match[1], message: match[2] }
  return { source: 'app', message: raw }
}

function describe (value) {
  if (value instanceof Error) return value.stack || value.message || String(value)
  try { return typeof value === 'string' ? value : util.format(value) } catch (_) { return '[valeur non affichable]' }
}

// Enveloppe console.warn ou console.error. La sortie d origine est appelee en
// premier, donc rien n est perdu : elle seule alimente `docker compose logs bot`.
function capture (level, emit) {
  const method = level === 'WARN' ? 'warn' : 'error'

  console[method] = (...args) => {
    let parsed = { source: 'app', message: '' }
    try { parsed = parse(args) } catch (_) {}

    try { emit(...args) } catch (_) {}

    record(level, parsed.source, parsed.message)
  }
}

// A appeler une seule fois, le plus tot possible : avant la connexion du bot,
// pour capter aussi les erreurs de connexion.
function install () {
  if (installed) return
  installed = true

  capture('ERROR', originalError)
  capture('WARN', originalWarn)

  // Exception non capturee : on journalise, on previent, puis on quitte en code
  // 1 apres un court delai. Preserver la semantique de crash evite un serveur
  // zombie qui ne repond plus mais reste `healthy`.
  // Poser ce handler supprime l impression stderr par defaut de Node : on
  // reemet donc la sortie d origine nous-memes, en premier, pour que `docker
  // compose logs bot` continue de montrer l exception. `originalError` est la
  // fonction d origine, pas la version interceptee, donc pas de reentrance.
  process.on('uncaughtException', err => {
    try { originalError(err) } catch (_) {}
    record('ERROR', 'process', `Exception non capturee : ${describe(err)}`)
    setTimeout(() => process.exit(1), CRASH_DRAIN_MS)
  })

  // Rejet non gere : meme journalisation, sans quitter. Un rejet de promesse
  // isole ne doit pas tuer un bot qui fonctionne par ailleurs.
  process.on('unhandledRejection', reason => {
    try { originalError(reason) } catch (_) {}
    record('ERROR', 'process', `Rejet de promesse non gere : ${describe(reason)}`)
  })
}

// Lie le logger a l instance Mineflayer (ou la detache avec `attach(null)` quand
// le bot se deconnecte). C est ce qui autorise l ecriture dans le chat.
function attach (instance) {
  bot = instance || null
}

module.exports = {
  install,
  attach,
  LOG_FILE,
  DEDUP_MS,
  CHAT_MAX_PER_MIN,
  CHAT_MAX_LEN
}
