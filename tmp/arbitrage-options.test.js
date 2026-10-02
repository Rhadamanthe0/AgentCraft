'use strict'

// Une demande qui en remplace une autre en cours (arbitrage « remplacement »,
// ARBITRATION_DEFAULT) garde ses options de demarrage. Vu au banc 25603d5 :
// skill/sand-walled lance pendant qu une mission du niveau precedent tournait
// encore ; le remplacement relancait l objectif sans son script, et le modele
// planifiait une mission qui devait etre jouee sans lui.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-'))
process.env.OBJECTIVES_FILE = path.join(dir, 'o.json')
process.env.OBJECTIVES_EVENTS_FILE = path.join(dir, 'e.jsonl')
const index = require('../bot/index')

test('remplacement automatique : la nouvelle mission demarre avec son script et son brief', async () => {
  const runner = index.missionRunner
  const vrais = { start: runner.start, stop: runner.stop }
  const demarrages = []
  runner.start = async (objective, requester, opts) => { demarrages.push({ objective, opts }); return { ok: true } }
  runner.stop = () => {}
  try {
    const premier = await index.startObjectiveDurable('Fabrique 4 torches', 'Alice')
    assert.equal(premier.ok, true)
    const script = [{ action: 'recolter', quantite: 4 }]
    const brief = { type: 'recolte', matiere: 'sable' }
    const second = await index.startObjectiveDurable('Ramasse 4 blocs de sable', 'Bob', { script, brief })
    assert.equal(second.replaced, true, JSON.stringify(second))
    await new Promise(resolve => setImmediate(resolve))
    const dernier = demarrages[demarrages.length - 1]
    assert.equal(dernier.objective, 'Ramasse 4 blocs de sable')
    assert.deepEqual(dernier.opts.script, script, 'le script survit au remplacement')
    assert.deepEqual(dernier.opts.brief, brief)
  } finally {
    runner.start = vrais.start
    runner.stop = vrais.stop
  }
})
