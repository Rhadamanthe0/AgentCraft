'use strict'

// Gestionnaire d objectifs + inbox arbitre (cible D01/D18/D22-D23/D29/D36/D38/D42/D44-D47/D50).
//
// Durabilite (revue) : le snapshot canonique contient `outbox` (evenements
// durables pas encore copies dans le journal). Le `store.save(snapshot)`
// atomique constitue le commit ; `store.appendEvent` n est qu une copie
// secondaire flushed ensuite avec un identifiant stable. Une panne du journal
// garde l outbox + un avertissement mais NE rollback PAS un etat commite.
// Au `recover`, reflush avec deduplication par `id` via `store.readEvents`
// quand disponible : ni perte, ni fausse admission.
//
// Contrat persistance :
//   - echec `save` : admission refusee, memoire + disque inchanges (sauf
//     pause/totalStop qui latchent en securite, voir ci-dessous) ;
//   - echec `appendEvent` : admission durable reussie, outbox visible,
//     avertissement `journal-flush-error`, retry via `flushOutbox()` ou
//     prochain `recover` ;
//   - `pauseWork`/`totalStop` latchent meme sur panne `save` (etat in-mem
//     stoppe, timer annule, erreur propagee visible), jamais de reprise
//     timer apres stop. L integrateur coupe le physique avant de persister.
//
// Pile des interrompus : `pausedStack` (LIFO). Chaque `pause_reprise`
// empile l ancien sans ecraser les ancetres ; `complete` d une temporaire
// depile. `pausedPrevious` reste expose comme alias du sommet pour
// compatibilite (snapshot + lecture).
//
// Ce que le module ne fait PAS : validation doctrine/proprio (implicite
// appelant, D44), ordres physiques, appels reseau/monde, scheduler global
// (un seul timer d arbitrage injecte), chemins en dur (store injecte,
// API bot/state-store.js stable read-only pour ce module).
//
// Retour API :
//   const ctrl = createObjectiveController({ store, now?, setTimer?, clearTimer?, onEvent?, arbitrationMs? })
//   ctrl.recordMessage({ auteur, texte, date?, id? }) -> copie message inbox
//   ctrl.proposeObjective({ auteur, texte, mode?, contraintes? })
//     -> { status: 'started'|'arbitration'|'queued'|'pending', objective, question? }
//   ctrl.resolveArbitration({ choice: 'pause_reprise'|'remplacement', actor? })
//     -> { status: 'resumed-new'|'replaced', objective }
//   ctrl.addContext({ auteur, texte }) -> copie message (kind 'context')
//   ctrl.askQuestion({ auteur?, texte }) -> copie question
//   ctrl.pauseWork(motif?) -> copie snapshot (latch en securite)
//   ctrl.totalStop(motif?) -> copie snapshot (latch en securite, timer annule)
//   ctrl.resume() -> copie snapshot (reprise strictement explicite)
//   ctrl.recordProgress(valeur) -> copie objectif courant (objet avec
//     `objectifId` : refuse `stale` si ce n est plus le courant ; sans
//     objectifId : repli heritage sans controle)
//   ctrl.complete(resultat?) -> { objectif, restaure? }
//   ctrl.snapshot() -> copie profonde (inclut `outbox`, `pausedStack`, alias `pausedPrevious`)
//   ctrl.flushOutbox() -> { flushed, remaining, errors } (retry journal, deduplique par id)
//   ctrl.recover() -> copie snapshot rechargee (revalide faits, reflush, relance timer sauf interruption)
//
// Evenements (store.appendEvent + onEvent, meme objet avant copie) :
//   { id (stable, `evt-N`), type, date (ISO), ... } avec type parmi :
//   'message' | 'context' | 'question' | 'objective-started' | 'arbitration-started' |
//   'objective-queued' | 'arbitration-resolved' | 'arbitration-timeout' |
//   'pause' | 'stop' | 'resume' | 'progress' | 'complete' | 'maintaining' |
//   'recovered' | 'journal-flush-error' | 'persist-error' | 'timer-error' |
//   'arbitration-timeout-error'

