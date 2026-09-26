'use strict'

// Le chat est un flux d intentions, pas une deuxieme file de touches.
// Une reponse distante obsolete ne peut ni parler ni modifier une mission.
//
// Cycle durable (C0/C5/D18/D36) : les arretes immediats (stop / arret total /
// reprends) bypassent le LLM et annulent interpretations + lots obsoletes.
// Les messages normaux sont PERSISTES via le controleur (inbox) par l hote :
// - chemin nominal : la methode terminale persiste (propose/addContext/...) ;
// - chemin annule : l hote persiste via noteIgnored (sans perte).
// Une question ou precision conserve la mission ; un nouvel objectif passe
// par l arbitrage du controleur (pause + question, 60 s, reprise ancien).
// Aucune replanification globale des instructions apres chaque message.

const SOFT_STOP_RE = /^(?:stop|stops?|stoppe|pause|arr[eê]te?s?|arrete)\b[.!\s]*$/i
const HARD_STOP_RE = /^\W*(?:arr[eê]t\s*total|arret\s*total|stop\s*total)\W*$/i
const RESUME_RE = /^\W*(?:reprends?(?:\s+le\s+travail)?|resume(?:\s+le\s+travail)?|continue|reprendre(?:\s+le\s+travail)?)\W*$/i

function isHardStop (text) {
  return HARD_STOP_RE.test(String(text || '').trim())
}

function isResume (text) {
  return RESUME_RE.test(String(text || '').trim())
}

function isSoftStop (text) {
  const t = String(text || '').trim()
  if (HARD_STOP_RE.test(t) || RESUME_RE.test(t)) return false
  return SOFT_STOP_RE.test(t)
}

