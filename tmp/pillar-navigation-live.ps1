param([switch]$Start, [switch]$Observe, [switch]$PickupPhase, [switch]$DirtPhase, [int]$Seconds = 30)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
$path = Join-Path $PSScriptRoot $(if ($DirtPhase) { 'pillar-navigation-dirt-context-live.json' } elseif ($PickupPhase) { 'pillar-navigation-pickup-live.json' } else { 'pillar-navigation-live.json' })
if (($PickupPhase -or $DirtPhase) -and $Start) { throw 'Follow-up phases must resume existing objective, never start a duplicate' }
function Status { Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/status' -TimeoutSec 8 }
function LogsColumn {
  $cells = @()
  foreach ($y in 69..73) {
    $reply = (& docker compose exec -T minecraft rcon-cli "execute if block 44 $y -106 #minecraft:logs") -join ' '
    $cells += [pscustomobject]@{ x=44; y=$y; z=-106; isLog=($reply -eq 'Test passed'); reply=$reply }
  }
  return $cells
}
if ($Start) {
  if (Test-Path -LiteralPath $path) { throw 'Live proof already exists: never issue duplicate objective' }
  $before = Status
  if ($before.missionRunning -or $before.objectifs.current -or $before.objectifs.hardstop -or $before.objectifs.workPaused) { throw 'Unexpected objective or stop state: do not start' }
  $beforeColumn = LogsColumn
  $inventory = (& docker compose exec -T minecraft rcon-cli 'data get entity TestBot Inventory') -join ' '
  $report = [ordered]@{ at=[DateTime]::UtcNow.ToString('o'); before=$before; beforeColumn=$beforeColumn; beforeInventoryRcon=$inventory; snapshots=@(); windows=@() }
  $body = @{ requester='Rhadamanthe0'; message="Casse l'arbre à côté" } | ConvertTo-Json -Compress
  $report | ConvertTo-Json -Depth 75 | Set-Content -LiteralPath $path -Encoding utf8
  try {
    $report.admission = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/instruction' -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 105
  } catch {
    $report.admissionError = $_.Exception.Message
    throw
  } finally { $report | ConvertTo-Json -Depth 75 | Set-Content -LiteralPath $path -Encoding utf8 }
  $report.admission | ConvertTo-Json -Depth 6
}
if ($Observe) {
  if ($Seconds -lt 1 -or $Seconds -gt 60) { throw 'Observation window must be 1..60 seconds' }
  $report = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  $window = [ordered]@{ at=[DateTime]::UtcNow.ToString('o'); reason='window elapsed' }
  do {
    $s = Status
    $report.snapshots += [pscustomobject]@{ at=[DateTime]::UtcNow.ToString('o'); status=$s }
    if ($s.inLiquid -or $s.health -lt $report.before.health) {
      $window.reason='danger'
      $window.safetyPause = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/stop' -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 8
      break
    }
    if (-not $s.missionRunning) { $window.reason='mission ended or paused'; break }
    if ($DirtPhase) {
      $remainingNow = @(LogsColumn | Where-Object isLog).Count
      $report.snapshots[-1] | Add-Member -NotePropertyName remainingTargetLogs -NotePropertyValue $remainingNow -Force
      $woodGained = @($report.snapshots | Where-Object { $_.status.inventory.buches -gt $report.before.inventory.buches }).Count -gt 0
      if ($remainingNow -eq 0 -and $woodGained) {
        $window.reason='validation complete: target column empty and new wood received'
        $window.validationPause = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/stop' -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 8
        break
      }
    }
    Start-Sleep -Seconds 3
  } while ([DateTime]::UtcNow -lt $deadline)
  $window.after = Status
  $window.column = LogsColumn
  $window.inventoryRcon = (& docker compose exec -T minecraft rcon-cli 'data get entity TestBot Inventory') -join ' '
  $window.trace = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/navigation/trace?history=1' -TimeoutSec 8
  $window.remainingTargetLogs = @($window.column | Where-Object isLog).Count
  $window.woodObservedInInventory = ($window.after.inventory.buches -gt $report.before.inventory.buches) -or (@($report.snapshots | Where-Object { $_.status.inventory.buches -gt $report.before.inventory.buches }).Count -gt 0)
  $since = ([DateTime]$report.at).ToUniversalTime().ToString('o')
  $logs = @(& docker compose logs --since $since --no-color bot 2>&1 | ForEach-Object { "$_" })
  $window.logs = $logs
  $report.windows += [pscustomobject]$window
  $report | ConvertTo-Json -Depth 75 | Set-Content -LiteralPath $path -Encoding utf8
  [pscustomobject]@{reason=$window.reason;position=$window.after.position;onGround=$window.after.onGround;health=$window.after.health;mission=$window.after.mission;inventory=$window.after.inventory;remainingTargetLogs=$window.remainingTargetLogs;woodObservedInInventory=$window.woodObservedInInventory} | ConvertTo-Json -Depth 7
  $logs | Select-Object -Last 18
}
if (-not $Start -and -not $Observe) { Write-Output 'Prepared only. Start requires orchestrator GO; observation windows do not issue objectives.' }