const ARBITRATION_CHOICES = new Set(['pause_reprise', 'remplacement'])
const MODES = new Set(['temporary', 'permanent'])
const MODE_ALIASES = { ponctuel: 'temporary', temporaire: 'temporary', temporairement: 'temporary', autonome: 'permanent', permanente: 'permanent', permanent: 'permanent' }

function isPlainObject (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function deepCopy (value) {
  return JSON.parse(JSON.stringify(value))
}

function asNonEmptyString (value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`objective-controller: ${field} attendu (chaine non vide), recu : ${String(value)}`)
  }
  return value
}

function isoNow (now) {
  return new Date(now()).toISOString()
}

function buildArbitrationQuestion (previous, candidate, arbitrationMs) {
  const secs = Math.max(1, Math.round(arbitrationMs / 1000))
  return `Je fais deja \u00ab ${previous.texte} \u00bb pour ${previous.auteur}. ` +
    `Je mets ce travail en pause. Faut-il le reprendre ensuite (pause_reprise) ` +
    `ou l abandonner pour \u00ab ${candidate.texte} \u00bb (remplacement) ? ` +
    `Sans reponse dans ${secs} s, je reprends l ancien et je garde la nouvelle demande en attente.`
}

function normalizeMode (mode) {
  if (mode === undefined || mode === null || mode === '') return 'temporary'
  if (typeof mode !== 'string') throw new TypeError('objective-controller: mode attendu (chaine), recu : ' + String(mode))
  const key = mode.trim().toLowerCase()
  if (MODES.has(key)) return key
  if (MODE_ALIASES[key]) return MODE_ALIASES[key]
  throw new TypeError(`objective-controller: mode inconnu (recu ${String(mode)}, attendu temporary|permanent)`)
}

