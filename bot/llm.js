'use strict'

// Transport LLM partage : un seul endroit parle les protocoles
// `/chat/completions` (defaut), `/responses` (gpt-*, muse-spark) et
// `/messages` (claude-*, format Anthropic), et un seul endroit sait lire un
// JSON de modele. La sonde des modeles du banc (ci/model-probe.js) le reutilise.
//
// Ce module ne connait ni modele, ni URL, ni cle : tout est passe par l appelant.
// Il reste volontairement sans etat, hors du fetch. Il ne reessaie jamais : les
// rejeux (meme modele, autre cle) appartiennent aux appelants (planner.js,
// model-chain.js), pas au transport.

// Detection sure du protocole quand l appelant ne precise rien : seul
// `muse-spark` (insensible a la casse, avec ou sans suffixe) bascule sur
// `/responses`. Tout le reste — dont `deepseek-v4.1-flash` — reste sur
// `/chat/completions`, a l identique d avant. Une option explicite gagne
// toujours sur cette detection.
const RESPONSES_MODEL_RE = /muse-spark/i
// Les modeles Claude (claude-haiku-5-5 au gateway Go) ne sont servis que sur
// `/messages` (format Anthropic) : ce protocole prime sur toute option.
const MESSAGES_MODEL_RE = /^claude-/i
// Les modeles GPT (gpt-6-luna au gateway Go) ne sont servis que sur
// `/responses`, sans temperature (modele a raisonnement) : idem, prime.
const GPT_MODEL_RE = /^gpt-/i

function resolveProtocol (model, protocol) {
  if (MESSAGES_MODEL_RE.test(String(model ?? ''))) return 'messages'
  if (GPT_MODEL_RE.test(String(model ?? ''))) return 'responses'
  if (protocol === 'responses' || protocol === 'chat') return protocol
  return RESPONSES_MODEL_RE.test(String(model ?? '')) ? 'responses' : 'chat'
}

// Usage `/messages` ramene a la forme OpenAI lue par le planificateur :
// `input_tokens` n y compte pas le cache, d ou la somme. Les ecritures de
// cache (facturees a part chez Anthropic) restent dans `cache_write_tokens`.
function messagesUsage (u) {
  if (!u) return null
  const read = u.cache_read_input_tokens ?? 0
  const write = u.cache_creation_input_tokens ?? 0
  return {
    prompt_tokens: (u.input_tokens ?? 0) + read + write,
    completion_tokens: u.output_tokens ?? 0,
    prompt_tokens_details: { cached_tokens: read },
    cache_write_tokens: write
  }
}

// Usage `/responses` (input_tokens, cache dans input_tokens_details) complete
// des champs OpenAI chat lus par le planificateur ; l original reste.
function responsesUsage (u) {
  if (!u || u.prompt_tokens != null) return u ?? null
  return {
    ...u,
    prompt_tokens: u.input_tokens ?? 0,
    completion_tokens: u.output_tokens ?? 0,
    prompt_tokens_details: { cached_tokens: u.input_tokens_details?.cached_tokens ?? 0 }
  }
}

// L API Responses ne rend pas `choices` : le texte utile vit dans les parties
// `output_text` des messages de `output` (ou, selon le fournisseur, dans le
// champ agrege `output_text`). On concatene toutes les parties, sans rien
// inventer quand il n y en a aucune.
function extractResponsesText (body) {
  if (typeof body?.output_text === 'string' && body.output_text.trim()) return body.output_text
  const out = Array.isArray(body?.output) ? body.output : []
  const parts = []
  for (const item of out) {
    const content = Array.isArray(item?.content) ? item.content : []
    for (const c of content) {
      if ((c?.type === 'output_text' || c?.type === 'text') && typeof c?.text === 'string' && c.text) {
        parts.push(c.text)
      }
    }
  }
  return parts.join('')
}

