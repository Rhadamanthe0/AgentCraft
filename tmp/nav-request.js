const fs = require('node:fs')
fetch('http://127.0.0.1:3102/' + (process.argv[2] || ''), { method: 'POST', headers: { 'content-type': 'application/json' }, body: process.argv[3] || '{}' })
  .then(r => r.text()).then(s => { if (process.argv[4]) fs.writeFileSync(process.argv[4], s); else console.log(s) })
  .catch(e => { console.error(e); process.exitCode = 1 })
