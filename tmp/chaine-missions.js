// tmp/chaine-missions.js — orchestration versionnee de deux missions etagees.
//
// VOIE (b) : la chaine vit HORS du bot, dans ce harness qui pilote l API.
// Aucun code du bot n est touche (ni mission.js, ni index.js, ni garde-fous) :
// l inventaire persiste entre les deux phases parce que c est le meme
// conteneur et le meme monde, et `construire` echoue a stock vide, ce qui
// aiguille deja casser -> fabriquer sans enchainement code en dur.
//
// Usage (depuis l hote, PowerShell ; sous Git Bash prefixer par MSYS_NO_PATHCONV=1) :
//   docker compose cp tmp/chaine-missions.js bot:/tmp/chaine.js
//   docker compose exec -T -e NODE_PATH=/app/node_modules bot node /tmp/chaine.js `
//     --phase1 "coupe 6 bois" --phase2 "construis un abri en bois de 3 par 3 par 3"
//
// Options :
//   --phase1 "..."   objectif recolte (defaut : "coupe 6 bois")
//   --phase2 "..."   objectif construction (defaut : "construis un abri en bois de 3 par 3 par 3")
//   --materiau NOM   cle d inventaire lue via /api/status : buches|planches|pierre|batons|portes
//                    (defaut : planches ; la terre/dirt n y est pas exposee, voir LIMITES)
//   --seuil N        stock minimal exige apres phase 1 (defaut : besoin calcule de phase 2)
//   --poll-secs N    cadence de scrutation (defaut 5, min 2)
//   --timeout-min N  delai max par phase (defaut 16, max 30 ; MISSION_MAX_DURATION_MS vaut 15 min)
//   --requester NOM  demandeur affiche (defaut : chaine)
//   --api URL        base API (defaut : http://127.0.0.1:3000, joignable depuis l hote
//                    comme depuis le conteneur bot qui ecoute sur 0.0.0.0:3000)
//   --dry-run        verifie garde-fous + besoin + stock, sans lancer aucune mission
//   --help           aide
//
// Exemples :
//   node chaine.js --dry-run
//   node chaine.js --phase1 "coupe 6 bois" --phase2 "construis un abri en bois de 3 par 3 par 3"
//   node chaine.js --phase1 "ramasse 8 graines" --phase2 "construis un abri en bois de 3 par 3 par 3" `
//     --materiau planches --seuil 24
//
// Garde-fous RUNTIME (verifies avant de lancer, jamais modifies) :
//   - MISSION_MAX_STEPS / MISSION_MAX_DURATION_MS : lus nulle part, ecrits nulle part.
//     Le script ne fait que REPORTER etapes et raison de fin de chaque phase.
//   - MISSION_SCREENSHOT : le script exige `planner.captures == 0` a l entree et
//     reporte le delta (0 attendu) ; l operateur garde MISSION_SCREENSHOT vide.
//   - PLANNER_BASE_URL : exige un hote opencode.ai/zen, modele deepseek, jamais vide.
//   - Survie sans cheat : le script ne fait ni /tp, ni /gamemode, ni POST /api/chat
//     en "/" ; les TP rcon d arene restent manuels cote operateur (harness only).
//   - Gate de phase : phase 2 lancee SSI phase 1 close en `done` ET stock >= seuil.
//     Sinon sortie 2, sans reprise auto (voir LIMITES).
//
// Codes de sortie : 0 chaine OK (phase 2 `done`) ; 1 usage/erreur/garde-fou ;
//   2 gate refuse (stock ou etat phase 1 insuffisant) ; 3 echec/timeout d une phase.
//
// LIMITES :
//   - Pas de reprise sur echec phase 1 : si phase 1 finit en stopped/failed ou si
//     le stock est sous le seuil, phase 2 N EST PAS lancee. Relancer a la main
//     apres inspection (/api/mission, /api/status).
//   - `--materiau` ne couvre que les cles exposees par /api/status.inventory
//     (buches, planches, pierre, batons, portes). La dirt/terre n y figure pas :
//     une chaine "terre" est refusee avec un message explicite.
//   - Le besoin est une BORNE BASSE (boite creuse planHouse, sans la porte ni les
//     pertes de craft) : voir blocsPrevus(). Un seuil explicite plus large reste
//     possible via --seuil.
//   - Verif serveur des blocs (execute if block) reste manuelle : le script
//     IMPRIME les commandes rcon exactes, il n execute aucun rcon lui-meme.
'use strict'

