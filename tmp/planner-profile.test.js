'use strict'

// Profil pilote (bot/planner.js) : Muse par defaut, SANS repli (2026-09-26).
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
    PLANNER_RELAUNCH_MS: process.env.PLANNER_RELAUNCH_MS,
    PLANNER_PILOT_MAX_TOKENS: process.env.PLANNER_PILOT_MAX_TOKENS,
    PLANNER_PILOT_RETRY_MAX_TOKENS: process.env.PLANNER_PILOT_RETRY_MAX_TOKENS,
    BOT_USERNAME: process.env.BOT_USERNAME
  }
  process.env.PLANNER_BASE_URL = GO_BASE
  process.env.PLANNER_SESSION_ID = 'minecraft-bot-TestBot'
  process.env.PLANNER_MAX_TOKENS = '2000'
  process.env.PLANNER_PILOT_MAX_TOKENS = '4096'
  process.env.PLANNER_PILOT_RETRY_MAX_TOKENS = '8192'
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
    // Without relaunch (PLANNER_RELAUNCH_MS=0) the caller's signal reaches the
    // transport as is; the relaunch path is covered by planner-relaunch.test.js.
    const planner = loadPlanner({ PLANNER_MODEL: DEEPSEEK, PLANNER_MAX_TOKENS: '4096', PLANNER_TIMEOUT_MS: '45000', PLANNER_RELAUNCH_MS: '0' })
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
    assert.ok(!('FALLBACK_MODEL' in planner), 'plus aucun modele de repli')
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
  })

  it('config DeepSeek explicite gardee, profil inactif, rien ne pretend Muse', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: DEEPSEEK })
    assert.equal(planner.MODEL, DEEPSEEK)
    const st = planner.profileStatus()
    assert.equal(st.enabled, false)
    assert.equal(st.configured, DEEPSEEK)
    assert.equal(st.effective, DEEPSEEK)
    mockLlm(async () => okPlan())
    await planner.plan({ consigne: 't' }, 'recolte', 'harvest')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].options.model, DEEPSEEK)
  })
})

describe('profil pilote : Muse responses', () => {
  it('Muse responses succes : protocole responses, un seul appel', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: undefined })
    mockLlm(async () => okPlan())
    const res = await planner.plan({ consigne: 't' }, 'recolte', 'harvest')
    assert.ok(res.steps.length >= 1)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].options.model, MUSE)
    assert.equal(seen[0].options.protocol, 'responses')
  })

})

describe('profil pilote : pas de repli hors disponibilite', () => {
  it('abort : aucun fallback, un seul appel', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: undefined })
    mockLlm(async () => { throw new Error('appel annule') })
    const c = new AbortController()
    c.abort()
    await assert.rejects(planner.plan({ consigne: 't' }, 'recolte', 'harvest', {}, null, { signal: c.signal }), /annule/)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].options.model, MUSE)
  })

  it('mauvais JSON : pas de remplacement d objectif, pas de repli', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: undefined })
    mockLlm(async () => ({ content: 'pas du json du tout', usage: null, ms: 1 }))
    await assert.rejects(planner.plan({ consigne: 't' }, 'recolte', 'harvest'), /illisible/)
    assert.equal(seen.length, 1)
    // readBrief : un JSON illisible leve, ne rend aucun objectif de remplacement.
    seen = []
    await assert.rejects(planner.readBrief('casse du bois'), /illisible/)
    assert.equal(seen.length, 1)
  })
})

