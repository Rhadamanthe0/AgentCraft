'use strict'

// Tests du transport LLM partage (bot/llm.js) : compatibilite `/chat/completions`
// inchangee + nouveau chemin `/responses` pour Muse Go. Tout le reseau est
// simule (fetch moque) : aucun appel distant, aucun secret.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const llm = require('../bot/llm')

const BASE = 'https://opencode.ai/zen/go/v1'
const ZH = { 'user-agent': 'minecraft-bot/1.0', 'x-opencode-session': 's-test' }

describe('options dual : protocoles separes et modele renvoye', () => {
  it('chat transporte thinking disabled seulement', async () => {
    mockFetch(() => okJson({ model: 'mimo-v2.6-flash', choices: [{ message: { content: '{}' } }] }))
    const result = await llm.call('sys', '{}', { baseUrl: BASE, model: 'mimo-v2.6-flash', protocol: 'chat',
      thinking: { type: 'disabled' }, reasoning: { effort: 'xhigh' }, maxTokens: 4096 })
    assert.deepEqual(seen.body.thinking, { type: 'disabled' })
    assert.equal(seen.body.reasoning, undefined)
    assert.equal(seen.body.max_output_tokens, undefined)
    assert.equal(result.responseModel, 'mimo-v2.6-flash')
  })
  it('responses transporte reasoning xhigh seulement, modele absent reste null', async () => {
    mockFetch(() => okJson({ output_text: '{}' }))
    const result = await llm.call('sys', '{}', { baseUrl: BASE, model: 'muse-spark-1.3-contributor', protocol: 'responses',
      reasoning: { effort: 'xhigh' }, thinking: { type: 'disabled' }, maxTokens: 16384 })
    assert.deepEqual(seen.body.reasoning, { effort: 'xhigh' })
    assert.equal(seen.body.thinking, undefined)
    assert.equal(seen.body.max_tokens, undefined)
    assert.equal(seen.body.max_output_tokens, 16384)
    assert.equal(result.responseModel, null)
  })
})

let realFetch
let seen

function mockFetch (impl) {
  seen = {}
  global.fetch = async (url, init = {}) => {
    seen.url = String(url)
    seen.init = init
    seen.body = init.body ? JSON.parse(init.body) : null
    return impl(url, init)
  }
}

function okJson (payload) {
  return { ok: true, status: 200, json: async () => payload }
}

function httpError (status, text) {
  return { ok: false, status, text: async () => text }
}

function abortingFetch () {
  return (url, init = {}) => new Promise((_, reject) => {
    const onAbort = () => {
      const err = new Error('aborted')
      err.name = 'AbortError'
      reject(err)
    }
    if (init.signal?.aborted) return onAbort()
    init.signal?.addEventListener('abort', onAbort, { once: true })
  })
}

beforeEach(() => { realFetch = global.fetch })
afterEach(() => { global.fetch = realFetch })

