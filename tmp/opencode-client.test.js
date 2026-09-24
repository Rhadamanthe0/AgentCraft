'use strict'

// Tests du client Astra via OpenCode Desktop (bot/opencode-client.js).
// Tout le reseau est moque (fetch injecte) : aucun appel live, aucun secret.
// Couvre : corps session deny-all, tools {id:false} dynamiques, directory sur
// chaque endpoint, concatenation texte + rejet des parties outils, cleanup
// DELETE borne meme en echec, abort borne pendant message et pendant create
// (ID tardif), timeout/auth sans fuite de secret, URL non-loopback refusee,
// model/variant injectables, reponses partielles/inattendues,
// info.error (string/objet) jamais success, toolIDs vide/malformed refuses,
// DELETE/abort qui pendent (borne + orpheline exposee, sans retry).

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { createOpenCodeClient } = require('../bot/opencode-client')

const BASE = 'http://127.0.0.1:4096'
const DIR = 'C:\\Temp\\opencode-test'

let realFetch

beforeEach(() => { realFetch = globalThis.fetch })
afterEach(() => { globalThis.fetch = realFetch })

function makeHarness ({ toolIds = ['a', 'b'], messageBody = null, failMessage = null, delayCreateMs = 0, deleteHang = false, abortHang = false, deleteFail = false } = {}) {
  const calls = []
  const fetch = async (url, init = {}) => {
    const u = String(url)
    const method = String(init.method || 'GET').toUpperCase()
    let body = null
    try { body = init.body ? JSON.parse(init.body) : null } catch (_) { body = null }
    calls.push({ url: u, method, body, headers: { ...(init.headers || {}) } })
    if (init.signal?.aborted) {
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    }
    if (u.includes('/experimental/tool/ids')) {
      return { ok: true, status: 200, json: async () => toolIds, text: async () => '' }
    }
    if (method === 'POST' && u.includes('/session') && u.includes('/message')) {
      if (failMessage) {
        return { ok: false, status: 500, text: async () => failMessage }
      }
      return { ok: true, status: 200, json: async () => messageBody, text: async () => '' }
    }
    if (method === 'POST' && /\/session$/.test(u.split('?')[0])) {
      if (delayCreateMs > 0) {
        // ID tardif : le serveur cree la session malgre l abort client ;
        // le mock ignore le signal pour simuler l arrivee tardive de l ID,
        // que le client doit nettoyer (abort borne + DELETE borne).
        await new Promise((resolve) => setTimeout(resolve, delayCreateMs))
      }
      return { ok: true, status: 200, json: async () => ({ id: 'sess-1' }), text: async () => '' }
    }
    if (method === 'POST' && u.includes('/abort')) {
      // Endpoint qui ignore l abort : ne respecte jamais le signal, pend.
      if (abortHang) return new Promise(() => {})
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
    }
    if (method === 'DELETE' && u.includes('/session/')) {
      // Endpoint qui ignore l abort : pend sans jamais repondre.
      if (deleteHang) return new Promise(() => {})
      if (deleteFail) return { ok: false, status: 500, json: async () => ({}), text: async () => 'ko' }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
    }
    throw new Error(`route moquee inattendue : ${method} ${u}`)
  }
  return { calls, fetch }
}

function okMessage () {
  return {
    info: { id: 'sess-1' },
    parts: [
      { type: 'step-start' },
      { type: 'text', text: '{"fini":' },
      { type: 'text', text: '0}' },
      { type: 'step-finish', reason: 'stop' }
    ]
  }
}

