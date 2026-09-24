$ErrorActionPreference='Stop'
$path=Join-Path $PSScriptRoot 'tree-complete-diagnostic.json'
$r=Get-Content $path -Raw | ConvertFrom-Json
$queries=[Collections.Generic.List[object]]::new()
foreach($x in 38..50){foreach($z in -112..-100){foreach($y in 79..82){$queries.Add([pscustomobject]@{x=$x;y=$y;z=$z;kind='upper';block='#minecraft:logs'})}}}
foreach($x in 43..45){foreach($z in -107..-105){foreach($y in 64..78){foreach($block in @('minecraft:air','minecraft:grass_block','minecraft:dirt','minecraft:oak_leaves','minecraft:oak_log')){$queries.Add([pscustomobject]@{x=$x;y=$y;z=$z;kind='bodyColumn';block=$block})}}}}
foreach($p in $r.branchScan.logs){$queries.Add([pscustomobject]@{x=$p.x;y=$p.y;z=$p.z;kind='species';block='minecraft:oak_log'})}
$commands=@($queries | ForEach-Object { "execute if block $($_.x) $($_.y) $($_.z) $($_.block)" })+@('exit')
$raw=($commands | docker compose exec -T minecraft rcon-cli) -join "`n"
$answers=@([regex]::Matches($raw,'> (Test passed|Test failed)') | ForEach-Object {$_.Groups[1].Value})
if($answers.Count -ne $queries.Count){throw "Unexpected response count"}
$passed=@(for($i=0;$i -lt $queries.Count;$i++){if($answers[$i] -eq 'Test passed'){$queries[$i]}})
$r | Add-Member -NotePropertyName geometry -NotePropertyValue ([ordered]@{at=[DateTime]::UtcNow.ToString('o');upperBounds=@{x=@(38,50);z=@(-112,-100);y=@(79,82)};upperLogs=@($passed | Where-Object kind -eq upper);bodyBounds=@{x=@(43,45);z=@(-107,-105);y=@(64,78)};bodyCells=@($passed | Where-Object kind -eq bodyColumn);oakLogs=@($passed | Where-Object kind -eq species);testedQueries=$queries.Count}) -Force
$s=curl.exe -s --max-time 8 http://127.0.0.1:3000/api/status | ConvertFrom-Json
$r | Add-Member -NotePropertyName finalStatus -NotePropertyValue $s -Force
$r | ConvertTo-Json -Depth 75 | Set-Content $path -Encoding utf8
[pscustomobject]@{upperLogs=$r.geometry.upperLogs;oakLogCount=$r.geometry.oakLogs.Count;columnAtBot=@($r.geometry.bodyCells | Where-Object {$_.x -eq 44 -and $_.z -eq -106});position=$s.position;mission=$s.mission.etat;controls=$s.controls;onGround=$s.onGround;health=$s.health;dirt=$r.dirtInventoryRcon} | ConvertTo-Json -Depth 7
