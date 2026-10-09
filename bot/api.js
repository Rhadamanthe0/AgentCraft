'use strict'

// API HTTP et interface web du bot, sortie d index.js (2026-10-01). index.js
// garde le bot Mineflayer, le chien de garde et les commandes ; il passe ici
// ce que les routes lisent : `rt` donne l etat vivant (bot, spawned, chemins,
// sauvetages) par des accesseurs, lus a chaque requete ; `deps` les fonctions
// et objets stables.

const express = require('express')
const path = require('path')
const { runPhysicalOrThrow } = require('./executor')
// R10 : validation stricte des corps de requetes AVANT tout effet de bord.
// Chaque 400 sort avant admission, lease, cancel ou mission : une requete
// rejetee ne modifie jamais le runtime.
const config = require('./config')
const modelChain = require('./model-chain')

function createApi (rt, deps) {
  const {
    BOT_USERNAME,
    CHAT_HISTORY_MAX,
    CMD_PREFIX,
    CONTROL_KEYS,
    HANDLERS,
    MC_VERSION,
    activeControls,
    conversation,
    controlLease,
    craft,
    durableCorrupted,
    durablePersistError,
    handleHardStop,
    handleResume,
    inLiquid,
    isHardStopText,
    isHardStopped,
    isResumeText,
    isSoftStopText,
    memory,
    missionRunner,
    navigator,
    objectivesSnapshotSafe,
    physicalExecutor,
    planner,
    recentChat,
    requireAdmissionOrThrow,
    requireBot,
    rescue,
    resolveIntent,
    runPhysical,
    skills,
    startObjectiveDurable,
    stopPathfinding,
    validateModeFirst
  } = deps

  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '16kb' }))
  app.use(express.static(path.join(__dirname, 'public')))

  app.get('/api/status', (req, res) => {
    const position = rt.bot?.entity?.position
    res.json({
      ok: true,
      connected: Boolean(rt.bot),
      spawned: rt.spawned,
      username: rt.bot?.username ?? BOT_USERNAME,
      minecraftVersion: rt.bot?.version ?? null,
      expectedMinecraftVersion: MC_VERSION,
      health: rt.bot?.health ?? null,
      food: rt.bot?.food ?? null,
      position: position
        ? {
            x: Number(position.x.toFixed(2)),
            y: Number(position.y.toFixed(2)),
            z: Number(position.z.toFixed(2))
          }
        : null,
      pathfinding: Boolean(rt.bot?.pathfinder?.isMoving?.()),
      inLiquid: inLiquid(),
      pathStatus: rt.lastPathStatus,
      // Diagnostics : un chemin trouve mais un bot immobile se voit ici.
      pathLength: rt.lastPathLength,
      gravity: rt.bot?.physics?.gravity ?? null,
      onGround: rt.bot?.entity?.onGround ?? null,
      controls: activeControls(),
      followMode: rt.followMode,
      navigation: navigator.status(),
      rescues: rt.rescueCount,
      lastRescue: rt.lastRescue,
      commandPrefix: CMD_PREFIX,
      classifier: planner.isEnabled() ? 'planner' : 'indisponible',
      classifierModel: planner.isEnabled() ? `${planner.MODEL} (plan JSON)` : null,
      classifierMinConfidence: planner.isEnabled() ? planner.MIN_CONFIDENCE : null,
      classifierError: planner.isEnabled() ? null : (planner.lastError ?? 'PLANNER_BASE_URL vide'),
      // Latence reelle du planificateur : c est le chiffre a regarder avant de
      // changer de modele ou de taille de plan.
      planner: planner.isEnabled()
        ? { base: planner.BASE_URL, model: planner.MODEL, planMax: planner.PLAN_MAX, ...planner.stats }
        : null,
      // Memoire du modele : lisible sans entrer dans le conteneur, comme la
      // documentation des actions. C est le garde-fou humain de « le modele se souvient ».
      // Cache en couches : `travail` (memoire de mission) et `long_terme`
      // (persistante) ont des plafonds separes (`plafonds`), leurs jetons par
      // portee (`jetons`), ce qui reste (`restants`), les notes long terme en
      // attente de commit (`a_retenir`) et un compteur `generation` qui sert de
      // cle de cache a la couche 3 du prompt. Les champs historiques
      // `jetons_utilises` / `jetons_max` / `jetons_restants` restent servis.
      memory: memory.snapshot(),
      lastIntent: rt.lastIntent,
      recentChat,
      missionRunning: missionRunner.isRunning(),
      mission: missionRunner.status(),
      // Cycle durable (additif) : objectifs/inbox + executeur, sans changer
      // les champs historiques. `physicalWriter` dit honnetement ce qui passe
      // par le writer unique : touches persistantes en lease (slot tenu de
      // state=true a state=false) et regards admis avant lookAt, comme le
      // reste (plus d exception connue).
      objectifs: objectivesSnapshotSafe(),
      durableCorrompu: durableCorrupted(),
      durableErreur: durablePersistError(),
      executor: (() => { try { return physicalExecutor ? physicalExecutor.status() : null } catch (_) { return null } })(),
      // R03 : resultat final du dernier /api/goto admis (async) : l admission
      // repond admitted sans attendre, mais le resultat (completed / failed /
      // cancelled, code et message conserves) est expose ici, jamais comme un
      // second ok:true.
      dernierGoto: rt.lastGoto ?? null,
      toucheTenue: (() => { try { return controlLease ? controlLease.status() : null } catch (_) { return null } })(),
      physicalWriter: {
        singleWriter: true,
        couverture: 'totale',
        viaExecuteur: ['mission-steps', 'mission-parcours', 'nav-commands', 'rescue-walk', 'rescue', 'api-control-lease', 'api-goto', 'api-jump', 'api-turn', 'api-look', 'touches-commandes-lease', 'saut-commande', 'regard-vois'],
        exceptions: [],
        profilPilote: (() => { try { return planner.profileStatus?.() ?? null } catch (_) { return null } })()
      },
      // L inventaire decide de tout en survie : le voir sans entrer en jeu evite
      // de deviner pourquoi un chantier n avance pas.
      supply: missionRunner.SUPPLY,
      inventory: rt.bot?.inventory ? craft.snapshot(rt.bot) : null,
      heldItem: rt.bot?.heldItem?.name ?? null
    })
  })

  // La table des commandes et le resultat de l audit, pour verifier sans lire le
  // code que chat, catalogue et handlers parlent bien de la meme chose.
  app.get('/api/commands', (req, res) => {
    res.json({
      ok: true,
      prefix: CMD_PREFIX,
      audit: rt.commandAudit,
      commands: Object.entries(skills.COMMANDS).map(([name, spec]) => ({
        name,
        aliases: spec.aliases,
        usage: spec.usage.replace(/^!/, CMD_PREFIX),
        summary: spec.summary,
        routableParLeChat: Boolean(spec.chat)
      })),
      supply: missionRunner.SUPPLY,
      actions: Object.entries(skills.ACTIONS).map(([name, spec]) => ({
        name,
        summary: spec.summary,
        parametre: spec.scale,
        // Parametres du plan JSON et leurs bornes.
        parametres: Object.entries(skills.jsonParamsFor(name) ?? {}).map(([param, descriptor]) => ({
          nom: param,
          question: descriptor.question,
          bornes: descriptor.json
        })),
        types: spec.kinds
      })),
      crafts: Object.entries(craft.TARGETS).map(([name, spec]) => ({
        name,
        summary: spec.summary
      })),
      missionKinds: Object.keys(skills.KINDS),
      landmarks: Object.keys(skills.LANDMARKS),
      resources: Object.keys(skills.RESOURCES).filter(name => name !== 'aucune'),
      // La documentation et les exemples des actions natives.
      documentation: skills.documentedActions()
    })
  })

  // La documentation et les exemples des actions natives, tels que le modele les lit.
  app.get('/api/actions', (req, res) => {
    res.json({ ok: true, actions: skills.documentedActions() })
  })

  // La memoire du modele, lisible et effacable sans entrer dans le conteneur.
  // Garde-fou humain : on voit ce qu il retient,
  // et on efface si ca l egare. `portee` vaut travail, long_terme ou tout.
  // Le snapshot expose les champs par couche (jetons, plafonds, restants,
  // a_retenir, generation) ; effacer la memoire long terme increment
  // `generation`, donc invalide la couche 3 du prompt au tour suivant.
  app.get('/api/memory', (req, res) => {
    res.json({
      ok: true,
      fichier: memory.FILE,
      erreurEcriture: memory.persistError,
      ...memory.snapshot()
    })
  })

  // R24 : etat de la memoire (corruption lecture seule, erreur d ecriture).
  // Lecture seule : ne touche ni au fichier ni a l etat.
  app.get('/api/memory/status', (req, res) => {
    const st = typeof memory.status === 'function'
      ? memory.status()
      : { fichier: memory.FILE, corrompue: false, erreur: null, erreurEcriture: memory.persistError, generation: memory.generation }
    res.json({ ok: true, ...st })
  })

  app.delete('/api/memory', (req, res) => {
    const portee = String(req.query.portee ?? req.body?.portee ?? 'tout')
    const result = memory.clear(portee)
    if (!result.ok) return res.status(400).json({ ok: false, error: result.error })
    console.log(`[memoire] portee "${result.portee}" effacee par l API`)
    res.json({ ok: true, portee: result.portee, ...result.snapshot })
  })

  // Interrupteurs A/B du banc (mission.setFeatures) : {"solveur": false} coupe
  // un mode, {"reset": true} revient aux defauts. Aucun pouvoir en jeu.
  app.post('/api/features', (req, res) => {
    const features = missionRunner.setFeatures(req.body ?? {})
    console.log(`[features] ${JSON.stringify(features)}`)
    res.json({ ok: true, features })
  })

  // A/B de modele du banc (bot/model-chain.js) : {"plan": "claude-haiku-5-5"}
  // remplace le modele d un usage (plan, brief, chat, compact), {"reset": true}
  // revient au .env. Aucun pouvoir en jeu.
  app.post('/api/models', (req, res) => {
    const models = modelChain.setOverrides(req.body ?? {})
    console.log(`[modeles] ${JSON.stringify(models)}`)
    res.json({ ok: true, models })
  })

  app.post('/api/control', requireBot, async (req, res) => {
    const body = req.body ?? {}
    // Touche enumeree (cles connues) et state strict via config, jamais
    // Boolean() (R23 : 'false' devenait true, l absence un release).
    // Acquire/release exigent un booleen explicite ; sinon 400 sans effet.
    const controlParsed = config.parseRequestEnum(body.control, CONTROL_KEYS, { name: 'control' })
    const state = config.strictBoolean(body.state)

    if (!controlParsed.ok) {
      return res.status(400).json({ ok: false, error: controlParsed.error })
    }
    const control = controlParsed.value

    if (state === null) {
      return res.status(400).json({ ok: false, error: 'state must be a boolean (true to hold, false to release)' })
    }
    if (!controlLease || typeof controlLease.acquire !== 'function') {
      return res.status(409).json({ ok: false, error: 'lease de touches indisponible (fail-closed)', code: 'unavailable' })
    }
    // Garde executeur : arret total ou slot tenu => refus fail-closed, jamais
    // de chevauchement avec une mission/nav en cours.
    if (isHardStopped()) {
      return res.status(409).json({ ok: false, error: 'arret total : reprends d abord', code: 'stopped' })
    }

    if (state === true) {
      // Acquire : la touche est appliquee DANS le slot, qui reste TENU tant
      // que le lease existe. Reponse immediate d admission, comme /api/goto :
      // le slot, lui, ne se libere qu a release (state=false) ou abort.
      try {
        requireAdmissionOrThrow()
      } catch (err) {
        return res.status(409).json({ ok: false, error: err.message, code: err.code || 'refus' })
      }
      try {
        await controlLease.acquire(control, `api-control-${control}-${Date.now()}`)
      } catch (err) {
        return res.status(409).json({ ok: false, error: err.message, code: err.code || 'refus' })
      }
      return res.json({ ok: true, control, state, controls: activeControls() })
    }
    // Release : libere le MEME lease, quel que soit son mode d acquisition
    // (!avance ou /api/control). La touche s eteint dans le slot, qui se
    // libere ensuite : la suivante est admise. Idempotent : sans touche
    // tenue, ok:true avec released:false (compat : jamais de 400).
    let released = false
    try {
      const outcome = await controlLease.release()
      // Bail reel : { released: true/false }. Mocks historiques sans forme :
      // compat (release effectue), released:true.
      released = outcome && typeof outcome.released === 'boolean' ? outcome.released : true
    } catch (err) {
      return res.status(409).json({ ok: false, error: err.message, code: err.code || 'refus' })
    }
    res.json({ ok: true, control, state, released, controls: activeControls() })
  })

  app.post('/api/jump', requireBot, async (req, res) => {
    try {
      requireAdmissionOrThrow()
    } catch (err) {
      return res.status(409).json({ ok: false, error: err.message, code: err.code || 'refus' })
    }
    // R03 : le callback qui jette ne rend jamais ok:true (code/message
    // conserves, slot libere par l executeur dans tous les cas).
    try {
      await runPhysicalOrThrow(runPhysical, `api-jump-${Date.now()}`, 'work', async () => {
        stopPathfinding()
        rt.bot.setControlState('jump', true)
        await new Promise(resolve => setTimeout(resolve, 300))
        if (rt.bot && rt.spawned) rt.bot.setControlState('jump', false)
        return { jumped: true }
      })
    } catch (err) {
      if (err && (err.code === 'paused' || err.code === 'stopped' || err.code === 'busy' || err.code === 'unavailable' || err.code === 'cancelled')) {
        return res.status(409).json({ ok: false, error: err.message, code: err.code })
      }
      return res.status(500).json({ ok: false, error: err.message, code: (err && err.code) || 'erreur' })
    }
    res.json({ ok: true })
  })

  app.post('/api/turn', requireBot, async (req, res) => {
    // Nombre fini et borne, sans coercition (Number(null) valait 0 : un tour
    // nul admis pour rien). 400 avant toute admission.
    const parsed = config.parseRequestNumber((req.body ?? {}).degrees, { min: -360, max: 360, name: 'degrees' })
    if (!parsed.ok) {
      return res.status(400).json({ ok: false, error: parsed.error })
    }
    const degrees = parsed.value
    try {
      requireAdmissionOrThrow()
    } catch (err) {
      return res.status(409).json({ ok: false, error: err.message, code: err.code || 'refus' })
    }

    try {
      await runPhysicalOrThrow(runPhysical, `api-turn-${Date.now()}`, 'work', async () => {
        stopPathfinding()
        const radians = degrees * Math.PI / 180
        await rt.bot.look(rt.bot.entity.yaw + radians, rt.bot.entity.pitch, true)
        return { degrees }
      })
      res.json({ ok: true })
    } catch (err) {
      if (err && (err.code === 'paused' || err.code === 'stopped' || err.code === 'busy' || err.code === 'unavailable' || err.code === 'cancelled')) {
        return res.status(409).json({ ok: false, error: err.message, code: err.code })
      }
      res.status(500).json({ ok: false, error: err.message, code: (err && err.code) || 'erreur' })
    }
  })

  app.post('/api/look', requireBot, async (req, res) => {
    // yaw borne au tour complet, pitch a la verticale : sans borne, un pitch
    // absurde partait au slot physique avant d echouer. 400 avant admission.
    const body = req.body ?? {}
    const yawParsed = config.parseRequestNumber(body.yaw, { min: -360, max: 360, name: 'yaw' })
    const pitchParsed = config.parseRequestNumber(body.pitch, { min: -90, max: 90, name: 'pitch' })
    if (!yawParsed.ok) {
      return res.status(400).json({ ok: false, error: yawParsed.error })
    }
    if (!pitchParsed.ok) {
      return res.status(400).json({ ok: false, error: pitchParsed.error })
    }
    const yaw = yawParsed.value
    const pitch = pitchParsed.value
    try {
      requireAdmissionOrThrow()
    } catch (err) {
      return res.status(409).json({ ok: false, error: err.message, code: err.code || 'refus' })
    }

    try {
      await runPhysicalOrThrow(runPhysical, `api-look-${Date.now()}`, 'work', async () => {
        stopPathfinding()
        await rt.bot.look(yaw * Math.PI / 180, pitch * Math.PI / 180, true)
        return { yaw, pitch }
      })
      res.json({ ok: true })
    } catch (err) {
      if (err && (err.code === 'paused' || err.code === 'stopped' || err.code === 'busy' || err.code === 'unavailable' || err.code === 'cancelled')) {
        return res.status(409).json({ ok: false, error: err.message, code: err.code })
      }
      res.status(500).json({ ok: false, error: err.message, code: (err && err.code) || 'erreur' })
    }
  })

  app.post('/api/chat', requireBot, (req, res) => {
    // Chaine reelle exigee : String({}) valait '[object Object]' et partait au jeu.
    const parsed = config.parseRequestString((req.body ?? {}).message, { minLen: 1, maxLen: 240, name: 'message' })
    if (!parsed.ok) {
      return res.status(400).json({ ok: false, error: parsed.error })
    }
    const message = parsed.value

    rt.bot.chat(message)
    res.json({ ok: true })
  })

  app.post('/api/goto', requireBot, async (req, res) => {
    // Coordonnees finies dans le monde, range entier borne : Number(null)
    // valait 0 (destination 0,0,0 admise) et un range 'abc' retombait a 1 en
    // silence. Toute erreur rend 400 avant toute admission.
    const body = req.body ?? {}
    const xParsed = config.parseRequestNumber(body.x, { min: -30000000, max: 30000000, name: 'x' })
    const yParsed = config.parseRequestNumber(body.y, { min: -2048, max: 2048, name: 'y' })
    const zParsed = config.parseRequestNumber(body.z, { min: -30000000, max: 30000000, name: 'z' })
    if (!xParsed.ok) {
      return res.status(400).json({ ok: false, error: xParsed.error })
    }
    if (!yParsed.ok) {
      return res.status(400).json({ ok: false, error: yParsed.error })
    }
    if (!zParsed.ok) {
      return res.status(400).json({ ok: false, error: zParsed.error })
    }
    let range = 1
    if (body.range !== undefined) {
      const rangeParsed = config.parseRequestNumber(body.range, { min: 1, max: 8, integer: true, name: 'range' })
      if (!rangeParsed.ok) {
        return res.status(400).json({ ok: false, error: rangeParsed.error })
      }
      range = rangeParsed.value
    }
    const x = xParsed.value
    const y = yParsed.value
    const z = zParsed.value
    // Admission AVANT tout ordre (fail-closed) : un refus ne detruit rien.
    try {
      requireAdmissionOrThrow()
    } catch (err) {
      return res.status(409).json({ ok: false, error: err.message, code: err.code || 'refus' })
    }

    const target = { x, y, z, range: Math.floor(range) }
    // Une invocation = tout le trajet, en tache de fond (reponse immediate
    // d admission, slot tenu jusqu a resolution reelle).
    // R03 : l admission repond admitted sans attendre la fin du trajet, mais
    // APRES la prise effective du slot (I1) : un busy concurrent rend 409,
    // jamais admitted:true suivi d un lastGoto failed. Le resultat final est
    // enregistre (rt.lastGoto, expose par /api/status en dernierGoto) avec
    // son outcome distinct : jamais de ok:true sur failed/cancelled.
    const admittedAt = new Date().toISOString()
    let priseResolve = null
    const prise = new Promise(resolve => { priseResolve = resolve })
    const execPromise = runPhysicalOrThrow(runPhysical, `api-goto-${Date.now()}`, 'work', async (ctx) => {
      try { priseResolve() } catch (_) {}
      const signal = ctx?.signal
      if (signal?.aborted) {
        const err = new Error('goto annule avant depart')
        err.code = 'cancelled'
        throw err
      }
      stopPathfinding()
      rt.lastPathStatus = null
      return await navigator.toPosition({ x, y, z }, { signal, radius: target.range })
    })
    // Prise effective avant de repondre : le refus d admission (busy, paused,
    // stopped, unavailable) rejette avant la prise et rend 409. Un echec du
    // trajet APRES la prise reste un lastGoto failed, jamais un 409.
    try {
      await Promise.race([prise, execPromise])
    } catch (err) {
      return res.status(409).json({ ok: false, error: err.message, code: (err && err.code) || 'refus' })
    }
    execPromise.then(
      result => {
        try { rt.lastGoto = { target, admittedAt, at: new Date().toISOString(), outcome: 'completed', result } } catch (_) {}
      },
      err => {
        console.error(`[nav] goto refuse/interrompu (${err.code || 'erreur'}) : ${err.message}`)
        try {
          rt.lastGoto = {
            target,
            admittedAt,
            at: new Date().toISOString(),
            outcome: err && err.code === 'cancelled' ? 'cancelled' : 'failed',
            code: (err && err.code) || 'erreur',
            error: err.message
          }
        } catch (_) {}
      }
    )
    res.json({ ok: true, admitted: true, target })
  })

  // Vrais flux /api/instruction : inbox persistee + immediats hors LLM.
  // stop / arret total / reprends bypassent le modele ; le reste passe par la
  // conversation (question/context conservent, concurrent => arbitrage).
  app.post('/api/instruction', validateModeFirst, requireBot, async (req, res) => {
    // Validation complete avant tout effet (inbox, stop, reprise) : une 400 ne
    // pousse rien dans recentChat et ne touche a aucun arret.
    const body = req.body ?? {}
    const messageParsed = config.parseRequestString(body.message, { minLen: 1, maxLen: 1000, name: 'message' })
    if (!messageParsed.ok) {
      return res.status(400).json({ ok: false, error: messageParsed.error })
    }
    const requesterParsed = config.parseRequestString(body.requester, { minLen: 1, maxLen: 32, name: 'requester' })
    if (!requesterParsed.ok) {
      return res.status(400).json({ ok: false, error: requesterParsed.error })
    }
    const message = messageParsed.value
    const requester = requesterParsed.value
    // Inbox persistee best-effort AVANT interpret (sans perte sur annulation).
    // Le terminal (propose/addContext) persiste aussi : en cas de doublon futur,
    // c est l inbox qui fait foi, jamais une perte.
    recentChat.push({ de: requester, message: message.slice(0, 160), a: new Date().toISOString() })
    if (recentChat.length > CHAT_HISTORY_MAX) recentChat.shift()
    if (isHardStopText(message)) {
      handleHardStop()
      return res.json({ ok: true, relation: 'stop', kind: 'hardstop' })
    }
    if (isResumeText(message)) {
      handleResume()
      return res.json({ ok: true, relation: 'resume' })
    }
    if (isSoftStopText(message)) {
      HANDLERS.stop()
      return res.json({ ok: true, relation: 'stop' })
    }
    const result = await resolveIntent(requester, message, req.directMode ? { mode: req.directMode } : undefined)
    res.json({ ok: !result?.error, ...result })
  })

  app.post('/api/mission', validateModeFirst, requireBot, async (req, res) => {
    // R10 : validation COMPLETE avant tout effet de bord. Le cancel annulait
    // les interpretations en vol meme pour un objectif vide ou trop long : une
    // 400 ne doit jamais modifier le runtime (ni cancel, ni objectif).
    const body = req.body ?? {}
    const objectiveParsed = config.parseRequestString(body.objective, { minLen: 1, maxLen: 240, name: 'objective' })
    if (!objectiveParsed.ok) {
      return res.status(400).json({ ok: false, error: objectiveParsed.error })
    }
    let requester = 'api'
    if (body.requester !== undefined) {
      const requesterParsed = config.parseRequestString(body.requester, { minLen: 1, maxLen: 32, name: 'requester' })
      if (!requesterParsed.ok) {
        return res.status(400).json({ ok: false, error: requesterParsed.error })
      }
      requester = requesterParsed.value
    }
    const objective = objectiveParsed.value
    conversation.cancel(false)
    // Meme intake durable que le chat (hardstop + arbitrage), jamais direct.
    const result = await startObjectiveDurable(objective, requester, req.directMode ? { mode: req.directMode } : undefined)
    if (!result.ok && !result.arbitration && !result.queued) return res.status(409).json(result)

    res.json(result)
  })

  // Mission scriptee (banc de competences, script-brain.js) : etapes donnees
  // d avance, aucun appel au modele. Fermee hors banc (MISSION_SCRIPT=1).
  app.post('/api/mission/script', validateModeFirst, requireBot, async (req, res) => {
    if (process.env.MISSION_SCRIPT !== '1') return res.status(404).json({ ok: false, error: 'missions scriptees fermees (MISSION_SCRIPT)' })
    // Validation complete avant tout effet : 400/409 avant le cancel.
    const body = req.body ?? {}
    const objectiveParsed = config.parseRequestString(body.objective, { minLen: 1, maxLen: 240, name: 'objective' })
    if (!objectiveParsed.ok) {
      return res.status(400).json({ ok: false, error: objectiveParsed.error })
    }
    let requester = 'api'
    if (body.requester !== undefined) {
      const requesterParsed = config.parseRequestString(body.requester, { minLen: 1, maxLen: 32, name: 'requester' })
      if (!requesterParsed.ok) {
        return res.status(400).json({ ok: false, error: requesterParsed.error })
      }
      requester = requesterParsed.value
    }
    const scriptParsed = config.parseRequestArray(body.script, { minLen: 1, maxLen: 200, item: 'object', name: 'script' })
    if (!scriptParsed.ok) {
      return res.status(400).json({ ok: false, error: scriptParsed.error })
    }
    let brief = {}
    if (body.brief !== undefined) {
      const briefParsed = config.parseRequestObject(body.brief, { name: 'brief' })
      if (!briefParsed.ok) {
        return res.status(400).json({ ok: false, error: briefParsed.error })
      }
      brief = briefParsed.value
    }
    const objective = objectiveParsed.value
    if (missionRunner.isRunning()) return res.status(409).json({ ok: false, error: 'mission en cours' })
    conversation.cancel(false)
    const result = await startObjectiveDurable(objective, requester, { script: scriptParsed.value, brief })
    res.status(result.ok ? 200 : 409).json(result)
  })

  app.get('/api/mission', (req, res) => {
    res.json({ ok: true, running: missionRunner.isRunning(), mission: missionRunner.status() })
  })

  app.get('/api/mission/instantanes', (req, res) => {
    res.json({ ok: true, instantanes: missionRunner.instantanes?.() ?? [] })
  })

  app.get('/api/mission/trace', (req, res) => {
    res.json({ ok: true, trace: missionRunner.trace?.() ?? null })
  })

  app.get('/api/navigation/trace', (req, res) => res.json(req.query.history === '1'
    ? { ok: true, traces: navigator.traces(), active: navigator.isActive() ? navigator.trace() : null }
    : { ok: true, trace: navigator.trace() }))

  app.delete('/api/mission', (req, res) => {
    // Vraie pause (contexte conserve, reprise possible), pas de stop destructeur.
    // Forme compatible : cles historiques gardees, `paused` additif.
    conversation.cancel()
    const wasRunning = missionRunner.isRunning()
    const paused = wasRunning ? missionRunner.pauseWork('arret demande via l API') : false
    res.json({ ok: true, stopped: false, paused, mission: missionRunner.status() })
  })

  app.post('/api/unstuck', requireBot, async (req, res) => {
    if (isHardStopped()) {
      return res.status(409).json({ ok: false, error: 'arret total : rescue interdit, reprends d abord', code: 'stopped', rescues: rt.rescueCount, lastRescue: rt.lastRescue })
    }
    await rescue('requested via API', { escalate: true })
    res.json({ ok: true, rescues: rt.rescueCount, lastRescue: rt.lastRescue })
  })

  app.post('/api/stop', requireBot, (req, res) => {
    HANDLERS.stop()
    res.json({ ok: true, missionStopped: true })
  })

  app.post('/api/arret-total', requireBot, (req, res) => {
    handleHardStop()
    res.json({ ok: true, hardstop: true })
  })

  app.post('/api/resume', requireBot, (req, res) => {
    handleResume()
    res.json({ ok: true, resumed: true })
  })

  app.get('/api/objectifs', (req, res) => {
    res.json({ ok: true, objectifs: objectivesSnapshotSafe() })
  })

  // Filet des handlers async : une route qui leve (Express 5 propage le rejet)
  // doit rendre un 500 lisible au lieu de laisser la requete pendre.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err)

    // Corps de requete illisible (JSON malforme : `entity.parse.failed`, ou corps
    // trop volumineux : `entity.too.large`) : c'est la faute du client, pas une
    // panne interne. Le 500 + le message dans le chat etaient trompeurs et
    // polluaient le jeu ; on rend le vrai code d'erreur sans journaliser.
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      return res.status(err.statusCode || err.status || 400).json({ ok: false, error: err.message })
    }

    console.error('[api] erreur non geree :', err.message)
    res.status(500).json({ ok: false, error: err.message })
  })


  return app
}

module.exports = { createApi }