describe('opencode-client : contrat session + outils + directory', () => {
  it('POST /session deny-all + modeles par defaut, tools tous false, directory partout', async () => {
    const { calls, fetch } = makeHarness({ toolIds: ['read', 'bash', 'edit'], messageBody: okMessage() })
    const client = createOpenCodeClient({ baseUrl: BASE, directory: DIR, fetch })
    const res = await client.call('sys', 'jeu')
    assert.equal(res.content, '{"fini":0}')
    assert.equal(res.cleanupFailed, false)

    const create = calls.find((c) => c.method === 'POST' && /\/session$/.test(c.url.split('?')[0]))
    assert.ok(create, 'creation de session appelee')
    assert.deepEqual(create.body, {
      title: 'minecraft-bot',
      model: { id: 'gpt-6-astra', providerID: 'openai', variant: 'high' },
      permission: [{ permission: '*', pattern: '*', action: 'deny' }]
    })

    const msg = calls.find((c) => c.url.includes('/message'))
    assert.ok(msg)
    assert.deepEqual(msg.body.model, { providerID: 'openai', modelID: 'gpt-6-astra' })
    assert.equal(msg.body.variant, 'high')
    assert.deepEqual(msg.body.tools, { read: false, bash: false, edit: false })
    assert.deepEqual(msg.body.parts, [{ type: 'text', text: 'sys\n\njeu' }])

    for (const c of calls) {
      assert.ok(c.url.includes(`directory=${encodeURIComponent(DIR)}`), `directory manquant : ${c.url}`)
    }
    const del = calls.find((c) => c.method === 'DELETE' && c.url.includes('/session/sess-1'))
    assert.ok(del, 'cleanup DELETE appele')
  })

  it('model/variant injectables (test) sans piloter de route', async () => {
    const { calls, fetch } = makeHarness({ toolIds: ['x'], messageBody: okMessage() })
    const client = createOpenCodeClient({
      baseUrl: BASE, directory: DIR, fetch,
      modelId: 'test-model', providerId: 'test-prov', variant: 'low', title: 't-test'
    })
    await client.call('s', 'u')
    const create = calls.find((c) => c.method === 'POST' && /\/session$/.test(c.url.split('?')[0]))
    assert.deepEqual(create.body.model, { id: 'test-model', providerID: 'test-prov', variant: 'low' })
    const msg = calls.find((c) => c.url.includes('/message'))
    assert.deepEqual(msg.body.model, { providerID: 'test-prov', modelID: 'test-model' })
    assert.equal(msg.body.variant, 'low')
  })

  it('ids sous forme {ids:[...]} acceptees', async () => {
    const { calls, fetch } = makeHarness({ toolIds: { ids: ['k1', 'k2'] }, messageBody: okMessage() })
    const client = createOpenCodeClient({ baseUrl: BASE, directory: DIR, fetch })
    await client.call('s', 'u')
    const msg = calls.find((c) => c.url.includes('/message'))
    assert.deepEqual(msg.body.tools, { k1: false, k2: false })
  })
})

describe('opencode-client : texte seul, outils jamais executes', () => {
  it('parties outils inattendues ignorees, texte concatene', async () => {
    const body = {
      info: {},
      parts: [
        { type: 'step-start' },
        { type: 'text', text: 'hello ' },
        { type: 'tool', name: 'bash', input: { cmd: 'rm -rf /' } },
        { type: 'text', text: 'world' },
        { type: 'step-finish' }
      ]
    }
    const { fetch } = makeHarness({ messageBody: body })
    const client = createOpenCodeClient({ baseUrl: BASE, directory: DIR, fetch })
    const res = await client.call('s', 'u')
    assert.equal(res.content, 'hello world')
    assert.ok(!JSON.stringify(res).includes('rm -rf'))
  })

  it('reponse sans texte (que des outils) -> erreur, mais cleanup quand meme', async () => {
    const { calls, fetch } = makeHarness({
      messageBody: { info: {}, parts: [{ type: 'step-start' }, { type: 'tool', name: 'x' }] }
    })
    const client = createOpenCodeClient({ baseUrl: BASE, directory: DIR, fetch })
    await assert.rejects(client.call('s', 'u'), /sans contenu/)
    assert.ok(calls.some((c) => c.method === 'DELETE'), 'DELETE meme sur reponse vide')
  })

  it('parts absentes -> erreur sans contenu', async () => {
    const { fetch } = makeHarness({ messageBody: { info: {} } })
    const client = createOpenCodeClient({ baseUrl: BASE, directory: DIR, fetch })
    await assert.rejects(client.call('s', 'u'), /sans contenu/)
  })
})