describe('profil pilote : helper unique sur tous les points d appel', () => {
  it('brief/conversation/compaction visent Muse en responses', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: undefined })
    mockLlm(async (s, u, o) => {
      if (o.model !== MUSE) throw new Error('pas le pilote')
      // Reponse adaptee a l appelant, lue dans le prompt systeme.
      if (String(s).includes('lis l objectif')) return { content: '{"type":"recolte","matiere":"herbe","repere":"ici","porte":0,"confiance":0.9,"parcours":null,"degagement":0,"livraison":false,"recherche_web":false}', usage: null, ms: 1 }
      if (String(s).includes('interpretes chaque phrase')) return { content: '{"relation":"question","objective":"","response":"oui","clearanceBlocks":null}', usage: null, ms: 1 }
      return { content: 'resume bref', usage: null, ms: 1 }
    })
    await planner.readBrief('ramasse de l herbe')
    await planner.interpretMessage('que fais-tu ?', {})
    await planner.compact('note de travail')
    assert.equal(seen.length, 3)
    for (const call of seen) {
      assert.equal(call.options.model, MUSE)
      assert.equal(call.options.protocol, 'responses')
    }
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

  it('troncature pilote -> UN reessai elargi, meme delai, tentatives comptees', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: undefined })
    const t0 = planner.stats.tentatives
    const trunc0 = planner.stats.troncatures
    const retry0 = planner.stats.reessais
    mockLlm(async (s, u, o) => {
      if (o.model === MUSE && seen.length === 1) throw new Error('reponse incomplete (max_output_tokens)')
      return okPlan()
    })
    const res = await planner.plan({ consigne: 't' }, 'recolte', 'harvest')
    assert.ok(res.steps.length >= 1)
    assert.equal(seen.length, 2)
    assert.equal(seen[0].options.model, MUSE)
    assert.equal(seen[1].options.model, MUSE)
    // Budget elargi au reessai, delai strict inchange.
    assert.ok(seen[0].options.maxTokens >= 4096)
    assert.equal(seen[1].options.maxTokens, 8192)
    assert.equal(seen[1].options.timeoutMs, seen[0].options.timeoutMs)
    assert.equal(seen[1].options.protocol, 'responses')
    // Stats : toutes les tentatives comptent.
    assert.equal(planner.stats.tentatives, t0 + 2)
    assert.equal(planner.stats.troncatures, trunc0 + 1)
    assert.equal(planner.stats.reessais, retry0 + 1)
    assert.equal(planner.profileStatus().troncatures, trunc0 + 1)
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
    assert.deepEqual(brief.fabricationSuite, [])
  })

  it('readBrief fabrication : plusieurs objets, le premier est la cible, la suite gardee', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: undefined })
    mockLlm(async () => ({
      content: '{"type":"recolte","matiere":"pierre","repere":"ici","porte":0,"confiance":0.9,"parcours":null,"fabrication":["stone_pickaxe","stone_axe",null,"stone_sword"],"fabrication_quantite":null}',
      usage: null,
      ms: 1
    }))
    const brief = await planner.readBrief('fabrique-toi une pioche, une hache et une epee en pierre')
    assert.equal(brief.fabrication, 'stone_pickaxe')
    assert.deepEqual(brief.fabricationSuite, ['stone_axe', 'stone_sword'])
  })
})

