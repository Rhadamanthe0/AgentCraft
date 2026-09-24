'use strict'
// Preuves deterministes de la fondation executeur (aucun cablage mission/nav).
// Chaque test isole son executeur ; pas de timers aleatoires, seulement des
// promesses pilotees (deferred) et des micro-delais bornes.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createExecutor } = require('../bot/executor')

function deferred () {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const tick = (ms = 5) => new Promise(res => setTimeout(res, ms))

async function assertRefusal (promise, code) {
  await assert.rejects(promise, err => err && err.code === code, `attendu refus ${code}`)
}

test('concurrent : second run refuse busy, aucune chevauche', async () => {
  const ex = createExecutor({ stopControls: () => {} })
  let active = 0
  let maxActive = 0
  const gate = deferred()
  const p1 = ex.run({ id: 'w1', kind: 'work' }, async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await gate.promise
    active -= 1
    return 'w1-ok'
  })
  await tick()
  await assertRefusal(ex.run({ id: 'w2', kind: 'work' }, async () => 'w2'), 'busy')
  gate.resolve()
  const env = await p1
  assert.equal(env.outcome, 'completed')
  assert.equal(env.cancelled, false)
  assert.equal(env.value, 'w1-ok')
  assert.equal(maxActive, 1)
  assert.equal(ex.status().busy, false)
})

test('pauseWork annule travail, survie autorisee, travail refuse', async () => {
  const stops = []
  const ex = createExecutor({ stopControls: reason => { stops.push(reason) } })
  const gate = deferred()
  let seenSignal = null
  const pWork = ex.run({ id: 'w', kind: 'work' }, async ({ signal }) => {
    seenSignal = signal
    await gate.promise
    return 'tardif-mais-reel'
  })
  await tick()
  const st = ex.pauseWork('danger')
  assert.equal(st.paused, true)
  // stop synchrone des l arret : le signal est deja aborte au retour de pauseWork.
  assert.equal(seenSignal.aborted, true)
  assert.ok(stops.some(r => String(r).startsWith('pause:')))
  await assertRefusal(ex.run({ id: 'w-bis', kind: 'work' }, async () => 1), 'paused')
  gate.resolve() // vraie sortie du travail annule : la survie devient admissible
  const wEnv = await pWork
  assert.equal(wEnv.outcome, 'cancelled')
  const surv = await ex.run({ id: 's', kind: 'survival' }, async () => 'hors-danger')
  assert.equal(surv.outcome, 'completed')
  assert.equal(surv.value, 'hors-danger')
  await assertRefusal(ex.run({ id: 'w-ter', kind: 'work' }, async () => 1), 'paused')
})

test('pauseWork puis survie apres vraie sortie (pas de chevauchement)', async () => {
  const ex = createExecutor({ stopControls: () => {} })
  const order = []
  const gate = deferred()
  const pWork = ex.run({ id: 'w', kind: 'work' }, async ({ signal }) => {
    order.push('work-start')
    await gate.promise
    order.push(signal.aborted ? 'work-cancelled-exit' : 'work-exit')
    return 'w-valeur'
  })
  await tick()
  ex.pauseWork('danger')
  await assertRefusal(ex.run({ id: 's-tot', kind: 'survival' }, async () => 'trop-tot' ), 'busy')
  gate.resolve()
  const wEnv = await pWork
  assert.equal(wEnv.outcome, 'cancelled')
  assert.equal(wEnv.cancelled, true)
  assert.equal(wEnv.value, 'w-valeur') // valeur tardive preservee, pas jetee
  const sEnv = await ex.run({ id: 's', kind: 'survival' }, async () => {
    order.push('survival-run')
    return 'ok'
  })
  assert.equal(sEnv.outcome, 'completed')
  assert.deepEqual(order, ['work-start', 'work-cancelled-exit', 'survival-run'])
  await assertRefusal(ex.run({ id: 'w2', kind: 'work' }, async () => 1), 'paused')
  await assertRefusal(ex.run({ id: 't1', kind: 'trial' }, async () => 1), 'paused')
})

