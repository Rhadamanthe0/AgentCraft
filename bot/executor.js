'use strict'

// Fondation executeur a proprietaire unique (C4/C5/D18, pas encore cable).
// Volontairement sans dependance : aucun watchdog / mission / nav ici.
// Le cablage viendra plus tard ; ce module ne fait qu une chose :
// garantir qu un seul callback physique tourne a la fois, avec annulation
// par AbortController et arret synchrone des controles.
//
// Contrat :
//   const ex = createExecutor({ stopControls, onEvent })
//   const env = await ex.run({ id, kind, signal? }, async ({ signal }) => valeur)
//   ex.pauseWork(reason)  // travail/interruption : seul 'survival' reste admissible
//   ex.totalStop(reason)  // tout est refuse, meme 'survival', jusqu a resume()
//   ex.resume()           // leve pause + stop ; ne demarre rien tout seul
//   ex.status()           // etat d execution distinct de la valeur metier
//
// Regles physiques (non negociables) :
// - Le slot n est libere qu a la resolution REELLE du callback. Un timeout ou
//   un Promise.race ne libere jamais le slot : JS ne s interromp pas.
// - pauseWork/totalStop abortent le signal interne ET appellent stopControls
//   de facon SYNCHRONE, avant tout await.
// - Apres pauseWork, run(kind='survival') reste admissible, le reste est
//   refuse (code 'paused'). Apres totalStop, tout est refuse (code 'stopped').
// - Si le slot est tenu (meme par un callback qui ignore l abort), tout run
//   est refuse (code 'busy'). La preemption survie = pauseWork() puis run()
//   : si le travail ignore l abort, la survie recoit 'busy' au lieu de
//   chevaucher. On attend la vraie sortie, jamais de chevauchement.
// - L enveloppe d execution ne convertit JAMAIS la valeur metier : un objet
//   { status: 'succeeded' } rendu par le callback reste opaque dans
//   envelope.value. L etat d execution vit dans envelope.outcome.
// - Les erreurs de stopControls / onEvent / callback ne corrompent pas l etat.
// - Le signal externe, s il est fourni, doit etre un AbortSignal utilisable
//   (aborted boolean + add/removeEventListener fonctions). Tout le reste est
//   refuse en 'invalid' AVANT de prendre le slot, et un addEventListener qui
//   jette annule l admission sans tenir le slot (rollback garanti).

const KINDS = new Set(['work', 'survival', 'trial'])

function refusal (code, message, extra) {
  const err = new Error(message)
  err.code = code
  if (extra) err.details = extra
  return err
}

function isUsableSignal (s) {
  if ((typeof s !== 'object' && typeof s !== 'function') || s === null) return false
  return typeof s.aborted === 'boolean' &&
    typeof s.addEventListener === 'function' &&
    typeof s.removeEventListener === 'function'
}

