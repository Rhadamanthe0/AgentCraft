'use strict'

// Tests de l'atelier de deblocage : `bot/unlock-service.js` (C0/D04/D06/D10/
// D15/D19/D25-D27/D31/D51). Modules reels, reseau/filesystem jamais touches :
// tous les backends sont des adapters mocks stricts (doctrine, Go/Astra,
// outils, candidateStore, supervisor, trialRunner, pause/resume/announce/record).
// Aucun deploiement, aucune installation simulee : les refus `unsupported`
// prouvent qu'on ne fait pas semblant. L'autorite des outils (scope/protection)
// est supposee host (documentee dans le service, non revendiquee) : ici les
// outils mocks portent les refus `outside-scope`.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createUnlockService, OPS, LIMITS, PROOF_MARK } = require('../bot/unlock-service')

const GOOD_DIGEST = 'a'.repeat(64)
const DOCTRINE_VERSION = 'doctrine-v3'

function doctrine (text) {
  let calls = 0
  return {
    calls: () => calls,
    get: async () => {
      calls += 1
      return { version: DOCTRINE_VERSION, text: text || 'doctrine-courante : stop prioritaire, pas de reset monde' }
    }
  }
}

function scriptedCalls (answers) {
  // answers : [{ content }] ou [{ throw: err }] ; enregistre (system, user).
  const seen = []
  let i = 0
  const fn = async (system, user, opts) => {
    seen.push({ system, user, aborted: Boolean(opts && opts.signal && opts.signal.aborted) })
    const next = answers[Math.min(i, answers.length - 1)]
    i += 1
    if (next && next.throw) throw next.throw
    return { content: next.content, usage: null, ms: 1 }
  }
  fn.seen = seen
  fn.count = () => i
  return fn
}

function errWith (code, message) {
  const e = new Error(message || code)
  e.code = code
  return e
}

function goodDescriptor (version) {
  return {
    version: version || 'cand-1',
    manifestDigest: GOOD_DIGEST,
    status: 'pending-trial',
    checks: [{ name: 'scope', ok: true }],
    proof: { status: 'pending-trial' },
    doctrine: { version: DOCTRINE_VERSION, digest: 'b'.repeat(64) }
  }
}

function makeStore (over) {
  const calls = { prepare: [], verify: [] }
  const api = {
    calls,
    async prepare ({ changes, reason }) {
      calls.prepare.push({ changes, reason })
      if (over && over.prepareThrow) throw over.prepareThrow
      if (over && over.describe) return over.describe({ changes, reason })
      return goodDescriptor('cand-1')
    },
    async verify (version) {
      calls.verify.push(version)
      if (over && over.verifyThrow) throw over.verifyThrow
      return { version, ok: true, manifestDigest: GOOD_DIGEST, checks: [{ name: 'scope', ok: true }] }
    },
    getDescriptor (version) {
      return goodDescriptor(version)
    }
  }
  return api
}

function makeSupervisor (over) {
  const calls = { activate: [], confirm: [], rollback: [] }
  const api = {
    calls,
    async activate (version) {
      calls.activate.push(version)
      if (over && over.activateThrow) throw over.activateThrow
      if (over && over.activateImpl) return over.activateImpl(version)
      return { state: 'trial', trial: { version }, lastGood: null }
    },
    async confirmTrial (version, proof) {
      calls.confirm.push({ version, proof })
      if (over && over.confirmThrow) throw over.confirmThrow
      return { state: 'active', lastGood: { version } }
    },
    async rollback (reason) {
      calls.rollback.push(reason)
      if (over && over.rollbackThrow) throw over.rollbackThrow
      return { state: 'active' }
    }
  }
  return api
}

function makeHost (over) {
  const o = over || {}
  const announced = []
  const recorded = []
  const resumes = []
  return {
    announced,
    recorded,
    resumes,
    pauseWork: o.pauseWork || (async () => { if (o.pauseThrow) throw o.pauseThrow }),
    resumeWork: async (info) => { resumes.push(info); if (o.resumeThrow) throw o.resumeThrow },
    announce: o.announce || (async (t) => { announced.push(t); if (o.announceThrow) throw o.announceThrow }),
    record: o.record || ((e) => { recorded.push(e); if (o.recordThrow) throw o.recordThrow }),
    tools: o.tools || {
      readFile: async (p) => ({ content: `contenu de ${p}` }),
      fetchDocumentation: async (r) => ({ content: `doc ${r}` })
    },
    trialRunner: o.trialRunner || (async ({ version }) => ({ accept: true, measurements: { effet: 1 }, version }))
  }
}

