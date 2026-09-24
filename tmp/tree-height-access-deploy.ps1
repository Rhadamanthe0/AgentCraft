param([switch]$Run)
$ErrorActionPreference='Stop'
if(-not $Run){Write-Output 'Prepared only. Run requires favorable review and root deployment GO.';return}
$path=Join-Path $PSScriptRoot 'tree-height-access-deploy.json'
function Status { curl.exe -s --max-time 8 http://127.0.0.1:3000/api/status | ConvertFrom-Json }
function Save { $script:r | ConvertTo-Json -Depth 80 | Set-Content $path -Encoding utf8 }
$before=Status
if(-not $before.objectifs.workPaused -or $before.missionRunning -or $before.objectifs.current.id -ne 'obj-91' -or $before.controls.Count -ne 0){throw 'Unexpected running/control/objective state'}
$diag=Get-Content (Join-Path $PSScriptRoot 'tree-dual-blocked.json') -Raw | ConvertFrom-Json
if(($before.objectifs.inbox | ConvertTo-Json -Depth 20 -Compress) -ne ($diag.after.objectifs.inbox | ConvertTo-Json -Depth 20 -Compress)){throw 'New user message since diagnostic: coordinate before deploying'}
$imageId=(& docker inspect --format '{{.Image}}' minecraft-bot-test-bot-1).Trim()
$tag='minecraft-bot-test-bot:before-tree-height-access-20260924'
$r=[ordered]@{at=[DateTime]::UtcNow.ToString('o');before=$before;oldImage=$imageId;backupTag=$tag;minecraftBefore=((& docker inspect --format '{{.Id}} {{.State.StartedAt}}' minecraft-bot-test-minecraft-1) -join ' ');localMissionHash=(Get-FileHash bot/mission.js -Algorithm SHA256).Hash.ToLower();stage='checked preconditions'}
Save
$existing=@(& docker image ls --format '{{.Repository}}:{{.Tag}}' | Where-Object {$_ -eq $tag})
if($existing.Count -eq 0){& docker tag $imageId $tag;if($LASTEXITCODE -ne 0){throw 'Backup tag failed'};$r.backupCreated=$true}else{$r.backupCreated=$false}
$r.stage='building';Save
& docker compose build bot
if($LASTEXITCODE -ne 0){throw 'Build failed'}
$r.stage='built';Save
$check=Status
if($check.missionRunning -or ($check.objectifs.inbox | ConvertTo-Json -Depth 20 -Compress) -ne ($before.objectifs.inbox | ConvertTo-Json -Depth 20 -Compress)){throw 'New mission/chat during build; no recreation'}
& docker compose up -d --no-deps bot
if($LASTEXITCODE -ne 0){throw 'Bot recreate failed'}
$r.stage='recreated';Save
$deadline=[DateTime]::UtcNow.AddSeconds(55)
do {
  Start-Sleep -Seconds 2
  $healthy=(& docker inspect --format '{{.State.Health.Status}}' minecraft-bot-test-bot-1).Trim()
}while($healthy -ne 'healthy' -and [DateTime]::UtcNow -lt $deadline)
$after=Status
$r.after=$after
$r.newImage=(& docker inspect --format '{{.Image}}' minecraft-bot-test-bot-1).Trim()
$r.containerMissionHash=((& docker exec minecraft-bot-test-bot-1 sha256sum /app/mission.js) -split ' ')[0]
$r.sourceHashes=@(foreach($file in @('mission.js','planner.js','skills.js','model-routing.js')){[pscustomobject]@{file=$file;local=(Get-FileHash (Join-Path bot $file) -Algorithm SHA256).Hash.ToLower();container=((& docker exec minecraft-bot-test-bot-1 sha256sum "/app/$file") -split ' ')[0]}})
$r.config=((& docker exec minecraft-bot-test-bot-1 node -e 'console.log(JSON.stringify({model:process.env.PLANNER_MODEL,routingMode:process.env.PLANNER_ROUTING_MODE,fastModel:process.env.PLANNER_FAST_MODEL,fastTimeoutMs:Number(process.env.PLANNER_FAST_TIMEOUT_MS),fastMaxTokens:Number(process.env.PLANNER_FAST_MAX_TOKENS),strategyModel:process.env.PLANNER_STRATEGY_MODEL,strategyTimeoutMs:Number(process.env.PLANNER_STRATEGY_TIMEOUT_MS),strategyMaxTokens:Number(process.env.PLANNER_STRATEGY_MAX_TOKENS),repairModel:process.env.REPAIR_MODEL}))') | ConvertFrom-Json)
$r.minecraftAfter=((& docker inspect --format '{{.Id}} {{.State.StartedAt}}' minecraft-bot-test-minecraft-1) -join ' ')
$r.inventoryRcon=((& docker compose exec -T minecraft rcon-cli 'data get entity TestBot Inventory') -join ' ')
$r.checks=[ordered]@{healthy=($healthy -eq 'healthy');spawned=($after.spawned -and $after.username -eq 'TestBot');idle=(-not $after.missionRunning -and $after.controls.Count -eq 0);objective=($after.objectifs.current.id -eq 'obj-91' -and $after.objectifs.current.texte -eq $before.objectifs.current.texte);pendingPreserved=(($after.objectifs.pending.id -join ',') -eq ($before.objectifs.pending.id -join ','));position=(($after.position|ConvertTo-Json -Compress) -eq ($before.position|ConvertTo-Json -Compress));inventory=(($after.inventory|ConvertTo-Json -Depth 6 -Compress) -eq ($before.inventory|ConvertTo-Json -Depth 6 -Compress));missionHash=($r.localMissionHash -eq $r.containerMissionHash);config=($r.config.model -eq 'mimo-v2.6-flash' -and $r.config.routingMode -eq 'dual' -and $r.config.fastModel -eq 'mimo-v2.6-flash' -and $r.config.fastTimeoutMs -eq 45000 -and $r.config.fastMaxTokens -eq 4096 -and $r.config.strategyModel -eq 'muse-spark-1.3-contributor' -and $r.config.strategyTimeoutMs -eq 120000 -and $r.config.strategyMaxTokens -eq 16384 -and $r.config.repairModel -eq 'muse-spark-1.3-contributor');minecraftUntouched=($r.minecraftBefore -eq $r.minecraftAfter)}
$r.stage='verified';Save
$r.checks.sourceHashes=(@($r.sourceHashes|Where-Object {$_.local -ne $_.container}).Count -eq 0)
$r.checks.pausePreserved=($after.objectifs.workPaused -eq $true)
Save
[pscustomobject]$r.checks | ConvertTo-Json
if(@($r.checks.Values | Where-Object {$_ -ne $true}).Count){throw 'At least one deployment verification failed; do not resume'}
Write-Output 'Deployment verified. No resume issued by this script.'