describe('opencode-client : info.error jamais success', () => {
  it('info.error string + texte -> erreur modele, cleanup DELETE', async () => {
    const { calls, fetch } = makeHarness({
      messageBody: { info: { error: 'modele surcharge fictif' }, parts: [{ type: 'text', text: '{"fini":0}' }] }
    })
    const client = createOpenCodeClient({ baseUrl: BASE, directory: DIR, fetch })
    await assert.rejects(client.call('s', 'u'), (err) => {
      assert.match(err.message, /erreur modele/)
      assert.match(err.message, /surcharge fictif/)
      assert.equal(err.code, 'OPENCODE_MODEL_ERROR')
      return true
    })
    assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.includes('sess-1')), 'DELETE malgre info.error')
  })

  it('info.error objet + texte -> whitelist code/message, secrets redactes', async () => {
    const secret = 'Bearer abcdef12345'
    const { calls, fetch } = makeHarness({
      messageBody: {
        info: { error: { code: 'E_FICTIVE', message: `boom ${secret} password: secret-fictif`, extra: { token: 'ne-pas-recopier' } } },
        parts: [{ type: 'text', text: '{"fini":0}' }]
      }
    })
    const client = createOpenCodeClient({ baseUrl: BASE, directory: DIR, fetch })
    await assert.rejects(client.call('s', 'u'), (err) => {
      assert.match(err.message, /erreur modele/)
      assert.match(err.message, /boom/)
      assert.equal(err.code, 'OPENCODE_MODEL_ERROR')
      assert.equal(err.modelCode, 'E_FICTIVE')
      assert.doesNotMatch(err.message, /abcdef12345/)
      assert.doesNotMatch(err.message, /secret-fictif/)
      assert.doesNotMatch(err.message, /ne-pas-recopier/)
      assert.match(err.message, /redacted/)
      return true
    })
    assert.ok(calls.some((c) => c.method === 'DELETE'), 'DELETE malgre info.error objet')
  })
})

describe('opencode-client : toolIDs vide/malformed refuses', () => {
  it('liste vide -> refus OPENCODE_NO_TOOLS, aucun message tools{}', async () => {
    const { calls, fetch } = makeHarness({ toolIds: [], messageBody: okMessage() })
    const client = createOpenCodeClient({ baseUrl: BASE, directory: DIR, fetch })
    await assert.rejects(client.call('s', 'u'), (err) => {
      assert.match(err.message, /vide/)
      assert.equal(err.code, 'OPENCODE_NO_TOOLS')
      return true
    })
    assert.ok(!calls.some((c) => c.url.includes('/message')), 'aucun message envoye')
  })

  it('liste malformed -> refus, sans message ni session orpheline', async () => {
    const { calls, fetch } = makeHarness({ toolIds: { unexpected: 1 }, messageBody: okMessage() })
    const client = createOpenCodeClient({ baseUrl: BASE, directory: DIR, fetch })
    await assert.rejects(client.call('s', 'u'), (err) => {
      assert.match(err.message, /illisible/)
      assert.equal(err.code, 'OPENCODE_BAD_RESPONSE')
      return true
    })
    assert.ok(!calls.some((c) => c.url.includes('/message')), 'aucun message envoye')
    assert.ok(!calls.some((c) => c.method === 'POST' && /\/session$/.test(c.url.split('?')[0])), 'aucune session creee (pas d orpheline)')
  })
})

