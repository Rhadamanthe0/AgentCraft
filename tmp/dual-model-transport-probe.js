'use strict'
// Executed as an independent node process, never imports bot/index or planner.
const base = (process.env.PLANNER_BASE_URL || '').replace(/\/+$/, '')
const key = process.env.PLANNER_API_KEY
if (!base || !key) throw new Error('Required configured transport unavailable')
const headers = {
  'content-type': 'application/json',
  authorization: `Bearer ${key}`,
  'user-agent': process.env.PLANNER_USER_AGENT || 'minecraft-bot/1.0',
  'x-opencode-session': process.env.PLANNER_SESSION_ID || `minecraft-bot-${process.env.BOT_USERNAME || 'bot'}`
}
const prompt = 'Return only this valid JSON object: {"pong":true}. No explanation.'
const cases = [
  { model: 'mimo-v2.6-flash', endpoint: '/chat/completions', timeoutMs: 45000,
    body: { model: 'mimo-v2.6-flash', messages: [{ role: 'user', content: prompt }], thinking: { type: 'disabled' }, max_tokens: 512, response_format: { type: 'json_object' } } },
  { model: 'muse-spark-1.3-contributor', endpoint: '/responses', timeoutMs: 120000,
    body: { model: 'muse-spark-1.3-contributor', input: [{ role: 'user', content: prompt }], reasoning: { effort: 'xhigh' }, max_output_tokens: 8192 } }
]
async function probe (c) {
  const started = Date.now()
  const out = { request: { model: c.model, endpoint: c.endpoint, thinking: c.body.thinking, reasoning: c.body.reasoning, maxTokens: c.body.max_tokens || c.body.max_output_tokens, timeoutMs: c.timeoutMs }, at: new Date().toISOString() }
  try {
    const r = await fetch(base + c.endpoint, { method: 'POST', headers, body: JSON.stringify(c.body), signal: AbortSignal.timeout(c.timeoutMs) })
    const body = await r.json()
    out.status = r.status
    out.modelReturned = body.model
    out.usage = body.usage
    out.responseStatus = body.status
    out.finishReason = body.choices?.[0]?.finish_reason
    out.error = body.error ? { code: body.error.code, type: body.error.type, message: body.error.message } : undefined
    const message = body.choices?.[0]?.message
    out.reasoningContentPresent = Boolean(message?.reasoning_content || message?.reasoning)
    out.outputTypes = body.output?.map(x => x.type)
    const content = message?.content || body.output?.flatMap(x => x.content || []).filter(x => x.type === 'output_text').map(x => x.text).join('') || ''
    out.content = content
    try { out.contentJSON = JSON.parse(content) } catch (_) { out.contentJSON = null }
  } catch (error) { out.error = { name: error.name, message: error.message } }
  out.latencyMs = Date.now() - started
  return out
}
Promise.all(cases.map(probe)).then(results => console.log(JSON.stringify({ at: new Date().toISOString(), purpose: 'Two minimal transport acceptance probes, not a model quality benchmark; no world connection', results }, null, 2)))