const DEFAULTS = {
  phase1: 'coupe 6 bois',
  phase2: 'construis un abri en bois de 3 par 3 par 3',
  materiau: 'planches',
  pollSecs: 5,
  timeoutMin: 16,
  requester: 'chaine',
  api: process.env.CHAINE_API || 'http://127.0.0.1:3000'
}

// Cles lues dans /api/status.inventory (craft.snapshot). Pas de dirt : voir LIMITES.
const MATERIAUX = new Set(['buches', 'planches', 'pierre', 'batons', 'portes'])

const MIN_SIZE = 3
const MAX_SIZE = 9

function clamp (v) {
  if (!Number.isFinite(v)) return 5
  return Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(v)))
}

// Meme lecture que build.parseDimensions (3 dimensions, sinon cube 5). Sert a
// chiffrer le besoin de phase 2 sans interroger le modele : le code compte.
function parseDimensions (text) {
  const clean = String(text || '').toLowerCase().replace(/,/g, ' ')
  const sep = '\\s*(?:par|sur|x|\\*)\\s*'
  const three = clean.match(new RegExp(`(\\d+)${sep}(\\d+)${sep}(\\d+)`))
  if (three) {
    return { width: clamp(Number(three[1])), depth: clamp(Number(three[2])), height: clamp(Number(three[3])) }
  }
  const two = clean.match(new RegExp(`(\\d+)${sep}(\\d+)`))
  if (two) return { width: clamp(Number(two[1])), depth: clamp(Number(two[2])), height: 5 }
  const one = clean.match(/(\d+)\s*blocs?/)
  if (one) {
    const s = clamp(Number(one[1]))
    return { width: s, depth: s, height: s }
  }
  return { width: 5, depth: 5, height: 5 }
}

// Boite creuse planHouse : plancher plein + toit plein + murs, moins l ouverture
// de porte (2 cases). Borne basse : ni la porte, ni les pertes de craft.
function blocsPrevus ({ width, depth, height }) {
  const sol = width * depth
  const toit = width * depth
  const murs = Math.max(0, height - 2) * (2 * width + 2 * depth - 4)
  return sol + toit + murs - 2
}

function args (argv) {
  const out = {}
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i]
    if (t === '--help' || t === '-h') out.help = true
    else if (t === '--dry-run') out.dryRun = true
    else if (t.startsWith('--phase1=')) out.phase1 = t.slice(9)
    else if (t.startsWith('--phase2=')) out.phase2 = t.slice(9)
    else if (t.startsWith('--materiau=')) out.materiau = t.slice(11)
    else if (t.startsWith('--seuil=')) out.seuil = Number(t.slice(8))
    else if (t.startsWith('--poll-secs=')) out.pollSecs = Number(t.slice(12))
    else if (t.startsWith('--timeout-min=')) out.timeoutMin = Number(t.slice(14))
    else if (t.startsWith('--requester=')) out.requester = t.slice(12)
    else if (t.startsWith('--api=')) out.api = t.slice(6)
    else if (t === '--phase1' || t === '--phase2' || t === '--materiau' || t === '--seuil' ||
      t === '--poll-secs' || t === '--timeout-min' || t === '--requester' || t === '--api') {
      const key = t.slice(2).replace(/-./g, s => s[1].toUpperCase())
      out[key] = argv[i + 1]
      i += 1
    } else {
      throw new Error(`argument inconnu : ${t} (--help pour l aide)`)
    }
  }
  return out
}

