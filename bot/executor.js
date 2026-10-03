'use strict'

// Executeur a proprietaire unique, cable par index.js (slot physique des
// missions, du suivi et des commandes directes). Volontairement sans
// dependance : aucun watchdog / mission / nav ici. Il ne fait qu une chose :
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
//   unwrapExecutionEnvelope(envelope) // completed->valeur, cancelled->jette
//     PhysicalCancelledError, failed->jette l erreur d origine (R03)
//   runPhysicalOrThrow(run, id, kind, fn) // run + deballage (R03)
//   await awaitPhysicalWithTimeout(promise, ms, label, { signal?, onTimeout? })
//   const lease = createControlLease({ run, stopNavigation, applyControl, clearControls })
//
// Regles physiques (non negociables) :
// - Le slot n est libere qu a la resolution REELLE du callback. Un timeout ou
//   un Promise.race ne libere jamais le slot : JS ne s interromp pas.
//   Corollaire : aucune borne de delai ne rend avant le settle reel. Le helper
//   `awaitPhysicalWithTimeout` applique cette regle a UNE promesse physique :
//   au timeout/abort il appelle l annulation concrete (onTimeout : stopDigging,
//   setGoal(null), clear controls...), ATTEND le settle reel de la promesse
//   d origine, puis seulement leve timeout/cancelled. Un appelant DANS le slot
//   garde donc le slot jusqu a la fin reelle ; un second run concurrent recoit
//   'busy' jusque-la.
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

// Borne une promesse physique SANS jamais liberer avant son settle reel.
// Au premier latch (settle, delai ou abort) l annulation concrete est appelee
// (onTimeout, best-effort : stopDigging, setGoal(null)...), mais le retour
// n a lieu qu APRES le settle reel de `promise` :
//   - abort (signal aborte) => leve { code: 'cancelled' } ;
//   - delai depasse => leve Error(label) avec { code: 'timeout' } ;
//   - sinon rend/releve le resultat reel.
// Sans delai ni signal, simple attente du settle. Le timer est unref quand
// c est possible (meme convention que delivery.js).
async function awaitPhysicalWithTimeout (promise, ms, label, opts = {}) {
  const message = String(label ?? 'delai physique depasse')
  const timeoutMs = Number(ms)
  const signal = opts && typeof opts.signal === 'object' && opts.signal !== null ? opts.signal : null
  const onTimeout = opts && typeof opts.onTimeout === 'function' ? opts.onTimeout : null
  const settleGate = Promise.resolve(promise).then(
    value => ({ ok: true, value }),
    error => ({ ok: false, error })
  )
  let timedOut = false
  let abortFired = Boolean(signal && signal.aborted === true)
  const fireCancel = () => {
    if (!onTimeout) return
    try { onTimeout(abortFired ? 'abort' : 'timeout') } catch { /* annulation best-effort */ }
  }
  if (abortFired) fireCancel()
  let timer = null
  const timeoutGate = new Promise(resolve => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return
    timer = setTimeout(() => {
      timedOut = true
      if (signal && signal.aborted === true) abortFired = true
      fireCancel()
      resolve('timeout')
    }, timeoutMs)
    if (timer.unref) timer.unref()
  })
  let onAbort = null
  const abortGate = new Promise(resolve => {
    if (!signal || typeof signal.addEventListener !== 'function') return
    if (signal.aborted) { abortFired = true; resolve('abort'); return }
    onAbort = () => { abortFired = true; fireCancel(); resolve('abort') }
    try { signal.addEventListener('abort', onAbort, { once: true }) } catch { /* ecoute best-effort */ }
  })
  if (timer !== null || onAbort !== null || abortFired) {
    await Promise.race([settleGate, timeoutGate, abortGate])
  }
  const settle = await settleGate // <-- jamais de retour avant ce settle
  if (timer) clearTimeout(timer)
  if (onAbort && signal && typeof signal.removeEventListener === 'function') {
    try { signal.removeEventListener('abort', onAbort) } catch { /* nettoyage best-effort */ }
  }
  if (abortFired || (signal && signal.aborted === true)) {
    const err = new Error('cancelled')
    err.code = 'cancelled'
    throw err
  }
  if (timedOut) {
    const err = new Error(message)
    err.code = 'timeout'
    throw err
  }
  if (!settle.ok) throw settle.error
  return settle.value
}

