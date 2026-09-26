'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createConversation } = require('../bot/conversation')

function fixture () {
  const events = []
  const state = { id: 'm1', revision: 0, etat: 'running', objectif: 'suis-moi' }
  const host = {
    status: () => ({ ...state }), interpret: async () => ({ relation: 'new', objective: 'viens' }),
    stop: () => events.push('stop'), start: async text => events.push(['start', text]),
    revise: async text => events.push(['revise', text]), context: text => events.push(['context', text]),
    say: text => events.push(['say', text])
  }
  const conversation = createConversation(host)
  return { events, state, host, conversation }
}
test('question repond sans interrompre le suivi', async () => {
  const f = fixture()
  f.host.interpret = async () => ({ relation: 'question', response: 'Je te suis.' })
  await f.conversation.receive('Alice', 'Que fais-tu ?')
  assert.deepEqual(f.events, [['say', 'Je te suis.']])
})
test('precision conserve la mission, modification passe par revise', async () => {
  const f = fixture()
  f.host.interpret = async () => ({ relation: 'context' })
  await f.conversation.receive('Alice', 'je suis derriere toi')
  f.host.interpret = async () => ({ relation: 'amend', objective: 'fais trois allers-retours' })
  await f.conversation.receive('Alice', 'plutot trois')
  assert.deepEqual(f.events.filter(e => e[0] !== 'say'), [['context', 'je suis derriere toi'], ['revise', 'fais trois allers-retours']])
  assert.equal(f.events.filter(e => e[0] === 'say').length, 2)
})
test('reponse tardive apres stop ne lance rien', async () => {
  const f = fixture()
  let release
  f.host.interpret = () => new Promise(resolve => { release = resolve })
  const pending = f.conversation.receive('Alice', 'viens')
  await f.conversation.receive('Alice', 'stop')
  release({ relation: 'new', objective: 'viens' })
  assert.equal((await pending).ignored, true)
  assert.deepEqual(f.events, ['stop'])
})
test('modification ne cible pas une mission remplacee pendant le calcul', async () => {
  const f = fixture()
  f.host.interpret = async () => { f.state.id = 'm2'; return { relation: 'amend', objective: 'autre' } }
  assert.equal((await f.conversation.receive('A', 'plutot trois')).ignored, true)
  assert.equal(f.events[0][0], 'say')
})
test('mission finie pendant le calcul : la revision complete devient une nouvelle demande', async () => {
  const f = fixture()
  f.host.interpret = async () => { f.state.etat = 'done'; return { relation: 'amend', objective: 'coupe un arbre' } }
  const out = await f.conversation.receive('A', 'laisse tomber, coupe plutot un arbre')
  assert.notEqual(out.ignored, true)
  assert.deepEqual(f.events.filter(e => e[0] === 'start'), [['start', 'coupe un arbre']])
})
test('precision sur une mission finie pendant le calcul : toujours redemandee', async () => {
  const f = fixture()
  f.host.interpret = async () => { f.state.etat = 'done'; return { relation: 'context' } }
  assert.equal((await f.conversation.receive('A', 'je suis derriere')).ignored, true)
})
test('question pendant le brief ne supprime pas un objectif deja accepte', async () => {
  const f = fixture()
  let release
  let interrupted = false
  f.host.start = async (text, user, opts) => {
    opts.signal.addEventListener('abort', () => { interrupted = true })
    await new Promise(resolve => { release = resolve })
  }
  const pending = f.conversation.receive('A', 'viens')
  await new Promise(resolve => setImmediate(resolve))
  f.host.interpret = async () => ({ relation: 'question', response: 'Je prepare le trajet.' })
  await f.conversation.receive('A', 'que fais-tu ?')
  release()
  await pending
  assert.equal(interrupted, false)
})
test('permission de degagement transmise comme donnee, pas simple texte', async () => {
  const f = fixture()
  f.host.interpret = async () => ({ relation: 'context', clearanceBlocks: 1 })
  f.host.context = (text, username, permission) => f.events.push(permission)
  await f.conversation.receive('A', 'tu peux casser un bloc')
  assert.deepEqual(f.events[0], { clearanceBlocks: 1 })
  assert.equal(f.events[1][0], 'say')
})
test('permission apres refus reprend le placement precedent', async () => {
  const f = fixture()
  Object.assign(f.state, { etat: 'failed', objectif: 'sous un arbre', parcours: { steps: [{ type: 'sous_arbre', state: 'failed' }] } })
  f.host.interpret = async () => ({ relation: 'context', clearanceBlocks: 1 })
  await f.conversation.receive('A', 'tu peux casser un bloc')
  assert.deepEqual(f.events.filter(e => e[0] !== 'say'), [['revise', 'sous un arbre']])
})
test('nouvel objectif accuse reception AVANT lecture du brief', async () => {
  const f = fixture()
  f.host.interpret = async () => ({ relation: 'new', objective: 'chercher du sable', response: 'Je verifie comment trouver du sable.' })
  f.host.start = async () => { assert.deepEqual(f.events, [['say', 'Je verifie comment trouver du sable.']]); return { ok: true } }
  await f.conversation.receive('A', 'trouve du sable')
})
test('capacite manquante : accuse reception puis explication, jamais silence', async () => {
  const f = fixture()
  f.host.interpret = async () => ({ relation: 'new', objective: 'donner du sable', response: 'Je verifie les etapes.' })
  f.host.start = async () => ({ ok: false, error: 'remise d objets indisponible' })
  const result = await f.conversation.receive('A', 'donne-moi du sable')
  assert.equal(result.error, 'remise d objets indisponible')
  assert.equal(f.events.length, 2)
  assert.match(f.events[1][1], /remise d objets indisponible/)
})
test('erreur tardive de classification apres stop ne provoque pas de message obsolete', async () => {
  const f = fixture()
  let reject
  f.host.interpret = () => new Promise((resolve, fail) => { reject = fail })
  const pending = f.conversation.receive('A', 'viens')
  await f.conversation.receive('A', 'stop')
  reject(new Error('timeout distant'))
  assert.equal((await pending).ignored, true)
  assert.deepEqual(f.events, ['stop'])
})
test('A objectif (brief lent) / B question / C objectif : B repond vite, C gagne, A annule', async () => {
  // Verifie l affirmation d architecture AVANT tout changement : l admission
  // (propose synchrone) ordonne les objectifs, le brief ne fait que lire ;
  // la disposition ne tient aucun verrou, donc une question ne se bloque pas
  // derriere un brief, et un vieux brief annule ne demarre jamais.
  const events = []
  let gen = 0
  let activeMission = null
  const gates = {}
  const host = {
    status: () => activeMission ? { id: activeMission, revision: 0, etat: 'running', objectif: activeMission } : null,
    interpret: async (msg) => {
      if (msg === 'que fais-tu ?') return { relation: 'question', response: 'Je prepare le trajet.' }
      return { relation: 'new', objective: msg, response: 'Recu, je verifie.' }
    },
    // Starter fidele : admission synchrone (comme proposeObjective en prod),
    // brief differe, garde de generation (comme startGeneration en prod).
    start: async (objective, user, opts) => {
      const g = ++gen
      events.push(['propose', objective])
      if (gates[objective]) await gates[objective]
      if (g !== gen || opts.signal?.aborted) {
        events.push(['annule', objective])
        return { ok: false, error: 'objectif annule' }
      }
      activeMission = objective
      events.push(['start', objective])
      return { ok: true }
    },
    revise: async () => ({ ok: true }),
    context: () => {},
    stop: () => {},
    say: (t) => events.push(['say', t]),
    cancelPendingStart: () => {}
  }
  const conversation = createConversation(host)
  gates['objectif A'] = new Promise((resolve) => { gates.__releaseA = resolve })
  const pendingA = conversation.receive('Alice', 'objectif A')
  await new Promise((resolve) => setImmediate(resolve))
  // B doit repondre SANS attendre la fin du brief de A.
  await conversation.receive('Bob', 'que fais-tu ?')
  assert.ok(events.some((e) => e[0] === 'say' && e[1] === 'Je prepare le trajet.'), 'B repond pendant le brief de A')
  assert.equal(activeMission, null, 'A ne demarre pas avant son brief')
  // C arrive pendant le brief de A : admis apres, brief immediat.
  await conversation.receive('Cara', 'objectif C')
  assert.equal(activeMission, 'objectif C', 'C demarre, aucune mission perdue')
  // Le vieux brief de A se reveille : annule, jamais active.
  gates.__releaseA()
  const resA = await pendingA
  assert.equal(resA.error, 'objectif annule')
  assert.equal(activeMission, 'objectif C', 'C gardee, A n ecrase pas')
  assert.ok(!events.some((e) => e[0] === 'start' && e[1] === 'objectif A'), 'l ancien brief ne demarre jamais')
  // Ordre d admission synchrone preserve : A propose avant C.
  assert.deepEqual(events.filter((e) => e[0] === 'propose').map((e) => e[1]), ['objectif A', 'objectif C'])
})

