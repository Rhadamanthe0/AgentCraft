'use strict'

// Banc de competences hors ligne (tmp/skill-sim.js) : les niveaux skill/*
// rapides se jouent ici a chaque test unitaire, vrai A*, vraie physique, vraie
// mission scriptee, sans serveur ni modele. Chacun dans son processus : les
// interrupteurs d une variante (FEATURE_*) ne fuient pas dans le suivant.
// skill/tree-pillar (~65 s) se joue a la demande :
//   NODE_PATH=$PWD/bot/node_modules node tmp/skill-sim.js skill/tree-pillar

const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const path = require('node:path')

function jouer (niveau) {
  const out = execFileSync(process.execPath, [path.join(__dirname, 'skill-sim.js'), niveau, '--json'],
    { env: process.env, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\n').filter(l => l.startsWith('{')).pop()
  return JSON.parse(out)
}

for (const niveau of ['skill/tree-reachable', 'skill/dirt-box', 'skill/sand-walled', 'skill/sand-walled~avec-acces_unifie', 'skill/hedge-pit', 'skill/coal-rock']) {
  test(`hors ligne : ${niveau}`, () => {
    let r
    try {
      r = jouer(niveau)
    } catch (err) {
      // Exit code 1 : niveau en echec, le JSON est sur stdout.
      r = JSON.parse(String(err.stdout).split('\n').filter(l => l.startsWith('{')).pop())
    }
    assert.equal(r.success, true, JSON.stringify({ checks: r.checks, mission: r.mission, logs: r.logs?.slice(-8) }))
  })
}

test('hors ligne : un niveau qui fabrique reste au banc, dit', () => {
  const r = jouer('skill/cabin-batir')
  assert.equal(r.horsChamp, true)
})