describe('llm.call : chemin chat inchange (DeepSeek)', () => {
  it('POST /chat/completions avec headers Go, response_format et usage', async () => {
    mockFetch(async () => okJson({
      choices: [{ message: { content: '{"fini":0}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10 }
    }))
    const res = await llm.call('sys', 'jeu', {
      baseUrl: BASE, apiKey: 'K', model: 'deepseek-v4.1-flash',
      maxTokens: 400, timeoutMs: 2000, headers: ZH
    })
    assert.equal(seen.url, `${BASE}/chat/completions`)
    assert.equal(seen.init.headers.authorization, 'Bearer K')
    assert.equal(seen.init.headers['x-opencode-session'], 's-test')
    assert.equal(seen.body.model, 'deepseek-v4.1-flash')
    assert.deepEqual(seen.body.messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'jeu' }])
    assert.deepEqual(seen.body.response_format, { type: 'json_object' })
    assert.equal(res.content, '{"fini":0}')
    assert.deepEqual(res.usage, { prompt_tokens: 10 })
    assert.equal(typeof res.ms, 'number')
  })

  it('image jointe en tableau text + image_url', async () => {
    mockFetch(async () => okJson({ choices: [{ message: { content: '{}' } }] }))
    await llm.call('sys', 'jeu', {
      baseUrl: BASE, model: 'deepseek-v4.1-flash', image: 'data:image/png;base64,AAA'
    })
    assert.ok(Array.isArray(seen.body.messages[1].content))
    assert.deepEqual(seen.body.messages[1].content, [
      { type: 'text', text: 'jeu' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }
    ])
  })

  it('troncature finish length rejetee (pas de plan)', async () => {
    mockFetch(async () => okJson({ choices: [{ message: { content: '{"fini":' }, finish_reason: 'length' }] }))
    await assert.rejects(
      llm.call('s', 'u', { baseUrl: BASE, model: 'deepseek-v4.1-flash' }),
      /tronquee/
    )
  })

  it('texte vide rejete', async () => {
    mockFetch(async () => okJson({ choices: [{ message: { content: '   ' } }] }))
    await assert.rejects(
      llm.call('s', 'u', { baseUrl: BASE, model: 'deepseek-v4.1-flash' }),
      /sans contenu/
    )
  })
})

describe('llm.call : chemin responses (Muse Go)', () => {
  const responsesOk = {
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: '{"fini":0}' }] }],
    usage: { input_tokens: 5 }
  }

  it('option protocol explicite -> POST /responses, input + max_output_tokens', async () => {
    mockFetch(async () => okJson(responsesOk))
    const res = await llm.call('sys', 'jeu', {
      baseUrl: BASE, apiKey: 'K', model: 'n-importe-quel-modele',
      protocol: 'responses', maxTokens: 2000, timeoutMs: 2000, headers: ZH
    })
    assert.equal(seen.url, `${BASE}/responses`)
    assert.equal(seen.init.headers.authorization, 'Bearer K')
    assert.equal(seen.init.headers['x-opencode-session'], 's-test')
    assert.equal(seen.body.model, 'n-importe-quel-modele')
    assert.equal(seen.body.max_output_tokens, 2000)
    assert.ok(!('max_tokens' in seen.body))
    assert.ok(!('keep_alive' in seen.body))
    assert.deepEqual(seen.body.text, { format: { type: 'json_object' } })
    assert.deepEqual(seen.body.input, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'jeu' }])
    assert.equal(res.content, '{"fini":0}')
  })

  it('detection auto muse-spark-1.3-contributor sans option -> /responses', async () => {
    mockFetch(async () => okJson(responsesOk))
    await llm.call('s', 'u', { baseUrl: BASE, model: 'muse-spark-1.3-contributor' })
    assert.equal(seen.url, `${BASE}/responses`)
  })

  it('detection auto : deepseek sans option reste sur /chat/completions', async () => {
    mockFetch(async () => okJson({ choices: [{ message: { content: '{}' } }] }))
    await llm.call('s', 'u', { baseUrl: BASE, model: 'deepseek-v4.1-flash' })
    assert.equal(seen.url, `${BASE}/chat/completions`)
  })

  it('option chat explicite gagne sur detection muse -> /chat/completions', async () => {
    mockFetch(async () => okJson({ choices: [{ message: { content: '{}' } }] }))
    await llm.call('s', 'u', { baseUrl: BASE, model: 'muse-spark-1.3-contributor', protocol: 'chat' })
    assert.equal(seen.url, `${BASE}/chat/completions`)
  })

  it('image responses en input_text + input_image', async () => {
    mockFetch(async () => okJson(responsesOk))
    await llm.call('sys', 'jeu', {
      baseUrl: BASE, model: 'muse-spark-1.3-contributor', image: 'data:image/png;base64,AAA'
    })
    assert.deepEqual(seen.body.input[1].content, [
      { type: 'input_text', text: 'jeu' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAA' }
    ])
  })

  it('plusieurs parties output_text concatenees', async () => {
    mockFetch(async () => okJson({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"a":' }, { type: 'output_text', text: '1}' }] }]
    }))
    const res = await llm.call('s', 'u', { baseUrl: BASE, model: 'muse-spark-1.3-contributor' })
    assert.equal(res.content, '{"a":1}')
  })

  it('reponse incomplete rejetee', async () => {
    mockFetch(async () => okJson({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }))
    await assert.rejects(
      llm.call('s', 'u', { baseUrl: BASE, model: 'muse-spark-1.3-contributor' }),
      /incomplete/
    )
  })

  it('texte vide responses rejete', async () => {
    mockFetch(async () => okJson({ status: 'completed', output: [] }))
    await assert.rejects(
      llm.call('s', 'u', { baseUrl: BASE, model: 'muse-spark-1.3-contributor' }),
      /sans contenu/
    )
  })
})