test('mode permanent traverse jusqu au demarrage, defaut temporary', async () => {
  const seen = []
  const host = {
    status: () => null,
    interpret: async () => ({ relation: 'new', objective: 'entretiens le jardin', response: 'Recu.', mode: 'permanent' }),
    start: async (objective, user, opts) => { seen.push(opts); return { ok: true } },
    revise: async (objective, user, opts) => { seen.push(opts); return { ok: true } },
    context: () => {},
    stop: () => {},
    say: () => {},
    cancelPendingStart: () => {}
  }
  const conversation = createConversation(host)
  await conversation.receive('Alice', 'entretiens le jardin')
  assert.equal(seen[0].mode, 'permanent')
  // Sans mode interprete ni mode direct : undefined (temporary par defaut en aval).
  const host2 = {
    status: () => null,
    interpret: async () => ({ relation: 'new', objective: 'coupe du bois', response: 'Recu.' }),
    start: async (objective, user, opts) => { seen.push(opts); return { ok: true } },
    revise: async () => ({ ok: true }),
    context: () => {},
    stop: () => {},
    say: () => {},
    cancelPendingStart: () => {}
  }
  const conversation2 = createConversation(host2)
  await conversation2.receive('Alice', 'coupe du bois', { mode: 'permanent' })
  assert.equal(seen[1].mode, 'permanent')
})