test('totalStop interdit meme survie, reprise seulement explicite', async () => {
  const ex = createExecutor({ stopControls: () => {} })
  const gate = deferred()
  const p = ex.run({ id: 'w', kind: 'work' }, async () => {
    await gate.promise
    return 1
  })
  await tick()
  ex.totalStop('urgence')
  gate.resolve()
  const env = await p
  assert.equal(env.outcome, 'cancelled')
  await assertRefusal(ex.run({ id: 's', kind: 'survival' }, async () => 1), 'stopped')
  await assertRefusal(ex.run({ id: 'w2', kind: 'work' }, async () => 1), 'stopped')
  await tick(20) // aucune reprise spontanee
  assert.equal(ex.status().stopped, true)
  assert.equal(ex.status().busy, false)
  ex.resume()
  assert.equal(ex.status().stopped, false)
  const after = await ex.run({ id: 'w3', kind: 'work' }, async () => 'reparti')
  assert.equal(after.outcome, 'completed')
  assert.equal(after.value, 'reparti')
})

test('signal externe deja annule refuse sans invoquer ; abort en vol annule', async () => {
  const ex = createExecutor({ stopControls: () => {} })
  const dead = new AbortController()
  dead.abort()
  let invoked = false
  await assertRefusal(
    ex.run({ id: 'x', kind: 'work', signal: dead.signal }, async () => { invoked = true }),
    'aborted'
  )
  assert.equal(invoked, false)
  assert.equal(ex.status().busy, false)

  const live = new AbortController()
  const stops = []
  const ex2 = createExecutor({ stopControls: r => { stops.push(r) } })
  const gate = deferred()
  const p = ex2.run({ id: 'y', kind: 'work', signal: live.signal }, async ({ signal }) => {
    await gate.promise
    return signal.aborted ? 'vu-abort' : 'pas-vu'
  })
  await tick()
  live.abort() // abort externe en vol : stop synchrone + abort interne
  assert.ok(stops.some(r => String(r).startsWith('external-abort:')))
  gate.resolve()
  const env = await p
  assert.equal(env.outcome, 'cancelled')
  assert.equal(env.value, 'vu-abort')
})

test('exception callback => envelope failed, slot libere, suite possible', async () => {
  const ex = createExecutor({ stopControls: () => {} })
  const boom = new Error('panne physique')
  const env = await ex.run({ id: 'bad', kind: 'work' }, async () => { throw boom })
  assert.equal(env.outcome, 'failed')
  assert.equal(env.cancelled, false)
  assert.equal(env.error, boom)
  assert.equal(ex.status().busy, false)
  const next = await ex.run({ id: 'ok', kind: 'work' }, async () => 42)
  assert.equal(next.outcome, 'completed')
  assert.equal(next.value, 42)
})

test('callback ignorant abort : slot tenu jusqu a resolution reelle, busy explicite', async () => {
  const ex = createExecutor({ stopControls: () => {} })
  let active = 0
  let maxActive = 0
  const release = deferred()
  const p1 = ex.run({ id: 'lourd', kind: 'work' }, async ({ signal }) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    // Ignore volontairement signal : simule une action physique sourde.
    await release.promise
    active -= 1
    return { status: 'succeeded', note: 'metier-opaque' }
  })
  await tick()
  ex.pauseWork('preemption-survie')
  // La survie veut preempter mais le travail n est pas sorti : refus busy, pas de chevauche.
  await assertRefusal(ex.run({ id: 's', kind: 'survival' }, async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    active -= 1
  }), 'busy')
  assert.equal(maxActive, 1)
  release.resolve() // seule la vraie sortie libere
  const env = await p1
  assert.equal(env.outcome, 'cancelled') // abort demande + sortie tardive
  assert.deepEqual(env.value, { status: 'succeeded', note: 'metier-opaque' }) // pas converti, pas jete
  assert.equal(ex.status().busy, false)
  const s = await ex.run({ id: 's2', kind: 'survival' }, async () => 'apres-vraie-sortie')
  assert.equal(s.outcome, 'completed')
  assert.equal(maxActive, 1)
})

