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
  rejoindre: 'Je cherche un chemin pour te rejoindre.',
  retour: 'Je reviens a mon point de depart.',
  regarder: 'Je me tourne vers toi.',
  suivre: 'Je continue a te suivre.',
  attendre: 'J attends comme demande.',
  sous_arbre: 'Je cherche une place accessible sous la couronne d un arbre.'
}
const ACTIONS = {
  regarder_autour: 'Je regarde autour de moi pour reperer ma cible.',
  avancer: 'Je cherche a avancer vers ma cible.',
  casser: 'Je casse les blocs demandes.',
  ramasser: 'Je cherche a recuperer les objets tombes.',
  fabriquer: 'Je prepare la fabrication avec mon inventaire.',
  construire: 'Je travaille sur les blocs du chantier.',
  choisir_terrain: 'Je cherche un emplacement pour le chantier.',
  piler: 'Je prepare une montee avec les blocs de mon inventaire.',
  sortir: 'Je tente de me degager.',
  attendre: 'J attends comme demande.',
  demander_aide: 'Je suis bloque. Je demande une autre approche avec mes actions disponibles.',
  reviser_actions: 'Je revois la documentation de mes actions pour trouver une autre approche.'
}

module.exports = { createActivityReporter, SUBGOALS, ACTIONS }
