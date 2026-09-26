'use strict'

// Profil pilote D37/D49 (bot/planner.js) : Muse par defaut, repli DeepSeek annonce.
// Tout le reseau est simule (llm.call moque) : aucun appel distant, aucun secret.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')

const llm = require('../bot/llm')

const PLANNER_PATH = require.resolve('../bot/planner')
const MUSE = 'muse-spark-1.3-contributor'
const DEEPSEEK = 'deepseek-v4.1-flash'
const GO_BASE = 'https://opencode.ai/zen/go/v1'

let origCall
let seen
let savedEnv

function loadPlanner (overrides = {}) {
  delete require.cache[PLANNER_PATH]
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  const planner = require('../bot/planner')
  planner._resetProfile()
  return planner
}

function mockLlm (impl) {
  seen = []
  llm.call = async (system, user, options = {}) => {
    seen.push({ system, user, options })
    return impl(system, user, options)
  }
}

function okPlan () {
  return { content: '{"fini":0,"pourquoi":"test","plan":[{"action":"regarder_autour"}]}', usage: null, ms: 5 }
}

beforeEach(() => {
  origCall = llm.call
  savedEnv = {
    PLANNER_BASE_URL: process.env.PLANNER_BASE_URL,
    PLANNER_MODEL: process.env.PLANNER_MODEL,
    PLANNER_SESSION_ID: process.env.PLANNER_SESSION_ID,
    PLANNER_MAX_TOKENS: process.env.PLANNER_MAX_TOKENS,
    PLANNER_TIMEOUT_MS: process.env.PLANNER_TIMEOUT_MS,
    PLANNER_PILOT_MAX_TOKENS: process.env.PLANNER_PILOT_MAX_TOKENS,
    PLANNER_PILOT_RETRY_MAX_TOKENS: process.env.PLANNER_PILOT_RETRY_MAX_TOKENS,
    PLANNER_PILOT_COOLDOWN_MS: process.env.PLANNER_PILOT_COOLDOWN_MS,
    BOT_USERNAME: process.env.BOT_USERNAME
  }
  process.env.PLANNER_BASE_URL = GO_BASE
  process.env.PLANNER_SESSION_ID = 'minecraft-bot-TestBot'
  process.env.PLANNER_MAX_TOKENS = '2000'
  process.env.PLANNER_PILOT_MAX_TOKENS = '4096'
  process.env.PLANNER_PILOT_RETRY_MAX_TOKENS = '8192'
  process.env.PLANNER_PILOT_COOLDOWN_MS = '60000'
  process.env.BOT_USERNAME = 'TestBot'
})

afterEach(() => {
  llm.call = origCall
  delete require.cache[PLANNER_PATH]
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('profil pilote : selection par defaut et gardes', () => {
  it('marge temporaire DeepSeek : 4096 jetons et 45 s apres chauffe, annulation conservee', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: DEEPSEEK, PLANNER_MAX_TOKENS: '4096', PLANNER_TIMEOUT_MS: '45000' })
    mockLlm(async () => okPlan())
    const signal = new AbortController().signal
    await planner.plan({ consigne: 'premier appel' }, 'recolte', 'harvest')
    await planner.plan({ consigne: 'appel apres chauffe' }, 'recolte', 'harvest', {}, null, { signal })
    const effective = seen[1].options
    assert.equal(effective.maxTokens, 4096)
    assert.equal(effective.timeoutMs, 45000)
    assert.equal(effective.model, DEEPSEEK)
    assert.equal(effective.protocol, 'chat')
    assert.equal(effective.signal, signal)
    assert.equal(planner.profileStatus().fallbackActive, false)
    assert.equal(planner.profileStatus().enabled, false)
    assert.equal(planner.profileStatus().session, 'minecraft-bot-TestBot')
    assert.ok(!Object.hasOwn(effective, 'reasoning') && !Object.hasOwn(effective, 'effort'))
  })

  it('marge configurable : le plancher historique de 2000 jetons reste applique', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: DEEPSEEK, PLANNER_MAX_TOKENS: '1000', PLANNER_TIMEOUT_MS: '45000' })
    mockLlm(async () => okPlan())
    await planner.plan({ consigne: 'test' }, 'recolte', 'harvest')
    assert.equal(seen[0].options.maxTokens, 2000)
  })

  it('Muse par defaut pour nouveau profil (sans PLANNER_MODEL)', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: undefined })
    assert.equal(planner.MODEL, MUSE)
    assert.equal(planner.PILOT_MODEL, MUSE)
    assert.equal(planner.FALLBACK_MODEL, DEEPSEEK)
    const st = planner.profileStatus()
    assert.equal(st.configured, MUSE)
    assert.equal(st.effective, MUSE)
    assert.equal(st.enabled, true)
    assert.equal(st.baseConfigured, true)
    assert.equal(st.isGo, true)
    assert.equal(st.sessionStable, true)
    assert.equal(st.session, 'minecraft-bot-TestBot')
    assert.ok(st.maxTokens >= 2000)
    assert.equal(st.maxTokensOk, true)
    assert.doesNotMatch(st.pilot, /astra/i)
    assert.doesNotMatch(st.effective, /astra/i)
  })

  it('config DeepSeek explicite gardee, profil inactif, rien ne pretend Muse', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: DEEPSEEK })
    assert.equal(planner.MODEL, DEEPSEEK)
    const st = planner.profileStatus()
    assert.equal(st.enabled, false)
    assert.equal(st.configured, DEEPSEEK)
    assert.equal(st.effective, DEEPSEEK)
    mockLlm(async () => okPlan())
    const events = []
    const off = planner.onProfileEvent(e => events.push(e))
    try {
      await planner.plan({ consigne: 't' }, 'recolte', 'harvest')
    } finally { off() }
    assert.equal(seen.length, 1)
    assert.equal(seen[0].options.model, DEEPSEEK)
    assert.deepEqual(events, [])
    assert.equal(planner.profileStatus().fallbackActive, false)
  })
})

