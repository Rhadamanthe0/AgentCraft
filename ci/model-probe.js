'use strict'
// Sonde des modeles candidats (demande du proprietaire, 2026-09-26) : pour
// chaque entree de chaine, 3 plans de recolte, 3 messages de chat et une
// lecture d objectif avec les VRAIS prompts du planificateur, sans le jeu.
// Mesure latence et validite (reponse acceptee par planner.validate / par
// interpretMessage). Un processus par modele (le planificateur est un
// singleton), tous en parallele. Imprime un JSON sur stdout.
//
//   node ci/model-probe.js                     (liste CI_PROBE_MODELS ou defaut)
//   node ci/model-probe.js --one <entree>      (processus enfant, un modele)
const { spawn } = require('node:child_process')
const path = require('node:path')

// Face-a-face actions/chat (2026-09-26) : meme effort (PLANNER_REASONING_EFFORT_*
// du banc), jetons de raisonnement et acceptation du champ effort mesures.
// A/B Claude Haiku 5.5 (2026-10-09) : meme face-a-face, meme effort.
const DEFAULT = ['deepseek-v4.1-flash', 'claude-haiku-5-5']
const RUNS = Number(process.env.CI_PROBE_RUNS || 8)
// Lecture d objectif (usage BRIEF) : modele:effort compares sur de vrais
// ordres du banc (2026-09-27 : muse high, p50 17,8 s, p95 45 s, 3 delais de
// 60 s sur 64 au banc a685869).
// Mesure faite (c4c1501 : muse high 33,8 s, medium 20,8 s, low 17,8 s, deepseek
// high 6,2 s de mediane) : vide par defaut, CI_PROBE_BRIEFS pour la refaire.
const BRIEF_DEFAULT = []
// Trois ordres : au pire 3 x 60 s, sous le plafond de la sonde (compose run 300 s).
const BRIEF_ORDERS = ['Va sous l arbre', 'Fabrique une pioche en pierre', 'Coupe moi un arbre et rapporte moi le bois']

const STATE = {
  consigne: { objectif: 'coupe moi un arbre', type: 'recolte', matiere: 'bois', arbre_entier: true },
  progression: { blocs_casses: 1, objets_recoltes: 1, quota: null },
  arbre_demande: { buches_debout: 4, bois_au_sol: 1 },
  inventaire: { oak_log: 1 },
  environnement: {
    bloc_cible: { nom: 'oak_log', position: { x: 12, y: 201, z: 7 }, distance: 4.6, a_portee: false, hauteur_relative: 1 },
    navigation: { angle: 35, distance_horizontale: 4.1 },
    objets_au_sol: [{ nom: 'oak_log', distance: 2.3 }]
  },
  dernieres_etapes: [{ action: 'casser', resultat: '1 bloc(s) casse(s) : oak_log' }]
}
const CHAT = [
  ['coupe moi un arbre', {}],
  ['stop', { mission_active: 'coupe moi un arbre' }],
  ['tu en es ou ?', { mission_active: 'coupe moi un arbre' }]
]

async function one (entry) {
  // Les journaux du planificateur vont sur stderr : stdout porte le seul JSON.
  console.log = (...a) => console.error(...a)
  Object.assign(process.env, {
    PLANNER_MODEL: entry, PLANNER_MODEL_PLAN: '', PLANNER_MODEL_BRIEF: '', PLANNER_MODEL_CHAT: '', PLANNER_MODEL_COMPACT: '',
    PLANNER_TIMEOUT_MS: '30000', PLANNER_WARMUP_TIMEOUT_MS: '30000', BOT_USERNAME: 'ProbeModel',
    // Mesure du modele, pas du repli de cle : la cle secondaire d abord.
    PLANNER_KEY_FIRST: process.env.OPENCODE_SECONDARY_API_KEY ? 'secondary' : 'primary'
  })
  // Espion du transport : effort envoye, refus 400, jetons de raisonnement.
  const llm = require(path.join(__dirname, '..', 'bot', 'llm'))
  const real = llm.call
  let wire = []
  llm.call = async (system, user, o = {}) => {
    const effort = o.reasoningEffort ?? o.reasoning?.effort ?? null
    try {
      const r = await real(system, user, o)
      const u = r.usage ?? {}
      wire.push({ effort, ok: true, reasoning: u.completion_tokens_details?.reasoning_tokens ?? u.output_tokens_details?.reasoning_tokens ?? null, output: u.completion_tokens ?? u.output_tokens ?? null })
      return r
    } catch (err) { wire.push({ effort, ok: false, status: err?.status ?? null }); throw err }
  }
  const planner = require(path.join(__dirname, '..', 'bot', 'planner'))
  const out = { model: entry, plan: [], chat: [], brief: null }
  const timed = async (fn) => {
    const t = Date.now()
    wire = []
    try { const v = await fn(); return { ok: true, ms: Date.now() - t, wire, ...v } } catch (err) {
      return { ok: false, ms: Date.now() - t, wire, error: String(err?.message ?? err).slice(0, 200) }
    }
  }
  for (let i = 0; i < RUNS; i++) {
    out.plan.push(await timed(async () => {
      const r = await planner.plan(STATE, 'recolte', 'harvest')
      return { steps: (r?.steps ?? []).map(s => s.action) }
    }))
  }
  for (const [message, context] of [...CHAT, ...CHAT, ...CHAT].slice(0, Math.max(3, RUNS))) {
    out.chat.push(await timed(async () => {
      const r = await planner.interpretMessage(message, context)
      return { message, relation: r?.relation ?? null }
    }))
  }
  out.brief = await timed(async () => {
    const r = await planner.readBrief('Construis une maison en terre de 3 par 3 par 3 a cote de l arbre')
    return { brief: JSON.stringify(r ?? null).slice(0, 160) }
  })
  out.servedBy = planner.stats?.modele_servi ?? null
  return out
}

