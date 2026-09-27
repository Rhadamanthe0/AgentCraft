'use strict'

// Compte rendu d execution : phases observees, jamais un monologue invente.
// Le heartbeat couvre aussi les await longs (modele, trajet, fabrication) ;
// un meme message repete attend deux fois plus a chaque fois (15, 30, 60 s...) :
// le chat Minecraft est petit, « Je réfléchis… » x12 en 3 min le noyait.
function createActivityReporter ({ say, isActive = () => true, intervalMs = 15000, minNoticeMs = 5000, now = Date.now }) {
  let current = null
  let closed = false
  let lastSpoken = -Infinity
  let lastText = null
  let repeats = 0
  let deliveryError = null
  const startedAt = now()
  const speak = text => {
    if (!text) return
    repeats = text === lastText ? repeats + 1 : 0
    lastText = text
    try {
      say(String(text).replace(/[\r\n]+/g, ' ').slice(0, 230))
      deliveryError = null
    } catch (err) { deliveryError = err.message }
    lastSpoken = now()
  }
  const tick = () => {
    const since = Number.isFinite(lastSpoken) ? lastSpoken : startedAt
    const wait = current?.message === lastText ? intervalMs * 2 ** (repeats + 1) : intervalMs
    if (!closed && isActive() && current && now() - since >= wait) speak(current.message)
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  function update (phase, message, announce = false) {
    if (closed || !isActive()) return
    if (current?.phase !== phase || current.message !== message) current = { phase, message, since: now() }
    if (announce === 'important' || (announce && now() - lastSpoken >= minNoticeMs)) speak(message)
  }
  function finish (phase, message = null) {
    if (closed) return
    closed = true
    clearInterval(timer)
    current = { phase, message, since: now() }
    if (message) speak(message)
  }
  return { update, finish, tick,
    snapshot: () => current && { ...current, elapsedMs: now() - current.since, deliveryError } }
}

const SUBGOALS = {
  rejoindre: 'Je te rejoins…',
  retour: 'Retour au départ…',
  regarder: 'Je me tourne vers toi.',
  suivre: 'Je te suis…',
  attendre: 'J attends.',
  sous_arbre: 'Je cherche une place sous l arbre…'
}
const ACTIONS = {
  regarder_autour: 'Je cherche…',
  avancer: 'J avance…',
  casser: 'Je casse…',
  ramasser: 'Je ramasse…',
  fabriquer: 'Je fabrique…',
  construire: 'Je construis…',
  choisir_terrain: 'Je cherche un terrain…',
  piler: 'Je monte…',
  sortir: 'Je me dégage…',
  attendre: 'J attends.'
}

module.exports = { createActivityReporter, SUBGOALS, ACTIONS }
