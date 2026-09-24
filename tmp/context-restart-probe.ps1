param([switch]$Run)
$ErrorActionPreference = 'Stop'
if (-not $Run) { Write-Output 'Prepared only. Explicit orchestrator GO required before -Run.'; exit 0 }
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$candidateName = 'context-restart-probe'
$candidateVolume = 'context-restart-data'
$baseUri = 'http://127.0.0.1:3002'
$resultPath = Join-Path $PSScriptRoot 'context-restart-results.json'
$report = [ordered]@{ at = [DateTime]::UtcNow.ToString('o'); scope = 'Real API/conversation/runner/store/Minecraft; deterministic planner double, no remote model validation'; passed = $false; checks = @(); evidence = [ordered]@{} }
$created = $false
$volumeCreated = $false
function Api([string]$route, $body = $null) {
  if ($null -eq $body) { return Invoke-RestMethod -Uri ($baseUri + $route) -TimeoutSec 10 }
  return Invoke-RestMethod -Uri ($baseUri + $route) -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 30 -Compress))) -TimeoutSec 10
}
function Check([bool]$ok, [string]$label) {
  $report.checks += [ordered]@{ ok = $ok; label = $label }
  if (-not $ok) { throw "Assertion failed: $label" }
}
function Disk([string]$path) {
  $raw = & docker exec $candidateName cat $path
  if ($LASTEXITCODE -ne 0) { throw "Cannot read candidate artifact $path" }
  return ($raw -join "`n") | ConvertFrom-Json
}
function Ready {
  $until = [DateTime]::UtcNow.AddSeconds(45)
  do {
    try { $s = Api '/api/status'; if ($s.spawned) { return $s } } catch {}
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $until)
  throw 'Candidate did not spawn within 45 seconds'
}
function Same($actual, $expected) {
  return (($actual | ConvertTo-Json -Depth 30 -Compress) -ceq ($expected | ConvertTo-Json -Depth 30 -Compress))
}
function Quiet($s) {
  return (-not $s.missionRunning -and -not $s.pathfinding -and @($s.controls).Count -eq 0 -and $s.rescues -eq 0)
}
try {
  $names = @(& docker ps -a --format '{{.Names}}')
  Check (-not ($names -contains $candidateName)) 'dedicated candidate name unused'
  $volumes = @(& docker volume ls --format '{{.Name}}')
  Check (-not ($volumes -contains $candidateVolume)) 'dedicated volume unused'
  $candidateImage = (& docker inspect minecraft-bot-test-bot-1 --format '{{.Config.Image}}').Trim()
  if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve current image' }
  & docker volume create $candidateVolume | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Cannot create dedicated volume' }
  $volumeCreated = $true
  $argsRun = @('run', '-d', '--name', $candidateName, '--network', 'minecraft-bot-test_mc-test-net',
    '-p', '127.0.0.1:3002:3000', '--mount', "type=bind,source=$repo\bot,target=/src,readonly",
    '--mount', "type=bind,source=$repo,target=/work,readonly", '--mount', "type=volume,source=$candidateVolume,target=/data",
    '-e', 'NODE_PATH=/app/node_modules', '-e', 'NODE_OPTIONS=--require /work/tmp/context-restart-preload.js',
    '-e', 'BOT_USERNAME=TestProbe3', '-e', 'MC_HOST=minecraft', '-e', 'MC_PORT=25565', '-e', 'MC_VERSION=26.1',
    '-e', 'API_PORT=3000', '-e', 'PLANNER_BASE_URL=https://opencode.ai/zen/go/v1', '-e', 'PLANNER_MODEL=deepseek-v4.1-flash',
    '-e', 'PLANNER_API_KEY=', '-e', 'MISSION_SCREENSHOT=', '-e', 'MEMORY_FILE=/data/memory.json',
    '-e', 'OBJECTIVES_FILE=/data/objectives.json', '-e', 'OBJECTIVES_EVENTS_FILE=/data/objectives-events.jsonl',
    $candidateImage, 'node', '/src/index.js')
  & docker @argsRun | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Candidate launch failed' }
  $created = $true
  $initial = Ready
  Check ($initial.username -ceq 'TestProbe3' -and -not $initial.inLiquid) 'silent candidate spawned outside liquid'
  Start-Sleep -Seconds 1
  $initial = Api '/api/status'
  $report.evidence.initial = $initial
  $admitted = Api '/api/mission' @{ objective = 'Ramasse 16 blocs de sable'; requester = 'ContextProbeOwner'; mode = 'temporary' }
  Check ($admitted.ok -eq $true) 'temporary objective admitted by real API'
  $expected = @()
  $acceptances = @()
  for ($i = 1; $i -le 8; $i++) {
    $author = if ($i % 2 -eq 0) { 'ContextProbeOwner' } else { 'ContextProbeWitness' }
    $msg = "Precision test $i : conserver cette information $i sans deplacement."
    $expected += [pscustomobject]@{ de = $author; message = $msg }
    $response = Api '/api/instruction' @{ message = $msg; requester = $author }
    $acceptances += $response
    Check ($response.ok -eq $true -and $response.relation -eq 'context') "context $i accepted"
  }
  # Read disk immediately after acceptance, before stop can save progress.
  $immediate = Disk '/data/objectives.json'
  $report.evidence.expected = $expected
  $report.evidence.acceptances = $acceptances
  $report.evidence.immediateDisk = $immediate
  Check (Same $immediate.current.progression.contexte $expected) 'eight exact authors/messages in order durable immediately after acceptance'
  Check ($immediate.current.progression.etapes -eq 0) 'context persisted before first wait action completes'
  Check ($null -ne $immediate.current.progression.descripteur) 'resume descriptor persisted before first action completion'
  $stop = Api '/api/instruction' @{ message = 'arret total'; requester = 'ContextProbeOwner' }
  Check ($stop.ok -eq $true -and $stop.kind -eq 'hardstop') 'hardstop handled outside interpreter'
  $before = Api '/api/status'
  $diskBefore = Disk '/data/objectives.json'
  $planBefore = Disk '/data/observed-plan.json'
  $report.evidence.beforeRestart = $before
  $report.evidence.diskBeforeRestart = $diskBefore
  $report.evidence.planBeforeRestart = $planBefore
  Check ($before.objectifs.hardstop -and (Quiet $before)) 'hardstop stops activity before restart'
  & docker restart --time 2 $candidateName | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Restart failed' }
  $after = Ready
  Start-Sleep -Seconds 6
  $after = Api '/api/status'
  $planIdle = Disk '/data/observed-plan.json'
  $report.evidence.afterRestartBeforeResume = $after
  Check ($after.objectifs.hardstop -and (Quiet $after)) 'hardstop durable after restart and six seconds without activity'
  Check (Same $planIdle $planBefore) 'no planner invocation replay before explicit resume'
  Check (Same $after.objectifs.current.progression.contexte $expected) 'eight contexts preserved through restart'
  Check (Same $after.position $before.position) 'position unchanged through restart and idle'
  Check ($after.objectifs.current.id -ceq $before.objectifs.current.id) 'durable objective identity preserved'
  $resume = Api '/api/resume' @{}
  Check ($resume.ok -eq $true) 'explicit resume admitted'
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    $resumedPlan = Disk '/data/observed-plan.json'
    if ($resumedPlan.boot -cne $planBefore.boot) { break }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  $resumed = Api '/api/status'
  $report.evidence.firstResumedPlan = $resumedPlan
  $report.evidence.resumed = $resumed
  Check ($resumedPlan.boot -cne $planBefore.boot -and $resumedPlan.calls -eq 1) 'observed first planner invocation of restarted process'
  Check (Same $resumedPlan.consigne.precisions $expected) 'actual runner passes exact restored context to deterministic planner'
  Check ($resumedPlan.progression.blocs_casses -eq 0 -and $resumedPlan.progression.objets_recoltes -eq 0 -and $resumedPlan.progression.etapes_effectuees -eq 0) 'resume does not replay work or manufacture progress'
  Check ($resumed.mission.rehydrated -eq $true) 'real runner rehydrated objective'
  Check (Same $resumed.position $initial.position) 'candidate stayed at original settled spawn position'
  Check ($resumed.rescues -eq 0 -and -not $resumed.pathfinding -and @($resumed.controls).Count -eq 0) 'no navigation controls or rescue'
  $report.passed = $true
} catch {
  $report.error = $_.Exception.Message
} finally {
  if ($created) {
    try { $report.evidence.finalStop = Api '/api/instruction' @{ message = 'arret total'; requester = 'ContextProbeOwner' } } catch {}
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $report.evidence.candidateLogs = @(& docker logs --tail 120 $candidateName 2>&1 | ForEach-Object { "$_" })
      & docker rm -f $candidateName | Out-Null
      $report.containerRemoved = ($LASTEXITCODE -eq 0)
    } finally { $ErrorActionPreference = $savedPreference }
  }
  if ($volumeCreated) {
    & docker volume rm $candidateVolume | Out-Null
    $report.volumeRemoved = ($LASTEXITCODE -eq 0)
  }
  $report | ConvertTo-Json -Depth 60 | Set-Content -LiteralPath $resultPath -Encoding utf8
}
Write-Output ([pscustomobject]$report | Select-Object passed, error, containerRemoved, volumeRemoved | ConvertTo-Json -Compress)
if (-not $report.passed) { exit 1 }