async function briefOnly (spec) {
  console.log = (...a) => console.error(...a)
  const [model, effort] = spec.split(':')
  Object.assign(process.env, {
    PLANNER_MODEL: model, PLANNER_MODEL_BRIEF: model, PLANNER_REASONING_EFFORT_BRIEF: effort || '',
    PLANNER_TIMEOUT_MS_BRIEF: '60000', PLANNER_WARMUP_TIMEOUT_MS: '60000', BOT_USERNAME: 'ProbeBrief',
    PLANNER_KEY_FIRST: process.env.OPENCODE_SECONDARY_API_KEY ? 'secondary' : 'primary'
  })
  const planner = require(path.join(__dirname, '..', 'bot', 'planner'))
  const rows = []
  for (const order of BRIEF_ORDERS) {
    const t = Date.now()
    try {
      const r = await planner.readBrief(order)
      rows.push({ order, ok: true, ms: Date.now() - t, brief: JSON.stringify(r ?? null).slice(0, 200) })
    } catch (err) {
      rows.push({ order, ok: false, ms: Date.now() - t, error: String(err?.message ?? err).slice(0, 160) })
    }
  }
  const ms = rows.map(r => r.ms).sort((a, b) => a - b)
  return { briefProbe: spec, ok: rows.filter(r => r.ok).length, of: rows.length,
    medianMs: ms[Math.floor(ms.length / 2)], maxMs: ms[ms.length - 1], rows }
}

// Intelligence (demande du proprietaire, 2026-09-27) : reflexion (lecture
// d objectif) notee sur des cas connus,
// modele:effort par modele:effort (CI_PROBE_SMART). Un point par critere tenu.
// Tranche le 2026-09-27 (d1983b2) : deepseek-v4.1-flash high 25/27 et 4/4,
// muse high 23/27 et 4/4, 4-5x plus lent. Vide par defaut (la sonde muse
// allonge le banc de plusieurs minutes) ; CI_PROBE_SMART pour la refaire.
const SMART_DEFAULT = ['deepseek-v4.1-flash:high', 'claude-haiku-5-5:high']
const has = (route, type) => Array.isArray(route) && route.some(s => s.type === type)
const BRIEF_CASES = [
  ['Va sous l arbre', b => [has(b.route, 'sous_arbre')]],
  ['Suis moi', b => [has(b.route, 'suivre')]],
  ['Fais deux allers-retours entre toi et moi', b => [(b.route || []).filter(s => s.type === 'rejoindre').length === 2, has(b.route, 'retour')]],
  ['Viens me voir, attends 3 secondes, puis retourne a ta place', b => [has(b.route, 'rejoindre'), (b.route || []).some(s => s.type === 'attendre' && s.secondes === 3), has(b.route, 'retour')]],
  ['Fabrique une pioche en pierre', b => [fab(b.fabrication) === 'stone_pickaxe', b.kind !== 'construction']],
  ['Fabrique un four', b => [fab(b.fabrication) === 'furnace']],
  ['Fabrique 3 torches', b => [fab(b.fabrication) === 'torch', b.fabricationQuantite === 3]],
  ['Coupe moi un arbre et rapporte moi le bois', b => [b.kind === 'recolte', b.resource === 'bois', b.needsTransfer === true]],
  ['Coupe un arbre', b => [b.kind === 'recolte', b.resource === 'bois', b.needsTransfer === false, !b.fabrication]],
  ['Ramasse 4 blocs de sable', b => [b.kind === 'recolte', b.resource === 'sable']],
  ['Construis une maison en terre de 5 par 5 a cote de l arbre avec une porte', b => [b.kind === 'construction', b.resource === 'terre', b.landmark === 'arbre', b.door === true]],
  ['Fabrique une porte en bois', b => [fab(b.fabrication) === 'oak_door' || /door|porte/.test(String(b.fabrication)), b.needsTransfer === false]]
]
function fab (raw) {
  const skills = require(path.join(__dirname, '..', 'bot', 'skills'))
  return raw ? skills.normalizeFabricationTarget(raw) : null
}
async function smartOnly (spec) {
  console.log = (...a) => console.error(...a)
  const [model, effort] = spec.split(':')
  Object.assign(process.env, {
    PLANNER_MODEL: model, PLANNER_MODEL_BRIEF: model, PLANNER_REASONING_EFFORT_BRIEF: effort || '',
    PLANNER_TIMEOUT_MS_BRIEF: '60000', PLANNER_WARMUP_TIMEOUT_MS: '60000',
    BOT_USERNAME: 'ProbeSmart', PLANNER_KEY_FIRST: process.env.OPENCODE_SECONDARY_API_KEY ? 'secondary' : 'primary'
  })
  const planner = require(path.join(__dirname, '..', 'bot', 'planner'))
  const brief = []
  let points = 0
  let total = 0
  for (const [order, check] of BRIEF_CASES) {
    const t = Date.now()
    let b = null
    let error = null
    try { b = await planner.readBrief(order) } catch (err) { error = String(err?.message ?? err).slice(0, 120) }
    const got = b ? check(b).map(Boolean) : [false]
    const n = b ? got.length : check({}).length
    points += got.filter(Boolean).length
    total += n
    brief.push({ order, ms: Date.now() - t, score: `${got.filter(Boolean).length}/${n}`, error,
      got: b && { route: b.route, kind: b.kind, resource: b.resource, landmark: b.landmark, door: b.door,
        needsTransfer: b.needsTransfer, fabrication: b.fabrication, fabricationQuantite: b.fabricationQuantite } })
  }
  const med = a => { const v = [...a].sort((x, y) => x - y); return v[Math.floor(v.length / 2)] }
  return { smartProbe: spec, briefScore: `${points}/${total}`, briefMedianMs: med(brief.map(x => x.ms)),
    briefMaxMs: Math.max(...brief.map(x => x.ms)), brief }
}