describe('profil pilote : Muse responses succes et repli', () => {
  it('Muse responses succes : protocole responses, un seul appel', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: undefined })
    mockLlm(async () => okPlan())
    const res = await planner.plan({ consigne: 't' }, 'recolte', 'harvest')
    assert.ok(res.steps.length >= 1)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].options.model, MUSE)
    assert.equal(seen[0].options.protocol, 'responses')
    assert.equal(planner.profileStatus().fallbackActive, false)
  })

  it('indispo Muse -> DeepSeek, repli declare via callback et etat', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: undefined })
    mockLlm(async (s, u, o) => {
      if (o.model === MUSE) throw new Error('HTTP 503 : Endpoint is unavailable')
      return okPlan()
    })
    const events = []
    const off = planner.onProfileEvent(e => events.push(e))
    let res
    try {
      res = await planner.plan({ consigne: 't' }, 'recolte', 'harvest')
    } finally { off() }
    assert.ok(res.steps.length >= 1)
    assert.equal(seen.length, 2)
    assert.equal(seen[0].options.model, MUSE)
    assert.equal(seen[1].options.model, DEEPSEEK)
    assert.equal(seen[1].options.protocol, 'chat')
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'fallback')
    assert.equal(events[0].from, MUSE)
    assert.equal(events[0].to, DEEPSEEK)
    const st = planner.profileStatus()
    assert.equal(st.fallbackActive, true)
    assert.equal(st.effective, DEEPSEEK)
    assert.match(String(st.reason), /503/)
    // Statut public sans secret.
    assert.doesNotMatch(JSON.stringify(st), /oc_sk|apikey|Bearer/i)
    // Miroir dans stats pour /api/status.planner (sans modifier index.js).
    assert.equal(planner.stats.repli_actif, true)
    assert.equal(planner.stats.modele_effectif, DEEPSEEK)
    assert.equal(planner.stats.modele_configure, MUSE)
  })

  it('cooldown expire : reprise Muse sur sondage normal, un seul appel', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: undefined })
    mockLlm(async (s, u, o) => {
      if (o.model === MUSE) throw new Error('HTTP 503 : Endpoint is unavailable')
      return okPlan()
    })
    await planner.plan({ consigne: 't' }, 'recolte', 'harvest')
    assert.equal(planner.profileStatus().fallbackActive, true)
    // Fin du cooldown : le prochain appel normal re-sonde le pilote.
    planner._profile.nextRetryAt = Date.now() - 1
    const events = []
    const off = planner.onProfileEvent(e => events.push(e))
    mockLlm(async () => okPlan())
    try {
      await planner.plan({ consigne: 't' }, 'recolte', 'harvest')
    } finally { off() }
    assert.equal(seen.length, 1)
    assert.equal(seen[0].options.model, MUSE)
    assert.equal(planner.profileStatus().fallbackActive, false)
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'recovery')
    assert.equal(events[0].to, MUSE)
  })
})

