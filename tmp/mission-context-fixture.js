'use strict'

// Real conversation, runner, controller and file store; model and world are fakes.
process.env.MISSION_TICK_MS = '1'
process.env.MISSION_QUEUE_TICK_MS = '1'
const assert = require('node:assert/strict')
const path = require('node:path')
const { Vec3 } = require('vec3')
const planner = require('../bot/planner')
const { createMissionRunner } = require('../bot/mission')
const { createConversation } = require('../bot/conversation')
const { createObjectiveController } = require('../bot/objective-controller')
const { createStateStore } = require('../bot/state-store')

const brief = { kind: 'recolte', kindConfidence: 1, resource: 'sable', resourceConfidence: 1,
  landmark: 'ici', door: false, doorProbability: 0 }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until (predicate) {
  for (let n = 0; n < 300; n++) {
    if (predicate()) return
    await delay(5)
  }
  throw new Error('fixture timeout')
}

function harness (dir, options = {}) {
  const store = createStateStore({ file: path.join(dir, 'snapshot.json'), eventFile: path.join(dir, 'events.jsonl') })
  const controller = createObjectiveController({ store })
  const messages = []
  const plans = []
  let moving = false
  let finishMove
  const bot = { entity: { position: new Vec3(0, 65, 0), yaw: 0, pitch: 0 },
    registry: { blocksByName: {}, itemsByName: {} }, inventory: { items: () => [] },
    players: {}, entities: {}, findBlocks: () => [], findBlock: () => null,
    clearControlStates () {}, blockAt: () => null }
  planner.isEnabled = () => true
  planner.readBrief = async () => brief
  planner.plan = async state => {
    plans.push(JSON.parse(JSON.stringify(state)))
    if (options.holdPlan) return new Promise(() => {})
    return { ms: 0, seconds: 1, rejected: [], done: 0, finished: false,
      steps: [{ action: 'rejoindre_demandeur', scale: 0, scaleLevel: null, choices: {} }] }
  }
  const runner = createMissionRunner({ getBot: () => bot, isReady: () => true,
    inLiquid: () => false, stopPathfinding () {}, chat: text => messages.push(text),
    recentChat: () => [], navigateToPlayer: async (_username, { signal }) => {
      moving = true
      return new Promise(resolve => {
        finishMove = () => resolve({ reached: false, code: 'cancelled' })
        signal.addEventListener('abort', finishMove, { once: true })
      })
    } }, { objectives: controller })
  const conversation = createConversation({ status: runner.status,
    interpret: async () => ({ relation: 'context', response: 'Precision acceptee.' }),
    context: (text, author, permissions) => {
      controller.addContext({ auteur: author, texte: text })
      return runner.addContext(text, author, permissions)
    }, say: text => messages.push(text),
    resume: () => { controller.resume(); runner.rehydrate(controller.snapshot().current) }
  })
  return { store, controller, runner, conversation, messages, plans,
    get moving () { return moving },
    async start () {
      const admitted = controller.proposeObjective({ auteur: 'Alice', texte: 'ramasse du sable' })
      await runner.start(admitted.objective.texte, admitted.objective.auteur, { objectiveId: admitted.objective.id })
      await until(() => moving)
      assert.equal(runner.status().etapes, 0)
    },
    close () { runner.pauseWork('fixture cleanup'); finishMove?.() }
  }
}

const expectedContext = Array.from({ length: 10 }, (_, n) => ({
  de: n % 2 ? 'Bob' : 'Alice', message: (`precision ${n} ` + 'x'.repeat(320)).slice(0, 300)
})).slice(-8)

async function child () {
  const [mode, dir] = process.argv.slice(2)
  const f = harness(dir, { holdPlan: mode === 'read' })
  if (mode === 'write') {
    await f.start()
    for (let n = 0; n < 10; n++) {
      const result = await f.conversation.receive(n % 2 ? 'Bob' : 'Alice', `precision ${n} ` + 'x'.repeat(320))
      assert.equal(result.relation, 'context')
      assert.equal(result.error, undefined)
    }
    // No completed action or graceful shutdown may be needed for this commit.
    assert.equal(f.runner.status().etapes, 0)
    assert.deepEqual(f.store.load().current.progression.contexte, expectedContext)
    f.controller.totalStop('arret total avant restart')
  } else {
    const snapshot = f.controller.recover()
    assert.equal(snapshot.hardstop, true)
    await delay(20)
    assert.equal(f.runner.status(), null)
    assert.equal(f.plans.length, 0)
    await f.conversation.receive('Alice', 'reprends')
    await until(() => f.plans.length > 0)
    assert.equal(f.controller.snapshot().hardstop, false)
    assert.deepEqual(f.runner.status().precisions, expectedContext)
    assert.deepEqual(f.plans[0].consigne.precisions, expectedContext)
    assert.equal(f.runner.status().etapes, 0)
  }
  process.stdout.write(`CONTEXT_${mode.toUpperCase()}_OK\n`)
  // Deliberate process exit: no runner stop, final action or persistence hook.
  process.exit(0)
}
if (require.main === module) child().catch(err => { console.error(err); process.exit(1) })
module.exports = { harness, until, expectedContext }
