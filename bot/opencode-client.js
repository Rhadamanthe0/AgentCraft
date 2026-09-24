'use strict'

// Client d inference Astra via OpenCode Desktop existant, sans outil integre.
//
// Perimetre strict : ce module ne fait qu appeler le serveur Desktop deja
// present (audite en 1.18.32). Il ne lit jamais auth.json, ne liste aucun
// processus, n ouvre aucun binding Desktop, ne lit aucune variable
// d environnement et ne decide d aucune route : baseUrl, auth Basic et
// directory sont INJECTES par l appelant (options de la factory).
//
// Endpoints prouves par l auditeur (tous avec ?directory=) :
//   POST /session
//     {title, model:{id,providerID,variant},
//      permission:[{permission:'*',pattern:'*',action:'deny'}]}
//   GET /experimental/tool/ids -> liste dynamique (~15 ids)
//   POST /session/{id}/message
//     {model:{providerID,modelID}, variant, tools:{<id>:false,...},
//      parts:[{type:'text',text:prompt}]}
//     reponse {info, parts:[step-start, text, step-finish, ...]}
//   POST /session/{id}/abort (si annulation, borne)
//   DELETE /session/{id} (cleanup systematique borne, meme en echec)
//
// Garanties :
// - session isolee par call() : creation + message + DELETE borne en finally.
//   Le nettoyage utilise un AbortController DEDIE + timer cleanupTimeoutMs :
//   il n utilise jamais le signal principal (deja aborte) et ne pend jamais.
//   Si l endpoint ignore l abort, la course reste bornee (IO non physique) et
//   la session orpheline est EXPOSEE (cleanupFailed=true + sessionId) pour
//   remediation, sans secret et sans masquer l erreur principale.
// - AUCUN retry : une seule tentative par endpoint, jamais de boucle.
// - outils TOUS refuses : permission deny-all a la creation (FILET, meme si le
//   cache toolIDs est perime) + tools {id:false} explicites au message.
//   Liste vide ou illisible => REFUS avant message, jamais tools:{}.
//   Cache memoire court (toolIdsTtlMs) : le deny-all de creation reste le filet.
// - info.error (string ou objet) avec ou sans texte => ERREUR, jamais success.
//   Extraction whitelist (code/message seuls), secrets redactes.
// - les parties non-texte de la reponse (outils, step-start/finish, ...) sont
//   IGNOREES et jamais executees localement.
// - le module rend {content, usage, ms, cleanupFailed, sessionId} : le parsing
//   JSON appartient a l appelant (llm.parseJson), jamais ici.
// - auth Basic jamais journalisee ni recopiee dans les messages d erreur.
// - baseUrl jamais fournie par le modele : option explicite, limitee au
//   loopback sauf allowNonLoopback explicite.
// - abort (signal externe ou timeout) : POST abort borne best-effort puis
//   DELETE borne ; si l abort arrive pendant le create, le cleanup a lieu des
//   que l ID arrive (ID tardif).
//
// Aucun appel reseau live ici : les tests injectent un fetch moque.
// Le bridge hote/production reste une question NON resolue : ce module est
// fonctionnel quand il tourne dans un process ayant acces au loopback du
// Desktop ; aucun claim que le conteneur atteigne 127.0.0.1 de l hote.

const DEFAULT_MODEL_ID = 'gpt-6-astra'
const DEFAULT_PROVIDER_ID = 'openai'
const DEFAULT_VARIANT = 'high'
const DEFAULT_TITLE = 'minecraft-bot'
const DEFAULT_TIMEOUT_MS = 60000
const DEFAULT_TOOL_IDS_TTL_MS = 30000
const DEFAULT_CLEANUP_TIMEOUT_MS = 3000

function isLoopbackHostname (hostname) {
  const h = String(hostname ?? '').toLowerCase()
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true
  return false
}

function sanitizeBaseUrl (baseUrl, allowNonLoopback) {
  if (!baseUrl || typeof baseUrl !== 'string') {
    throw new Error('client opencode mal configure (baseUrl manquante)')
  }
  if (baseUrl.includes('@')) {
    throw new Error('client opencode mal configure (baseUrl avec credentials refusee)')
  }
  let parsed
  try {
    parsed = new URL(baseUrl)
  } catch (_) {
    throw new Error('client opencode mal configure (baseUrl invalide)')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('client opencode mal configure (baseUrl http(s) requise)')
  }
  if (!allowNonLoopback && !isLoopbackHostname(parsed.hostname)) {
    throw new Error('client opencode refuse : hote non-loopback sans allowNonLoopback explicite')
  }
  return String(baseUrl).replace(/\/+$/, '')
}

function buildAuthHeader (username, password) {
  if (username == null && password == null) return null
  if (!username || !password) {
    throw new Error('client opencode mal configure (username/password incomplets)')
  }
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
}

