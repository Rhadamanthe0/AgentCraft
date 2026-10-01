'use strict'
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),test=require('node:test');
const source=fs.readFileSync(process.env.CODEX_GATE_TEST_SOURCE || path.join(__dirname,'../.github/workflows/codex-review-gate.yml'),'utf8');
const workflow=code=>new (Object.getPrototypeOf(async function(){}).constructor)('github','context','core',code.split('          script: |')[1].split(/\r?\n/).map(s=>s.replace(/^            /,'')).join('\n'));
async function simulate(source, { event = true, role = 'read', historic = false, sameBucket = false, foreignWatermark = false, savedWatermark = false, denied = false, lateRequest = false, savedState = null, malformed = false } = {}) {
  const head = 'a'.repeat(40)
  const requestDate = '2026-10-01T01:10:00Z'
  const finishedDate = sameBucket ? requestDate : '2026-10-01T01:00:00Z'
  const request = { id: 17, user: { id: 100, login: 'commenter', type: 'User' }, body: '@codex review', updated_at: requestDate }
  const summaryBody = '<!-- codex-pull-request-review-summary -->\n| Review | Status | Commit | Review trigger |\n| --- | --- | --- | --- |\n| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="' + finishedDate + '"></relative-time> | `' + head + '` | manual |'
  const summary = { id: 9, node_id: 'summary', updated_at: '2026-10-01T01:00:00Z', body: summaryBody,
    user: { id: 199175422, login: 'chatgpt-codex-connector[bot]', type: 'Bot' } }
  const pr = number => ({ number, state: foreignWatermark && number === 1 ? 'closed' : 'open', draft: false,
    head: { sha: head }, base: { sha: 'base', ref: 'main' } })
  let commentReads=0; const writes = [], notes = []
  const publish = async value => { writes.push(value); return { data: { id: 21 } } }
  const previous = { id: 20, name: 'Codex review gate', app: { id: 15368 }, external_id: 'codex-review-gate:v1',
    output: { text: malformed ? '{broken' : JSON.stringify(savedState || { schema: 'codex-review-gate:v1', review_requests: { 'Code Review': Date.parse(requestDate) + 1000 } }) } }
  const github = { rest: {
    pulls: { get: async args => ({ data: pr(args.pull_number) }), list: 'pulls' },
    checks: { listForRef: 'checks', create: publish, update: publish },
    issues: { listComments: 'comments', listEventsForTimeline: 'timeline', getComment: async () => ({ data: summary }) },
    repos: { getCommit: async () => ({ data: { sha: head } }), getCollaboratorPermissionLevel: async () => {
      if (denied) throw Object.assign(new Error('Forbidden'), { status: 403 })
      return { data: { permission: role, user: { id: 100 } } }
    } }
  }, paginate: async kind => kind === 'pulls' ? [pr(foreignWatermark ? 2 : 1)]
    : kind === 'checks' ? (foreignWatermark || savedWatermark || malformed || savedState ? [previous] : [])
      : kind === 'timeline' ? [] : (historic || (lateRequest && ++commentReads > 1)) ? [summary, request] : [summary],
  graphql: async () => ({ node: { body: summaryBody, editor: { databaseId: 199175422 } } }) }
  const context = { repo: { owner: 'fixture', repo: 'fixture' }, runId: 1,
    eventName: event ? 'issue_comment' : 'pull_request_target',
    payload: event ? { issue: { number: 1 }, comment: request } : { pull_request: { number: 1 } } }
  let error = null
  try { await workflow(source)(github, context, { info: x => notes.push(x), warning: x => notes.push(x) }) }
  catch (e) { error = e.message }
  return { commentReads, firstWrittenId: writes[0]?.check_run_id ?? null, writes: writes.map(w => ({ status: w.status, conclusion: w.conclusion || null, persisted: JSON.parse(w.output.text) })), notes, error }
}

const watermark=Date.parse('2026-10-01T01:10:00Z')+1000;
const scoped=byPr=>({schema:'codex-review-gate:v2',reset_after:0,review_requests_by_pr:byPr});
test('un lecteur ne peut pas invalider via issue_comment',async()=>{assert.equal((await simulate(source)).writes.length,0)});
test('les demandes historiques non autorisees sont ignorees',async()=>{assert.equal((await simulate(source,{event:false,historic:true})).writes.at(-1).conclusion,'success')});
for(const role of ['write','maintain','admin']) test('demande autorisee '+role+' persiste par PR',async()=>{const r=await simulate(source,{role});assert.equal(r.writes.at(-1).status,'in_progress');assert.equal(r.writes.at(-1).persisted.review_requests_by_pr['1']['Code Review'],watermark)});
test('demande tardive relue avant success',async()=>{const r=await simulate(source,{event:false,role:'write',lateRequest:true});assert.equal(r.writes.at(-1).status,'in_progress');assert.equal(r.commentReads,2)});
test('B ne reutilise pas watermark A apres fermeture',async()=>{const r=await simulate(source,{event:false,foreignWatermark:true,savedState:scoped({'1':{'Code Review':watermark}})});assert.equal(r.writes.at(-1).conclusion,'success');assert.equal(r.writes.at(-1).persisted.review_requests_by_pr['1']['Code Review'],watermark)});
test('demande autorisee supprimee conservee pour la meme PR',async()=>{assert.equal((await simulate(source,{event:false,savedState:scoped({'1':{'Code Review':watermark}})})).writes.at(-1).status,'in_progress')});
test('legacy non vide reste bloque sans attribution inventee',async()=>{const r=await simulate(source,{event:false,savedWatermark:true});assert.equal(r.writes.at(-1).conclusion,'failure');assert.ok(r.writes[0].persisted.reset_after>0);assert.equal(r.firstWrittenId,null)});
test('legacy vide exige de nouvelles revues sans preuve de contexte',async()=>{const r=await simulate(source,{event:false,savedState:{schema:'codex-review-gate:v1',review_requests:{}}});assert.equal(r.writes.at(-1).conclusion,'failure');assert.ok(r.writes.at(-1).persisted.reset_after>0)});
test('malformed cree failure sans reessayer ancien check',async()=>{const r=await simulate(source,{event:false,malformed:true});assert.equal(r.writes.at(-1).conclusion,'failure');assert.equal(r.firstWrittenId,null);assert.ok(r.writes[0].persisted.reset_after>0)});
test('schema incompatible cree failure',async()=>{assert.equal((await simulate(source,{event:false,savedState:{schema:'unknown',review_requests:{}}})).writes.at(-1).conclusion,'failure')});
test('borne de reprise bloque encore les anciennes revues',async()=>{const r=await simulate(source,{event:false,savedState:{schema:'codex-review-gate:v2',reset_after:watermark,review_requests_by_pr:{}}});assert.equal(r.writes.at(-1).status,'in_progress');assert.equal(r.writes.at(-1).persisted.reset_after,watermark)});
test('timestamp egal bloque encore ancienne completion',async()=>{assert.equal((await simulate(source,{role:'write',sameBucket:true})).writes.at(-1).status,'in_progress')});
test('revue courante sans nouvelle demande accepte success',async()=>{assert.equal((await simulate(source,{event:false})).writes.at(-1).conclusion,'success')});

test('blocage conserve les demandes connues par PR',async()=>{const state=scoped({'1':{'Code Review':watermark}});const r=await simulate(source,{event:false,savedState:state});assert.equal(r.writes.at(-1).status,'in_progress');assert.equal(r.writes.at(-1).persisted.review_requests_by_pr['1']['Code Review'],watermark);assert.equal(r.firstWrittenId,20)});