function createObjectiveController (options = {}) {
  if (!isPlainObject(options)) throw new TypeError('objective-controller: options attendues sous forme d objet')
  const store = options.store
  if (!store || typeof store.save !== 'function' || typeof store.appendEvent !== 'function' || typeof store.load !== 'function') {
    throw new TypeError('objective-controller: store { load, save, appendEvent } attendu')
  }
  const hasReadEvents = typeof store.readEvents === 'function'
  const now = typeof options.now === 'function' ? options.now : Date.now
  const setTimer = typeof options.setTimer === 'function' ? options.setTimer : (fn, ms) => setTimeout(fn, ms)
  const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : (id) => clearTimeout(id)
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null
  const arbitrationMs = options.arbitrationMs === undefined ? 60000 : options.arbitrationMs
  if (!Number.isFinite(arbitrationMs) || arbitrationMs <= 0) {
    throw new TypeError('objective-controller: arbitrationMs attendu (nombre fini > 0)')
  }

  const state = {
    seq: 0,
    inbox: [],
    current: null,
    pending: [],
    pausedStack: [],
    questions: [],
    archive: [],
    facts: [],
    outbox: [],
    arbitration: null, // { candidate, previous, question, deadline, deadlineIso, timerId, generation }
    hardstop: false,
    hardstopReason: null,
    workPaused: false,
    workPausedReason: null,
    generation: 0
  }

  function emit (event) {
    if (!onEvent) return
    try { onEvent(deepCopy(event)) } catch { /* onEvent ne corrompt jamais l etat */ }
  }

  function topPaused () {
    return state.pausedStack.length > 0 ? state.pausedStack[state.pausedStack.length - 1] : null
  }

  function persistable () {
    return {
      version: 1,
      seq: state.seq,
      inbox: deepCopy(state.inbox),
      current: deepCopy(state.current),
      pending: deepCopy(state.pending),
      pausedStack: deepCopy(state.pausedStack),
      pausedPrevious: deepCopy(topPaused()),
      questions: deepCopy(state.questions),
      archive: deepCopy(state.archive),
      facts: deepCopy(state.facts),
      outbox: deepCopy(state.outbox),
      arbitration: state.arbitration
        ? {
            candidate: deepCopy(state.arbitration.candidate),
            previous: deepCopy(state.arbitration.previous),
            question: state.arbitration.question,
            deadline: state.arbitration.deadline,
            deadlineIso: state.arbitration.deadlineIso,
            generation: state.arbitration.generation
          }
        : null,
      hardstop: state.hardstop,
      hardstopReason: state.hardstopReason,
      workPaused: state.workPaused,
      workPausedReason: state.workPausedReason
    }
  }

  function captureState () {
    return {
      seq: state.seq,
      inbox: deepCopy(state.inbox),
      current: deepCopy(state.current),
      pending: deepCopy(state.pending),
      pausedStack: deepCopy(state.pausedStack),
      questions: deepCopy(state.questions),
      archive: deepCopy(state.archive),
      facts: deepCopy(state.facts),
      outbox: deepCopy(state.outbox),
      arbitration: state.arbitration
        ? {
            candidate: deepCopy(state.arbitration.candidate),
            previous: deepCopy(state.arbitration.previous),
            question: state.arbitration.question,
            deadline: state.arbitration.deadline,
            deadlineIso: state.arbitration.deadlineIso,
            generation: state.arbitration.generation,
            timerId: state.arbitration.timerId
          }
        : null,
      hardstop: state.hardstop,
      hardstopReason: state.hardstopReason,
      workPaused: state.workPaused,
      workPausedReason: state.workPausedReason,
      generation: state.generation
    }
  }

  function restoreState (backup) {
    state.seq = backup.seq
    state.inbox = backup.inbox
    state.current = backup.current
    state.pending = backup.pending
    state.pausedStack = backup.pausedStack
    state.questions = backup.questions
    state.archive = backup.archive
    state.facts = backup.facts
    state.outbox = backup.outbox
    state.arbitration = backup.arbitration
    state.hardstop = backup.hardstop
    state.hardstopReason = backup.hardstopReason
    state.workPaused = backup.workPaused
    state.workPausedReason = backup.workPausedReason
    state.generation = backup.generation
  }

  function nextId (prefix) {
    state.seq += 1
    return `${prefix}-${state.seq}`
  }

  // Journal secondaire : flush best-effort avec dedup par id. Ne jette jamais.
  function flushOutboxInternal () {
    if (state.outbox.length === 0) return { flushed: 0, remaining: 0, errors: [] }
    let knownIds = null
    if (hasReadEvents) {
      try {
        knownIds = new Set(store.readEvents().map((e) => e && e.id))
      } catch (err) {
        emit({ type: 'journal-flush-error', date: isoNow(now), error: err && err.message, pending: state.outbox.length })
        return { flushed: 0, remaining: state.outbox.length, errors: [err && err.message] }
      }
    }
    let flushed = 0
    const errors = []
    const remaining = []
    for (const evt of state.outbox) {
      if (knownIds && knownIds.has(evt.id)) { flushed += 1; continue }
      try {
        const stored = store.appendEvent(evt)
        if (knownIds) knownIds.add((stored && stored.id) || evt.id)
        flushed += 1
        emit(stored)
      } catch (err) {
        errors.push(err && err.message)
        remaining.push(evt)
      }
    }
    state.outbox = remaining
    // Prune best-effort : le journal a deja l evenement, un echec ici sera
    // resorbe par dedup au prochain flush (pas de perte).
    try {
      store.save(persistable())
    } catch (err) {
      errors.push(err && err.message)
      emit({ type: 'persist-error', date: isoNow(now), op: 'outbox-prune', error: err && err.message })
    }
    if (errors.length > 0) {
      emit({ type: 'journal-flush-error', date: isoNow(now), error: errors[0], pending: remaining.length })
    }
    return { flushed, remaining: remaining.length, errors }
  }

  // Commit outbox : mutate (dans try, vrai rollback deep) puis save unique
  // atomique (commit), puis flush journal secondaire. Une panne du journal
  // ne rollback PAS l etat commite.
  function commit (mutate, makeEvent, opts = {}) {
    const latch = opts.latch === true
    const backup = captureState()
    let rawEvent
    try {
      mutate()
      rawEvent = typeof makeEvent === 'function' ? makeEvent() : makeEvent
      if (!isPlainObject(rawEvent)) throw new TypeError('objective-controller: evenement interne invalide')
      if (rawEvent.id === undefined || rawEvent.id === null || rawEvent.id === '') {
        rawEvent = { ...rawEvent, id: nextId('evt') }
      } else {
        rawEvent = { ...rawEvent, id: String(rawEvent.id) }
      }
      rawEvent = { ...rawEvent, date: rawEvent.date || isoNow(now) }
      state.outbox = [...state.outbox, deepCopy(rawEvent)]
    } catch (err) {
      if (latch && latchHolds(backup)) {
        // La securite l emporte : on garde le latch meme si la suite echoue.
        // Ici l echec vient de mutate/makeEvent avant save : on restaure tout
        // sauf les drapeaux de stop, et on propage l erreur visible.
        const keepHard = state.hardstop
        const keepHardReason = state.hardstopReason
        const keepPaused = state.workPaused
        const keepPausedReason = state.workPausedReason
        restoreState(backup)
        state.hardstop = keepHard
        state.hardstopReason = keepHardReason
        state.workPaused = keepPaused
        state.workPausedReason = keepPausedReason
        throw err
      }
      restoreState(backup)
      throw err
    }
    const snapshotToSave = persistable()
    try {
      store.save(snapshotToSave)
    } catch (err) {
      if (latch) {
        // Latch en securite : memoire stoppee conservee, disque inchange,
        // timer deja annule par l appelant. Erreur visible, pas de rollback
        // du latch.
        emit({ type: 'persist-error', date: isoNow(now), op: rawEvent.type, error: err && err.message, latched: true })
        throw err
      }
      restoreState(backup)
      throw err
    }
    // Commit reussi : flush secondaire, sans rollback en cas de panne.
    flushOutboxInternal()
    return deepCopy(rawEvent)
  }

  function latchHolds (backup) {
    return state.hardstop !== backup.hardstop || state.workPaused !== backup.workPaused
  }

  function clearArbitrationTimerSync () {
    if (state.arbitration && state.arbitration.timerId !== null && state.arbitration.timerId !== undefined) {
      try { clearTimer(state.arbitration.timerId) } catch { /* best-effort */ }
    }
  }

  function scheduleArbitrationTimer (generation) {
    if (!state.arbitration) return
    try {
      const delay = Math.max(0, state.arbitration.deadline - now())
      const timerId = setTimer(() => onArbitrationTimeout(generation), delay)
      state.arbitration.timerId = timerId
    } catch (err) {
      // Timer sobre : admission gardee (deadline persistee), recover la relancera.
      emit({ type: 'timer-error', date: isoNow(now), error: err && err.message, generation })
    }
  }

  // Callback timer : ne jette JAMAIS vers l appelant (faux clock comme reels).
  function onArbitrationTimeout (generation) {
    try {
      if (!state.arbitration) return
      if (state.arbitration.generation !== generation) return
      if (state.hardstop) return
      const backup = captureState()
      try {
        const arb = state.arbitration
        state.current = { ...arb.previous, statut: 'active', updatedAt: isoNow(now) }
        state.pending = [arb.candidate, ...state.pending]
        state.arbitration = null
        const rawEvent = {
          id: nextId('evt'),
          type: 'arbitration-timeout',
          date: isoNow(now),
          resumed: deepCopy(state.current),
          queued: deepCopy(arb.candidate),
          question: arb.question
        }
        state.outbox = [...state.outbox, deepCopy(rawEvent)]
        try {
          store.save(persistable())
        } catch (err) {
          restoreState(backup)
          emit({ type: 'arbitration-timeout-error', date: isoNow(now), error: err && err.message })
          return
        }
        flushOutboxInternal()
      } catch (err) {
        try { restoreState(backup) } catch { /* restauration best-effort */ }
        emit({ type: 'arbitration-timeout-error', date: isoNow(now), error: err && err.message })
      }
    } catch (err) {
      try { emit({ type: 'arbitration-timeout-error', date: isoNow(now), error: err && err.message }) } catch { /* ignore */ }
    }
  }

  function recordMessage (input = {}) {
    if (!isPlainObject(input)) throw new TypeError('objective-controller: message attendu sous forme d objet')
    const auteur = asNonEmptyString(input.auteur, 'auteur')
    const texte = asNonEmptyString(input.texte, 'texte')
    const date = input.date === undefined || input.date === null || input.date === ''
      ? isoNow(now)
      : String(input.date)
    let assigned = null
    commit(() => {
      assigned = { id: input.id ? String(input.id) : nextId('msg'), auteur, date, texte, kind: 'message' }
      state.inbox = [...state.inbox, assigned]
    }, () => ({ type: 'message', message: deepCopy(assigned) }))
    return deepCopy(assigned)
  }

  function proposeObjective (input = {}) {
    if (!isPlainObject(input)) throw new TypeError('objective-controller: objectif attendu sous forme d objet')
    const auteur = asNonEmptyString(input.auteur, 'auteur')
    const texte = asNonEmptyString(input.texte, 'texte')
    const mode = normalizeMode(input.mode)
    const contraintes = input.contraintes === undefined ? [] : input.contraintes
    if (!Array.isArray(contraintes)) {
      throw new TypeError('objective-controller: contraintes attendues sous forme de tableau')
    }
    const contraintesCopy = deepCopy(contraintes)
    const date = isoNow(now)

    if (state.hardstop) {
      let queued = null
      commit(() => {
        queued = {
          id: nextId('obj'), version: 1, auteur, mode, texte,
          statut: 'pending', progression: {}, contraintes: deepCopy(contraintesCopy),
          createdAt: date, updatedAt: date
        }
        state.inbox = [...state.inbox, { id: nextId('msg'), auteur, date, texte, kind: 'message' }]
        state.pending = [...state.pending, queued]
      }, () => ({ type: 'objective-queued', objective: deepCopy(queued), reason: 'hardstop' }))
      return { status: 'pending', objective: deepCopy(queued), question: null }
    }

    if (!state.current && !state.arbitration) {
      let started = null
      commit(() => {
        started = {
          id: nextId('obj'), version: 1, auteur, mode, texte,
          statut: 'active',
          progression: {}, contraintes: deepCopy(contraintesCopy),
          createdAt: date, updatedAt: date
        }
        state.inbox = [...state.inbox, { id: nextId('msg'), auteur, date, texte, kind: 'message' }]
        state.current = started
        state.workPaused = false
        state.workPausedReason = null
      }, () => ({ type: 'objective-started', objective: deepCopy(started) }))
      return { status: 'started', objective: deepCopy(started), question: null }
    }

    if (state.arbitration) {
      let queued = null
      commit(() => {
        queued = {
          id: nextId('obj'), version: 1, auteur, mode, texte,
          statut: 'pending', progression: {}, contraintes: deepCopy(contraintesCopy),
          createdAt: date, updatedAt: date
        }
        state.inbox = [...state.inbox, { id: nextId('msg'), auteur, date, texte, kind: 'message' }]
        state.pending = [...state.pending, queued]
      }, () => ({ type: 'objective-queued', objective: deepCopy(queued) }))
      return { status: 'queued', objective: deepCopy(queued), question: state.arbitration.question }
    }

    let candidate = null
    let question = null
    commit(() => {
      candidate = {
        id: nextId('obj'), version: 1, auteur, mode, texte,
        statut: 'pending', progression: {}, contraintes: deepCopy(contraintesCopy),
        createdAt: date, updatedAt: date
      }
      const previous = { ...state.current, statut: 'paused', updatedAt: date }
      question = buildArbitrationQuestion(previous, candidate, arbitrationMs)
      state.generation += 1
      state.inbox = [...state.inbox, { id: nextId('msg'), auteur, date, texte, kind: 'message' }]
      state.current = previous
      state.workPaused = false
      state.workPausedReason = null
      state.arbitration = {
        candidate,
        previous,
        question,
        deadline: now() + arbitrationMs,
        deadlineIso: new Date(now() + arbitrationMs).toISOString(),
        timerId: null,
        generation: state.generation
      }
    }, () => ({ type: 'arbitration-started', objective: deepCopy(candidate), question }))
    scheduleArbitrationTimer(state.generation)
    return { status: 'arbitration', objective: deepCopy(candidate), question }
  }

  function resolveArbitration (input = {}) {
    if (!isPlainObject(input)) throw new TypeError('objective-controller: arbitrage attendu sous forme d objet')
    const choice = input.choice
    if (!ARBITRATION_CHOICES.has(choice)) {
      throw new TypeError(`objective-controller: choice attendu parmi pause_reprise|remplacement, recu : ${String(choice)}`)
    }
    const arb = state.arbitration
    if (!arb) {
      const err = new Error('objective-controller: aucun arbitrage en cours (timer obsolete ou deja resolu)')
      err.code = 'stale'
      throw err
    }
    if (state.hardstop) {
      const err = new Error('objective-controller: arret total en cours, arbitrage suspendu (stop l emporte)')
      err.code = 'stopped'
      throw err
    }
    if (input.actor !== undefined && input.actor !== null && input.actor !== '' && input.actor !== arb.candidate.auteur) {
      const err = new Error(`objective-controller: seul le nouveau demandeur (${arb.candidate.auteur}) peut confirmer`)
      err.code = 'forbidden'
      throw err
    }
    const date = isoNow(now)
    let applied = null
    commit(() => {
      if (choice === 'pause_reprise') {
        // Pile LIFO : aucun ancetre perdu en cas d interruptions imbriquees.
        state.pausedStack = [...state.pausedStack, { ...arb.previous, statut: 'paused', updatedAt: date }]
        applied = { ...arb.candidate, statut: 'active', version: arb.candidate.version + 1, updatedAt: date }
        state.current = applied
      } else {
        state.archive = [...state.archive, { ...arb.previous, statut: 'replaced', updatedAt: date }]
        state.pausedStack = state.pausedStack.filter((o) => o.id !== arb.previous.id)
        applied = { ...arb.candidate, statut: 'active', version: arb.candidate.version + 1, updatedAt: date }
        state.current = applied
      }
      state.arbitration = null
      state.generation += 1
    }, () => ({ type: 'arbitration-resolved', choice, actor: input.actor === undefined ? null : input.actor, objective: deepCopy(applied) }))
    try { clearTimer(arb.timerId) } catch { /* best-effort */ }
    return { status: choice === 'pause_reprise' ? 'resumed-new' : 'replaced', objective: deepCopy(applied) }
  }

  function addContext (input = {}) {
    if (!isPlainObject(input)) throw new TypeError('objective-controller: contexte attendu sous forme d objet')
    const auteur = asNonEmptyString(input.auteur, 'auteur')
    const texte = asNonEmptyString(input.texte, 'texte')
    const date = isoNow(now)
    let assigned = null
    commit(() => {
      assigned = { id: input.id ? String(input.id) : nextId('msg'), auteur, date, texte, kind: 'context' }
      state.inbox = [...state.inbox, assigned]
    }, () => ({ type: 'context', message: deepCopy(assigned) }))
    return deepCopy(assigned)
  }

  function askQuestion (input = {}) {
    if (!isPlainObject(input)) throw new TypeError('objective-controller: question attendue sous forme d objet')
    const texte = asNonEmptyString(input.texte, 'texte')
    const auteur = input.auteur === undefined || input.auteur === null || input.auteur === '' ? null : String(input.auteur)
    const date = isoNow(now)
    let assigned = null
    commit(() => {
      assigned = { id: nextId('q'), auteur, date, texte }
      state.questions = [...state.questions, assigned]
      if (state.current) state.current = { ...state.current, question: texte, updatedAt: date }
    }, () => ({ type: 'question', question: deepCopy(assigned) }))
    return deepCopy(assigned)
  }

  function pauseWork (reason) {
    const motif = reason === undefined || reason === null || reason === '' ? 'pause' : String(reason)
    const date = isoNow(now)
    // Securite d abord : couper le timer avant de persister.
    const arb = state.arbitration
    if (arb) clearArbitrationTimerSync()
    commit(() => {
      state.workPaused = true
      state.workPausedReason = motif
      if (state.current && (state.current.statut === 'active')) {
        state.current = { ...state.current, statut: 'paused', version: state.current.version + 1, updatedAt: date }
      }
    }, () => ({ type: 'pause', reason: motif }), { latch: true })
    return snapshot()
  }

  function totalStop (reason) {
    const motif = reason === undefined || reason === null || reason === '' ? 'stop' : String(reason)
    const date = isoNow(now)
    // Securite d abord : couper le timer avant de persister, jamais de reprise apres stop.
    const arb = state.arbitration
    if (arb) clearArbitrationTimerSync()
    commit(() => {
      state.hardstop = true
      state.hardstopReason = motif
      if (state.arbitration) {
        state.pending = [state.arbitration.candidate, ...state.pending]
        state.arbitration = null
        state.generation += 1
      }
      if (state.current && state.current.statut !== 'done') {
        state.current = { ...state.current, statut: 'stopped', version: state.current.version + 1, updatedAt: date }
      }
    }, () => ({ type: 'stop', reason: motif }), { latch: true })
    if (arb) { try { clearTimer(arb.timerId) } catch { /* best-effort */ } }
    return snapshot()
  }

  function resume () {
    const date = isoNow(now)
    commit(() => {
      state.hardstop = false
      state.hardstopReason = null
      state.workPaused = false
      state.workPausedReason = null
      if (state.current && (state.current.statut === 'paused' || state.current.statut === 'stopped')) {
        state.current = { ...state.current, statut: 'active', version: state.current.version + 1, updatedAt: date }
      }
    }, () => ({ type: 'resume' }))
    return snapshot()
  }

  function recordProgress (value) {
    if (!state.current) throw new Error('objective-controller: aucun objectif courant a faire progresser')
    if (state.hardstop) {
      const err = new Error('objective-controller: arret total, progression fige (reprendre d abord)')
      err.code = 'stopped'
      throw err
    }
    // Correlation durable : un appelant qui annonce un objectifId doit viser
    // le courant, sinon sa progression ecraserait un autre engagement
    // (arbitrage survenu entre deux tours). Absent => repli heritage.
    if (isPlainObject(value) && value.objectifId !== undefined && value.objectifId !== null) {
      if (state.current.id !== value.objectifId) {
        const err = new Error(`objective-controller: progression pour ${String(value.objectifId)} refusee, le courant est ${state.current.id} (stale)`)
        err.code = 'stale'
        throw err
      }
    }
    const date = isoNow(now)
    let updated = null
    commit(() => {
      const base = state.current.progression && isPlainObject(state.current.progression) ? state.current.progression : {}
      let next
      if (typeof value === 'number' && Number.isFinite(value)) next = { ...base, faits: value }
      else if (isPlainObject(value)) {
        const { objectifId, ...data } = value
        void objectifId
        next = { ...base, ...deepCopy(data) }
      } else throw new TypeError('objective-controller: progression attendue (nombre fini ou objet)')
      updated = { ...state.current, progression: next, version: state.current.version + 1, updatedAt: date }
      state.current = updated
    }, () => ({ type: 'progress', objective: deepCopy(updated) }))
    return deepCopy(updated)
  }

  function complete (result) {
    if (!state.current) throw new Error('objective-controller: aucun objectif courant a conclure')
    if (state.hardstop) {
      const err = new Error('objective-controller: arret total, conclusion refusee (reprendre d abord)')
      err.code = 'stopped'
      throw err
    }
    if (state.arbitration) {
      const err = new Error('objective-controller: arbitrage en cours, conclure apres resolution')
      err.code = 'arbitration'
      throw err
    }
    const date = isoNow(now)
    const current = state.current
    const resultCopy = result === undefined ? null : deepCopy(result)
    let outcome = null
    let restored = null
    commit(() => {
      if (current.mode === 'permanent') {
        outcome = { ...current, statut: 'maintaining', version: current.version + 1, updatedAt: date }
        state.current = outcome
      } else {
        outcome = { ...current, statut: 'done', version: current.version + 1, updatedAt: date }
        state.archive = [...state.archive, outcome]
        if (state.pausedStack.length > 0) {
          const top = state.pausedStack[state.pausedStack.length - 1]
          restored = { ...top, statut: 'active', updatedAt: date }
          state.pausedStack = state.pausedStack.slice(0, -1)
          state.current = restored
        } else if (state.pending.length > 0) {
          const [next, ...rest] = state.pending
          restored = { ...next, statut: 'active', version: next.version + 1, updatedAt: date }
          state.current = restored
          state.pending = rest
        } else {
          state.current = null
        }
      }
    }, () => ({ type: current.mode === 'permanent' ? 'maintaining' : 'complete', objective: deepCopy(outcome), result: resultCopy }))
    return { objectif: deepCopy(outcome), restaure: restored ? deepCopy(restored) : null }
  }

  function snapshot () {
    return deepCopy(persistable())
  }

  function flushOutbox () {
    return flushOutboxInternal()
  }

  function recover () {
    const loaded = store.load()
    if (loaded === null) return snapshot()
    if (!isPlainObject(loaded)) throw new Error('objective-controller: snapshot corrompu (objet attendu)')
    clearArbitrationTimerSync()
    state.seq = Number.isInteger(loaded.seq) && loaded.seq >= 0 ? loaded.seq : 0
    state.inbox = Array.isArray(loaded.inbox) ? deepCopy(loaded.inbox) : []
    state.current = loaded.current === null || loaded.current === undefined ? null : deepCopy(loaded.current)
    state.pending = Array.isArray(loaded.pending) ? deepCopy(loaded.pending) : []
    if (Array.isArray(loaded.pausedStack)) {
      state.pausedStack = deepCopy(loaded.pausedStack)
    } else if (loaded.pausedPrevious !== null && loaded.pausedPrevious !== undefined) {
      state.pausedStack = [deepCopy(loaded.pausedPrevious)]
    } else {
      state.pausedStack = []
    }
    state.questions = Array.isArray(loaded.questions) ? deepCopy(loaded.questions) : []
    state.archive = Array.isArray(loaded.archive) ? deepCopy(loaded.archive) : []
    const facts = Array.isArray(loaded.facts) ? deepCopy(loaded.facts) : []
    state.facts = facts.map((f) => (isPlainObject(f) ? { ...f, stale: true, requiresObservation: true } : f))
    state.outbox = Array.isArray(loaded.outbox) ? deepCopy(loaded.outbox) : []
    state.hardstop = loaded.hardstop === true
    state.hardstopReason = loaded.hardstopReason === undefined ? null : loaded.hardstopReason
    state.workPaused = loaded.workPaused === true
    state.workPausedReason = loaded.workPausedReason === undefined ? null : loaded.workPausedReason
    const arb = loaded.arbitration === null || loaded.arbitration === undefined ? null : loaded.arbitration
    state.generation += 1
    if (arb) {
      const deadline = Number(arb.deadline)
      const hasCandidate = arb.candidate && isPlainObject(arb.candidate)
      const hasPrevious = arb.previous && isPlainObject(arb.previous)
      if (!Number.isFinite(deadline) || !hasCandidate || !hasPrevious) {
        if (hasCandidate) state.pending = [deepCopy(arb.candidate), ...state.pending]
        if (hasPrevious && !state.current) state.current = { ...deepCopy(arb.previous), statut: 'paused' }
        state.arbitration = null
      } else {
        state.arbitration = {
          candidate: deepCopy(arb.candidate),
          previous: deepCopy(arb.previous),
          question: String(arb.question || ''),
          deadline,
          deadlineIso: String(arb.deadlineIso || new Date(deadline).toISOString()),
          timerId: null,
          generation: state.generation
        }
        if (state.hardstop) {
          // Interruption respectee : aucun timer relance.
        } else {
          const remaining = state.arbitration.deadline - now()
          if (remaining <= 0) {
            const timedOut = state.arbitration
            state.current = { ...timedOut.previous, statut: 'active', updatedAt: isoNow(now) }
            state.pending = [timedOut.candidate, ...state.pending]
            state.arbitration = null
          } else {
            scheduleArbitrationTimer(state.generation)
          }
        }
      }
    } else {
      state.arbitration = null
    }
    // Evenement durable de reprise, puis save + reflush (dedup par id).
    const recoveredEvent = { id: nextId('evt'), type: 'recovered', date: isoNow(now) }
    state.outbox = [...state.outbox, deepCopy(recoveredEvent)]
    store.save(persistable())
    flushOutboxInternal()
    return snapshot()
  }

  return {
    recordMessage,
    proposeObjective,
    resolveArbitration,
    addContext,
    askQuestion,
    pauseWork,
    totalStop,
    resume,
    recordProgress,
    complete,
    snapshot,
    flushOutbox,
    recover,
    ARBITRATION_CHOICES: [...ARBITRATION_CHOICES]
  }
}

module.exports = { createObjectiveController, buildArbitrationQuestion }