describe('llm.call : erreurs, annulation, timeout (les deux endpoints)', () => {
  it('HTTP 401 structuree sans secret', async () => {
    mockFetch(async () => httpError(401, 'Unauthorized: bad key'))
    await assert.rejects(
      llm.call('s', 'u', { baseUrl: BASE, apiKey: 'SECRET', model: 'deepseek-v4.1-flash' }),
      (err) => {
        assert.match(err.message, /HTTP 401/)
        assert.doesNotMatch(err.message, /SECRET/)
        return true
      }
    )
  })

  it('panne passagere (503) : un reessai, signale a l appelant par onRetry', async () => {
    let fetches = 0
    let retries = 0
    mockFetch(async () => (++fetches === 1
      ? httpError(503, 'Endpoint is unavailable')
      : okJson({ choices: [{ message: { content: '{"ok":1}' }, finish_reason: 'stop' }] })))
    const r = await llm.call('s', 'u', { baseUrl: BASE, model: 'deepseek-v4.1-flash', onRetry: () => { retries += 1 } })
    assert.equal(r.content, '{"ok":1}')
    assert.equal(fetches, 2)
    assert.equal(retries, 1)
  })

  it('HTTP 503 responses sans secret', async () => {
    mockFetch(async () => httpError(503, 'Endpoint is unavailable'))
    await assert.rejects(
      llm.call('s', 'u', { baseUrl: BASE, apiKey: 'SECRET', model: 'muse-spark-1.3-contributor' }),
      (err) => {
        assert.match(err.message, /HTTP 503/)
        assert.doesNotMatch(err.message, /SECRET/)
        return true
      }
    )
  })

  it('signal deja aborte -> appel annule', async () => {
    mockFetch(abortingFetch())
    const c = new AbortController()
    c.abort()
    await assert.rejects(
      llm.call('s', 'u', { baseUrl: BASE, model: 'deepseek-v4.1-flash', signal: c.signal, timeoutMs: 1000 }),
      /appel annule/
    )
  })

  it('abort pendant l appel -> appel annule (pas timeout)', async () => {
    mockFetch(abortingFetch())
    const c = new AbortController()
    setTimeout(() => c.abort(), 10)
    await assert.rejects(
      llm.call('s', 'u', { baseUrl: BASE, model: 'muse-spark-1.3-contributor', signal: c.signal, timeoutMs: 2000 }),
      /appel annule/
    )
  })

  it('timeout sans signal -> pas de reponse en N ms', async () => {
    mockFetch(abortingFetch())
    await assert.rejects(
      llm.call('s', 'u', { baseUrl: BASE, model: 'deepseek-v4.1-flash', timeoutMs: 30 }),
      /pas de reponse en 30 ms/
    )
  })
})

describe('llm.parseJson : JSON enveloppe', () => {
  it('phrase autour + bloc ```json', () => {
    const out = llm.parseJson('voici le plan : ```json\n{"fini":0}\n```')
    assert.deepEqual(out, { fini: 0 })
  })

  it('objet nu toujours lu', () => {
    assert.deepEqual(llm.parseJson('{"a":1}'), { a: 1 })
  })
})

