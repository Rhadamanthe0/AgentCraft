'use strict'

// API HTTP et interface web du bot, sortie d index.js (2026-10-01). index.js
// garde le bot Mineflayer, le chien de garde et les commandes ; il passe ici
// ce que les routes lisent : `rt` donne l etat vivant (bot, spawned, chemins,
// sauvetages) par des accesseurs, lus a chaque requete ; `deps` les fonctions
// et objets stables.

const express = require('express')
const path = require('path')

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
      // Couverture honnete du writer : jamais singleWriter:true tant qu une
      // exception subsiste (touches directes tenue indefinite, regards).
      objectifs: objectivesSnapshotSafe(),
      durableCorrompu: durableCorrupted(),
      durableErreur: durablePersistError(),
      executor: (() => { try { return physicalExecutor ? physicalExecutor.status() : null } catch (_) { return null } })(),
      physicalWriter: {
        singleWriter: false,
        couverture: 'partielle',
        viaExecuteur: ['mission-steps', 'mission-parcours', 'nav-commands', 'rescue-walk', 'api-control', 'api-goto', 'api-jump', 'api-turn', 'api-look', 'touches-commandes', 'saut-commande'],
        exceptions: ['touches-tenues-indefini-apres-admission', 'regards-lookAt-hors-slot'],
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

  app.post('/api/control', requireBot, async (req, res) => {
    const control = String(req.body.control || '')
    const state = Boolean(req.body.state)

    const allowed = new Set(CONTROL_KEYS)

    if (!allowed.has(control)) {
      return res.status(400).json({ ok: false, error: 'Invalid control' })
    }
    // Garde executeur : arret total ou slot tenu => refus fail-closed, jamais
    // de chevauchement avec une mission/nav en cours.
    if (isHardStopped()) {
      return res.status(409).json({ ok: false, error: 'arret total : reprends d abord', code: 'stopped' })
    }
    try {
      const st = physicalExecutor ? physicalExecutor.status() : null
      if (st && st.busy) {
        return res.status(409).json({ ok: false, error: `executeur occupe par ${st.current?.id}`, code: 'busy' })
      }
      if (st && st.paused) {
        return res.status(409).json({ ok: false, error: 'travail en pause', code: 'paused' })
      }
    } catch (_) {}

    // Controle manuel DANS le writer (admission fail-closed busy/stop d abord,
    // jamais de chevauchement). Tenu indefini cote jeu : documente comme tel.
    try {
      requireAdmissionOrThrow()
    } catch (err) {
      return res.status(409).json({ ok: false, error: err.message, code: err.code || 'refus' })
    }
    try {
      await runPhysical(`api-control-${control}-${Date.now()}`, 'work', async () => {
        const held = state ? activeControls() : []
        if (state && rt.bot?.pathfinder?.goal) stopPathfinding()
        rt.bot.setControlState(control, state)
        for (const name of held) {
          if (name !== control) rt.bot.setControlState(name, true)
        }
        return { control, state }
      })
    } catch (err) {
      return res.status(409).json({ ok: false, error: err.message, code: err.code || 'refus' })
    }
    res.json({ ok: true, control, state, controls: activeControls() })
  })

  app.post('/api/jump', requireBot, async (req, res) => {
    try {
      requireAdmissionOrThrow()
    } catch (err) {
      return res.status(409).json({ ok: false, error: err.message, code: err.code || 'refus' })
    }
    try {
      await runPhysical(`api-jump-${Date.now()}`, 'work', async () => {
        stopPathfinding()
        rt.bot.setControlState('jump', true)
        await new Promise(resolve => setTimeout(resolve, 300))
        if (rt.bot && rt.spawned) rt.bot.setControlState('jump', false)
        return { jumped: true }
      })
    } catch (err) {
      return res.status(409).json({ ok: false, error: err.message, code: err.code || 'refus' })
    }
    res.json({ ok: true })
  })

  app.post('/api/turn', requireBot, async (req, res) => {
    const degrees = Number(req.body.degrees)

    if (!Number.isFinite(degrees) || Math.abs(degrees) > 360) {
      return res.status(400).json({ ok: false, error: 'degrees must be between -360 and 360' })
    }
    try {
      requireAdmissionOrThrow()
    } catch (err) {
      return res.status(409).json({ ok: false, error: err.message, code: err.code || 'refus' })
    }

    try {
      await runPhysical(`api-turn-${Date.now()}`, 'work', async () => {
        stopPathfinding()
        const radians = degrees * Math.PI / 180
        await rt.bot.look(rt.bot.entity.yaw + radians, rt.bot.entity.pitch, true)
        return { degrees }
      })
      res.json({ ok: true })
    } catch (err) {
      if (err && (err.code === 'paused' || err.code === 'stopped' || err.code === 'busy' || err.code === 'unavailable')) {
        return res.status(409).json({ ok: false, error: err.message, code: err.code })
      }
      res.status(500).json({ ok: false, error: err.message })
    }
  })

  app.post('/api/look', requireBot, async (req, res) => {
    const yaw = Number(req.body.yaw)
    const pitch = Number(req.body.pitch)

    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
      return res.status(400).json({ ok: false, error: 'yaw and pitch must be numbers in degrees' })
    }
    try {
      requireAdmissionOrThrow()
    } catch (err) {
      return res.status(409).json({ ok: false, error: err.message, code: err.code || 'refus' })
    }

    try {
      await runPhysical(`api-look-${Date.now()}`, 'work', async () => {
        stopPathfinding()
        await rt.bot.look(yaw * Math.PI / 180, pitch * Math.PI / 180, true)
        return { yaw, pitch }
      })
      res.json({ ok: true })
    } catch (err) {
      if (err && (err.code === 'paused' || err.code === 'stopped' || err.code === 'busy' || err.code === 'unavailable')) {
        return res.status(409).json({ ok: false, error: err.message, code: err.code })
      }
      res.status(500).json({ ok: false, error: err.message })
    }
  })

  app.post('/api/chat', requireBot, (req, res) => {
    const message = String(req.body.message || '').trim()

    if (!message || message.length > 240) {
      return res.status(400).json({ ok: false, error: 'Message must contain 1 to 240 characters' })
    }

    rt.bot.chat(message)
    res.json({ ok: true })
  })

  app.post('/api/goto', requireBot, (req, res) => {
    const x = Number(req.body.x)
    const y = Number(req.body.y)
    const z = Number(req.body.z)
    const rangeInput = Number(req.body.range ?? 1)
    const range = Math.max(1, Math.min(8, Number.isFinite(rangeInput) ? rangeInput : 1))

    if (![x, y, z].every(Number.isFinite)) {
      return res.status(400).json({ ok: false, error: 'x, y and z must be numbers' })
    }
    // Admission AVANT tout ordre (fail-closed) : un refus ne detruit rien.
    try {
      requireAdmissionOrThrow()
    } catch (err) {
      return res.status(409).json({ ok: false, error: err.message, code: err.code || 'refus' })
    }

    const target = { x, y, z, range: Math.floor(range) }
    // Une invocation = tout le trajet, en tache de fond (reponse immediate
    // d admission, slot tenu jusqu a resolution reelle).
    runPhysical(`api-goto-${Date.now()}`, 'work', async ({ signal }) => {
      if (signal?.aborted) return { code: 'cancelled', reached: false }
      stopPathfinding()
      rt.lastPathStatus = null
      return await navigator.toPosition({ x, y, z }, { signal, radius: target.range })
    }).catch(err => {
      console.error(`[nav] goto refuse/interrompu (${err.code || 'erreur'}) : ${err.message}`)
    })
    res.json({ ok: true, admitted: true, target })
  })

  // Vrais flux /api/instruction : inbox persistee + immediats hors LLM.
  // stop / arret total / reprends bypassent le modele ; le reste passe par la
  // conversation (question/context conservent, concurrent => arbitrage).
  app.post('/api/instruction', validateModeFirst, requireBot, async (req, res) => {
    const message = String(req.body.message ?? '').trim()
    const requester = String(req.body.requester ?? '').trim()
    if (!message || message.length > 1000 || !requester) return res.status(400).json({ ok: false, error: 'message et requester requis' })
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
    conversation.cancel(false)
    const objective = String(req.body.objective || '').trim()
    const requester = String(req.body.requester || 'api').slice(0, 32)

    if (!objective || objective.length > 240) {
      return res.status(400).json({ ok: false, error: 'objective must contain 1 to 240 characters' })
    }
    // Meme intake durable que le chat (hardstop + arbitrage), jamais direct.
    const result = await startObjectiveDurable(objective, requester, req.directMode ? { mode: req.directMode } : undefined)
    if (!result.ok && !result.arbitration && !result.queued) return res.status(409).json(result)

    res.json(result)
  })

  // Mission scriptee (banc de competences, script-brain.js) : etapes donnees
  // d avance, aucun appel au modele. Fermee hors banc (MISSION_SCRIPT=1).
  app.post('/api/mission/script', validateModeFirst, requireBot, async (req, res) => {
    if (process.env.MISSION_SCRIPT !== '1') return res.status(404).json({ ok: false, error: 'missions scriptees fermees (MISSION_SCRIPT)' })
    const objective = String(req.body.objective || '').trim()
    const requester = String(req.body.requester || 'api').slice(0, 32)
    if (!objective || objective.length > 240) {
      return res.status(400).json({ ok: false, error: 'objective must contain 1 to 240 characters' })
    }
    if (!Array.isArray(req.body.script) || req.body.script.length === 0) {
      return res.status(400).json({ ok: false, error: 'script must be a non-empty array' })
    }
    if (missionRunner.isRunning()) return res.status(409).json({ ok: false, error: 'mission en cours' })
    conversation.cancel(false)
    const result = await startObjectiveDurable(objective, requester, { script: req.body.script, brief: req.body.brief ?? {} })
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