describe('profil pilote : pas de repli hors disponibilite', () => {
  it('abort : aucun fallback, un seul appel', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: undefined })
    mockLlm(async () => { throw new Error('appel annule') })
    const events = []
    const off = planner.onProfileEvent(e => events.push(e))
    const c = new AbortController()
    c.abort()
    try {
      await assert.rejects(planner.plan({ consigne: 't' }, 'recolte', 'harvest', {}, null, { signal: c.signal }), /annule/)
    } finally { off() }
    assert.equal(seen.length, 1)
    assert.equal(seen[0].options.model, MUSE)
    assert.deepEqual(events, [])
    assert.equal(planner.profileStatus().fallbackActive, false)
  })

  it('mauvais JSON : pas de remplacement d objectif, pas de repli', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: undefined })
    mockLlm(async () => ({ content: 'pas du json du tout', usage: null, ms: 1 }))
    const events = []
    const off = planner.onProfileEvent(e => events.push(e))
    try {
      await assert.rejects(planner.plan({ consigne: 't' }, 'recolte', 'harvest'), /illisible/)
      assert.equal(seen.length, 1)
      assert.deepEqual(events, [])
      assert.equal(planner.profileStatus().fallbackActive, false)
      // readBrief : un JSON illisible leve, ne rend aucun objectif de remplacement.
      seen = []
      await assert.rejects(planner.readBrief('casse du bois'), /illisible/)
      assert.equal(seen.length, 1)
      assert.equal(planner.profileStatus().fallbackActive, false)
    } finally { off() }
  })
})

describe('profil pilote : helper unique sur tous les points d appel', () => {
  it('classify/brief/conversation/compaction visent Muse en responses', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: undefined })
    mockLlm(async (s, u, o) => {
      if (o.model !== MUSE) throw new Error('pas le pilote')
      // Reponse adaptee a l appelant, lue dans le prompt systeme.
      if (String(s).includes('routes le chat')) return { content: '{"commande":"mission","confiance":0.9}', usage: null, ms: 1 }
      if (String(s).includes('lis l objectif')) return { content: '{"type":"recolte","matiere":"herbe","repere":"ici","porte":0,"confiance":0.9,"parcours":null,"degagement":0,"livraison":false,"recherche_web":false}', usage: null, ms: 1 }
      if (String(s).includes('interpretes chaque phrase')) return { content: '{"relation":"question","objective":"","response":"oui","clearanceBlocks":null}', usage: null, ms: 1 }
      return { content: 'resume bref', usage: null, ms: 1 }
    })
    await planner.classify('bonjour')
    await planner.readBrief('ramasse de l herbe')
    await planner.interpretMessage('que fais-tu ?', {})
    await planner.compact('note de travail')
    assert.equal(seen.length, 4)
    for (const call of seen) {
      assert.equal(call.options.model, MUSE)
      assert.equal(call.options.protocol, 'responses')
    }
    assert.equal(planner.profileStatus().fallbackActive, false)
  })
})

