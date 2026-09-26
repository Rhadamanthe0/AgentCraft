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
const DEFAULT = ['deepseek-v4.1-flash@go2', 'glm-5.3-flash@go2']
const RUNS = Number(process.env.CI_PROBE_RUNS || 8)

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
    PLANNER_TIMEOUT_MS: '30000', PLANNER_WARMUP_TIMEOUT_MS: '30000', BOT_USERNAME: 'ProbeModel'
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
  const models = String(process.env.CI_PROBE_MODELS || '').split(',').map(s => s.trim()).filter(Boolean)
  const list = models.length ? models : DEFAULT
  const results = await Promise.all(list.map(entry => new Promise(resolve => {
    const child = spawn(process.execPath, [__filename, '--one', entry], { env: process.env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    const kill = setTimeout(() => child.kill('SIGKILL'), 240000)
    child.on('close', () => {
      clearTimeout(kill)
      try { resolve(summarize(JSON.parse(stdout))) } catch {
        resolve({ model: entry, error: (stderr || stdout).slice(-300) })
      }
    })
  })))
  process.stdout.write(JSON.stringify(results))
}

main().catch(err => { console.error(err); process.exit(1) })