function createExecutor (opts) {
  const stopControls = opts && typeof opts.stopControls === 'function' ? opts.stopControls : null
  const onEvent = opts && typeof opts.onEvent === 'function' ? opts.onEvent : null

  const state = {
    current: null, // { id, kind, controller, startedAt } ou null
    paused: false,
    pauseReason: null,
    stopped: false,
    stopReason: null,
    last: null // { id, kind, outcome, cancelled, at }
  }

  function emit (event) {
    if (!onEvent) return
    try { onEvent(event) } catch { /* onEvent ne corrompt jamais l etat */ }
  }

  // Toujours synchrone, jamais jetant. Appele AVANT controller.abort().
  function stopNow (reason) {
    if (!stopControls) return
    try { stopControls(reason) } catch (err) {
      emit({ type: 'stop-controls-error', reason, error: err })
    }
  }

  function snapshot () {
    return {
      busy: state.current !== null,
      paused: state.paused,
      pauseReason: state.pauseReason,
      stopped: state.stopped,
      stopReason: state.stopReason,
      current: state.current
        ? { id: state.current.id, kind: state.current.kind, startedAt: state.current.startedAt }
        : null,
      last: state.last ? { ...state.last } : null
    }
  }

  async function run (spec, fn) {
    const id = spec && spec.id
    const kind = spec && spec.kind
    const external = spec && spec.signal
    if (typeof id !== 'string' || id.length === 0) {
      throw refusal('invalid', 'run exige un id non vide')
    }
    if (!KINDS.has(kind)) {
      throw refusal('invalid', `run exige kind 'work'|'survival'|'trial' (recu ${String(kind)})`)
    }
    if (typeof fn !== 'function') {
      throw refusal('invalid', 'run exige un callback fonction')
    }
    if (state.stopped) {
      throw refusal('stopped', `arret total (${state.stopReason || 'sans motif'}) : run refuse`, { id, kind })
    }
    if (state.paused && kind !== 'survival') {
      throw refusal('paused', `travail en pause (${state.pauseReason || 'sans motif'}) : seul 'survival' est admissible`, { id, kind })
    }
    if (state.current) {
      throw refusal('busy', `slot tenu par ${state.current.id} : aucune chevauche`, { id, kind, by: state.current.id })
    }
    if (external !== undefined && external !== null && !isUsableSignal(external)) {
      throw refusal('invalid', 'run exige signal de type AbortSignal (aborted boolean + add/removeEventListener fonctions)', { id, kind })
    }
    if (external && external.aborted) {
      throw refusal('aborted', 'signal externe deja annule : callback jamais invoque', { id, kind })
    }

    const controller = new AbortController()
    const startedAt = Date.now()
    // Attache du listener externe AVANT de prendre le slot : si
    // addEventListener jette, l admission est annulee sans effet de bord
    // (busy reste faux, callback jamais invoque).
    let onExternalAbort = null
    if (external) {
      onExternalAbort = () => {
        // Annulation demandee par l appelant : stop synchrone puis abort interne.
        stopNow(`external-abort:${id}`)
        try { controller.abort() } catch { /* abort ne jette pas en pratique */ }
        emit({ type: 'external-abort', id, kind })
      }
      try {
        external.addEventListener('abort', onExternalAbort, { once: true })
      } catch (err) {
        throw refusal('invalid', 'signal externe inutilisable (addEventListener a jete) : callback jamais invoque', { id, kind })
      }
    }
    state.current = { id, kind, controller, startedAt }
    emit({ type: 'start', id, kind, at: startedAt })

    let envelope
    try {
      const value = await fn({ signal: controller.signal })
      const cancelled = controller.signal.aborted
      envelope = { id, kind, outcome: cancelled ? 'cancelled' : 'completed', cancelled, value, error: undefined }
    } catch (error) {
      const cancelled = controller.signal.aborted
      envelope = { id, kind, outcome: cancelled ? 'cancelled' : 'failed', cancelled, value: undefined, error }
    } finally {
      if (external && onExternalAbort && typeof external.removeEventListener === 'function') {
        try { external.removeEventListener('abort', onExternalAbort) } catch { /* nettoyage best-effort */ }
      }
      // Seule la resolution reelle arrive ici : le slot se libere MAINTENANT.
      state.current = null
      state.last = { id: envelope.id, kind: envelope.kind, outcome: envelope.outcome, cancelled: envelope.cancelled, at: Date.now() }
      emit({ type: 'settled', ...state.last })
    }
    return envelope
  }

  function pauseWork (reason) {
    state.paused = true
    state.pauseReason = typeof reason === 'string' ? reason : String(reason || 'pause')
    stopNow(`pause:${state.pauseReason}`)
    if (state.current) {
      try { state.current.controller.abort() } catch { /* abort ne jette pas en pratique */ }
    }
    emit({ type: 'pause', reason: state.pauseReason })
    return snapshot()
  }

  function totalStop (reason) {
    state.stopped = true
    state.stopReason = typeof reason === 'string' ? reason : String(reason || 'stop')
    stopNow(`stop:${state.stopReason}`)
    if (state.current) {
      try { state.current.controller.abort() } catch { /* abort ne jette pas en pratique */ }
    }
    emit({ type: 'stop', reason: state.stopReason })
    return snapshot()
  }

  function resume () {
    state.paused = false
    state.pauseReason = null
    state.stopped = false
    state.stopReason = null
    // Reprise strictement explicite : on ne demarre rien ici.
    emit({ type: 'resume' })
    return snapshot()
  }

  function status () {
    return snapshot()
  }

  return { run, pauseWork, totalStop, resume, status }
}

module.exports = { createExecutor, KINDS: [...KINDS] }