// Erreur d annulation physique (R03) : levee par l adaptateur commun quand
// l enveloppe d execution est 'cancelled'. Porte toujours { code:
// 'cancelled' } : les appelants la distinguent d un echec sans perdre le
// message, et ne l annoncent jamais comme un succes.
class PhysicalCancelledError extends Error {
  constructor (message = 'execution annulee (stop/pause)', details) {
    super(message)
    this.name = 'PhysicalCancelledError'
    this.code = 'cancelled'
    if (details !== undefined) this.details = details
  }
}

function errorFromEnvelope (envelope, fallbackMessage) {
  const cause = envelope ? envelope.error : undefined
  if (cause instanceof Error) return cause
  const message = cause && typeof cause.message === 'string'
    ? cause.message
    : String(cause ?? fallbackMessage ?? 'echec physique sans detail')
  const err = new Error(message)
  if (cause && typeof cause.code === 'string') err.code = cause.code
  return err
}

// Adaptateur commun (R03) : deballe une enveloppe d execution SANS convertir
// la valeur metier.
//   completed (non annule) -> rend envelope.value ;
//   cancelled (ou cancelled vrai) -> jette PhysicalCancelledError ;
//   failed -> jette envelope.error d origine (code/message conserves).
// Le contrat bas niveau de run() (enveloppe completed/failed/cancelled) est
// inchange : seuls les appelants qui veulent un succes-ou-jettent passent ici.
function unwrapExecutionEnvelope (envelope) {
  if (!envelope || typeof envelope !== 'object' || typeof envelope.outcome !== 'string') {
    throw new PhysicalCancelledError('enveloppe d execution absente ou illisible')
  }
  if (envelope.cancelled || envelope.outcome === 'cancelled') {
    throw new PhysicalCancelledError('execution annulee (stop/pause)', { id: envelope.id, kind: envelope.kind })
  }
  if (envelope.outcome === 'failed') {
    throw errorFromEnvelope(envelope, 'echec physique sans detail')
  }
  return envelope.value
}

// Variante async : execute DANS le slot puis deballe. `run` est le writer
// (id, kind, fn) -> enveloppe (index.runPhysical, meme signature). Les refus
// d admission (busy/paused/stopped/...) rejettent tels quels, avant le slot.
async function runPhysicalOrThrow (run, id, kind, fn) {
  if (typeof run !== 'function') {
    const err = new Error('runPhysicalOrThrow exige un writer (id, kind, fn)')
    err.code = 'invalid'
    throw err
  }
  const envelope = await run(id, kind, fn)
  return unwrapExecutionEnvelope(envelope)
}