describe('profil pilote : budget distinct et reessai troncature (D37 live)', () => {
  it('budgets distincts : pilote 4096, DeepSeek 2000, statut sans secret', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: undefined })
    assert.equal(planner.PILOT_EFFECTIVE_MAX_TOKENS, 4096)
    assert.equal(planner.PILOT_RETRY_EFFECTIVE_MAX_TOKENS, 8192)
    assert.equal(planner.EFFECTIVE_MAX_TOKENS, 2000)
    const st = planner.profileStatus()
    assert.equal(st.pilotMaxTokens, 4096)
    assert.equal(st.pilotRetryMaxTokens, 8192)
    assert.equal(st.deepseekMaxTokens, 2000)
    assert.doesNotMatch(JSON.stringify(st), /oc_sk|apikey|Bearer/i)
  })

  it('troncature pilote -> UN reessai elargi, meme delai, annonce et tentatives comptees', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: undefined })
    const t0 = planner.stats.tentatives
    const trunc0 = planner.stats.troncatures
    const retry0 = planner.stats.reessais
    mockLlm(async (s, u, o) => {
      if (o.model === MUSE && seen.length === 1) throw new Error('reponse incomplete (max_output_tokens)')
      return okPlan()
    })
    const events = []
    const off = planner.onProfileEvent(e => events.push(e))
    let res
    try {
      res = await planner.plan({ consigne: 't' }, 'recolte', 'harvest')
    } finally { off() }
    assert.ok(res.steps.length >= 1)
    assert.equal(seen.length, 2)
    assert.equal(seen[0].options.model, MUSE)
    assert.equal(seen[1].options.model, MUSE)
    // Budget elargi au reessai, delai strict inchange.
    assert.ok(seen[0].options.maxTokens >= 4096)
    assert.equal(seen[1].options.maxTokens, 8192)
    assert.equal(seen[1].options.timeoutMs, seen[0].options.timeoutMs)
    assert.equal(seen[1].options.protocol, 'responses')
    // Annonce + stats : toutes les tentatives comptent.
    assert.equal(events.filter(e => e.type === 'truncation-retry').length, 1)
    assert.equal(planner.stats.tentatives, t0 + 2)
    assert.equal(planner.stats.troncatures, trunc0 + 1)
    assert.equal(planner.stats.reessais, retry0 + 1)
    assert.equal(planner.profileStatus().fallbackActive, false)
    assert.equal(planner.profileStatus().troncatures, trunc0 + 1)
  })

  it('troncature persistante a 8192 -> repli DeepSeek annonce', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: undefined })
    mockLlm(async (s, u, o) => {
      if (o.model === MUSE) throw new Error('reponse incomplete (max_output_tokens)')
      return okPlan()
    })
    const events = []
    const off = planner.onProfileEvent(e => events.push(e))
    let res
    try {
      res = await planner.plan({ consigne: 't' }, 'recolte', 'harvest')
    } finally { off() }
    assert.ok(res.steps.length >= 1)
    assert.equal(seen.length, 3)
    assert.equal(seen[0].options.model, MUSE)
    assert.equal(seen[1].options.model, MUSE)
    assert.equal(seen[2].options.model, DEEPSEEK)
    assert.equal(seen[2].options.protocol, 'chat')
    assert.equal(seen[2].options.maxTokens, 2000)
    assert.ok(events.some(e => e.type === 'truncation-retry'))
    assert.ok(events.some(e => e.type === 'fallback'))
    assert.equal(planner.profileStatus().fallbackActive, true)
  })

  it('timeout pilote : pas de reessai budget, repli direct delai strict', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: undefined })
    mockLlm(async (s, u, o) => {
      if (o.model === MUSE) {
        const err = new Error('pas de reponse en 12000 ms')
        err.code = 'LLM_TIMEOUT'
        throw err
      }
      return okPlan()
    })
    const events = []
    const off = planner.onProfileEvent(e => events.push(e))
    try {
      await planner.plan({ consigne: 't' }, 'recolte', 'harvest')
    } finally { off() }
    assert.equal(seen.length, 2)
    assert.equal(events.filter(e => e.type === 'truncation-retry').length, 0)
    assert.equal(events.filter(e => e.type === 'fallback').length, 1)
  })

  it('readBrief fabrication : brut transmis, quantite bornee, sans repli', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: undefined })
    mockLlm(async () => ({
      content: '{"type":"recolte","matiere":"bois","repere":"ici","porte":0,"confiance":0.9,"parcours":null,"degagement":0,"livraison":false,"recherche_web":false,"fabrication":"hache","fabrication_quantite":1}',
      usage: null,
      ms: 1
    }))
    const brief = await planner.readBrief('fabrique une hache')
    assert.equal(brief.fabrication, 'hache')
    assert.equal(brief.fabricationQuantite, 1)
    assert.equal(brief.kind, 'recolte')
    assert.equal(seen.length, 1)
    assert.equal(planner.profileStatus().fallbackActive, false)
  })
})

describe('reaiguillage de session sur refus du fournisseur', () => {
  function upstream400 () {
    const err = new Error('HTTP 400 : {"error":{"type":"server_error","message":"Upstream request failed: Invalid request parameters. Please check your input and try again."}}')
    err.code = 'LLM_HTTP'
    err.status = 400
    return err
  }
  it('400 upstream persistant : nouvelle session x-opencode-session, puis succes', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: DEEPSEEK })
    mockLlm(async (s, u, o) => {
      if (o.headers['x-opencode-session'] === 'minecraft-bot-TestBot') throw upstream400()
      return okPlan()
    })
    const res = await planner.plan({ consigne: 't' }, 'recolte', 'harvest')
    assert.ok(res)
    assert.equal(seen.at(-1).options.headers['x-opencode-session'], 'minecraft-bot-TestBot-r1')
    assert.equal(planner.profileStatus().session, 'minecraft-bot-TestBot-r1')
    // La session reste la nouvelle pour les appels suivants.
    await planner.plan({ consigne: 't2' }, 'recolte', 'harvest')
    assert.equal(seen.at(-1).options.headers['x-opencode-session'], 'minecraft-bot-TestBot-r1')
  })
  it('trois reaiguillages au plus, puis l erreur remonte', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: DEEPSEEK })
    mockLlm(async () => { throw upstream400() })
    for (let i = 0; i < 3; i++) {
      await assert.rejects(planner.plan({ consigne: 't' }, 'recolte', 'harvest'))
    }
    await assert.rejects(planner.plan({ consigne: 't' }, 'recolte', 'harvest'))
    assert.equal(planner.profileStatus().session, 'minecraft-bot-TestBot-r3')
  })
  it('un autre 400 (pas upstream) ne change pas de session', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: DEEPSEEK })
    mockLlm(async () => { const e = new Error('HTTP 400 : bad json'); e.code = 'LLM_HTTP'; e.status = 400; throw e })
    await assert.rejects(planner.plan({ consigne: 't' }, 'recolte', 'harvest'))
    assert.equal(planner.profileStatus().session, 'minecraft-bot-TestBot')
  })
})