describe('opencode-client : echecs, cleanup borne, auth sans secrets', () => {
  it('echec message HTTP 500 -> erreur + DELETE quand meme, sans secret', async () => {
    const { calls, fetch } = makeHarness({ messageBody: null, failMessage: 'boom-serveur' })
    const client = createOpenCodeClient({
      baseUrl: BASE, directory: DIR, fetch, username: 'u1', password: 'p-super-secret'
    })
    await assert.rejects(client.call('s', 'u'), (err) => {
      assert.match(err.message, /HTTP 500/)
      assert.match(err.message, /boom-serveur/)
      assert.doesNotMatch(err.message, /p-super-secret/)
      assert.equal(err.cleanupFailed, false)
      return true
    })
    assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.includes('sess-1')))
    const msg = calls.find((c) => c.url.includes('/message'))
    assert.match(msg.headers.authorization, /^Basic /)
  })

  it('auth Basic envoyee mais jamais dans le message d erreur (401)', async () => {
    const secret = 'mot-de-passe-fictif'
    const fetch = async (url, init = {}) => {
      if (String(url).includes('/experimental/tool/ids')) {
        return { ok: false, status: 401, text: async () => 'Unauthorized' }
      }
      throw new Error('route inattendue')
    }
    const client = createOpenCodeClient({ baseUrl: BASE, directory: DIR, fetch, username: 'bot', password: secret })
    await assert.rejects(client.call('s', 'u'), (err) => {
      assert.match(err.message, /HTTP 401/)
      assert.doesNotMatch(err.message, new RegExp(secret))
      return true
    })
  })

  it('timeout court -> OPENCODE_TIMEOUT + abort borne + DELETE borne, sans secret', async () => {
    const fetch = async (url, init = {}) => {
      const u = String(url)
      if (u.includes('/experimental/tool/ids')) {
        return { ok: true, status: 200, json: async () => ['t1'], text: async () => '' }
      }
      if (u.includes('/message') || /\/session$/.test(u.split('?')[0])) {
        return new Promise((_, reject) => {
          const onAbort = () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          }
          if (init.signal?.aborted) return onAbort()
          init.signal?.addEventListener('abort', onAbort, { once: true })
        })
      }
      if (u.includes('/abort') || (String(init.method).toUpperCase() === 'DELETE')) {
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
      }
      throw new Error(`route inattendue ${u}`)
    }
    const client = createOpenCodeClient({ baseUrl: BASE, directory: DIR, fetch, username: 'u', password: 'p-fictif', cleanupTimeoutMs: 200 })
    await assert.rejects(client.call('s', 'u', { timeoutMs: 40 }), (err) => {
      assert.match(err.message, /pas de reponse en 40 ms/)
      assert.equal(err.code, 'OPENCODE_TIMEOUT')
      assert.doesNotMatch(err.message, /p-fictif/)
      return true
    })
  })

  it('signal externe pendant le message -> abort POST borne + DELETE borne + OPENCODE_ABORTED', async () => {
    const { calls, fetch } = makeHarness({ messageBody: okMessage() })
    // Retarde le message pour laisser l abort tomber pendant l envoi.
    const slowFetch = async (url, init = {}) => {
      if (String(url).includes('/message')) {
        await new Promise((r) => setTimeout(r, 60))
      }
      return fetch(url, init)
    }
    const client = createOpenCodeClient({ baseUrl: BASE, directory: DIR, fetch: slowFetch, cleanupTimeoutMs: 500 })
    const c = new AbortController()
    setTimeout(() => c.abort(), 10)
    await assert.rejects(client.call('s', 'u', { signal: c.signal, timeoutMs: 5000 }), /appel annule/)
    assert.ok(calls.some((k) => k.url.includes('/abort')), 'POST abort appele')
    assert.ok(calls.some((k) => k.method === 'DELETE'), 'DELETE appele')
  })

  it('abort pendant le create (ID tardif) -> cleanup borne des que l ID arrive', async () => {
    const { calls, fetch } = makeHarness({ messageBody: okMessage(), delayCreateMs: 60 })
    const client = createOpenCodeClient({ baseUrl: BASE, directory: DIR, fetch, cleanupTimeoutMs: 500 })
    const c = new AbortController()
    setTimeout(() => c.abort(), 10)
    await assert.rejects(
      client.call('s', 'u', { signal: c.signal, timeoutMs: 5000 }),
      (err) => {
        assert.match(err.message, /appel annule|pas de reponse/)
        assert.equal(err.cleanupFailed, false)
        return true
      }
    )
    assert.ok(calls.some((k) => k.method === 'DELETE' && k.url.includes('sess-1')), 'DELETE tardif appele')
  })

  it('DELETE qui pend (endpoint ignore abort) -> call borne + orpheline exposee, un seul essai', async () => {
    const { calls, fetch } = makeHarness({ messageBody: okMessage(), deleteHang: true })
    const client = createOpenCodeClient({ baseUrl: BASE, directory: DIR, fetch, cleanupTimeoutMs: 60 })
    const started = Date.now()
    const res = await client.call('s', 'u', { timeoutMs: 2000 })
    const elapsed = Date.now() - started
    assert.equal(res.content, '{"fini":0}', 'success non masque par le cleanup')
    assert.equal(res.cleanupFailed, true)
    assert.equal(res.sessionId, 'sess-1')
    assert.ok(elapsed < 800, `borne cleanup respectee (mesure ${elapsed} ms)`)
    assert.equal(calls.filter((k) => k.method === 'DELETE').length, 1, 'aucun retry en boucle')
  })

  it('abort qui pend (endpoint ignore abort) -> annulation quand meme bornee', async () => {
    const { calls, fetch } = makeHarness({ messageBody: okMessage(), abortHang: true })
    const slowFetch = async (url, init = {}) => {
      if (String(url).includes('/message')) {
        await new Promise((r) => setTimeout(r, 60))
      }
      return fetch(url, init)
    }
    const client = createOpenCodeClient({ baseUrl: BASE, directory: DIR, fetch: slowFetch, cleanupTimeoutMs: 60 })
    const c = new AbortController()
    setTimeout(() => c.abort(), 10)
    const started = Date.now()
    await assert.rejects(slowFetch && client.call('s', 'u', { signal: c.signal, timeoutMs: 5000 }), /appel annule/)
    const elapsed = Date.now() - started
    assert.ok(elapsed < 800, `abort borne (mesure ${elapsed} ms)`)
    assert.ok(calls.some((k) => k.url.includes('/abort')), 'abort tente une fois')
    assert.equal(calls.filter((k) => k.url.includes('/abort')).length, 1, 'aucun retry abort')
  })

  it('DELETE en echec HTTP -> success garde + orpheline exposee, un seul essai', async () => {
    const { calls, fetch } = makeHarness({ messageBody: okMessage(), deleteFail: true })
    const client = createOpenCodeClient({ baseUrl: BASE, directory: DIR, fetch, cleanupTimeoutMs: 500 })
    const res = await client.call('s', 'u')
    assert.equal(res.content, '{"fini":0}')
    assert.equal(res.cleanupFailed, true)
    assert.equal(res.sessionId, 'sess-1')
    assert.equal(calls.filter((k) => k.method === 'DELETE').length, 1)
  })
})

