'use strict'

// Compte rendu d execution : phases observees, jamais un monologue invente.
// Le heartbeat couvre aussi les await longs (modele, trajet, fabrication).
function createActivityReporter ({ say, isActive = () => true, intervalMs = 15000, minNoticeMs = 5000, now = Date.now }) {
  let current = null
  let closed = false
  let lastSpoken = -Infinity
  let deliveryError = null
  const startedAt = now()
  const speak = text => {
    if (!text) return
    try {
      say(String(text).replace(/[\r\n]+/g, ' ').slice(0, 230))
      deliveryError = null
    } catch (err) { deliveryError = err.message }
    lastSpoken = now()
  }
  const tick = () => {
    const since = Number.isFinite(lastSpoken) ? lastSpoken : startedAt
    if (!closed && isActive() && current && now() - since >= intervalMs) speak(current.message)
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
  attendre: 'J attends.',
  demander_aide: 'Bloqué, je cherche autrement…',
  reviser_actions: 'Je revois mes méthodes…'
}

module.exports = { createActivityReporter, SUBGOALS, ACTIONS }