// Bail de touche persistante (R23) : modele lease explicite au-dessus de
// l executeur. `acquire(control)` applique la touche DANS le slot et TIENT ce
// slot jusqu a `release()` (ou abort : pauseWork/totalStop) ; tant que le
// lease existe, tout run normal recoit 'busy' de l executeur lui-meme (aucun
// drapeau parallele). `release()` eteint la touche puis libere, meme lease
// (une touche tenue par !avance se libere par /api/control state=false).
// Fabrique pure : `run` est le writer (index.runPhysical), les trois autres
// sont les effets jeu. Jamais de clearControlStates opportuniste hors modele :
// toute extinction passe par le callback du slot (finally) ou stopControls.
function createControlLease (deps) {
  const run = deps && typeof deps.run === 'function' ? deps.run : null
  const stopNavigation = deps && typeof deps.stopNavigation === 'function' ? deps.stopNavigation : () => {}
  const applyControl = deps && typeof deps.applyControl === 'function' ? deps.applyControl : () => {}
  const clearControls = deps && typeof deps.clearControls === 'function' ? deps.clearControls : () => {}
  if (!run) throw refusal('invalid', 'createControlLease exige run(id, kind, fn)')

  let held = null // { control, resolveRelease, runPromise } ou null

  function status () {
    return { held: held !== null, control: held ? held.control : null }
  }

  // Attend la liberation (release) ou l abort du slot, sans jamais jeter :
  // l abort sort par le signal, pas par une exception de la gate.
  function waitRelease (releaseGate, signal) {
    if (!signal || typeof signal.addEventListener !== 'function') return releaseGate
    if (signal.aborted) return Promise.resolve('aborted')
    return Promise.race([
      releaseGate,
      new Promise(resolve => {
        const onAbort = () => resolve('aborted')
        try { signal.addEventListener('abort', onAbort, { once: true }) } catch { resolve('aborted') }
      })
    ])
  }

  async function acquire (control, id) {
    if (typeof control !== 'string' || control.length === 0) {
      throw refusal('invalid', 'acquire exige un nom de touche non vide')
    }
    if (held) {
      throw refusal('busy', `touche ${held.control} tenue : aucune chevauche`, { control, by: held.control })
    }
    let resolveRelease = null
    const releaseGate = new Promise(resolve => { resolveRelease = resolve })
    let acquiredResolve = null
    let acquiredReject = null
    const acquired = new Promise((resolve, reject) => { acquiredResolve = resolve; acquiredReject = reject })
    const record = { control, resolveRelease, runPromise: null }
    let runPromise = null
    try {
      runPromise = run(id ?? `lease-${control}-${Date.now()}`, 'work', async ({ signal }) => {
        stopNavigation()
        try { clearControls() } catch { /* nettoyage best-effort */ }
        applyControl(control, true)
        acquiredResolve()
        try {
          await waitRelease(releaseGate, signal)
        } finally {
          try { applyControl(control, false) } catch { /* extinction best-effort */ }
          if (held === record) held = null
        }
        return { control }
      })
    } catch (err) {
      acquiredReject(err)
      throw err
    }
    record.runPromise = runPromise
    held = record
    // Admission refusee (busy/paused/stopped) : le rejet remonte a acquire,
    // sans lease fantome. Sans cela, `await acquired` pendrait.
    // R03 : une enveloppe failed/cancelled (callback qui jette, abort en vol)
    // rejette acquire avec l erreur d origine, jamais un succes ni un pendu :
    // le slot, lui, est libere par l executeur dans tous les cas.
    Promise.resolve(runPromise).then(
      envelope => {
        if (envelope && typeof envelope === 'object' && envelope.outcome !== undefined && envelope.outcome !== 'completed') {
          const err = (envelope.outcome === 'cancelled' || envelope.cancelled)
            ? new PhysicalCancelledError('touche interrompue (stop/pause)', { id: envelope.id, kind: envelope.kind })
            : errorFromEnvelope(envelope, 'touche en echec')
          try { acquiredReject(err) } catch { /* acquire deja tranche */ }
        }
      },
      err => { try { acquiredReject(err) } catch { /* acquire deja tranche */ } }
    )
    try {
      await acquired
    } catch (err) {
      if (held === record) held = null
      try { await runPromise } catch { /* erreur d admission deja portee */ }
      throw err
    }
    return { control }
  }

  async function release () {
    const current = held
    if (!current) {
      try { clearControls() } catch { /* nettoyage best-effort */ }
      return { released: false }
    }
    try { current.resolveRelease() } catch { /* liberation best-effort */ }
    // R03 : le slot se libere dans tous les cas, mais le resultat ne devient
    // jamais un succes : enveloppe failed -> erreur d origine, cancelled ->
    // PhysicalCancelledError. L appelant (route/commande) repond en consequence.
    const envelope = await current.runPromise
    if (held === current) held = null
    if (envelope && typeof envelope === 'object' && envelope.outcome !== undefined) {
      if (envelope.outcome === 'cancelled' || envelope.cancelled) {
        throw new PhysicalCancelledError('touche interrompue (stop/pause)', { id: envelope.id, kind: envelope.kind })
      }
      if (envelope.outcome !== 'completed') {
        throw errorFromEnvelope(envelope, 'extinction de touche en echec')
      }
    }
    return { released: true, control: current.control }
  }

  return { acquire, release, status }
}

module.exports = { createExecutor, awaitPhysicalWithTimeout, createControlLease, unwrapExecutionEnvelope, runPhysicalOrThrow, PhysicalCancelledError, KINDS: [...KINDS] }