// Reponse explicite d arbitrage du NOUVEAU demandeur (hors LLM) :
// pause_reprise = reprendre l ancien ensuite ; remplacement = l abandonner.
// Vocabulaire borne, jamais devine : l inconnu retourne au LLM.
function parseArbitrationChoice (text) {
  const t = String(text || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  if (/pause[\s_-]*reprise/.test(t)) return 'pause_reprise'
  if (/remplacement/.test(t)) return 'remplacement'
  if (/reprends?.*(ensuite|apres)|garde.*pause|pause.*puis.*reprends/.test(t)) return 'pause_reprise'
  if (/^(oui\s+pour\s+l.autre|abandonne.*ancien|remplace.*ancien|non.*reprends?\s+pas)/.test(t)) return 'remplacement'
  if (/^remplace$/.test(t)) return 'remplacement'
  // Formulations libres vues en jeu : « Remplace la demande », « Remplace et
  // rejoins moi », « abandonne », « laisse tomber l arbre ». Une reprise
  // explicite (« reprends apres », « garde l ancien ») l emporte, testee avant.
  if (/\b(reprends?|reprise|garde)\b.*\b(apres|ensuite|ancien|plus tard)\b/.test(t)) return 'pause_reprise'
  if (/^(remplace|abandonne|laisse tomber|oublie|annule)\b/.test(t)) return 'remplacement'
  return null
}

function createConversation (host) {
  let generation = 0
  const controllers = new Set()
  // Serialisation des normaux : une seule interpretation terminale a la fois,
  // SANS deferer le premier (l interpret doit etre invoque dans le meme tick,
  // sinon un stop immediat le preempte avant tout appel). Les immediats
  // (stop/hardstop/resume/choix arbitrage) bypassent et preemptent
  // (generation++ + abort in-vol). Les normaux en file verifient la preemption
  // a leur tour : journal preserve via noteIgnored, disposition ignoree.
  let active = false
  const file = []
  // Prise SYNCHRONE si idle : l interpret du premier message est invoque dans
  // le meme tick (compatibilite + pas de preemption fantome). Sinon file.
  function tryTakeTurnSync () {
    if (!active) {
      active = true
      return true
    }
    return false
  }
  function waitTurnAsync () {
    return new Promise((res) => file.push(res))
  }
  function releaseTurn () {
    const next = file.shift()
    if (next) {
      next()
    } else {
      active = false
    }
  }
  function cancel (pendingStart = true) {
    generation++
    for (const c of [...controllers]) {
      try { c.abort() } catch (_) {}
    }
    controllers.clear()
    if (pendingStart) {
      try { host.cancelPendingStart?.() } catch (_) {}
    }
  }
  const key = m => m ? `${m.id ?? m.debut}|${m.revision ?? 0}|${m.etat}` : ''
  const summary = m => m && ({ id: m.id, revision: m.revision, objectif: m.objectif,
    demandeur: m.demandeur, etat: m.etat, type: m.type, etapes: m.etapes, parcours: m.parcours,
    historique: m.historique, raison: m.raison, autorisations: m.autorisations, activite: m.activite })
  function noteIgnored (username, message) {
    try { host.noteIgnored?.(username, message) } catch (_) {}
  }
  async function receive (username, message, opts = {}) {
    const raw = String(message || '')
    // Mode d admission directe (API) : repli quand l interpretation n en
    // porte pas. L interpretation reste prioritaire.
    const directMode = typeof opts.mode === 'string' && opts.mode ? opts.mode : undefined
    // Arrets et reprise : immediats, hors LLM, annulent l obsolete.
    // Note : incompatible avec l appelant qui voudrait grouper « reprends »
    // dans le LLM — fail-closed : l immediat l emporte, jamais de lot lance.
    if (isHardStop(raw)) {
      cancel(true)
      try { host.cancelPendingStart?.() } catch (_) {}
      try {
        if (typeof host.totalStop === 'function') host.totalStop(username)
        else host.stop()
      } catch (err) {
        try { host.say?.(`Arret total impossible : ${err.message}`) } catch (_) {}
        return { relation: 'stop', kind: 'hardstop', error: err.message }
      }
      return { relation: 'stop', kind: 'hardstop' }
    }
    if (isResume(raw)) {
      cancel(false)
      try {
        if (typeof host.resume === 'function') host.resume(username)
        else host.say?.('Rien a reprendre pour le moment.')
      } catch (err) {
        try { host.say?.(`Reprise impossible : ${err.message}`) } catch (_) {}
        return { relation: 'resume', error: err.message }
      }
      return { relation: 'resume' }
    }
    if (isSoftStop(raw)) {
      cancel(true)
      try { host.cancelPendingStart?.() } catch (_) {}
      try { host.stop() } catch (_) {}
      return { relation: 'stop' }
    }
    // Choix d arbitrage explicite du nouveau demandeur, sans LLM.
    // Seul le nouveau demandeur tranche (D44) ; toute autre reponse garde
    // la mission et attend le delai (60 s, reprise ancien).
    if (typeof host.arbitrationPending === 'function' && typeof host.resolveArbitration === 'function') {
      let pending = null
      try { pending = host.arbitrationPending() } catch (_) { pending = null }
      if (pending) {
        const choice = parseArbitrationChoice(raw)
        if (choice) {
          cancel(false)
          try {
            const out = host.resolveArbitration({ choice, actor: username })
            if (out && typeof out.then === 'function') await out
          } catch (err) {
            if (err && err.code === 'forbidden') {
              try { host.say?.(`Seul ${pending.candidateAuteur} peut confirmer : pause_reprise ou remplacement ?`) } catch (_) {}
              return { ignored: true, reason: 'forbidden' }
            }
            if (err && err.code === 'stale') return { ignored: true, reason: 'stale' }
            if (err && err.code === 'stopped') return { ignored: true, reason: 'stopped' }
            try { host.say?.(`Arbitrage impossible : ${err.message}`) } catch (_) {}
            return { ignored: true, reason: 'error' }
          }
          return { relation: 'arbitration', choice }
        }
      }
    }
    // Message normal : comprehension SERIASLISEE (tour pris sans defer si
    // idle, pour invoquer l interpret dans le meme tick). Le tour ne couvre
    // que la comprehension : la disposition (start/revise, brief reseau
    // bloquant) s execute SANS le tour, sinon une question pendant un brief
    // se bloquerait derriere lui. La concurrence des dispositions reste
    // gardee (cles mission + startGeneration + journal noteIgnored).
    // Preemption stop : journal preserve, disposition ignoree.
    const enqueuedGen = generation
    if (!tryTakeTurnSync()) await waitTurnAsync()
    let own
    let abort
    let before
    let active
    let decision
    try {
      if (enqueuedGen !== generation) { noteIgnored(username, raw); return { ignored: true, reason: 'preempted' } }
      own = generation
      abort = new AbortController()
      controllers.add(abort)
      before = host.status()
      active = before?.etat === 'running' ? before : null
      const waiting = setTimeout(() => {
        if (own === generation && !abort.signal.aborted) {
          try { host.say('J ai recu ton message, je regarde ce que tu me demandes.') } catch (_) {}
        }
      }, 1500)
      try {
        decision = await host.interpret(message, { demandeur: username, mission: summary(active),
          precedent: active ? null : summary(before), etat: host.observation?.() }, { signal: abort.signal })
      } catch (err) {
        if (own !== generation || abort.signal.aborted) { controllers.delete(abort); noteIgnored(username, raw); return { ignored: true } }
        controllers.delete(abort)
        throw err
      } finally { clearTimeout(waiting) }
      if (own !== generation || abort.signal.aborted) { controllers.delete(abort); noteIgnored(username, raw); return { ignored: true } }
      // L interpretation est finie. Une question suivante ne doit pas annuler
      // le readBrief d un objectif deja accepte ; stop/new le feront explicitement.
      controllers.delete(abort)
      if (decision.relation === 'stop') {
        try { host.cancelPendingStart?.() } catch (_) {}
        try { host.stop() } catch (_) {}
        return decision
      }
      // Pour modifier une mission, elle doit etre celle que le modele a lue.
      if (['amend', 'context'].includes(decision.relation) && active && key(host.status()) !== key(active)) {
        // La mission lue s est terminee pendant l interpretation (modele lent :
        // « Laisse tomber, coupe plutot un arbre » perdu parce que « Rejoins
        // moi » venait de finir, vu avec space-bunny-free). Une revision qui
        // porte un objectif complet devient alors une nouvelle demande.
        const now = host.status()
        if (decision.relation === 'amend' && decision.objective && now?.etat !== 'running') {
          active = null
        } else {
          try { host.say('La mission a change entre-temps ; peux-tu reformuler ta precision ?') } catch (_) {}
          return { ignored: true }
        }
      }
    } finally {
      releaseTurn()
    }
    // Disposition SANS le tour (start/revise peuvent bloquer sur un brief) :
    // les gardes existantes (startGeneration, cles, generation) tranchent.
    const relation = decision.relation
    const acknowledge = () => host.say(decision.response || 'J ai compris, je verifie les etapes necessaires.')
    const rejected = result => {
      if (result?.ok !== false) return null
      if (own !== generation || abort.signal.aborted) { noteIgnored(username, raw); return { ignored: true } }
      host.say(`Je ne peux pas lancer cette demande : ${result.error}`)
      return { ...decision, error: result.error }
    }
    if (relation === 'question') {
      host.say(decision.response)
    } else if (relation === 'context' && !active && !(before?.etat === 'failed' && decision.clearanceBlocks !== undefined)) {
      // Une remarque sans mission en cours n est pas un ordre : avant, elle
      // relancait l objectif precedent (vu sur chat/chatter-ignored : « Je vais
      // aller miner plus tard » redemarrait un ancien « Rejoins moi »).
      if (decision.response) host.say(decision.response)
    } else if (!active && before?.etat === 'failed' && ['context', 'amend'].includes(relation) &&
      decision.clearanceBlocks !== undefined && before.parcours?.steps?.some(s => s.type === 'sous_arbre' && s.state === 'failed')) {
      // Une permission arrive souvent APRES le refus de passage. Reprendre
      // le contrat bloque, pas creer une mission "casser un bloc" sans cible.
      acknowledge()
      const result = await host.revise(before.objectif, username, { signal: abort.signal, clearanceBlocks: decision.clearanceBlocks, mode: decision.mode ?? directMode })
      if (result?.ok === false) return rejected(result)
    } else if (relation === 'context' && active) {
      try {
        const result = host.context(message, username, { clearanceBlocks: decision.clearanceBlocks })
        if (result === false || result?.ok === false) throw new Error(result?.error || 'mission indisponible ou enregistrement refuse')
      } catch (err) {
        host.say(`Precision refusee : ${err.message}. Je ne l ai pas ajoutee au contexte de la mission.`)
        return { ...decision, error: err.message }
      }
      host.say(decision.response || 'Compris, je prends cette precision en compte.')
    } else if (relation === 'amend' && active) {
      acknowledge()
      const result = await host.revise(decision.objective, username, { signal: abort.signal, clearanceBlocks: decision.clearanceBlocks, mode: decision.mode ?? directMode })
      if (result?.ok === false) return rejected(result)
    } else {
      acknowledge()
      const result = await host.start(decision.objective || message, username, { signal: abort.signal, clearanceBlocks: decision.clearanceBlocks, mode: decision.mode ?? directMode })
      if (result?.ok === false) return rejected(result)
    }
    if (own !== generation || abort.signal.aborted) { noteIgnored(username, raw); return { ignored: true } }
    return decision
  }
  return { receive, cancel }
}

module.exports = { createConversation, isSoftStop, isHardStop, isResume, parseArbitrationChoice }