// Redaction anti-secret (whitelist) : on ne recopie jamais un materiel
// d auth dans un message d erreur, meme si le serveur le renvoyait.
function redactSecrets (text) {
  return String(text ?? '')
    .replace(/Basic\s+[A-Za-z0-9+/=]{8,}/g, 'Basic [redacted]')
    .replace(/Bearer\s+[^\s"'{}]+/g, 'Bearer [redacted]')
    .replace(/password\s*[:=]\s*[^\s"'{}]+/gi, 'password:[redacted]')
    .replace(/api[_-]?key\s*[:=]\s*[^\s"'{}]+/gi, 'api_key:[redacted]')
    .slice(0, 200)
}

// Jamais d auth dans les erreurs : statut + extrait redacte, jamais les
// en-tetes ni la cle.
function httpError (status, detail) {
  const err = new Error(`opencode HTTP ${status} : ${redactSecrets(detail)}`)
  err.code = 'OPENCODE_HTTP'
  err.status = status
  return err
}

function typedError (message, code) {
  const err = new Error(message)
  err.code = code
  return err
}

function extractSessionId (body) {
  if (!body || typeof body !== 'object') return null
  if (typeof body.id === 'string' && body.id) return body.id
  if (typeof body.sessionID === 'string' && body.sessionID) return body.sessionID
  if (typeof body.sessionId === 'string' && body.sessionId) return body.sessionId
  if (body.session && typeof body.session.id === 'string' && body.session.id) return body.session.id
  if (body.info && typeof body.info.id === 'string' && body.info.id) return body.info.id
  return null
}

function extractToolIds (body) {
  const raw = Array.isArray(body) ? body : body?.ids
  if (!Array.isArray(raw)) {
    // Forme inattendue : on refuse plutot qu inventer des ids.
    throw typedError('liste d outils illisible', 'OPENCODE_BAD_RESPONSE')
  }
  return raw.filter((id) => typeof id === 'string' && id.length > 0)
}

// info.error (string ou objet) => erreur modele, meme si du texte est present.
// Extraction whitelist : seuls code/message sont repris, redactes et bornes.
// Le reste de l objet (potentiellement sensible) est ignore.
function assertNoModelError (body) {
  const raw = body?.info?.error
  if (raw == null || raw === '' || raw === false) return
  let code = 'OPENCODE_MODEL_ERROR'
  let message = ''
  if (typeof raw === 'string') {
    message = raw
  } else if (typeof raw === 'object') {
    if (typeof raw.code === 'string' && raw.code) code = raw.code.slice(0, 80)
    const candidate = raw.message ?? raw.text ?? raw.error
    if (typeof candidate === 'string' && candidate) message = candidate
    else {
      try { message = JSON.stringify({ code: raw.code ?? null, message: raw.message ?? null }) } catch (_) { message = 'erreur modele' }
    }
  } else {
    message = String(raw)
  }
  const err = typedError(`opencode erreur modele : ${redactSecrets(message) || 'inconnue'}`, code === 'OPENCODE_MODEL_ERROR' ? 'OPENCODE_MODEL_ERROR' : 'OPENCODE_MODEL_ERROR')
  err.modelCode = String(code).slice(0, 80)
  throw err
}

// Ne garde que le texte : les effets outils (parties non-texte) sont rejetes,
// jamais executes localement.
function extractText (body) {
  const parts = Array.isArray(body?.parts) ? body.parts : null
  if (!parts) throw typedError('reponse sans contenu', 'OPENCODE_EMPTY')
  const texts = []
  for (const part of parts) {
    if (part && part.type === 'text' && typeof part.text === 'string' && part.text) {
      texts.push(part.text)
    }
  }
  const content = texts.join('')
  if (!content.trim()) throw typedError('reponse sans contenu', 'OPENCODE_EMPTY')
  return content
}

function extractUsage (body) {
  if (!body || typeof body !== 'object') return null
  return body?.info?.tokens ?? body?.info?.usage ?? body?.usage ?? null
}

function createOpenCodeClient (options = {}) {
  const {
    baseUrl,
    username = null,
    password = null,
    directory,
    fetch: fetchImpl = null,
    modelId = DEFAULT_MODEL_ID,
    providerId = DEFAULT_PROVIDER_ID,
    variant = DEFAULT_VARIANT,
    title = DEFAULT_TITLE,
    toolIdsTtlMs = DEFAULT_TOOL_IDS_TTL_MS,
    cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
    allowNonLoopback = false
  } = options

  const base = sanitizeBaseUrl(baseUrl, allowNonLoopback)
  if (!directory || typeof directory !== 'string' || !directory.trim()) {
    throw new Error('client opencode mal configure (directory manquant)')
  }
  if (!Number.isFinite(Number(cleanupTimeoutMs)) || Number(cleanupTimeoutMs) <= 0) {
    throw new Error('client opencode mal configure (cleanupTimeoutMs invalide)')
  }
  const cleanupBudget = Number(cleanupTimeoutMs)
  const authHeader = buildAuthHeader(username, password)
  const doFetch = fetchImpl || globalThis.fetch
  if (typeof doFetch !== 'function') throw new Error('client opencode mal configure (fetch indisponible)')

  // Cache memoire court des ids d outils. Le FILET reste la permission
  // deny-all posee a la creation de session : meme avec un cache perime, le
  // serveur refuse tout effet outil. TTL actualise a chaque refresh reussi.
  const toolCache = { ids: null, at: 0 }

  function urlFor (path) {
    return `${base}${path}?directory=${encodeURIComponent(directory)}`
  }

  function sessionMessageUrl (sessionId) {
    return `${base}/session/${encodeURIComponent(sessionId)}/message?directory=${encodeURIComponent(directory)}`
  }

  function sessionAbortUrl (sessionId) {
    return `${base}/session/${encodeURIComponent(sessionId)}/abort?directory=${encodeURIComponent(directory)}`
  }

  function sessionUrl (sessionId) {
    return `${base}/session/${encodeURIComponent(sessionId)}?directory=${encodeURIComponent(directory)}`
  }

  function headersFor (extra) {
    const headers = { 'content-type': 'application/json' }
    if (authHeader) headers.authorization = authHeader
    if (extra) {
      for (const [key, value] of Object.entries(extra)) {
        if (String(key).toLowerCase() === 'authorization') continue
        if (String(key).toLowerCase() === 'content-type') continue
        headers[key] = value
      }
    }
    return headers
  }

  async function readJson (response) {
    try {
      return await response.json()
    } catch (_) {
      throw typedError('reponse illisible (JSON de transport invalide)', 'OPENCODE_BAD_RESPONSE')
    }
  }

  // Chemin principal : une seule tentative, aucun retry, aucune boucle.
  async function postJson (url, payload, signal) {
    let response
    try {
      response = await doFetch(url, {
        method: 'POST',
        signal,
        headers: headersFor(),
        body: JSON.stringify(payload)
      })
    } catch (err) {
      if (err?.name === 'AbortError') throw err
      const net = new Error(`opencode reseau : ${redactSecrets(err?.message ?? err).slice(0, 120)}`)
      net.code = 'OPENCODE_NETWORK'
      throw net
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw httpError(response.status, detail)
    }
    return readJson(response)
  }

  async function fetchToolIds (signal) {
    const now = Date.now()
    if (toolCache.ids && (now - toolCache.at) < toolIdsTtlMs) {
      if (toolCache.ids.length === 0) throw typedError('liste d outils vide (refus)', 'OPENCODE_NO_TOOLS')
      return toolCache.ids
    }
    let response
    try {
      response = await doFetch(urlFor('/experimental/tool/ids'), {
        method: 'GET',
        signal,
        headers: headersFor()
      })
    } catch (err) {
      if (err?.name === 'AbortError') throw err
      const net = new Error(`opencode reseau : ${redactSecrets(err?.message ?? err).slice(0, 120)}`)
      net.code = 'OPENCODE_NETWORK'
      throw net
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw httpError(response.status, detail)
    }
    const body = await readJson(response)
    const ids = extractToolIds(body)
    if (ids.length === 0) throw typedError('liste d outils vide (refus)', 'OPENCODE_NO_TOOLS')
    toolCache.ids = ids
    toolCache.at = Date.now()
    return ids
  }

  async function createSession (signal) {
    const body = await postJson(urlFor('/session'), {
      title,
      model: { id: modelId, providerID: providerId, variant },
      permission: [{ permission: '*', pattern: '*', action: 'deny' }]
    }, signal)
    const id = extractSessionId(body)
    if (!id) throw typedError('session sans identifiant', 'OPENCODE_BAD_RESPONSE')
    return id
  }

  async function sendMessage (sessionId, prompt, toolIds, signal) {
    const tools = {}
    for (const id of toolIds) tools[id] = false
    return postJson(sessionMessageUrl(sessionId), {
      model: { providerID: providerId, modelID: modelId },
      variant,
      tools,
      parts: [{ type: 'text', text: prompt }]
    }, signal)
  }

  // Nettoyage BORNE : AbortController dedie + timer propre, jamais le signal
  // principal (deja aborte). Ne leve jamais, ne retry jamais : retourne
  // {ok}. Si l endpoint ignore l abort, la course reste bornee par un race
  // (acceptable : DELETE/abort sont des IO non physiques, aucun effet monde) ;
  // l appelant expose alors l orpheline via cleanupFailed/sessionId.
  async function cleanupRequest (url, init) {
    const c = new AbortController()
    let timer = null
    const timeoutP = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { c.abort() } catch (_) { /* ignore */ }
        const err = new Error('cleanup timeout')
        err.name = 'AbortError'
        reject(err)
      }, cleanupBudget)
    })
    try {
      const res = await Promise.race([
        doFetch(url, { ...init, signal: c.signal }),
        timeoutP
      ])
      return { ok: !!res?.ok, status: res?.status ?? null }
    } catch (_) {
      return { ok: false, status: null }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function abortSession (sessionId) {
    return cleanupRequest(sessionAbortUrl(sessionId), { method: 'POST', headers: headersFor() })
  }

  async function deleteSession (sessionId) {
    return cleanupRequest(sessionUrl(sessionId), { method: 'DELETE', headers: headersFor() })
  }

  // Appel isole : {content, usage, ms, cleanupFailed, sessionId}. Le parsing
  // JSON (llm.parseJson) vit chez l appelant. En cas d orpheline (DELETE borne
  // en echec), cleanupFailed=true + sessionId pour remediation, sans secret et
  // sans masquer l erreur principale (annotee, pas remplacee).
  async function call (system, user, opts = {}) {
    const { signal: externalSignal = null, timeoutMs = DEFAULT_TIMEOUT_MS } = opts
    const prompt = system ? `${String(system)}\n\n${String(user ?? '')}` : String(user ?? '')
    if (!prompt.trim()) throw typedError('prompt vide', 'OPENCODE_BAD_REQUEST')

    const controller = new AbortController()
    const onExternalAbort = () => controller.abort()
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort()
      else {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true })
        if (externalSignal.aborted) {
          externalSignal.removeEventListener('abort', onExternalAbort)
          controller.abort()
        }
      }
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const started = Date.now()
    const signal = controller.signal

    let sessionId = null
    let result = null
    let mainError = null
    let abortAttempted = false

    // POST abort borne, une seule fois par call (aucun retry en boucle) :
    // les chemins abort (create tardif, message, catch AbortError) partagent
    // ce garde pour ne jamais spammer l endpoint.
    async function abortOnce () {
      if (abortAttempted || !sessionId) return
      abortAttempted = true
      await abortSession(sessionId)
    }

    try {
      const toolIds = await fetchToolIds(signal)
      sessionId = await createSession(signal)
      // Abort tombe pendant le create : l ID vient d arriver tard, on
      // previent le serveur (borne) puis on sort en cleanup (pas de message).
      if (signal.aborted) {
        await abortOnce()
        if (externalSignal?.aborted) mainError = typedError('appel annule', 'OPENCODE_ABORTED')
        else mainError = typedError(`pas de reponse en ${timeoutMs} ms`, 'OPENCODE_TIMEOUT')
      } else {
        let answer
        try {
          answer = await sendMessage(sessionId, prompt, toolIds, signal)
        } catch (err) {
          if (signal.aborted) await abortOnce()
          throw err
        }
        if (signal.aborted) {
          await abortOnce()
          if (externalSignal?.aborted) mainError = typedError('appel annule', 'OPENCODE_ABORTED')
          else mainError = typedError(`pas de reponse en ${timeoutMs} ms`, 'OPENCODE_TIMEOUT')
        } else {
          assertNoModelError(answer)
          const content = extractText(answer)
          result = { content, usage: extractUsage(answer), ms: Date.now() - started }
        }
      }
    } catch (err) {
      if (err?.name === 'AbortError') {
        // Course abort/timeout du chemin principal : POST abort borne unique
        // via abortOnce quand l ID est connu ; ici on normalise seulement.
        if (sessionId) await abortOnce()
        if (externalSignal?.aborted) mainError = typedError('appel annule', 'OPENCODE_ABORTED')
        else mainError = typedError(`pas de reponse en ${timeoutMs} ms`, 'OPENCODE_TIMEOUT')
      } else {
        mainError = err
      }
    } finally {
      clearTimeout(timer)
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort)
      let cleanupOk = true
      if (sessionId) {
        const del = await deleteSession(sessionId)
        cleanupOk = !!del.ok
      }
      if (mainError) {
        // N expose l ID que si orpheline : remediation ciblee, sans secret.
        mainError.cleanupFailed = !cleanupOk
        mainError.sessionId = cleanupOk ? null : sessionId
        throw mainError
      }
      result.cleanupFailed = !cleanupOk
      result.sessionId = cleanupOk ? null : sessionId
      return result
    }
  }

  return { call }
}

module.exports = {
  createOpenCodeClient,
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  DEFAULT_VARIANT,
  DEFAULT_TITLE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_CLEANUP_TIMEOUT_MS
}