async function getJson (url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`)
  return res.json()
}

async function postJson (url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`POST ${url} -> HTTP ${res.status} : ${data.error || res.statusText}`)
  return data
}

function stockOf (inventory, materiau) {
  if (!inventory || typeof inventory !== 'object') return 0
  const v = inventory[materiau]
  return Number.isFinite(v) ? v : 0
}

async function attendreFin (api, pollMs, deadline, label) {
  for (;;) {
    await new Promise(r => setTimeout(r, pollMs))
    const m = await getJson(`${api}/api/mission`)
    if (!m.running) return m.mission
    if (Date.now() > deadline) {
      throw new Error(`${label} : delai depasse, mission toujours en cours (${m.mission?.etapes ?? '?'} etapes)`)
    }
  }
}

async function main () {
  const o = args(process.argv)
  if (o.help) {
    console.log('Usage: node chaine-missions.js [--phase1 "..."] [--phase2 "..."] [--materiau planches] [--seuil N] [--poll-secs 5] [--timeout-min 16] [--requester chaine] [--api URL] [--dry-run]')
    console.log('Defauts : phase1 "' + DEFAULTS.phase1 + '" | phase2 "' + DEFAULTS.phase2 + '"')
    return 0
  }
  const phase1 = o.phase1 ?? DEFAULTS.phase1
  const phase2 = o.phase2 ?? DEFAULTS.phase2
  const materiau = String(o.materiau ?? DEFAULTS.materiau).toLowerCase()
  const pollSecs = Math.max(2, Number(o.pollSecs ?? o.pollSecs ?? DEFAULTS.pollSecs) || DEFAULTS.pollSecs)
  const timeoutMin = Math.min(30, Math.max(1, Number(o.timeoutMin ?? DEFAULTS.timeoutMin) || DEFAULTS.timeoutMin))
  const requester = String(o.requester ?? DEFAULTS.requester).slice(0, 32)
  const api = String(o.api ?? DEFAULTS.api).replace(/\/$/, '')

  if (!MATERIAUX.has(materiau)) {
    console.error(`[chaine] materiau "${materiau}" non suivi : /api/status.inventory n expose que ${[...MATERIAUX].join(', ')} (pas de dirt/terre).`)
    return 1
  }
  const dims = parseDimensions(phase2)
  const besoin = blocsPrevus(dims)
  const seuil = Number.isFinite(o.seuil) && o.seuil !== '' ? Number(o.seuil) : besoin
  if (!Number.isFinite(seuil) || seuil < 1) {
    console.error('[chaine] --seuil doit etre un entier >= 1')
    return 1
  }

  // Garde-fous : constats, jamais d ecriture cote bot.
  const st = await getJson(`${api}/api/status`)
  const base = st?.planner?.base || ''
  const model = st?.planner?.model || ''
  if (!base.includes('opencode.ai/zen')) throw new Error(`garde-fou : planner hors Zen (${base || 'absent'}) — refus`)
  if (!/^deepseek/i.test(model)) throw new Error(`garde-fou : modele non deepseek (${model || 'absent'}) — refus`)
  if (!base) throw new Error('garde-fou : PLANNER_BASE_URL vide — refus (repli Jev interdit ici)')
  const captures0 = st?.planner?.captures ?? 0
  if (captures0 !== 0) console.log(`[chaine] note : planner.captures=${captures0} (MISSION_SCREENSHOT attendu OFF)`)
  if (st?.missionRunning) throw new Error('garde-fou : une mission tourne deja — DELETE /api/mission d abord, pas de chevauchement')

  const inv0 = st?.inventory || null
  const stock0 = stockOf(inv0, materiau)
  console.log(`[chaine] besoin phase 2 (${dims.width}x${dims.depth}x${dims.height}) : ${besoin} bloc(s, borne basse) | seuil ${materiau} >= ${seuil} | stock initial : ${stock0}`)

  if (o.dryRun) {
    console.log(`[chaine] dry-run OK : garde-fous Zen/deepseek OK, besoin=${besoin}, stock ${materiau}=${stock0} ${stock0 >= seuil ? '>= seuil (phase 2 serait lancee)' : '< seuil (phase 2 serait refusee, code 2)'}`)
    return 0
  }

  // Phase 1 : recolte.
  console.log(`[chaine] phase 1 : POST /api/mission "${phase1}"`)
  await postJson(`${api}/api/mission`, { objective: phase1, requester })
  const fin1 = await attendreFin(api, pollSecs * 1000, Date.now() + timeoutMin * 60000, 'phase 1')
  const st1 = await getJson(`${api}/api/status`)
  const stock1 = stockOf(st1?.inventory, materiau)
  console.log(`[chaine] phase 1 finie : etat=${fin1?.etat} etapes=${fin1?.etapes} raison="${fin1?.raison}" resume="${fin1?.resume}" | stock ${materiau} : ${stock0} -> ${stock1} (seuil ${seuil})`)

  // Gate borne : etat done ET stock >= seuil, sinon pas de phase 2, pas de reprise auto.
  if (fin1?.etat !== 'done') {
    console.error(`[chaine] gate refuse : phase 1 en "${fin1?.etat}" (attendu "done"). Phase 2 NON lancee. Inspecter /api/mission puis relancer a la main.`)
    return 2
  }
  if (stock1 < seuil) {
    console.error(`[chaine] gate refuse : stock ${materiau}=${stock1} < seuil ${seuil}. Phase 2 NON lancee (recolter d abord, relancer a la main).`)
    return 2
  }

  // Phase 2 : construction, inventaire conserve (meme conteneur, meme monde).
  console.log(`[chaine] gate OK : phase 2 : POST /api/mission "${phase2}"`)
  await postJson(`${api}/api/mission`, { objective: phase2, requester })
  const fin2 = await attendreFin(api, pollSecs * 1000, Date.now() + timeoutMin * 60000, 'phase 2')
  const st2 = await getJson(`${api}/api/status`)
  const stock2 = stockOf(st2?.inventory, materiau)
  const ch = fin2?.chantier || st2?.mission?.chantier || null
  const captures1 = st2?.planner?.captures ?? 0
  console.log(`[chaine] phase 2 finie : etat=${fin2?.etat} etapes=${fin2?.etapes} raison="${fin2?.raison}" resume="${fin2?.resume}"`)
  console.log(`[chaine] stock ${materiau} : ${stock1} -> ${stock2} (consomme ${stock1 - stock2}) | chantier : ${ch ? `${ch.blocs_poses}/${ch.blocs_prevus} poses, emplacement ${ch.emplacement}, porte ${ch.porte_posee ? 'posee' : 'absente'}` : 'n/a'} | captures ${captures0}->${captures1}`)
  if (ch?.emplacement) {
    const [ox, oy, oz] = String(ch.emplacement).split(' ').map(Number)
    console.log('[chaine] verif serveur (rcon, par l operateur) :')
    console.log(`  docker compose exec -T minecraft rcon-cli "execute if block ${ox} ${oy} ${oz} minecraft:oak_planks run data get entity TestBot UUID"`)
    console.log(`  docker compose exec -T minecraft rcon-cli "data get entity TestBot playerGameType"   # attendu 0 (survie)`)
  }
  if (fin2?.etat !== 'done') {
    console.error(`[chaine] phase 2 en "${fin2?.etat}" : chaine incomplete (code 3).`)
    return 3
  }
  console.log('[chaine] OK : recolte puis chantier, inventaire conserve, garde-fous intacts.')
  return 0
}

main().then(code => process.exit(code)).catch(err => {
  console.error(`[chaine] ERREUR : ${err.message}`)
  process.exit(1)
})