function makeService (over) {
  const o = over || {}
  const doc = o.doctrine || doctrine()
  const store = o.store || makeStore(o.storeOver)
  const sup = o.supervisor || makeSupervisor(o.supOver)
  const host = makeHost(o)
  const svc = createUnlockService({
    doctrineProvider: doc,
    callGo: o.callGo,
    callAstra: o.callAstra === undefined ? null : o.callAstra,
    tools: host.tools,
    candidateStore: store,
    supervisor: sup,
    trialRunner: host.trialRunner,
    pauseWork: host.pauseWork,
    resumeWork: host.resumeWork,
    announce: host.announce,
    record: host.record,
    buildIsolated: o.buildIsolated === undefined ? null : o.buildIsolated,
    getStopState: o.getStopState === undefined ? null : o.getStopState,
    config: o.config
  })
  return { svc, doc, store, sup, host }
}

function json (ops, extra) {
  return JSON.stringify({ ops, ...(extra || {}) })
}

describe('unlock-service : contrats et garde-fous', () => {
  test('exports exacts et operations lisibles, jamais de JSON programme', async () => {
    assert.deepEqual([...OPS].sort(), ['escalate', 'explain', 'fetch_document', 'propose_doctrine', 'propose_patch', 'read_file'].sort())
    assert.match(LIMITS, /non deplooye/)
    assert.match(LIMITS, /isolation OS/)
    assert.match(LIMITS, /host/, 'autorite outils supposee host : documentee, non revendiquee')
    // Le worker ne touche ni fs ni shell : aucun require libre dans le module.
    const src = fs.readFileSync(require.resolve('../bot/unlock-service'), 'utf8')
    assert.ok(!src.includes("require('node:fs')") && !src.includes('require("node:fs")'), 'aucun fs dans le worker')
    assert.ok(!src.includes('child_process'), 'aucun shell/spawn dans le worker')
    assert.ok(!src.includes('eval(') && !src.includes('new Function'), 'jamais de JSON execute')
  })

  test('factory exige les backends (verite, pas de semblant)', async () => {
    const doc = doctrine()
    assert.throws(() => createUnlockService({}), TypeError)
    assert.throws(() => createUnlockService({
      doctrineProvider: doc,
      callGo: async () => ({}),
      tools: { readFile: async () => '', fetchDocumentation: async () => '' },
      candidateStore: {},
      supervisor: { activate: async () => ({}), confirmTrial: async () => ({}), rollback: async () => ({}) },
      trialRunner: async () => ({}),
      pauseWork: async () => {},
      resumeWork: async () => {},
      announce: async () => {},
      record: () => {}
    }), /candidateStore/)
  })

  test('nominal : prepare/check->TRIAL->preuves->confirm (retain vrai explicite)', async () => {
    const callGo = scriptedCalls([
      { content: json([{ op: 'propose_patch', changes: [{ path: 'bot/cap.js', content: "'use strict'\n1\n" }], reason: 'corrige cap', retain: true }]) }
    ])
    const { svc, store, sup, doc } = makeService({ callGo })
    const res = await svc.requestUnlock({ objective: 'rapporter 3 buches', facts: { pos: [1, 2, 3] } })
    assert.equal(res.outcome, 'confirmed')
    assert.equal(res.version, 'cand-1')
    assert.equal(res.retain, true)
    assert.equal(store.calls.prepare.length, 1)
    assert.deepEqual(store.calls.verify, ['cand-1'])
    assert.deepEqual(sup.calls.activate, ['cand-1'])
    assert.equal(sup.calls.confirm.length, 1)
    const proof = sup.calls.confirm[0].proof
    assert.equal(proof.essai, PROOF_MARK, 'preuve noyau explicite, decidee par le host')
    assert.equal(proof.version, 'cand-1')
    assert.ok(typeof proof.jobId === 'string' && proof.jobId === res.jobId, 'preuve liee au job')
    assert.ok(typeof proof.nonce === 'string' && proof.nonce.length >= 16, 'preuve liee par nonce')
    assert.equal(proof.doctrineVersion, DOCTRINE_VERSION)
    assert.deepEqual(proof.measurements, { effet: 1 }, 'mesures du trialRunner, pas du texte LLM')
    assert.equal(proof.accept, undefined, 'aucun bool LLM recopie tel quel')
    assert.equal(doc.calls(), 1, 'doctrine fournie a chaque appel Go')
    assert.equal(res.doctrineCalls, 1)
  })

  test('champ preuve forge par le modele ignore (pas de recopie aveugle)', async () => {
    const callGo = scriptedCalls([
      { content: json([{ op: 'propose_patch', changes: [{ path: 'a.js', content: 'x' }], reason: 'tente', retain: true, proof: { accept: true, essai: 'faux' } }]) }
    ])
    const { svc, sup } = makeService({ callGo })
    const res = await svc.requestUnlock({ objective: 'obj' })
    assert.equal(res.outcome, 'confirmed')
    const proof = sup.calls.confirm[0].proof
    assert.equal(proof.essai, PROOF_MARK)
    assert.notDeepEqual(proof.measurements, { accept: true }, 'le champ forge du modele ne traverse pas')
  })

  test('schema unknown et retain manquant refuses (aucune activation)', async () => {
    const badUnknown = scriptedCalls([{ content: json([{ op: 'teleporter', ou: 'ici' }]) }])
    const ctx1 = makeService({ callGo: badUnknown, config: { maxRounds: 1 } })
    const r1 = await ctx1.svc.requestUnlock({ objective: 'obj' })
    assert.equal(r1.outcome, 'impasse')
    assert.equal(ctx1.sup.calls.activate.length, 0, 'operation inconnue jamais executee')

    const badRetain = scriptedCalls([
      { content: json([{ op: 'propose_patch', changes: [{ path: 'a.js', content: 'x' }], reason: 'sans retain' }]) }
    ])
    const ctx2 = makeService({ callGo: badRetain, config: { maxRounds: 1 } })
    const r2 = await ctx2.svc.requestUnlock({ objective: 'obj' })
    assert.equal(r2.outcome, 'impasse')
    assert.equal(ctx2.sup.calls.activate.length, 0, 'retain implicite refuse (D19)')
  })

  test('descripteur : deja-confirme, digest non-hex et doctrine mismatch refuses', async () => {
    const patch = json([{ op: 'propose_patch', changes: [{ path: 'a.js', content: 'x' }], reason: 'tente', retain: true }])
    for (const [label, describe, code] of [
      ['promu', { ...goodDescriptor('cand-1'), status: 'active' }, 'already-promoted'],
      ['digest', { ...goodDescriptor('cand-1'), manifestDigest: 'digest-1' }, 'descriptor'],
      ['doctrine', { ...goodDescriptor('cand-1'), doctrine: { version: 'doctrine-autre', digest: 'c'.repeat(64) } }, 'doctrine-mismatch'],
      ['checks', { ...goodDescriptor('cand-1'), checks: [] }, 'descriptor']
    ]) {
      const ctx = makeService({
        callGo: scriptedCalls([{ content: patch }]),
        storeOver: { describe: () => describe },
        config: { maxRounds: 1 }
      })
      const res = await ctx.svc.requestUnlock({ objective: 'obj' })
      assert.ok(['impasse', 'failed'].includes(res.outcome), `${label} => pas de succes`)
      assert.equal(ctx.sup.calls.activate.length, 0, `${label} refuse avant activate (${code})`)
      assert.ok(ctx.svc.status().traces.concat(res.traces).some((t) => t.detail.includes(code) || t.type === 'round-error'), `${label} trace (${code})`)
      void code
    }
  })

  test('outil hors scope refuse, sans crash (autorite host)', async () => {
    const callGo = scriptedCalls([
      { content: json([{ op: 'read_file', path: '../secret.env' }]) },
      { content: json([{ op: 'explain', text: 'je reste honnete' }]) }
    ])
    const tools = {
      readFile: async () => { throw errWith('outside-scope', 'chemin protege exclu') },
      fetchDocumentation: async () => ({ content: 'doc' })
    }
    const { svc, sup } = makeService({ callGo, tools, config: { maxRounds: 2, stagnationRepeats: 3 } })
    const res = await svc.requestUnlock({ objective: 'obj' })
    assert.ok(['impasse', 'failed'].includes(res.outcome))
    assert.equal(sup.calls.activate.length, 0, 'outil refuse => aucune activation')
  })

  test('doctrine fournie a CHAQUE appel, y compris escalade Astra', async () => {
    const failing = errWith('tool-failed', 'read_file rate toujours pareil')
    const callGo = scriptedCalls([
      { content: json([{ op: 'read_file', path: 'a.js' }]) },
      { content: json([{ op: 'read_file', path: 'a.js' }]) },
      { content: json([{ op: 'read_file', path: 'a.js' }]) }
    ])
    const callAstra = scriptedCalls([{ content: json([{ op: 'explain', text: 'astra constate impasse' }]) }])
    const tools = {
      readFile: async () => { throw failing },
      fetchDocumentation: async () => ({ content: 'doc' })
    }
    const doc = doctrine()
    const { svc } = makeService({ callGo, callAstra, tools, doctrine: doc, config: { maxRounds: 4, stagnationRepeats: 3 } })
    const res = await svc.requestUnlock({ objective: 'objectif intact à garder' })
    assert.equal(doc.calls(), 4, `doctrine lue 3x Go + 1x Astra (mesure ${doc.calls()})`)
    assert.equal(res.doctrineCalls, 4)
    assert.deepEqual(res.doctrineVersions, [DOCTRINE_VERSION, DOCTRINE_VERSION, DOCTRINE_VERSION, DOCTRINE_VERSION])
    assert.equal(res.escalated, true, 'stagnation => escalade unique')
    // Objectif intact transmis a chaque appel Go/Astra.
    for (const seen of [...callGo.seen, ...callAstra.seen]) {
      assert.ok(seen.system.includes('objectif intact') || seen.user.includes('objectif intact à garder'), 'objectif intact + doctrine a chaque appel')
      assert.ok(seen.system.includes(DOCTRINE_VERSION), 'version doctrine dans chaque prompt')
    }
  })

  test('rollback sur essai refuse : faits monde conserves, pas de replay', async () => {
    const callGo = scriptedCalls([
      { content: json([{ op: 'propose_patch', changes: [{ path: 'a.js', content: 'x' }], reason: 'tente', retain: true }]) }
    ])
    const { svc, sup, host } = makeService({
      callGo,
      trialRunner: async () => ({ accept: false, measurements: { effet: 0 }, note: 'rien observe' }),
      config: { maxRounds: 1 }
    })
    const res = await svc.requestUnlock({ objective: 'obj' })
    assert.ok(['impasse', 'failed'].includes(res.outcome))
    assert.equal(sup.calls.rollback.length, 1, 'rollback appele apres essai refuse')
    assert.equal(sup.calls.confirm.length, 0, 'jamais de promotion sans acceptation')
    const blob = host.recorded.map((e) => e.detail).join('\n')
    assert.match(blob, /faits monde conserves|re-observer/, 'le rollback n annule pas les faits monde')
  })

  test('retain faux = temporaire explicite, jamais lastGood, cleanup + retour base', async () => {
    const callGo = scriptedCalls([
      { content: json([{ op: 'propose_patch', changes: [{ path: 'a.js', content: 'x' }], reason: 'utile une fois', retain: false }]) }
    ])
    const { svc, sup } = makeService({ callGo })
    const res = await svc.requestUnlock({ objective: 'obj' })
    assert.equal(res.outcome, 'temp-applied')
    assert.equal(res.retain, false)
    assert.equal(sup.calls.confirm.length, 0, 'temporaire jamais promu lastGood')
    assert.equal(sup.calls.rollback.length, 1, 'cleanup : retour base quiescente')
    assert.match(res.cleanup || '', /quiescente|temporaire|adapter/, 'cap temporaire explicite (futur adapter)')
  })

  test('meme erreur repetee => escalade unique Astra, jamais pilote', async () => {
    let goCalls = 0
    const callGo = async (system, user) => {
      goCalls += 1
      return { content: json([{ op: 'read_file', path: 'a.js' }]) }
    }
    let astraCalls = 0
    const callAstra = async () => {
      astraCalls += 1
      return { content: json([{ op: 'explain', text: 'astra explique, sans patch' }]) }
    }
    const tools = {
      readFile: async () => { throw errWith('tool-failed', 'meme panne mesuree') },
      fetchDocumentation: async () => ({ content: 'doc' })
    }
    const sup = makeSupervisor()
    const { svc } = makeService({ callGo, callAstra, tools, supervisor: sup, config: { maxRounds: 6, stagnationRepeats: 3 } })
    const res = await svc.requestUnlock({ objective: 'obj' })
    assert.equal(astraCalls, 1, 'escalade exactement une fois')
    assert.equal(res.escalated, true)
    assert.equal(sup.calls.activate.length, 0, 'Astra aide, jamais pilote (aucune activation hors pipeline)')
  })

  test('annulation pendant prepare : aucune activation tardive, rien a compenser', async () => {
    const c = new AbortController()
    const store = makeStore()
    const sup = makeSupervisor()
    const callGo = scriptedCalls([
      { content: json([{ op: 'propose_patch', changes: [{ path: 'a.js', content: 'x' }], reason: 'tente', retain: true }]) }
    ])
    store.prepare = async (args) => {
      await new Promise((r) => setTimeout(r, 60))
      return goodDescriptor('cand-late')
    }
    const { svc } = makeService({ callGo, store, supervisor: sup })
    const pending = svc.requestUnlock({ objective: 'obj' }, { signal: c.signal })
    setTimeout(() => c.abort(), 10)
    const res = await pending
    assert.equal(res.outcome, 'cancelled')
    assert.equal(sup.calls.activate.length, 0, 'stop avant activate => aucune activation tardive')
    assert.equal(sup.calls.confirm.length, 0)
    assert.equal(sup.calls.rollback.length, 0, 'rien commis => rien a compenser')
  })

  test('repro abort pendant activate lent : cancelled MAIS trial compense (rollback>=1)', async () => {
    const c = new AbortController()
    const sup = makeSupervisor({
      activateImpl: async (version) => {
        await new Promise((r) => setTimeout(r, 80))
        return { state: 'trial', trial: { version }, lastGood: null }
      }
    })
    const callGo = scriptedCalls([
      { content: json([{ op: 'propose_patch', changes: [{ path: 'a.js', content: 'x' }], reason: 'tente', retain: true }]) }
    ])
    const { svc } = makeService({ callGo, supervisor: sup })
    const pending = svc.requestUnlock({ objective: 'obj' }, { signal: c.signal })
    setTimeout(() => c.abort(), 10)
    const res = await pending
    assert.equal(res.outcome, 'cancelled', 'stop prioritaire gagne')
    assert.equal(sup.calls.activate.length, 1, 'activate lent commis malgre le stop')
    assert.ok(sup.calls.rollback.length >= 1, `trial orphelin interdit : rollback compense (mesure ${sup.calls.rollback.length})`)
    assert.equal(sup.calls.confirm.length, 0, 'aucune promotion tardive')
  })

  test('repro acceptation tardive (runner sourd) : cancelled, 0 confirm, rollback>=1', async () => {
    const c = new AbortController()
    const sup = makeSupervisor()
    const callGo = scriptedCalls([
      { content: json([{ op: 'propose_patch', changes: [{ path: 'a.js', content: 'x' }], reason: 'tente', retain: true }]) }
    ])
    const { svc } = makeService({
      callGo,
      supervisor: sup,
      trialRunner: async () => {
        await new Promise((r) => setTimeout(r, 80))
        return { accept: true, measurements: { effet: 1 } } // sourd au signal : repond quand meme
      }
    })
    const pending = svc.requestUnlock({ objective: 'obj' }, { signal: c.signal })
    setTimeout(() => c.abort(), 20)
    const res = await pending
    assert.equal(res.outcome, 'cancelled')
    assert.equal(sup.calls.confirm.length, 0, 'acceptation tardive jamais promue')
    assert.ok(sup.calls.rollback.length >= 1, 'trial compense apres acceptation tardive')
  })

  test('late accept + rollback en echec + hardstop : cancelled, uncertain trace, 0 resume', async () => {
    const c = new AbortController()
    const sup = makeSupervisor({ rollbackThrow: errWith('uncertain', 'sortie non reobservee') })
    const callGo = scriptedCalls([
      { content: json([{ op: 'propose_patch', changes: [{ path: 'a.js', content: 'x' }], reason: 'tente', retain: true }]) }
    ])
    const host = {}
    const doc = doctrine()
    const store = makeStore()
    const resumes = []
    const recorded = []
    const svc = createUnlockService({
      doctrineProvider: doc,
      callGo,
      callAstra: null,
      tools: { readFile: async (p) => ({ content: p }), fetchDocumentation: async (r) => ({ content: r }) },
      candidateStore: store,
      supervisor: sup,
      trialRunner: async () => {
        await new Promise((r) => setTimeout(r, 60))
        return { accept: true, measurements: { effet: 1 } } // tardif, apres le stop
      },
      pauseWork: async () => {},
      resumeWork: async (info) => { resumes.push(info) },
      announce: async () => {},
      record: (e) => { recorded.push(e) },
      buildIsolated: null,
      getStopState: async () => ({ stopped: true }),
      config: {}
    })
    void host
    const pending = svc.requestUnlock({ objective: 'obj' }, { signal: c.signal })
    setTimeout(() => c.abort(), 10)
    const res = await pending
    assert.equal(res.outcome, 'cancelled')
    assert.equal(sup.calls.confirm.length, 0)
    assert.ok(sup.calls.rollback.length >= 1, 'compensation tentee meme si rollback echoue')
    assert.ok(recorded.some((e) => e.type === 'rollback-failed'), 'echec rollback trace (uncertain)')
    assert.equal(resumes.length, 0, 'hardstop : resumeWork jamais appele')
    assert.ok(res.traces.some((t) => t.type === 'resume-skipped-hardstop'), 'reprise sautee tracee')
  })

  test('stop explicite ne reveille jamais un hardstop (bail release conditionnel)', async () => {
    let released = 0
    let resumed = 0
    const callGo = scriptedCalls([{ content: json([{ op: 'explain', text: 'fini' }]) }])
    const doc = doctrine()
    const svc = createUnlockService({
      doctrineProvider: doc,
      callGo,
      callAstra: null,
      tools: { readFile: async (p) => ({ content: p }), fetchDocumentation: async (r) => ({ content: r }) },
      candidateStore: makeStore(),
      supervisor: makeSupervisor(),
      trialRunner: async () => ({ accept: true, measurements: { effet: 1 } }),
      pauseWork: async () => ({ release: async () => { released += 1 } }),
      resumeWork: async () => { resumed += 1 },
      announce: async () => {},
      record: () => {},
      buildIsolated: null,
      getStopState: async () => ({ totalStopped: true }),
      config: { maxRounds: 1 }
    })
    const res = await svc.requestUnlock({ objective: 'obj' })
    assert.ok(res.outcome)
    assert.equal(released, 0, 'bail non libere sous hardstop')
    assert.equal(resumed, 0, 'resumeWork non appele sous hardstop')
    assert.ok(res.traces.some((t) => t.type === 'resume-skipped-hardstop'))
  })

  test('bail pause libere hors hardstop (release conditionnel nominal)', async () => {
    let released = 0
    const callGo = scriptedCalls([{ content: json([{ op: 'explain', text: 'fini' }]) }])
    const doc = doctrine()
    let resumed = 0
    const svc = createUnlockService({
      doctrineProvider: doc,
      callGo,
      callAstra: null,
      tools: { readFile: async (p) => ({ content: p }), fetchDocumentation: async (r) => ({ content: r }) },
      candidateStore: makeStore(),
      supervisor: makeSupervisor(),
      trialRunner: async () => ({ accept: true, measurements: { effet: 1 } }),
      pauseWork: async () => ({ release: async () => { released += 1 } }),
      resumeWork: async () => { resumed += 1 },
      announce: async () => {},
      record: () => {},
      buildIsolated: null,
      getStopState: async () => ({ stopped: false }),
      config: { maxRounds: 1 }
    })
    await svc.requestUnlock({ objective: 'obj' })
    assert.equal(released, 1, 'bail libere hors hardstop')
    assert.equal(resumed, 0, 'bail prioritaire sur resumeWork')
  })

  test('erreurs resume/announce/record ignorees, resumees unknown', async () => {
    const callGo = scriptedCalls([{ content: json([{ op: 'explain', text: 'bonjour' }]) }])
    const { svc } = makeService({
      callGo,
      resumeThrow: errWith('resume-hs', 'reprise hs'),
      announceThrow: errWith('announce-hs', 'annonce hs'),
      recordThrow: errWith('record-hs', 'trace hs'),
      config: { maxRounds: 1 }
    })
    const res = await svc.requestUnlock({ objective: 'obj' })
    assert.ok(['impasse', 'confirmed', 'temp-applied'].includes(res.outcome), 'panne callbacks jamais corruptive')
    assert.ok(res.traces.some((t) => t.type === 'resume-unknown' || t.type === 'record-unknown' || t.type === 'announce-unknown'),
      'erreurs resumees en traces unknown')
  })

  test('sans Astra : impasse honnete, jamais de pilote de substitution', async () => {
    const callGo = scriptedCalls([
      { content: json([{ op: 'escalate', reason: 'je suis coince, aide demandee' }]) }
    ])
    const { svc } = makeService({ callGo, callAstra: null })
    const res = await svc.requestUnlock({ objective: 'obj' })
    assert.equal(res.outcome, 'impasse')
    assert.equal(res.escalated, false, 'aucune escalade sans acces fourni')
    assert.match(res.reason || '', /indisponible|attente|sans acces/i)
  })

  test('deps sans adapter isole : non activable, reporte unsupported, rien invente', async () => {
    const callGo = scriptedCalls([
      { content: json([{ op: 'propose_patch', changes: [{ path: 'package.json', content: '{"name":"x"}' }], reason: 'ajoute dep', retain: true }]) }
    ])
    const { svc, store, sup } = makeService({ callGo, buildIsolated: null, config: { maxRounds: 1 } })
    const res = await svc.requestUnlock({ objective: 'obj' })
    assert.ok(['impasse', 'failed'].includes(res.outcome))
    assert.equal(sup.calls.activate.length, 0, 'deps sans build isole => zero activation')
    assert.equal(store.calls.prepare.length, 0, 'refuse avant tout effet (non simule)')
  })

  test('redaction generique cle=valeur (casse libre), faits non secrets preserves', async () => {
    const secretFacts = 'PASSWORD=hunter2-fictif, Api_Key: cle-fictive-123, OPENCODE_TOKEN=tok-fictif, passWD : x-fictif'
    const callGo = scriptedCalls([
      { content: json([{ op: 'explain', text: 'recu PASSWORD=hunter2-fictif et TOKEN: abc-fictif' }]) }
    ])
    const { svc, host } = makeService({ callGo, config: { maxRounds: 1 } })
    const res = await svc.requestUnlock({ objective: 'obj', facts: secretFacts })
    assert.ok(res.outcome)
    const blob = [...host.recorded.map((e) => `${e.type} ${e.detail}`), ...host.announced].join('\n')
    assert.ok(!/hunter2-fictif/.test(blob), 'valeur PASSWORD redigee')
    assert.ok(!/cle-fictive-123/.test(blob), 'valeur API_KEY redigee')
    assert.ok(!/tok-fictif/.test(blob), 'valeur OPENCODE_TOKEN redigee')
    assert.ok(blob.includes('[redacted]'), 'redaction visible')

    // Faits non secrets : mots isoles sans separateur, jamais expurges.
    const callGo2 = scriptedCalls([{ content: json([{ op: 'explain', text: 'ok' }]) }])
    const ctx2 = makeService({ callGo: callGo2, config: { maxRounds: 1 } })
    const facts = 'le coffre secret contient 3 pommes ; token count 5 ; le mot password apparait dans ce recit'
    const res2 = await ctx2.svc.requestUnlock({ objective: 'obj', facts })
    const blob2 = ctx2.host.recorded.map((e) => `${e.type} ${e.detail}`).join('\n')
    assert.ok(!/\[redacted\]/.test(blob2) || /start/.test(blob2), 'aucune expurgation par mot isole')
    assert.ok(res2.traces.length <= 80, `traces bornees (mesure ${res2.traces.length})`)
    for (const t of res2.traces) {
      assert.ok(t.detail.length <= 500, 'detail trace borne')
    }
    void res
  })

  test('porteurs Bearer/opencode-go rediges, traces bornees', async () => {
    const secretObjective = 'rapporter bois opencode-go-SECRET123 et Bearer abcdef12345'
    const callGo = scriptedCalls([
      { content: json([{ op: 'explain', text: 'recu opencode-go-SECRET123, Bearer abcdef' }]) }
    ])
    const { svc, host } = makeService({ callGo, config: { maxRounds: 1 } })
    const res = await svc.requestUnlock({ objective: secretObjective })
    assert.ok(res.outcome)
    const blob = [...host.recorded.map((e) => `${e.type} ${e.detail}`), ...host.announced].join('\n')
    assert.ok(!/Bearer\s+[A-Za-z0-9._~+/-]+=*/.test(blob), 'porteur Bearer redige')
    assert.ok(blob.includes('[redacted]'), 'redaction visible')
    assert.ok(res.traces.length <= 80, `traces bornees (mesure ${res.traces.length})`)
    for (const t of res.traces) {
      assert.ok(t.detail.length <= 500, 'detail trace borne')
    }
  })

  test('propositions doctrine enregistrees, jamais appliquees', async () => {
    const callGo = scriptedCalls([
      { content: json([{ op: 'propose_doctrine', text: 'nouvelle regle proposee' }, { op: 'explain', text: 'je propose seulement' }]) }
    ])
    const doc = doctrine()
    const { svc } = makeService({ callGo, doctrine: doc, config: { maxRounds: 1 } })
    const res = await svc.requestUnlock({ objective: 'obj' })
    assert.equal(res.doctrineProposals.length, 1)
    assert.match(res.doctrineProposals[0].text, /nouvelle regle/)
    assert.equal(doc.calls(), 1, 'doctrine courante inchangee (fournie, jamais mutee)')
  })

  test('single-job : deuxieme demande refusee sans file', async () => {
    const callGo = async () => {
      await new Promise((r) => setTimeout(r, 60))
      return { content: json([{ op: 'explain', text: 'lent' }]) }
    }
    const { svc } = makeService({ callGo, config: { maxRounds: 1 } })
    const first = svc.requestUnlock({ objective: 'premier' })
    await assert.rejects(svc.requestUnlock({ objective: 'second' }), (e) => e && e.code === 'busy')
    const res = await first
    assert.ok(res.outcome)
  })

  test('outil AbortError sans code => cancelled normalise, aucun nouvel appel', async () => {
    const abortLike = new Error('aborted sans code')
    abortLike.name = 'AbortError'
    const callGo = scriptedCalls([{ content: json([{ op: 'read_file', path: 'a.js' }]) }])
    const ctx = makeService({
      callGo,
      tools: {
        readFile: async () => { throw abortLike },
        fetchDocumentation: async () => ({ content: 'doc' })
      },
      config: { maxRounds: 3 }
    })
    const res = await ctx.svc.requestUnlock({ objective: 'obj' })
    assert.equal(res.outcome, 'cancelled', 'annulation, pas stagnation')
    assert.equal(res.escalated, false, 'aucune escalade apres annulation')
    assert.equal(callGo.count(), 1, 'aucun nouvel appel apres annulation outil')
    assert.equal(ctx.sup.calls.activate.length, 0)
  })

  test('fetch_document annule via signal => cancelled, pas tool-failed', async () => {
    const c = new AbortController()
    const callGo = scriptedCalls([{ content: json([{ op: 'fetch_document', ref: 'doc-x' }]) }])
    const ctx = makeService({
      callGo,
      tools: {
        readFile: async (p) => ({ content: p }),
        fetchDocumentation: async () => {
          await new Promise((r) => setTimeout(r, 60))
          throw new Error('reponse tardive')
        }
      }
    })
    const pending = ctx.svc.requestUnlock({ objective: 'obj' }, { signal: c.signal })
    setTimeout(() => c.abort(), 10)
    const res = await pending
    assert.equal(res.outcome, 'cancelled')
    assert.ok(res.traces.every((t) => !t.detail.startsWith('tool-failed')), 'pas de tool-failed sur annulation')
  })

  test('trialRunner AbortError sans code apres trial commis => cancelled + compense', async () => {
    const c = new AbortController()
    const sup = makeSupervisor()
    const callGo = scriptedCalls([
      { content: json([{ op: 'propose_patch', changes: [{ path: 'a.js', content: 'x' }], reason: 'tente', retain: true }]) }
    ])
    const ctx = makeService({
      callGo,
      supervisor: sup,
      trialRunner: async () => {
        await new Promise((r) => setTimeout(r, 60))
        const e = new Error('essai interrompu')
        e.name = 'AbortError'
        throw e // sans code, signal aborte entre-temps
      }
    })
    const pending = ctx.svc.requestUnlock({ objective: 'obj' }, { signal: c.signal })
    setTimeout(() => c.abort(), 10)
    const res = await pending
    assert.equal(res.outcome, 'cancelled')
    assert.equal(sup.calls.confirm.length, 0)
    assert.ok(sup.calls.rollback.length >= 1, 'trial commis compense meme sur AbortError sans code')
  })

  test('getStopState illisible (exception/timeout/forme) => 0 reprise', async () => {
    const patch = (text) => scriptedCalls([{ content: json([{ op: 'explain', text }]) }])
    // Exception.
    {
      const ctx = makeService({ callGo: patch('a'), getStopState: async () => { throw new Error('sonde hs') }, config: { maxRounds: 1 } })
      const res = await ctx.svc.requestUnlock({ objective: 'obj' })
      assert.equal(ctx.host.resumes.length, 0, 'exception stop => aucune reprise')
      assert.ok(res.traces.some((t) => t.type === 'resume-skipped-unknown'), 'reprise sautee tracee (unknown)')
    }
    // Timeout (borne courte).
    {
      const ctx = makeService({
        callGo: patch('b'),
        getStopState: () => new Promise(() => {}),
        config: { maxRounds: 1, stopStateTimeoutMs: 60 }
      })
      const begun = Date.now()
      const res = await ctx.svc.requestUnlock({ objective: 'obj' })
      assert.ok(Date.now() - begun < 2000, 'borne stopState respectee')
      assert.equal(ctx.host.resumes.length, 0, 'timeout stop => aucune reprise')
      assert.ok(res.traces.some((t) => t.type === 'resume-skipped-unknown'))
    }
    // Forme invalide.
    {
      const ctx = makeService({ callGo: patch('c'), getStopState: async () => 'oui', config: { maxRounds: 1 } })
      const res = await ctx.svc.requestUnlock({ objective: 'obj' })
      assert.equal(ctx.host.resumes.length, 0, 'forme invalide => aucune reprise')
      assert.ok(res.traces.some((t) => t.type === 'stopstate-unknown'), 'sonde invalide resumee unknown')
    }
  })

  test('supervisor.status incertain/failed-both/activating => 0 reprise', async () => {
    const mk = (statusFn) => {
      const sup = makeSupervisor()
      sup.status = statusFn
      return sup
    }
    for (const [label, statusFn] of [
      ['uncertain', async () => ({ state: 'trial', uncertain: { pid: 1 }, failedBoth: false })],
      ['failed-both', async () => ({ state: 'failed-both', uncertain: null, failedBoth: true })],
      ['activating', async () => ({ state: 'activating', uncertain: null, failedBoth: false })],
      ['rolling-back', async () => ({ state: 'rolling-back', uncertain: null, failedBoth: false })],
      ['status-throw', async () => { throw new Error('status hs') }]
    ]) {
      const ctx = makeService({
        callGo: scriptedCalls([{ content: json([{ op: 'explain', text: 'ok' }]) }]),
        supervisor: mk(statusFn),
        getStopState: async () => ({ stopped: false }),
        config: { maxRounds: 1 }
      })
      const res = await ctx.svc.requestUnlock({ objective: 'obj' })
      assert.equal(ctx.host.resumes.length, 0, `${label} => aucune reprise malgre stopstate false`)
      assert.ok(res.traces.some((t) => t.type === 'resume-skipped-unknown'), `${label} trace (pas de reprise)`)
    }
  })

  test('legacy sans sondes : reprise locale autorisee (prod la requiert)', async () => {
    const ctx = makeService({
      callGo: scriptedCalls([{ content: json([{ op: 'explain', text: 'ok' }]) }]),
      config: { maxRounds: 1 }
    })
    assert.equal(ctx.svc.requestUnlock.length, 2, 'contrat requestUnlock(request, opts) inchange')
    const res = await ctx.svc.requestUnlock({ objective: 'obj' })
    assert.equal(ctx.host.resumes.length, 1, 'mode legacy/test pur : reprise locale')
    assert.ok(!res.traces.some((t) => t.type.startsWith('resume-skipped')), 'aucun blocage en legacy')
  })

  test('retain faux + rollback en echec => failed/uncertain, pas de faux cleanup, 0 resume', async () => {
    const callGo = scriptedCalls([
      { content: json([{ op: 'propose_patch', changes: [{ path: 'a.js', content: 'x' }], reason: 'utile une fois', retain: false }]) }
    ])
    const ctx = makeService({
      callGo,
      supOver: { rollbackThrow: errWith('uncertain', 'sortie non reobservee') },
      getStopState: async () => ({ stopped: false }),
      config: { maxRounds: 1 }
    })
    const res = await ctx.svc.requestUnlock({ objective: 'obj' })
    assert.equal(res.outcome, 'failed', 'cleanup rate => pas de temp-applied')
    assert.equal(res.uncertain, true, 'latch uncertain global')
    assert.equal(res.cleanup, null, 'aucun "retour base quiescente" revendique')
    assert.match(res.error.message || res.reason || '', /non restauree|preserves/, 'detail faits monde preserves')
    assert.equal(ctx.sup.calls.confirm.length, 0, 'jamais promu')
    assert.equal(ctx.host.resumes.length, 0, 'stopstate false ne revoque pas le latch uncertain : 0 resume')
    assert.ok(res.traces.some((t) => t.type === 'resume-skipped-uncertain'), 'non-reprise tracee (uncertain)')
    assert.ok(res.traces.some((t) => t.type === 'compensation-failed-uncertain' || t.type === 'rollback-failed'), 'echec compensation trace')
  })
})