describe('audit : headers proteges, slash, ecoute, typage', () => {
  it('headers hostiles ignores (casse mixte), autres passes', async () => {
    mockFetch(async () => okJson({ choices: [{ message: { content: '{}' } }] }))
    await llm.call('s', 'u', {
      baseUrl: BASE,
      apiKey: 'K',
      model: 'deepseek-v4.1-flash',
      headers: {
        'Content-Type': 'text/plain',
        AUTHORIZATION: 'Bearer evil',
        'X-Custom': 'ok'
      }
    })
    const sent = seen.init.headers
    assert.equal(sent['content-type'], 'application/json')
    assert.equal(sent.authorization, 'Bearer K')
    assert.equal(sent['X-Custom'], 'ok')
    assert.ok(!('Content-Type' in sent))
    assert.ok(!('AUTHORIZATION' in sent))
  })

  it('trailing slash baseUrl sans double slash (chat + responses)', async () => {
    mockFetch(async () => okJson({ choices: [{ message: { content: '{}' } }] }))
    await llm.call('s', 'u', { baseUrl: `${BASE}/`, model: 'deepseek-v4.1-flash' })
    assert.equal(seen.url, `${BASE}/chat/completions`)
    mockFetch(async () => okJson({ status: 'completed', output: [] }))
    await assert.rejects(
      llm.call('s', 'u', { baseUrl: `${BASE}///`, model: 'muse-spark-1.3-contributor' }),
      /sans contenu/
    )
    assert.equal(seen.url, `${BASE}/responses`)
  })

  it('fetch reject reseau -> message d origine + code LLM_NETWORK, sans status', async () => {
    const failure = new TypeError('fetch failed')
    mockFetch(() => Promise.reject(failure))
    await assert.rejects(
      llm.call('s', 'u', { baseUrl: BASE, model: 'deepseek-v4.1-flash' }),
      (err) => {
        assert.match(err.message, /fetch failed/)
        assert.equal(err.code, 'LLM_NETWORK')
        assert.ok(!('status' in err))
        return true
      }
    )
  })

  it('response.json malforme -> code LLM_BAD_RESPONSE + status', async () => {
    mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token <') }
    }))
    await assert.rejects(
      llm.call('s', 'u', { baseUrl: BASE, model: 'deepseek-v4.1-flash' }),
      (err) => {
        assert.match(err.message, /JSON de transport/)
        assert.equal(err.code, 'LLM_BAD_RESPONSE')
        assert.equal(err.status, 200)
        return true
      }
    )
  })

  it('listener abort retire apres succes (retour niveau initial)', async () => {
    mockFetch(async () => okJson({ choices: [{ message: { content: '{}' } }] }))
    const c = new AbortController()
    const sig = c.signal
    let added = 0
    let removed = 0
    const origAdd = sig.addEventListener.bind(sig)
    const origRemove = sig.removeEventListener.bind(sig)
    sig.addEventListener = (...args) => { added += 1; return origAdd(...args) }
    sig.removeEventListener = (...args) => { removed += 1; return origRemove(...args) }
    await llm.call('s', 'u', { baseUrl: BASE, model: 'deepseek-v4.1-flash', signal: sig })
    assert.equal(added, 1)
    assert.equal(removed, 1)
  })

  it('listener abort retire aussi apres abort pendant l appel', async () => {
    mockFetch(abortingFetch())
    const c = new AbortController()
    const sig = c.signal
    let removed = 0
    const origRemove = sig.removeEventListener.bind(sig)
    sig.removeEventListener = (...args) => { removed += 1; return origRemove(...args) }
    setTimeout(() => c.abort(), 10)
    await assert.rejects(
      llm.call('s', 'u', { baseUrl: BASE, model: 'deepseek-v4.1-flash', signal: sig, timeoutMs: 2000 }),
      /appel annule/
    )
    assert.equal(removed, 1)
  })

  it('HTTP 500 -> code LLM_HTTP + status, message preserve', async () => {
    mockFetch(async () => httpError(500, 'boom'))
    await assert.rejects(
      llm.call('s', 'u', { baseUrl: BASE, model: 'deepseek-v4.1-flash' }),
      (err) => {
        assert.match(err.message, /HTTP 500 : boom/)
        assert.equal(err.code, 'LLM_HTTP')
        assert.equal(err.status, 500)
        return true
      }
    )
  })

  it('timeout type LLM_TIMEOUT, abort type LLM_ABORTED (messages inchanges)', async () => {
    mockFetch(abortingFetch())
    await assert.rejects(
      llm.call('s', 'u', { baseUrl: BASE, model: 'deepseek-v4.1-flash', timeoutMs: 30 }),
      (err) => {
        assert.match(err.message, /pas de reponse en 30 ms/)
        assert.equal(err.code, 'LLM_TIMEOUT')
        return true
      }
    )
    const c = new AbortController()
    c.abort()
    await assert.rejects(
      llm.call('s', 'u', { baseUrl: BASE, model: 'deepseek-v4.1-flash', signal: c.signal }),
      (err) => {
        assert.match(err.message, /appel annule/)
        assert.equal(err.code, 'LLM_ABORTED')
        return true
      }
    )
  })

  it('texte-plan invalide (parseJson) sans code : pas une indisponibilite', () => {
    assert.throws(
      () => llm.parseJson('pas du json du tout'),
      (err) => {
        assert.match(err.message, /pas de JSON/)
        assert.equal(err.code, undefined)
        return true
      }
    )
  })

  it('contenu "pas de plan" sans code : non reclasse reseau', async () => {
    mockFetch(async () => okJson({ choices: [{ message: { content: '   ' } }] }))
    await assert.rejects(
      llm.call('s', 'u', { baseUrl: BASE, model: 'deepseek-v4.1-flash' }),
      (err) => {
        assert.match(err.message, /sans contenu/)
        assert.equal(err.code, undefined)
        return true
      }
    )
  })
})