test('revision refusee remonte au chat, pas de demarrage fantome', async () => {
  const events = []
  const state = { id: 'm1', revision: 0, etat: 'running', objectif: 'abri' }
  const host = {
    status: () => ({ ...state }),
    interpret: async () => ({ relation: 'amend', objective: 'abri plus grand' }),
    start: async () => { events.push('start-inattendu'); return { ok: true } },
    revise: async () => ({ ok: false, error: 'revision refusee : disque plein' }),
    context: () => {},
    stop: () => {},
    say: (t) => events.push(['say', t]),
    cancelPendingStart: () => {}
  }
  const conversation = createConversation(host)
  const result = await conversation.receive('Alice', 'plus grand')
  assert.equal(result.error, 'revision refusee : disque plein')
  assert.ok(!events.includes('start-inattendu'), 'aucun demarrage sur revision refusee')
  assert.ok(events.some((e) => e[0] === 'say' && /revision refusee/.test(e[1])), 'refus dit dans le chat')
})

test('interpretation lente : accuse de reception intermediaire, puis vraie reponse', async () => {
  const f = fixture()
  let release
  f.host.interpret = () => new Promise(resolve => { release = resolve })
  const pending = f.conversation.receive('A', '3+3 ?')
  await new Promise(resolve => setTimeout(resolve, 1600))
  assert.match(f.events[0][1], /recu ton message/)
  release({ relation: 'question', response: '3 + 3 = 6.' })
  await pending
  assert.deepEqual(f.events[1], ['say', '3 + 3 = 6.'])
})
