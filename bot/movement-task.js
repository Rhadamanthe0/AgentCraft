'use strict'

// Contrat declaratif de mission, distinct des petits plans d actions. Chaque
// sous-objectif reste pending tant que son executeur n a pas apporte sa preuve.
const TYPES = new Set(['rejoindre', 'retour', 'regarder', 'suivre', 'attendre', 'aller_retour', 'sous_arbre'])

function validateRoute (raw) {
  if (raw == null) return null
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 16) throw new Error('parcours invalide (1 a 16 objectifs)')
  const steps = []
  for (const item of raw) {
    if (!item || !TYPES.has(item.type)) throw new Error('objectif de parcours inconnu')
    if (item.type === 'aller_retour') {
      const n = item.repetitions
      if (!Number.isInteger(n) || n < 1 || n > 8) throw new Error('allers-retours : repetitions entieres de 1 a 8 requises')
      for (let i = 0; i < n; i++) steps.push({ type: 'rejoindre' }, { type: 'retour' })
    } else {
      const step = { type: item.type }
      if (item.type === 'attendre' || (item.type === 'suivre' && item.secondes != null)) {
        if (!Number.isFinite(item.secondes) || item.secondes < 0.2 || item.secondes > 120) throw new Error('duree du parcours invalide (0.2 a 120 s)')
        step.secondes = item.secondes
      }
      steps.push(step)
    }
  }
  if (steps.length > 32) throw new Error('parcours trop long')
  if (steps.some((s, i) => s.type === 'suivre' && s.secondes == null && i < steps.length - 1)) {
    throw new Error('un suivi sans duree doit etre le dernier objectif')
  }
  return steps
}

function createTask (steps, origin) {
  return { origin: { x: origin.x, y: origin.y, z: origin.z }, cursor: 0,
    steps: steps.map(s => ({ ...s, state: 'pending', attempts: 0, result: null })) }
}

async function executeTask (task, host, requester, signal, onProgress = () => {}) {
  while (task.cursor < task.steps.length) {
    if (signal.aborted) return { code: 'cancelled', reached: false }
    const step = task.steps[task.cursor]
    step.state = 'running'
    step.attempts++
    onProgress(task)
    let result
    try {
      if (step.type === 'rejoindre') result = await host.navigateToPlayer(requester, { signal })
      else if (step.type === 'sous_arbre') result = await require('./tree-position').underTree(host, task.clearance ?? { limit: 0, used: 0 }, signal)
      else if (step.type === 'retour') result = await host.navigateToPosition(task.origin, { signal, radius: 0.6 })
      else if (step.type === 'suivre') result = await host.navigateToPlayer(requester, { signal, follow: true, durationMs: step.secondes == null ? null : step.secondes * 1000 })
      else if (step.type === 'regarder') {
        const bot = host.getBot()
        const target = bot?.players[requester]?.entity
        if (!target || !bot.entity) result = { code: 'target_lost', reached: false }
        else {
          await bot.lookAt(target.position.offset(0, 1, 0), true)
          result = { code: 'looked', reached: true }
        }
      } else {
        await new Promise(resolve => {
          const end = () => { clearTimeout(timer); signal.removeEventListener('abort', end); resolve() }
          const timer = setTimeout(end, step.secondes * 1000)
          signal.addEventListener('abort', end, { once: true })
        })
        result = { code: 'waited', reached: true }
      }
    } catch (err) {
      result = { code: 'execution_error', reached: false, detail: err.message }
    }
    if (signal.aborted) result = { code: 'cancelled', reached: false }
    step.result = result
    step.state = result.reached ? 'done' : (result.code === 'cancelled' ? 'cancelled' : 'failed')
    if (result.reached) task.cursor++
    onProgress(task)
    if (!result.reached) return result
  }
  return { reached: true, code: 'completed' }
}

module.exports = { validateRoute, createTask, executeTask }