function summarize (r) {
  const agg = (rows) => {
    const ok = rows.filter(x => x.ok)
    const ms = ok.map(x => x.ms).sort((a, b) => a - b)
    const calls = rows.flatMap(x => x.wire ?? [])
    const served = calls.filter(c => c.ok)
    const med = (v) => { const a = v.filter(n => Number.isFinite(n)).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null }
    return {
      ok: ok.length, of: rows.length, medianMs: ms.length ? ms[Math.floor(ms.length / 2)] : null,
      error: rows.find(x => !x.ok)?.error ?? null,
      // Effort reellement porte par les appels servis, et refus 400 du champ.
      effortServed: [...new Set(served.map(c => c.effort))],
      refused400: calls.filter(c => !c.ok && c.status === 400).length,
      medianReasoningTokens: med(served.map(c => c.reasoning)),
      medianOutputTokens: med(served.map(c => c.output))
    }
  }
  return { model: r.model, plan: agg(r.plan), chat: agg(r.chat), brief: agg([r.brief]), detail: r }
}

async function main () {
  const at = process.argv.indexOf('--one')
  if (at > 0) {
    process.stdout.write(JSON.stringify(await one(process.argv[at + 1])))
    return
  }
  const smartAt = process.argv.indexOf('--smart')
  if (smartAt > 0) {
    process.stdout.write(JSON.stringify(await smartOnly(process.argv[smartAt + 1])))
    return
  }
  const briefAt = process.argv.indexOf('--brief')
  if (briefAt > 0) {
    process.stdout.write(JSON.stringify(await briefOnly(process.argv[briefAt + 1])))
    return
  }
  const models = String(process.env.CI_PROBE_MODELS || '').split(',').map(s => s.trim()).filter(Boolean)
  const list = models.length ? models : DEFAULT
  const briefs = String(process.env.CI_PROBE_BRIEFS ?? BRIEF_DEFAULT.join(',')).split(',').map(s => s.trim()).filter(Boolean)
  const smart = String(process.env.CI_PROBE_SMART ?? SMART_DEFAULT.join(',')).split(',').map(s => s.trim()).filter(Boolean)
  const jobs = [...list.map(entry => ['--one', entry]), ...briefs.map(spec => ['--brief', spec]),
    ...smart.map(spec => ['--smart', spec])]
  const results = await Promise.all(jobs.map(([flag, entry]) => new Promise(resolve => {
    const child = spawn(process.execPath, [__filename, flag, entry], { env: process.env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    // La sonde d intelligence enchaine 12 lectures d objectif (muse : ~20-35 s chacune).
    const kill = setTimeout(() => child.kill('SIGKILL'), flag === '--smart' ? 840000 : 240000)
    child.on('close', () => {
      clearTimeout(kill)
      try { const r = JSON.parse(stdout); resolve(flag === '--one' ? summarize(r) : r) } catch {
        resolve({ model: entry, error: (stderr || stdout).slice(-300) })
      }
    })
  })))
  process.stdout.write(JSON.stringify(results))
}

main().catch(err => { console.error(err); process.exit(1) })
