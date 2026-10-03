'use strict'

// R01+R23 : propriete physique exclusive + timeout.
//
// - R01 : aucun timeout ne libere le slot avant terminaison reelle. Le helper
//   partage `awaitPhysicalWithTimeout` (bot/executor.js) appelle l annulation
//   concrete (stopDigging, setGoal(null)...) puis ATTEND le settle reel avant
//   de rendre timeout/cancelled. `pose.withTimeout` et `tree-position.clearOne`
//   suivent la meme regle.
// - R23 : touches persistantes en lease explicite. `createControlLease`
//   (bot/executor.js, cable par bot/index.js et bot/api.js) : state=true
//   acquiert et TIENT le slot jusqu a state=false ; tant que le lease existe,
//   tout travail normal recoit busy.
//
// Chaque test ci-dessous ECHOUE sur le code anterieur (retour avant settle,
// slot libere tot, lease absent) et PASSE avec le correctif.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createExecutor, awaitPhysicalWithTimeout, createControlLease } = require('../bot/executor')
const pose = require('../bot/pose')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Operation lente realiste : settle naturel a +500 ms, mais l annulation
// concrete (stopDigging / setGoal(null)) la fait atterrir ~80 ms plus tard.
// L ancien Promise.race rendait a 20 ms SANS annuler : l operation vivait
// encore quand le slot etait deja rendu.
function operationLente ({ naturelMs = 500, settleApresCancelMs = 80 } = {}) {
  let timer = null
  let rejecter = null
  let settledAt = null
  let cancelAt = null
  const promise = new Promise((_, reject) => {
    rejecter = err => { settledAt = Date.now(); reject(err) }
    timer = setTimeout(() => rejecter(new Error('settle naturel (cancel jamais appele)')), naturelMs)
  })
  const cancel = () => {
    if (cancelAt !== null) return
    cancelAt = Date.now()
    clearTimeout(timer)
    setTimeout(() => rejecter(new Error('annulee puis settle reel')), settleApresCancelMs)
  }
  return { promise, cancel, temoins: () => ({ cancelAt, settledAt }) }
}

async function assertRefusal (promise, code) {
  await assert.rejects(promise, err => err && err.code === code, `refus ${code} attendu`)
}

// ---------------------------------------------------------------------------
// Test 1 (R01) : timeout court sur operation lente, seconde operation
// immediate => busy jusqu a la fin REELLE de la premiere.
// Couvre dig, placeBlock et goto (cancel distinct par type).
// ---------------------------------------------------------------------------
for (const type of ['dig', 'placeBlock', 'goto']) {
  test(`R01 ${type} : timeout n admet pas la suivante avant le settle reel`, async () => {
    const stops = []
    const ex = createExecutor({ stopControls: reason => { stops.push(reason) } })
    const op = operationLente()
    const t0 = Date.now()
    const premiere = ex.run({ id: `r01-${type}-1`, kind: 'work' }, async () => {
      const cancelParType = () => {
        if (type === 'dig') { /* stopDigging */ op.cancel() } else if (type === 'placeBlock') { /* clear controls */ op.cancel() } else { /* cancel pathfinder */ op.cancel() }
      }
      await awaitPhysicalWithTimeout(op.promise, 20, `${type} trop long`, { onTimeout: cancelParType })
      return 'jamais (timeout attendu)'
    })
    // Attend le latch du timeout (annulation appelee), pas une duree fixe :
    // robuste a la charge. Le settle (~+80 ms) est encore a venir.
    for (let i = 0; i < 400 && op.temoins().cancelAt === null; i++) await sleep(5)
    assert.ok(op.temoins().cancelAt !== null, `${type} : le timeout n a jamais latch`)
    assert.equal(op.temoins().settledAt, null, `${type} : settle deja survenu avant le controle busy`)
    assert.equal(ex.status().busy, true, `${type} : slot rendu avant le settle reel`)
    await assertRefusal(ex.run({ id: `r01-${type}-2`, kind: 'work' }, async () => 'chevauche'), 'busy')
    const enveloppe = await premiere
    assert.equal(enveloppe.outcome, 'failed')
    assert.match(enveloppe.error.message, new RegExp(`${type} trop long`))
    const { cancelAt, settledAt } = op.temoins()
    assert.ok(cancelAt !== null && cancelAt - t0 >= 15, `${type} : annulation concrete non appelee au timeout`)
    assert.ok(settledAt !== null && settledAt >= cancelAt, `${type} : retour avant le settle reel`)
    assert.equal(ex.status().busy, false)
    const suivante = await ex.run({ id: `r01-${type}-3`, kind: 'work' }, async () => `${type}-ok`)
    assert.equal(suivante.outcome, 'completed')
    assert.equal(suivante.value, `${type}-ok`)
  })
}

