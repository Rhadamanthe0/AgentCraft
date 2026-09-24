param([switch]$Observe,[int]$Seconds=30)
$ErrorActionPreference='Stop'
$OutputEncoding=[Text.UTF8Encoding]::new($false)
if(-not $Observe){Write-Output 'Prepared only: no service/API/world action. Observe requires orchestrator GO after deployment and resume.';return}
if($Seconds -lt 1 -or $Seconds -gt 30){throw 'Window must be1..30 seconds'}
$proofPath=Join-Path $PSScriptRoot 'tree-dual-live.json'
$diagnostic=Get-Content (Join-Path $PSScriptRoot 'tree-complete-diagnostic.json') -Raw | ConvertFrom-Json
$targets=@($diagnostic.branchScan.logs)
if($targets.Count -ne 12){throw 'Expected exact12 measured targets'}
function Status { curl.exe -s --max-time 8 http://127.0.0.1:3000/api/status | ConvertFrom-Json }
function BlocksAndStock {
  $commands=@($targets | ForEach-Object {"execute if block $($_.x) $($_.y) $($_.z) minecraft:oak_log"})+@('data get entity TestBot Inventory[{id:"minecraft:dirt"}]','data get entity TestBot Inventory[{id:"minecraft:oak_log"}]','exit')
  $raw=($commands | docker compose exec -T minecraft rcon-cli) -join "`n"
  $answers=@([regex]::Matches($raw,'> (Test passed|Test failed)') | ForEach-Object {$_.Groups[1].Value})
  if($answers.Count -ne 12){throw 'Incomplete target observations'}
  $cells=@(for($i=0;$i -lt 12;$i++){[pscustomobject]@{x=$targets[$i].x;y=$targets[$i].y;z=$targets[$i].z;oakLog=($answers[$i] -eq 'Test passed')}})
  [pscustomobject]@{at=[DateTime]::UtcNow.ToString('o');cells=$cells;remaining=@($cells|Where-Object oakLog).Count;stockRaw=$raw}
}
function FullScanAndInventory {
  $cells=[Collections.Generic.List[object]]::new()
  foreach($x in 38..50){foreach($z in -112..-100){foreach($y in 65..82){$cells.Add([pscustomobject]@{x=$x;y=$y;z=$z})}}}
  $commands=@($cells|ForEach-Object {"execute if block $($_.x) $($_.y) $($_.z) #minecraft:logs"})+@('exit')
  $raw=($commands|docker compose exec -T minecraft rcon-cli)-join "`n"
  $answers=@([regex]::Matches($raw,'> (Test passed|Test failed)')|ForEach-Object {$_.Groups[1].Value})
  if($answers.Count -ne $cells.Count){throw 'Incomplete full-volume scan'}
  $remaining=@(for($i=0;$i -lt $cells.Count;$i++){if($answers[$i] -eq 'Test passed'){$cells[$i]}})
  $drops=[ordered]@{}
  foreach($field in @('Pos','Item','Age','PickupDelay')){
    $drops[$field]=((& docker compose exec -T minecraft rcon-cli "execute positioned 44 71 -106 as @e[type=minecraft:item,nbt={Item:{id:`"minecraft:oak_log`"}},distance=..18,sort=nearest,limit=30] run data get entity @s $field")-join ' ')
  }
  $ops=((& docker compose exec -T minecraft cat /data/ops.json)-join "`n")|ConvertFrom-Json
  [pscustomobject]@{at=[DateTime]::UtcNow.ToString('o');bounds=@{x=@(38,50);z=@(-112,-100);y=@(65,82)};testedCells=$cells.Count;remaining=$remaining;drops=$drops;inventoryRcon=((& docker compose exec -T minecraft rcon-cli 'data get entity TestBot Inventory')-join ' ');survival=((& docker compose exec -T minecraft rcon-cli 'data get entity TestBot playerGameType')-join ' ');testBotAbsentFromOps=(@($ops|Where-Object name -eq TestBot).Count -eq 0)}
}
$before=Status
if($before.objectifs.current.id -ne 'obj-91'){throw 'Unexpected current objective; do not operate another objective'}
if(Test-Path $proofPath){$report=Get-Content $proofPath -Raw | ConvertFrom-Json}else{$report=[pscustomobject]@{at=[DateTime]::UtcNow.ToString('o');targets=$targets;initial=$before;windows=@();limits='All12 measured logs tracked, no automatic completion claim. Entire-volume rescan required after clearing; detached branch ownership uncertain.'}}
$window=[ordered]@{at=[DateTime]::UtcNow.ToString('o');before=$before;snapshots=@();blockSnapshots=@();reason='bounded window elapsed'}
$deadline=[DateTime]::UtcNow.AddSeconds($Seconds)
try {
  do {
    $s=Status
    $window.snapshots+= [pscustomobject]@{at=[DateTime]::UtcNow.ToString('o');status=$s}
    $window.blockSnapshots+=BlocksAndStock
    if($s.health -lt $before.health -or $s.inLiquid){
      $window.reason='safety pause: health decreased or liquid'
      $window.safetyPause=Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/stop' -Method Post -ContentType application/json -Body '{}' -TimeoutSec 8
      break
    }
    if($s.objectifs.current.id -ne 'obj-91'){$window.reason='objective changed; observation ended';break}
    if($window.blockSnapshots[-1].remaining -eq 0){
      $window.fullScan=FullScanAndInventory
      if($window.fullScan.remaining.Count -eq 0){
        $window.reason='validation pause: entire scanned volume contains no logs; recovery extent recorded separately'
        $window.validationPause=Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/stop' -Method Post -ContentType application/json -Body '{}' -TimeoutSec 8
        break
      }
    }
    if(-not $s.missionRunning){$window.reason='mission is not running';break}
    Start-Sleep -Seconds 3
  }while([DateTime]::UtcNow -lt $deadline)
}finally {
  $window.after=Status
  $window.logs=@(& docker compose logs --since $window.at --timestamps --no-color bot 2>&1 | ForEach-Object {"$_"})
  $window.trace=curl.exe -s --max-time 8 'http://127.0.0.1:3000/api/navigation/trace?history=1' | ConvertFrom-Json
  $report.windows+=[pscustomobject]$window
  $report | ConvertTo-Json -Depth 80 | Set-Content $proofPath -Encoding utf8
}
[pscustomobject]@{reason=$window.reason;position=$window.after.position;health=$window.after.health;onGround=$window.after.onGround;controls=$window.after.controls;mission=$window.after.mission.etat;steps=$window.after.mission.etapes;remaining=$window.blockSnapshots[-1].remaining;inventory=$window.after.inventory;stock=$window.blockSnapshots[-1].stockRaw;recentActions=$window.after.mission.historique} | ConvertTo-Json -Depth 8
$window.logs | Select-Object -Last 20


