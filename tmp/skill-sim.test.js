'use strict'

// Banc de competences hors ligne (tmp/skill-sim.js) : les niveaux skill/*
// rapides se jouent ici a chaque test unitaire, vrai A*, vraie physique, vraie
// mission scriptee, sans serveur ni modele. Chacun dans son processus : les
// interrupteurs d une variante (FEATURE_*) ne fuient pas dans le suivant.

const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const path = require('node:path')

function jouer (niveau, env = {}) {
  const out = execFileSync(process.execPath, [path.join(__dirname, 'skill-sim.js'), niveau, '--json'],
    { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] })
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

// Pilier de terre verdi pendant la coupe (banc d67a3cb, herbe en quelques
// secondes au serveur) : il reste le pilier du bot, defait et repris.
test('hors ligne : skill/tree-pillar, pilier devenu herbe', () => {
  let r
  try {
    r = jouer('skill/tree-pillar', { SIM_HERBE_MS: '500' })
  } catch (err) {
    r = JSON.parse(String(err.stdout).split('\n').filter(l => l.startsWith('{')).pop())
  }
  assert.equal(r.success, true, JSON.stringify({ checks: r.checks, mission: r.mission, logs: r.logs?.slice(-8) }))
})

test('hors ligne : un niveau qui fabrique reste au banc, dit', () => {
  const r = jouer('skill/cabin-batir')
  assert.equal(r.horsChamp, true)
})