describe('brief de geste : contrat complet ou geste libre explicite', () => {
  function brief (extra = {}) {
    return { content: JSON.stringify({ type: 'geste', matiere: 'aucune', repere: 'ici',
      parcours: null, ...extra }), usage: null, ms: 1 }
  }
  it('un geste sans parcours ni distinction explicite est refuse', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: DEEPSEEK })
    mockLlm(async () => brief())
    await assert.rejects(planner.readBrief('accompagne le joueur'), /brief de geste incomplet/)
    assert.equal(seen.length, 1, 'le seul rejeu appartient a mission.start')
  })
  it('un parcours continu reste continu, sans geste libre requis', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: DEEPSEEK })
    mockLlm(async () => brief({ parcours: [{ type: 'suivre' }] }))
    const result = await planner.readBrief('accompagne le joueur')
    assert.deepEqual(result.route, [{ type: 'suivre' }])
    assert.equal(seen.length, 1)
  })
  it('un geste non represente reste valide sur distinction explicite', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: DEEPSEEK })
    mockLlm(async () => brief({ geste_libre: true }))
    const result = await planner.readBrief('saute trois fois')
    assert.equal(result.route, null)
    assert.equal(result.kind, 'geste')
    assert.equal(seen.length, 1)
  })
  it('le type normalise impose aussi le contrat', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: DEEPSEEK })
    mockLlm(async () => brief({ type: ' GESTE ' }))
    await assert.rejects(planner.readBrief('accompagne le joueur'), /brief de geste incomplet/)
  })
  async function admission (objective, extra = {}, answers = null) {
    const planner = loadPlanner({ PLANNER_MODEL: DEEPSEEK })
    let reads = 0
    mockLlm(async () => { reads++; return brief(answers?.[Math.min(reads - 1, answers.length - 1)] ?? extra) })
    const missionPath = require.resolve('../bot/mission')
    delete require.cache[missionPath]
    const { createMissionRunner } = require('../bot/mission')
    const { Vec3 } = require('vec3')
    const bot = { entity: { position: new Vec3(0, 65, 0), yaw: 0, pitch: 0, onGround: true },
      registry: { blocksByName: {}, itemsByName: { wooden_axe: { id: 1, name: 'wooden_axe' } } },
      inventory: { items: () => [] }, players: {}, entities: {},
      findBlocks: () => [], findBlock: () => null, blockAt: () => null,
      clearControlStates () {}, setControlState () {} }
    const runner = createMissionRunner({ getBot: () => bot, isReady: () => true, inLiquid: () => false,
      stopPathfinding () {}, chat () {}, recentChat: () => [] })
    let plans = 0
    planner.plan = async () => { plans++; return { steps: [], rejected: [], finished: false, done: 0, ms: 0 } }
    try {
      const result = await runner.start(objective, 'human')
      return { result, status: runner.status(), reads, plans }
    } finally { runner.stop(); delete require.cache[missionPath] }
  }
  it('vrai brief mal type : fabrication valide atteint la recuperation mission', async () => {
    const f = await admission('fabrique une hache', { fabrication: 'hache' })
    assert.equal(f.result.ok, true)
    assert.equal(f.status.type, 'recolte')
    assert.equal(f.status.fabrication_cible, 'hache')
    assert.equal(f.reads, 1, 'une lecture recuperable ne consomme pas le rejeu')
  })
  it('vrai brief sans parcours : le placement sous arbre reste recuperable', async () => {
    const f = await admission('va sous un arbre')
    assert.equal(f.result.ok, true)
    assert.equal(f.status.parcours.steps[0].type, 'sous_arbre')
    assert.equal(f.reads, 1)
  })
  it('suivi sans contrat : deux lectures refusees, aucun plan execute', async () => {
    const f = await admission('suis-moi')
    assert.equal(f.result.ok, false)
    assert.match(f.result.error, /brief de geste incomplet/)
    assert.equal(f.reads, 2, 'le rejeu BRIEF unique est conserve')
    assert.equal(f.plans, 0)
  })
  it('le rejeu d un suivi incomplet peut recuperer son vrai contrat', async () => {
    const f = await admission('suis-moi', {}, [{}, { parcours: [{ type: 'suivre' }] }])
    assert.equal(f.result.ok, true)
    assert.equal(f.status.parcours.steps[0].type, 'suivre')
    assert.equal(f.reads, 2)
    assert.equal(f.plans, 0, 'un suivi utilise le contrat, jamais un micro-plan')
  })
  it('une valeur non booleenne ne contourne pas le contrat', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: DEEPSEEK })
    mockLlm(async () => brief({ geste_libre: 'true' }))
    await assert.rejects(planner.readBrief('tourne sur toi-meme'), /brief de geste incomplet/)
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
  it('six reaiguillages au plus, puis l erreur remonte', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: DEEPSEEK })
    mockLlm(async () => { throw upstream400() })
    for (let i = 0; i < 6; i++) {
      await assert.rejects(planner.plan({ consigne: 't' }, 'recolte', 'harvest'))
    }
    await assert.rejects(planner.plan({ consigne: 't' }, 'recolte', 'harvest'))
    assert.equal(planner.profileStatus().session, 'minecraft-bot-TestBot-r6')
  })
  it('delai depasse : l appel echoue, les suivants partent sur une nouvelle session', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: DEEPSEEK })
    mockLlm(async (s, u, o) => {
      if (o.headers['x-opencode-session'] === 'minecraft-bot-TestBot') {
        const e = new Error('pas de reponse en 20000 ms'); e.code = 'LLM_TIMEOUT'; throw e
      }
      return okPlan()
    })
    await assert.rejects(planner.plan({ consigne: 't' }, 'recolte', 'harvest'), /pas de reponse/)
    assert.equal(seen.length, 1, 'aucun rejeu dans le meme appel')
    assert.equal(planner.profileStatus().session, 'minecraft-bot-TestBot-r1')
    const res = await planner.plan({ consigne: 't2' }, 'recolte', 'harvest')
    assert.ok(res)
    assert.equal(seen.at(-1).options.headers['x-opencode-session'], 'minecraft-bot-TestBot-r1')
  })
  it('le plafond compte les reaiguillages SANS reponse entre eux, pas ceux de toute la vie du bot', async () => {
    // Bancs 2026-10-08 : les six reaiguillages etaient epuises en 3 a 20 min
    // sur 75 ; ensuite un bot restait sur une route muette (plans muets 11 a
    // 23 % contre 5 a 10 % avant, jusqu a 7 d affilee : mission perdue).
    const planner = loadPlanner({ PLANNER_MODEL: DEEPSEEK })
    let muet = true
    mockLlm(async () => {
      if (muet) { const e = new Error('pas de reponse en 20000 ms'); e.code = 'LLM_TIMEOUT'; throw e }
      return okPlan()
    })
    let avant = planner.profileStatus().session
    for (let i = 1; i <= 8; i++) {
      muet = true
      await assert.rejects(planner.plan({ consigne: 't' }, 'recolte', 'harvest'), /pas de reponse/)
      // Appel relance compris : un plan muet peut changer deux fois de session.
      assert.notEqual(planner.profileStatus().session, avant, `delai ${i} sans nouvelle session`)
      avant = planner.profileStatus().session
      muet = false
      assert.ok(await planner.plan({ consigne: 't' }, 'recolte', 'harvest'))
    }
  })
  it('un autre 400 (pas upstream) ne change pas de session', async () => {
    const planner = loadPlanner({ PLANNER_MODEL: DEEPSEEK })
    mockLlm(async () => { const e = new Error('HTTP 400 : bad json'); e.code = 'LLM_HTTP'; e.status = 400; throw e })
    await assert.rejects(planner.plan({ consigne: 't' }, 'recolte', 'harvest'))
    assert.equal(planner.profileStatus().session, 'minecraft-bot-TestBot')
  })
})

