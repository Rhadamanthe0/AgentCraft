'use strict'
// Lance une mission/instruction sur le harness puis attend son resultat borne.
async function main () {
  const [route = 'mission', text = 'viens me rejoindre', wait = 'yes', expected = 'done'] = process.argv.slice(2)
  const summarize = value => value.mission ? { id: value.mission.id, revision: value.mission.revision,
    state: value.mission.etat, reason: value.mission.raison, task: value.mission.parcours,
    position: value.position, controls: value.controls, messages: value.messages } : value
  const response = await fetch(`http://127.0.0.1:3101/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(route === 'instruction' ? { message: text } : { objective: text }) })
  console.log(JSON.stringify(summarize(await response.json())))
  if (wait === 'no') return
  const until = Date.now() + 150000
  while (Date.now() < until) {
    const status = await (await fetch('http://127.0.0.1:3101/status')).json()
    if (status.mission?.etat !== 'running') {
      console.log(JSON.stringify(summarize(status)))
      if (status.mission?.etat !== expected) throw new Error(`attendu ${expected}, obtenu ${status.mission?.etat}`)
      return
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('mission encore active apres 150 s')
}
main().catch(err => { console.error(err); process.exitCode = 1 })
