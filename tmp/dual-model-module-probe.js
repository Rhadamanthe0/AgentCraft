'use strict'
// Prepared only. Host wrapper substitutes the frozen status, no world connection.
const frozen = __FROZEN_STATUS__
process.env.MEMORY_FILE = '/tmp/dual-probe-unused-memory.json'
process.env.ACTIONS_DOC_FILE = '/tmp/dual-probe-unused-actions.json'
process.env.PLANNER_DEBUG = '0'
process.env.REPAIR_DEBUG = '0'
const planner = require('/app/planner')
const repair = require('/app/repair')
const routing = require('/app/model-routing')
if (!routing.isDual()) throw new Error('Deployed process is not configured for dual routing')
const state = {
  consigne: { texte: frozen.objectifs.current.texte, demandeur: 'Rhadamanthe0', type: 'recolte', matiere: 'bois', repere: 'ici', precisions: [], porte_demandee: false },
  quota_par_defaut: 16, quota_vise: 16,
  progression: { etapes_effectuees: frozen.mission.etapes, blocs_casses: frozen.mission.blocs_casses, objets_recoltes: frozen.mission.objets_recoltes, unites_recoltees: Math.max(frozen.mission.blocs_casses, frozen.mission.objets_recoltes), dirt_secondaire: 0 },
  bot: { position: frozen.position, vie: frozen.health, dans_liquide: false, en_deplacement: false },
  environnement: { bloc_cible_le_plus_proche: 'oak_log', distance_du_bloc_cible: 2.51, bloc_cible_a_portee: true,
    navigation: { cible: 'oak_log', distance: 0.24, a_portee: true },
    cible_haute: null, objets_au_sol_a_proximite: 0, navigation_objet: null, bloc_regarde: null,
    hache_recommandee: true, dirt_secondaire_admise: false, dirt_secondaire_cible: null, outil_necessaire: null, casse_productive: true },
  inventaire: { buches: frozen.inventory.buches, planches: frozen.inventory.planches, batons: frozen.inventory.batons, etablis: frozen.inventory.etablis, dirt_en_inventaire: 0,
    outils: frozen.inventory.outils, echafaudage: { total: frozen.inventory.planches, materiaux: [{ nom: 'oak_planks', quantite: frozen.inventory.planches }] } },
  dernieres_etapes: [], chat_recent: [], livraison: { engagements: [], blocage_don: null }, blocage: { detecte: false }
}
const blocked = structuredClone(state)
blocked.dernieres_etapes = [{ action: 'avancer', resultat: 'approche de oak_log impossible : no_path', code: 'no_path', echec: true }]
blocked.blocage = { detecte: true, raison: 'Repeated no_path observed before target visibility correction', reparations_restantes: 1, reparateur_disponible: true }
const proof = { at: new Date().toISOString(), disclaimer: 'Reconstructed state from paused live status and measured visible B(44,75,-106), not a historical captured live planner payload. Nominal versus blocked flags deliberately varied for routing. No bot/world connection, no applying repair suggestions.', state, cases: [] }
async function run (name, expectedModel, fn) {
  const before = routing.status()
  const start = Date.now()
  const record = { name, expectedModel }
  try { record.output = await fn() } catch (error) { record.error = { name: error.name, code: error.code, message: error.message } }
  record.latencyMs = Date.now() - start
  const after = routing.status()
  record.route = after.lastCompleted
  record.actualCalls = Object.values(after.byModel).reduce((n, m) => n + m.calls, 0) - Object.values(before.byModel).reduce((n, m) => n + m.calls, 0)
  record.transportCorrect = record.route?.model === expectedModel && record.route?.responseModel === expectedModel && record.route?.result === 'response'
  record.validatedModuleResult = !record.error && record.output != null && record.output.ok !== false
  proof.cases.push(record)
  console.log('PROBE_CASE ' + JSON.stringify(record))
}
async function main () {
  await run('plan_nominal', 'mimo-v2.6-flash', () => planner.plan(state, 'recolte', 'harvest'))
  await run('plan_blocked', 'muse-spark-1.3-contributor', () => planner.plan(blocked, 'recolte', 'harvest'))
  await run('readBrief', 'muse-spark-1.3-contributor', () => planner.readBrief(frozen.objectifs.current.texte))
  await run('repair.askForAction', 'muse-spark-1.3-contributor', () => repair.askForAction({ probleme: 'avancer repete no_path depuis le pilier alors qu une buche visible est a portee; conseiller une action productive sans changer arbre', kind: 'recolte', supply: 'harvest', etat: blocked, historique: blocked.dernieres_etapes }))
  proof.routing = routing.status()
  console.log('PROBE_FINAL ' + JSON.stringify(proof))
}
main().catch(error => { console.log('PROBE_FATAL ' + JSON.stringify({ name: error.name, message: error.message })); process.exitCode = 1 })