it('prompt par type de mission : regles bois et fabrication seulement si utiles', () => {
  process.env.PLANNER_BASE_URL = process.env.PLANNER_BASE_URL || 'http://x/v1'
  const p = require('../bot/planner')
  const tout = p.systemPrompt('recolte', 'harvest')
  const fleurs = p.systemPrompt('recolte', 'harvest', { bois: false, fabrication: false })
  const bois = p.systemPrompt('recolte', 'harvest', { bois: true, fabrication: false })
  const fab = p.systemPrompt('recolte', 'harvest', { bois: false, fabrication: true })
  const route = p.systemPrompt('deplacement', 'harvest', { bois: false, fabrication: false })
  assert.ok(fleurs.length < tout.length)
  assert.ok(!/arbre_demande/.test(fleurs) && /arbre_demande/.test(bois) && /arbre_demande/.test(tout))
  assert.ok(!/fabrication_cible non null/.test(bois) && /fabrication_cible non null/.test(fab))
  assert.ok(!/choisir_terrain avant toute pose/.test(route))
  assert.ok(!/\$\{/.test(tout + fleurs + bois + fab + route), 'gabarit non interprete')
})

it('plans longs (A/B plans_longs) : bornes du prompt et de la validation', () => {
  process.env.PLANNER_BASE_URL = process.env.PLANNER_BASE_URL || 'http://x/v1'
  const p = require('../bot/planner')
  const court = p.systemPrompt('recolte', 'harvest')
  const long = p.systemPrompt('recolte', 'harvest', null, true)
  assert.match(court, /de 1 a 5 actions/)
  assert.match(court, /entre 6 et 10 secondes/)
  assert.match(long, /de 1 a 10 actions/)
  assert.match(long, /entre 25 et 40 secondes/)
  assert.match(long, /quatre a huit actions/)
  // Deux prompts distincts en cache : le mode ne recycle pas le prompt court.
  assert.match(p.systemPrompt('recolte', 'harvest'), /de 1 a 5 actions/)
  const douze = { fini: 0, plan: Array.from({ length: 12 }, () => ({ action: 'sauter' })) }
  assert.equal(p.validate(douze, 'recolte', 'harvest').steps.length, 5)
  assert.equal(p.validate(douze, 'recolte', 'harvest', { long: true }).steps.length, 10)
})

it('prompt en anglais (A/B prompt_anglais) : meme vocabulaire, langue du joueur, cache distinct', async () => {
  const skills = require('../bot/skills')
  const en = require('../bot/prompt-en')
  // Une traduction par action, memes parametres et autant d exemples : une
  // action ou un exemple ajoute en francais sans sa traduction casse ici.
  for (const [name, spec] of Object.entries(skills.ACTIONS)) {
    const t = en.ACTIONS[name]
    assert.ok(t?.intent, `traduction manquante : ${name}`)
    const params = Object.keys(spec.params ?? {}).filter(k => spec.params[k].json)
    assert.deepEqual(Object.keys(t.params ?? {}).sort(), params.sort(), `parametres de ${name}`)
    const doc = skills.actionDoc(name)
    assert.equal((t.exemples ?? []).length, doc.exemples.length, `exemples de ${name}`)
    assert.equal((t.contre_exemples ?? []).length, doc.contre_exemples.length, `contre-exemples de ${name}`)
  }
  assert.deepEqual(Object.keys(en.ACTIONS).filter(n => !skills.ACTIONS[n]), [], 'traduction d une action retiree')

  const planner = loadPlanner({ PLANNER_MODEL: DEEPSEEK })
  const identifiants = t => new Set(t.match(/\b[a-z]+(?:[._][a-z0-9]+)+\b/g))
  const cas = [['recolte', null], ['recolte', { bois: true }], ['recolte', { fabrication: true }],
    ['construction', null], ['deplacement', { bois: false, fabrication: false }], ['geste', null]]
  for (const [kind, profil] of cas) {
    for (const long of [false, true]) {
      const fr = planner.systemPrompt(kind, 'harvest', profil, long)
      const anglais = planner.systemPrompt(kind, 'harvest', profil, long, 'en')
      // Chaque champ de l etat, action et objet nomme en francais l est aussi en anglais.
      const vus = identifiants(anglais)
      const manquants = [...identifiants(fr)].filter(x => !vus.has(x))
      assert.deepEqual(manquants, [], `${kind} ${JSON.stringify(profil)} long=${long}`)
      assert.match(anglais, /player's language, French by\s+default/)
      assert.doesNotMatch(anglais, /\$\{|quand : |ne pas : |Tu pilotes/)
      assert.match(fr, /^Tu pilotes un bot Minecraft/)
    }
  }
  // Les exemples de demandes et les textes dits au joueur restent en francais.
  const geste = planner.systemPrompt('geste', 'harvest', null, false, 'en')
  assert.match(geste, /consigne\.texte "tourne sur toi"/)
  assert.match(geste, /"texte":"oui, je te vois"/)
  assert.match(planner.systemPrompt('recolte', 'harvest', null, true, 'en'), /de 1 a 10|from 1 to 10 actions/)

  // plan() sert le prompt de la langue demandee, le francais par defaut.
  mockLlm(async () => okPlan())
  await planner.plan({ consigne: 't' }, 'recolte', 'harvest', {}, null, { langue: 'en' })
  await planner.plan({ consigne: 't' }, 'recolte', 'harvest')
  assert.match(seen[0].system, /^You drive a Minecraft bot/)
  assert.match(seen[1].system, /^Tu pilotes un bot Minecraft/)
})
