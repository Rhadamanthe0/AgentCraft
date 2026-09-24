'use strict'
// Harness ONLY: real API/runner/storage/Minecraft, deterministic planner double.
// Does not prove remote model comprehension. No harvest, movement or admin action.
require('/work/tmp/architecture-runtime-preload.js')
const fs = require('node:fs')
const planner = require('/src/planner.js')
const output = '/data/observed-plan.json'
const boot = new Date().toISOString()
let calls = 0
planner.warmup = async () => ({ ok: true, ms: 0, stub: true })
planner.readBrief = async () => ({
  route: null, clearanceLimit: 0, needsTransfer: false, needsWeb: false,
  fabrication: null, fabricationQuantite: null,
  kind: 'recolte', kindConfidence: 1, resource: 'sable', resourceConfidence: 1,
  resourceProbabilities: null, landmark: 'ici', landmarkConfidence: 1,
  door: false, doorProbability: 0, usage: null, ms: 0
})
planner.interpretMessage = async (message) => ({
  relation: String(message).startsWith('Precision test ') ? 'context' : 'question',
  objective: '', response: 'Precision de test recue.', mode: 'temporary'
})
planner.classify = async () => ({ command: 'aucune', actionable: false, confidence: 1 })
planner.compact = async () => { throw new Error('Compaction hors scenario deterministe') }
planner.plan = async (state, kind) => {
  calls++
  const observed = { limitation: 'deterministic planner double; no remote model validation',
    boot, calls, at: new Date().toISOString(), kind, consigne: state.consigne,
    progression: state.progression }
  fs.writeFileSync(output, JSON.stringify(observed, null, 2))
  fs.appendFileSync('/data/observed-plans.jsonl', JSON.stringify(observed) + '\n')
  return { steps: [{ action: 'attendre', scale: 1, scaleLevel: null, choices: { duree: 5 } }],
    rejected: [], finished: false, done: 0, seconds: 5, ms: 0,
    why: 'Harness deterministe : attente immobile seulement.' }
}
