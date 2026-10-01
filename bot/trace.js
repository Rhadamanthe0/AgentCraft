'use strict'

// Trace structuree d une mission : une suite d evenements (plan demande,
// etape jouee, blocage, fin) avec leurs mesures, au lieu de lignes de journal
// a relire par expressions regulieres. Le banc l ecrit en JSONL a cote de
// report.json et en agrege les echecs par action et par code.
//
// Evenements (champ `type`) :
//   plan    { ms, etapes, rejetees, fini }
//   etape   { action, params, ms, echec, code, sans_effet, remedes, de, a }
//   blocage { raison }
//   fin     { etat, raison }
// Chaque evenement porte `t`, en millisecondes depuis le debut de la trace.

function arrondi (p) {
  return p ? { x: Number(p.x.toFixed(1)), y: Number(p.y.toFixed(1)), z: Number(p.z.toFixed(1)) } : null
}

function createTrace ({ max = 600, now = () => Date.now() } = {}) {
  const debut = now()
  const evenements = []
  let perdus = 0
  return {
    push (evenement) {
      evenements.push({ t: now() - debut, ...evenement })
      if (evenements.length > max) {
        evenements.shift()
        perdus += 1
      }
    },
    evenements: () => evenements.slice(),
    perdus: () => perdus,
    resume: () => resumer(evenements)
  }
}

// Par action : nombre, echecs, gestes sans effet, duree totale ; par code
// d echec : nombre ; plans : nombre et duree.
function resumer (evenements) {
  const parAction = {}
  const parCode = {}
  let plans = 0
  let planMs = 0
  for (const e of evenements) {
    if (e.type === 'plan') {
      plans += 1
      planMs += e.ms ?? 0
    }
    if (e.type !== 'etape') continue
    const a = parAction[e.action] ?? (parAction[e.action] = { n: 0, echecs: 0, sansEffet: 0, ms: 0 })
    a.n += 1
    a.ms += e.ms ?? 0
    if (e.echec) a.echecs += 1
    if (e.sans_effet) a.sansEffet += 1
    if (e.echec && e.code) parCode[e.code] = (parCode[e.code] ?? 0) + 1
  }
  return { plans, planMs, parAction, parCode }
}

module.exports = { createTrace, resumer, arrondi }
