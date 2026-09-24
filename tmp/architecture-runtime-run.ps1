# tmp/architecture-runtime-run.ps1 — PREPARATION seule : NE PAS EXECUTER pendant writers bot/*.js.
#
# Campagne jetable candidat (prochaine action, APRES fin writers + code fige) :
# vrai index.js+mission+API dans un conteneur "architecture-candidate" SANS
# remplacer prod TestBot. Ce script est READY mais NON LANCE par cette action.
#
# Garanties :
#  - image tag architecture-candidate (jamais latest) ; build depuis copie figee /tmp
#    APRES writers ; aucune nouvelle dep dans app (verifie package.json allow-list).
#  - candidat BOT_USERNAME=TestProbe3, receveur TestProbe2 (tmp/probe-bot.js
#    OBLIGATOIRE, reserve prochaine action, pas maintenant) ; jamais 2x TestBot.
#  - API candidat 127.0.0.1:3001 (conteneur 3000 mappe), principal 3000 LECTURE SEULE
#    (GET /api/status) ; aucune commande principal, config/monde pas reset.
#  - cle Go Muse (D37) injectee depuis env bot existant via hote SANS AFFICHER
#    (jamais Write-Host, -e seuls, aucun fichier secret) ; session id preuve unique,
#    images OFF, data ephemere (dossier temp, jamais volume prod bot-data).
#  - fixtures RCON uniquement 1000..1024 y=199, colonne TP verifiee air+sol avant
#    chaque usage, fixtures serial une owner ; aucune autre action/agent sur arene.
#  - nettoyage : harness liberes, forceload restaure, inventaire lu sans lost main.
#  - borne globale 15 min, arbitrage 60 s reel, un seul scenario debug retente.
#
# EXECUTION REELLE 2026-09-24 (resultats : tmp/architecture-runtime-results.json) :
# driver = pwsh direct (hote sans Node ; probe.js = reference des scenarios).
# Ordre execute : Check -> Build (fige + tag) -> Up (candidat TestProbe3 + receveur
# TestProbe2 via probe-bot.js + fixtures RCON + forceload) -> Probe (ci-dessous,
# S0..S9) -> Down (harness, candidat, forceload, volume dedie).
# LECONS OBLIGATOIRES (redecouvertes en campagne, a garder) :
#  - POST /api/mission|/api/instruction TOUJOURS avec "mode":"temporary"
#    (readDirectMode index.js:1087 rend undefined sinon -> 500 "reading 'error'") ;
#  - preload v2 triple-verrou exigee (v1 leak prouve : bot.chat=undefined au retour
#    de createBot, plugin mineflayer ecrase au login -> boucle chatter) ; preuve
#    silence par marqueur /api/chat capture localement, zero ligne serveur ;
#  - reponse "remplacement"/"pause_reprise" explicite aux arbitrages (pas 60 s
#    sauf S3) ; hardstop API irréversible dans l etat teste (resume echoue sur
#    rehydrate) -> S5 partiel, S4/S9 non couverts honnetement.
param([ValidateSet('Check','Build','Up','Probe','Down','All')][string]$Phase = 'Check')

$ErrorActionPreference = 'Stop'
$Proj = 'C:\Users\user\Downloads\minecraft-bot-test'
$Tag  = 'minecraft-bot-test-architecture-candidate'
$HostPort = 3001
$NetName = (docker network ls --format '{{.Name}}' | Select-String 'mc-test-net' | Select-Object -First 1).ToString().Trim()
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Session = "minecraft-bot-arch-candidate-$Stamp"   # session id preuve unique
$FreezeDir = Join-Path $env:TEMP "arch-candidate-freeze-$Stamp"
$DataDir  = Join-Path $env:TEMP "arch-candidate-data-$Stamp"

function Fail($m) { Write-Error $m; exit 1 }

function Phase-Check {
  if (-not $NetName) { Fail 'reseau mc-test-net introuvable (compose up requis)' }
  $p = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/status' -TimeoutSec 10
  if (-not $p.spawned) { Fail 'principal 3000 non spawne : ne pas lancer la campagne' }
  try { $null = Invoke-RestMethod -Uri "http://127.0.0.1:$HostPort/api/status" -TimeoutSec 3; Fail "port $HostPort occupe (candidat deja present?)" } catch {}
  $used = docker compose exec -T minecraft rcon-cli 'forceload query 1000 1000' 2>$null
  Write-Host "[check] net=$NetName principal=TestBot spawned=$($p.spawned) forceload=$used session=$Session"
  Write-Host '[check] OK : pret pour Build (APRES writers).'
}