test('R01 pose.withTimeout : rejet APRES le settle, jamais avant', async () => {
  const op = operationLente({ naturelMs: 120, settleApresCancelMs: 120 })
  const t0 = Date.now()
  await assert.rejects(pose.withTimeout(op.promise, 20, 'visee trop longue'))
  const duree = Date.now() - t0
  assert.ok(duree >= 90, `pose.withTimeout a rendu a ${duree} ms alors que l operation ne settle qu a ~120 ms : liberation anticipee INTERDITE`)
})

// ---------------------------------------------------------------------------
// Test 2 (R23) : forward=true tient le slot (busy), forward=false libere.
// ---------------------------------------------------------------------------
test('R23 lease : forward=true => busy + touche active ; forward=false => libere', async () => {
  const ex = createExecutor({ stopControls: () => {} })
  const touches = []
  const lease = createControlLease({
    run: (id, kind, fn) => ex.run({ id, kind }, fn),
    stopNavigation: () => {},
    applyControl: (control, state) => { touches.push({ control, state }) },
    clearControls: () => {}
  })
  await lease.acquire('forward', 'r23-lease-1')
  assert.equal(ex.status().busy, true, 'lease forward=true doit tenir le slot')
  assert.ok(touches.some(t => t.control === 'forward' && t.state === true), 'forward doit etre actif')
  await assertRefusal(ex.run({ id: 'r23-travail', kind: 'work' }, async () => 'chevauche'), 'busy')
  await assert.rejects(lease.acquire('forward', 'r23-lease-2'), err => err && err.code === 'busy')
  assert.ok(!touches.some(t => t.control === 'forward' && t.state === false), 'forward coupe avant forward=false INTERDIT')
  await lease.release()
  assert.equal(ex.status().busy, false, 'forward=false doit liberer le slot')
  assert.ok(touches.some(t => t.control === 'forward' && t.state === false), 'forward doit etre relache')
  const admise = await ex.run({ id: 'r23-apres', kind: 'work' }, async () => 'admise')
  assert.equal(admise.outcome, 'completed')
  assert.equal(admise.value, 'admise')
})

// ---------------------------------------------------------------------------
// Test 3 : rescue (survie) + commande concurrente : aucune mutation simultanee.
// Le travail tient le slot ; la survie est refusee busy au lieu de chevaucher,
// puis s execute SEULE apres la vraie sortie (maxActive reste 1).
// ---------------------------------------------------------------------------
test('R01+R23 rescue : survie refusee busy pendant le travail, seule apres', async () => {
  const ex = createExecutor({ stopControls: () => {} })
  let active = 0
  let maxActive = 0
  const mutations = []
  const liberer = {}
  const travail = ex.run({ id: 'r01-travail-long', kind: 'work' }, async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    mutations.push('travail-debut')
    await new Promise(resolve => { liberer.go = resolve })
    mutations.push('travail-fin')
    active -= 1
    return 'travail-ok'
  })
  await sleep(10)
  await assertRefusal(ex.run({ id: 'rescue-concurrent', kind: 'survival' }, async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    mutations.push('rescue-pendant-travail')
    active -= 1
  }), 'busy')
  assert.deepEqual(mutations, ['travail-debut'], 'la survie a mute pendant le travail')
  liberer.go()
  const fini = await travail
  assert.equal(fini.outcome, 'completed')
  const secours = await ex.run({ id: 'rescue-apres', kind: 'survival' }, async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    mutations.push('rescue-seule')
    active -= 1
    return 'sauve'
  })
  assert.equal(secours.value, 'sauve')
  assert.equal(maxActive, 1, 'chevauchement physique')
  assert.deepEqual(mutations, ['travail-debut', 'travail-fin', 'rescue-seule'])
})

