'use strict'
// Analyse uniquement les traces ; ne donne aucun ordre au bot.
const angle = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a)) * 180 / Math.PI
async function main () {
  const url = process.argv.slice(2).find(arg => !arg.startsWith('--')) || 'http://127.0.0.1:3000/api/navigation/trace?history=1'
  const value = await (await fetch(url)).json()
  const traces = Array.isArray(value) ? value : value.traces ?? [value.trace ?? value]
  for (const t of traces.filter(Boolean)) {
    const samples = t.samples
    let reversals = 0
    let maxStationaryTurn = 0
    for (let i = 1; i < samples.length; i++) {
      if (samples[i].t > 500 && Math.abs(angle(samples[i - 1].yaw, samples[i].yaw)) > 150) reversals++
      let turn = 0
      for (let j = i; j > 0 && samples[i].t - samples[j - 1].t <= 1000; j--) {
        const a = samples[j - 1].position
        const b = samples[i].position
        if (Math.hypot(a[0] - b[0], a[2] - b[2]) > 0.5) break
        turn += Math.abs(angle(samples[j - 1].yaw, samples[j].yaw))
      }
      maxStationaryTurn = Math.max(maxStationaryTurn, turn)
    }
    const jumps = t.events.filter(e => e.event === 'jump')
    const result = { label: t.label, outcome: t.outcome, samples: t.totalSamples,
      milliseconds: samples.at(-1)?.t, jumps: jumps.length,
      flatJumps: jumps.filter(e => e.point.y - e.position.y <= 0.5).length,
      reversalsAfterStart: reversals, maxStationaryTurn: Math.round(maxStationaryTurn) }
    console.log(JSON.stringify(result))
    if (process.argv.includes('--assert-smooth') && (result.flatJumps || reversals || maxStationaryTurn >= 300)) {
      throw new Error('mouvement parasite detecte dans la trace')
    }
  }
}
main().catch(err => { console.error(err.message); process.exitCode = 1 })