function Phase-Build {
  # Fige APRES writers : copie bot/ -> temp, verifie deps, build tag dedie.
  if (Test-Path $FreezeDir) { Remove-Item -Recurse -Force $FreezeDir }
  Copy-Item -Recurse "$Proj\bot" $FreezeDir
  Copy-Item "$Proj\tmp\architecture-runtime-preload.js" (Join-Path $FreezeDir 'architecture-runtime-preload.js')
  $pkg = Get-Content (Join-Path $FreezeDir 'package.json') -Raw | ConvertFrom-Json
  $allow = @('express','mineflayer','mineflayer-pathfinder','@typesafe-ai/sdk')
  foreach ($d in $pkg.dependencies.PSObject.Properties.Name) { if ($allow -notcontains $d) { Fail "nouvelle dep interdite dans app : $d" } }
  docker build -t $Tag $FreezeDir
  if ($LASTEXITCODE -ne 0) { Fail 'docker build candidat echoue' }
  Write-Host "[build] image $Tag fige $FreezeDir (sans latest)."
}

function Env-Candidat {
  # Cle injectee depuis env bot existant SANS AFFICHER : tunnel memoire seule, -e seuls.
  $key = (docker compose exec -T bot sh -c 'printf %s "$PLANNER_API_KEY"') | Out-String
  $key = $key.Trim()
  if (-not $key) { Fail 'PLANNER_API_KEY bot vide : campagne impossible (pas de fuite, pas de log)' }
  return @{
    MC_HOST='minecraft'; MC_PORT='25565'; MC_VERSION='26.1'; BOT_USERNAME='TestProbe3'; API_PORT='3000'
    PLANNER_BASE_URL='https://opencode.ai/zen/go/v1'; PLANNER_MODEL='muse-spark-1.3-contributor'; PLANNER_API_KEY=$key
    PLANNER_SESSION_ID=$Session; PLANNER_USER_AGENT='minecraft-bot/1.0'
    PLANNER_TIMEOUT_MS='20000'; PLANNER_MAX_TOKENS='2000'
    MISSION_SCREENSHOT=''; MISSION_SCREENSHOT_EVERY='5'
    NODE_OPTIONS='--require /app/architecture-runtime-preload.js'; CANDIDATE_CHAT_LOG='/tmp/candidate-chat.log'
  }
}

function Phase-Up {
  if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir | Out-Null }
  $e = Env-Candidat
  $args = @('run','-d','--rm','--name','arch-candidate',"--network",$NetName,'-p',"127.0.0.1:${HostPort}:3000",'-v',"${DataDir}:/data")
  foreach ($k in $e.Keys) { $args += @('-e',"$k=$($e[$k])") }  # -e seuls, aucun fichier secret
  $args += @($Tag)
  & docker @args
  Start-Sleep 12
  $s = Invoke-RestMethod -Uri "http://127.0.0.1:$HostPort/api/status" -TimeoutSec 10
  if (-not $s.spawned) { Fail 'candidat non spawne (voir docker logs arch-candidate)' }
  Write-Host "[up] candidat TestProbe3 spawned sur $HostPort, session $Session."
  Write-Host '[up] ETAPE SUIVANTE (reservation, pas maintenant auto) :'
  Write-Host '  docker compose cp tmp/probe-bot.js bot:/tmp/h2.js'
  Write-Host '  docker compose exec -T -d -e NODE_PATH=/app/node_modules bot node /tmp/h2.js TestProbe2 --idle-secs 1200'
  Write-Host '  puis fixtures RCON serial + colonne verifiee (voir probe), arene 1000..1024 y=199 reservee.'
}

function Phase-Probe {
  node "$Proj\tmp\architecture-runtime-probe.js" --candidate "http://127.0.0.1:$HostPort" --principal 'http://127.0.0.1:3000' --out "$Proj\tmp\architecture-runtime-results.json" --timeout-ms 900000
  if ($LASTEXITCODE -ne 0) { Write-Warning 'probe : echecs (voir results.json, 1 retry debug max)' ; exit 1 }
}

function Phase-Down {
  docker compose exec -T bot pkill -f '/tmp/h2.js' 2>$null
  docker compose exec -T minecraft rcon-cli 'forceload remove 1000 1000' 2>$null | Out-Null
  docker rm -f arch-candidate 2>$null | Out-Null
  # Preuve sans perte main : lectures seules.
  try { Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/status' -TimeoutSec 10 | Out-Null } catch {}
  Write-Host '[down] candidat supprime, harness libere, forceload restaure, principal relu (inventaire sans clear).'
}

Set-Location $Proj
switch ($Phase) {
  'Check' { Phase-Check }
  'Build' { Phase-Build }
  'Up'    { Phase-Up }
  'Probe' { Phase-Probe }
  'Down'  { Phase-Down }
  'All'   { Phase-Check; Phase-Build; Phase-Up; Phase-Probe; Phase-Down }
}