// Typage des erreurs pour le repli planificateur : le message reste la
// reference lisible (compat, dont le tri abort de planner.js sur message),
// et `code` (+ `status` quand il existe) permet un tri sans parser du texte.
// Seules les pannes de TRANSPORT sont typees : reseau, HTTP, JSON de
// transport, delai, annulation. Le texte-plan invalide (parseJson, APRES un
// call reussi) et les contenus "pas de plan" (vide, tronquee, incomplete)
// restent des erreurs SANS code : jamais une indisponibilite.
function typedError (message, code, status) {
  const err = new Error(message)
  err.code = code
  if (status !== undefined) err.status = status
  return err
}

// En-tetes proteges, comparaison insensible a la casse : le transport impose
// son JSON et son identite. Un overlay hostile (ou maladroit) ne peut ni
// changer le format ni voler la cle, quelle que soit la casse utilisee.
// Toute autre entree passe telle quelle, cle d origine conservee.
const PROTECTED_HEADERS = new Set(['content-type', 'authorization'])

function buildHeaders (apiKey, extraHeaders) {
  const headers = { 'content-type': 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      if (PROTECTED_HEADERS.has(String(key).toLowerCase())) continue
      headers[key] = value
    }
  }
  return headers
}

// Un baseUrl termine par `/` (copie depuis un navigateur, variable d env
// editee a la main) donnerait `.../v1//responses` : 404 ou routage perdu.
// On compacte les `/` finaux, jamais le reste.
function joinEndpoint (baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, '')}${path}`
}

async function isTransient (response) {
  if (response.status >= 500 || response.status === 429) return true
  if (response.status !== 400) return false
  try {
    return /upstream request failed/i.test(await response.clone().text())
  } catch (_) {
    return false
  }
}

async function call (system, user, options = {}) {
  const {
    baseUrl,
    apiKey = '',
    model,
    temperature = 0,
    maxTokens = 400,
    timeoutMs = 8000,
    // `keep_alive` est une extension d Ollama : un fournisseur qui valide son
    // schema strictement repondrait 400 sur un champ inconnu, donc l appelant ne
    // le fournit que pour un Ollama. Jamais envoye sur `/responses`.
    keepAlive = null,
    // En-tetes supplementaires propres au fournisseur. Le gateway OpenCode Zen
    // exige un User-Agent identifiable et un `x-opencode-session` stable (c est
    // ce dernier qui optimise le routage et le cache de prompt cote serveur).
    // Envoyes a l identique sur les deux endpoints.
    headers: extraHeaders = null,
    // Image jointe au message utilisateur, en data URL (`data:image/png;base64,...`).
    // Sur `/chat/completions`, le content devient un TABLEAU de parties texte +
    // image_url ; sur `/responses`, l entree devient `input_text` + `input_image`.
    // ATTENTION au cache de prompt : le message SYSTEME reste une chaine, donc le
    // prefixe mis en cache (couches 1-4 du planificateur) n est jamais invalide
    // par une image. Celle-ci vit uniquement dans le message utilisateur.
    image = null,
    signal = null,
    // Protocole explicite : 'chat' ou 'responses'. Absent : detection sure sur
    // le nom du modele (muse-spark -> responses, sinon chat).
    protocol = null,
    thinking = null,
    reasoning = null,
    // `reasoning_effort` (chat) : 'low' coupe ~80 % du raisonnement de
    // space-bunny-free (plan ~2 s au lieu de ~6 s, mesure 2026-09-26).
    reasoningEffort = null,
    // Called before the internal retry on a transient gateway failure, so the
    // caller can count every request actually sent.
    onRetry = null
  } = options

  if (!baseUrl || !model) throw new Error('transport LLM mal configure (baseUrl ou model manquant)')

  const proto = resolveProtocol(model, protocol)
  const endpoint = joinEndpoint(baseUrl, { responses: '/responses', messages: '/messages' }[proto] ?? '/chat/completions')

  const headers = buildHeaders(apiKey, extraHeaders)
  if (proto === 'messages') {
    headers['anthropic-version'] = '2023-06-01'
    if (apiKey) headers['x-api-key'] = apiKey
  }

  // Corps strictement separes par protocole : le chemin chat est inchange octet
  // pour octet (messages + response_format json_object) ; le chemin responses
  // porte l entree et demande aussi un objet JSON, sans `keep_alive`.
  let body
  if (proto === 'messages') {
    // Ni temperature (valeur non par defaut refusee en 400 par Claude Haiku
    // 5.5) ni response_format : le prompt exige deja un JSON, parseJson le lit.
    // Le systeme porte un point de cache : il est stable (piege 12).
    const data = image && /^data:([^;]+);base64,(.*)$/s.exec(image)
    const source = data ? { type: 'base64', media_type: data[1], data: data[2] } : { type: 'url', url: image }
    const userContent = image ? [{ type: 'image', source }, { type: 'text', text: user }] : user
    const effort = reasoningEffort ?? reasoning?.effort ?? null
    body = JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      ...(thinking ? { thinking } : {}),
      ...(effort && !thinking ? { output_config: { effort } } : {}),
      messages: [{ role: 'user', content: userContent }]
    })
  } else if (proto === 'responses') {
    const userContent = image
      ? [{ type: 'input_text', text: user }, { type: 'input_image', image_url: image }]
      : user
    // Le planificateur passe l effort en `reasoningEffort` (chat) pour un
    // modele qu il croit en chat : ramene en `reasoning.effort` ici.
    const effort = reasoning ?? (reasoningEffort ? { effort: reasoningEffort } : null)
    body = JSON.stringify({
      model,
      ...(GPT_MODEL_RE.test(model) ? {} : { temperature }),
      max_output_tokens: maxTokens,
      ...(effort ? { reasoning: effort } : {}),
      text: { format: { type: 'json_object' } },
      input: [
        { role: 'system', content: system },
        { role: 'user', content: userContent }
      ]
    })
  } else {
    // Sans image : une chaine, exactement comme avant (chemin par defaut inchange,
    // et c est ce que le planificateur envoie a chaque appel de mission).
    // Avec image : le tableau de parties attendu par /chat/completions.
    const userContent = image
      ? [
          { type: 'text', text: user },
          { type: 'image_url', image_url: { url: image } }
        ]
      : user
    body = JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      ...(thinking ? { thinking } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      // Sans cela un petit modele encadre son JSON de ``` et la reponse
      // devient inexploitable une fois sur trois.
      response_format: { type: 'json_object' },
      ...(keepAlive ? { keep_alive: keepAlive } : {}),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent }
      ]
    })
  }

  // Ecoute nommee pour pouvoir la retirer : un listener anonyme par appel
  // fuirait (un par plan, cent fois par mission) et fausserait tout comptage.
  const controller = new AbortController()
  const onExternalAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else {
      signal.addEventListener('abort', onExternalAbort, { once: true })
      // Course : aborte entre le test et l ecoute.
      if (signal.aborted) {
        signal.removeEventListener('abort', onExternalAbort)
        controller.abort()
      }
    }
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()

  // Phase transport : tout ce qui peut y echouer est une panne reseau/HTTP
  // ou du JSON de transport, jamais le texte-plan du modele. Le parsing du
  // contenu ("pas de plan") vit APRES ce bloc, hors de portee du catch,
  // donc aucune de ses erreurs ne recoit un code d indisponibilite.
  let parsed
  try {
    let response = await fetch(endpoint, { method: 'POST', signal: controller.signal, headers, body })
    // Un seul nouvel essai sur une panne passagere du gateway (5xx, 429, ou
    // 400 « Upstream request failed » de Zen), dans le meme delai global. Une
    // vraie erreur de requete (cle, modele, schema) n est jamais rejouee.
    if (!response.ok && await isTransient(response)) {
      // The pause ends early on abort (delay or caller): the fetch below then
      // throws at once instead of starting after the deadline.
      await new Promise(resolve => {
        const pause = setTimeout(resolve, 500)
        controller.signal.addEventListener('abort', () => { clearTimeout(pause); resolve() }, { once: true })
      })
      if (!controller.signal.aborted) onRetry?.()
      response = await fetch(endpoint, { method: 'POST', signal: controller.signal, headers, body })
    }

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200)
      throw typedError(`HTTP ${response.status} : ${detail}`, 'LLM_HTTP', response.status)
    }

    try {
      parsed = await response.json()
    } catch (inner) {
      // L annulation/delai pendant la lecture reste un abort, pas un corps
      // defectueux : laisser le catch externe le classer.
      if (inner?.name === 'AbortError') throw inner
      // JSON de TRANSPORT illisible (page HTML, corps vide...) : ce n est pas
      // le texte-plan du modele, donc pas une erreur de plan.
      throw typedError('reponse illisible (JSON de transport invalide)', 'LLM_BAD_RESPONSE', response.status)
    }
  } catch (err) {
    // Un abort venu du signal externe (mission stoppee, plan speculatif jete)
    // n est pas un delai depasse : le dire, pour que l appelant ne l impute pas
    // au reseau ni au modele. Messages preserves a l identique (le tri abort
    // du planificateur les lit), codes ajoutes pour un tri sans texte.
    if (err?.name === 'AbortError') {
      if (signal?.aborted) throw typedError('appel annule', 'LLM_ABORTED')
      throw typedError(`pas de reponse en ${timeoutMs} ms`, 'LLM_TIMEOUT')
    }
    // Rejet reseau (fetch ou lecture du corps : DNS, connexion refusee,
    // TLS...) : message d origine conserve, type pour le repli. Nos propres
    // erreurs portent deja un code et passent intactes.
    if (err instanceof Error && !err.code) err.code = 'LLM_NETWORK'
    throw err
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onExternalAbort)
  }

  if (proto === 'messages') {
    if (parsed?.type === 'error' || parsed?.error) {
      const msg = parsed.error?.message ?? JSON.stringify(parsed.error)
      throw new Error(`erreur modele : ${String(msg).slice(0, 200)}`)
    }
    if (parsed?.stop_reason === 'max_tokens') throw new Error('reponse tronquee (budget max_tokens atteint)')
    if (parsed?.stop_reason === 'refusal') throw new Error('reponse refusee par le modele')
    const content = (Array.isArray(parsed?.content) ? parsed.content : [])
      .filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('')
    if (!content.trim()) throw new Error('reponse sans contenu')
    return { content, usage: messagesUsage(parsed.usage), ms: Date.now() - started, responseModel: typeof parsed.model === 'string' ? parsed.model : null }
  }

  if (proto === 'responses') {
    // Erreur metier rendue en 200 : la signaler telle quelle, sans le corps.
    if (parsed?.error) {
      const msg = typeof parsed.error === 'string' ? parsed.error : (parsed.error.message ?? JSON.stringify(parsed.error))
      throw new Error(`erreur modele : ${String(msg).slice(0, 200)}`)
    }
    if (parsed?.status === 'failed') throw new Error('reponse en echec')
    // Une reponse incomplete (budget atteint, arret demande) n est pas un plan :
    // l appelant replanifie ou bascule de modele, il ne parse pas un JSON coupe.
    if (parsed?.status === 'incomplete') {
      const reason = parsed?.incomplete_details?.reason ?? 'tronquee'
      throw new Error(`reponse incomplete (${reason})`)
    }
    const content = extractResponsesText(parsed)
    if (typeof content !== 'string' || !content.trim()) throw new Error('reponse sans contenu')
    return { content, usage: responsesUsage(parsed.usage), ms: Date.now() - started, responseModel: typeof parsed.model === 'string' ? parsed.model : null }
  }

  // Chemin chat inchange, plus le garde-fou troncature : `finish_reason:
  // length` signifie que le JSON est coupe par le budget, donc pas un plan.
  if (parsed?.choices?.[0]?.finish_reason === 'length') throw new Error('reponse tronquee (budget max_tokens atteint)')
  const content = parsed?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) throw new Error('reponse sans contenu')

  return { content, usage: parsed.usage ?? null, ms: Date.now() - started, responseModel: typeof parsed.model === 'string' ? parsed.model : null }
}

// Un petit modele ajoute parfois une phrase avant son JSON malgre la consigne.
// On ne renonce pas pour si peu : on prend le premier objet complet.
function parseJson (text) {
  const trimmed = String(text ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()

  try {
    return JSON.parse(trimmed)
  } catch (_) {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start === -1 || end <= start) throw new Error('reponse illisible (pas de JSON)')
    return JSON.parse(trimmed.slice(start, end + 1))
  }
}

module.exports = { call, parseJson, resolveProtocol, messagesUsage }