// ---------------------------------------------------------------------------
// Test 4 : vois pendant une operation occupee ne modifie pas yaw/pitch.
// Comportement : admission d abord ; si busy, purement observationnel.
// ---------------------------------------------------------------------------
test('R23 vois : refusee ou sans regard quand le slot est tenu', async () => {
  const ex = createExecutor({ stopControls: () => {} })
  const bot = { yaw: 1.0, pitch: 0.2, regards: 0, lookAt: async (yaw, pitch) => { bot.regards++; bot.yaw = yaw; bot.pitch = pitch } }
  const gate = {}
  const operation = ex.run({ id: 'r23-operation', kind: 'work' }, async () => {
    await new Promise(resolve => { gate.go = resolve })
    return 'occupee'
  })
  await sleep(10)
  // Meme contrat que HANDLERS.vois : admission avant tout lookAt.
  let admise = true
  try {
    await ex.run({ id: 'r23-vois', kind: 'work' }, async () => { await bot.lookAt(0, 0) })
  } catch (err) {
    admise = !(err && err.code === 'busy')
    assert.equal(err.code, 'busy')
  }
  assert.equal(admise, false, 'vois admise pendant une operation')
  assert.equal(bot.regards, 0, 'yaw/pitch modifies pendant une operation')
  assert.equal(bot.yaw, 1.0)
  gate.go()
  await operation
  await ex.run({ id: 'r23-vois-apres', kind: 'work' }, async () => { await bot.lookAt(0, 0) })
  assert.equal(bot.regards, 1, 'vois refusee alors que le slot est libre')
})

// ---------------------------------------------------------------------------
// Garde-fous de cablage : les mutations vivent DANS le slot, jamais hors-slot.
// ---------------------------------------------------------------------------
test('cablage : lease et rescue/survie passent par l executeur', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '../bot/index.js'), 'utf8')
  const apiSource = fs.readFileSync(path.join(__dirname, '../bot/api.js'), 'utf8')
  assert.ok(indexSource.includes('controlLease'), 'index.js : lease de touches absent')
  assert.ok(apiSource.includes('controlLease'), 'api.js : /api/control hors lease')
  // R03 : le slot survie passe par l adaptateur commun (runPhysicalOrThrow),
  // jamais d execution hors slot.
  assert.ok(indexSource.includes('runPhysical(`rescue-') || indexSource.includes('runPhysicalOrThrow(runPhysical, `rescue-'), 'rescue : mutations hors slot survival')
  // M3 : l admission ne s accorde jamais sur un controle illisible
  // (fail-closed) : une erreur sans code du status executeur propage
  // 'unavailable' au lieu d accorder.
  const admissionDebut = indexSource.indexOf('function requireAdmissionOrThrow')
  const admissionSource = indexSource.slice(admissionDebut, admissionDebut + 900)
  assert.ok(admissionSource.includes("'unavailable'"), 'admission : erreur sans code ignoree (fail-open)')
  // Le regard de vois n est admis qu apres le controle d admission.
  const voisDebut = indexSource.indexOf('vois (username)')
  const voisFin = indexSource.indexOf('async mission (username', voisDebut)
  const voisSource = indexSource.slice(voisDebut, voisFin === -1 ? voisDebut + 2000 : voisFin)
  assert.ok(voisSource.includes('requireAdmissionOrThrow'), 'vois : lookAt sans admission physique')
})