test('stopControls qui jette + onEvent qui jette ne corrompent pas etat', async () => {
  const events = []
  const ex = createExecutor({
    stopControls: () => { throw new Error('frein hs') },
    onEvent: evt => {
      events.push(evt.type)
      if (evt.type === 'settled') throw new Error('listener hs')
    }
  })
  const gate = deferred()
  const p = ex.run({ id: 'w', kind: 'work' }, async () => {
    await gate.promise
    return 'ok'
  })
  await tick()
  const st = ex.pauseWork('test')
  assert.equal(st.paused, true) // pause appliquee malgre stopControls en erreur
  assert.ok(events.includes('stop-controls-error'))
  gate.resolve()
  const env = await p // settled a jete dans onEvent mais l enveloppe survit
  assert.equal(env.outcome, 'cancelled')
  assert.equal(env.value, 'ok')
  assert.equal(ex.status().busy, false)
  const s = await ex.run({ id: 's', kind: 'survival' }, async () => 'survie-ok')
  assert.equal(s.outcome, 'completed')
  ex.totalStop('fin')
  assert.equal(ex.status().stopped, true)
})

test('valeur metier opaque : pas de conversion auto succes => succes', async () => {
  const ex = createExecutor({ stopControls: () => {} })
  const business = { status: 'succeeded', blocs: 3 }
  const env = await ex.run({ id: 'b', kind: 'trial' }, async () => business)
  assert.equal(env.outcome, 'completed') // etat execution, distinct
  assert.equal(env.value, business) // meme reference, pas de copie ni conversion
  assert.equal(ex.status().last.outcome, 'completed')
  const unknown = await ex.run({ id: 'u', kind: 'trial' }, async () => ({ status: 'unknown' }))
  assert.equal(unknown.outcome, 'completed') // l executeur ne juge pas le metier
  assert.deepEqual(unknown.value, { status: 'unknown' })
})

test('signal malforme refuse invalid, slot jamais tenu, suite valide', async () => {
  const ex = createExecutor({ stopControls: () => {} })
  const badSignals = [
    'abort',
    42,
    true,
    { aborted: false }, // objet plain : annulation impossible
    { aborted: 'non' },
    { aborted: false, addEventListener: 'oui' },
    { aborted: false, addEventListener () {}, removeEventListener: 7 }
  ]
  for (const signal of badSignals) {
    let invoked = false
    await assertRefusal(
      ex.run({ id: 'bad', kind: 'work', signal }, async () => { invoked = true }),
      'invalid'
    )
    assert.equal(invoked, false)
    assert.equal(ex.status().busy, false)
    assert.equal(ex.status().current, null)
  }
  const ok = await ex.run({ id: 'apres', kind: 'work' }, async () => 'reparti')
  assert.equal(ok.outcome, 'completed')
  assert.equal(ok.value, 'reparti')
})

test('listener externe qui jette : rollback, busy faux, run suivant reussit', async () => {
  const ex = createExecutor({ stopControls: () => {} })
  // Repro auditeur : addEventListener jette APRES les controles d admission.
  const throwing = { aborted: false, addEventListener () { throw new Error('listener-hs') }, removeEventListener () {} }
  let invoked = false
  await assertRefusal(
    ex.run({ id: 'boom', kind: 'work', signal: throwing }, async () => { invoked = true }),
    'invalid'
  )
  assert.equal(invoked, false)
  assert.equal(ex.status().busy, false)
  assert.equal(ex.status().current, null)
  const ok = await ex.run({ id: 'valide', kind: 'work' }, async () => 7)
  assert.equal(ok.outcome, 'completed')
  assert.equal(ok.value, 7)

  // removeEventListener qui jette au cleanup : enveloppe intacte, slot libere.
  const ctl = new AbortController()
  const evilRemove = {
    get aborted () { return ctl.signal.aborted },
    addEventListener (...args) { return ctl.signal.addEventListener(...args) },
    removeEventListener () { throw new Error('remove-hs') }
  }
  const env = await ex.run({ id: 'evil', kind: 'work', signal: evilRemove }, async () => 'ok-malgre-remove')
  assert.equal(env.outcome, 'completed')
  assert.equal(env.value, 'ok-malgre-remove')
  assert.equal(ex.status().busy, false)
})