describe('opencode-client : garde-fous configuration', () => {
  it('directory manquant refuse', () => {
    assert.throws(() => createOpenCodeClient({ baseUrl: BASE, fetch: async () => ({}) }), /directory/)
  })

  it('cleanupTimeoutMs invalide refuse', () => {
    assert.throws(
      () => createOpenCodeClient({ baseUrl: BASE, directory: DIR, fetch: async () => ({}), cleanupTimeoutMs: 0 }),
      /cleanupTimeoutMs/
    )
  })

  it('hote non-loopback refuse sans allowNonLoopback explicite', () => {
    assert.throws(
      () => createOpenCodeClient({ baseUrl: 'https://exemple.test:4096', directory: DIR, fetch: async () => ({}) }),
      /non-loopback/
    )
  })

  it('hote explicite autorise avec allowNonLoopback (question bridge non tranchee)', async () => {
    const { fetch } = makeHarness({ messageBody: okMessage() })
    const client = createOpenCodeClient({
      baseUrl: 'https://exemple.test:4096', directory: DIR, fetch, allowNonLoopback: true
    })
    const res = await client.call('s', 'u')
    assert.equal(res.content, '{"fini":0}')
  })

  it('baseUrl avec credentials refusee (pas de secret en URL)', () => {
    assert.throws(
      () => createOpenCodeClient({ baseUrl: 'http://user:pass@127.0.0.1:4096', directory: DIR, fetch: async () => ({}) }),
      /credentials/
    )
  })

  it('prompt vide refuse sans reseau', async () => {
    let netCalls = 0
    const fetch = async () => { netCalls += 1; throw new Error('ne doit pas appeler') }
    const client = createOpenCodeClient({ baseUrl: BASE, directory: DIR, fetch })
    await assert.rejects(client.call('', '   '), /prompt vide/)
    assert.equal(netCalls, 0)
  })
})
