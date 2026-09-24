$ErrorActionPreference='Stop'
$trace=Get-Content (Join-Path $PSScriptRoot 'tree-materials-current-trace.json') -Raw|ConvertFrom-Json
$origin=@{x=44.3625;y=73;z=-105.3072}
$cells=[Collections.Generic.List[object]]::new()
foreach($x in 40..46){foreach($z in -109..-104){foreach($y in 72..76){$cells.Add([pscustomobject]@{x=$x;y=$y;z=$z})}}}
$kinds=@('air','oak_log','oak_leaves','oak_planks','dirt','grass_block')
$commands=@(foreach($c in $cells){foreach($kind in $kinds){"execute if block $($c.x) $($c.y) $($c.z) minecraft:$kind"}})+@('exit')
$raw=($commands|docker compose exec -T minecraft rcon-cli)-join "`n"
$answers=@([regex]::Matches($raw,'> (Test passed|Test failed)')|ForEach-Object {$_.Groups[1].Value})
if($answers.Count -ne $cells.Count*$kinds.Count){throw 'Incomplete RCON geometry'}
$blocks=@(for($i=0;$i -lt $cells.Count;$i++){$c=$cells[$i];$kind='unknown';for($j=0;$j -lt $kinds.Count;$j++){if($answers[$i*$kinds.Count+$j] -eq 'Test passed'){$kind=$kinds[$j]}};[pscustomobject]@{x=$c.x;y=$c.y;z=$c.z;name=$kind}})
$r=[ordered]@{at=[DateTime]::UtcNow.ToString('o');feet=$origin;eye=@{x=$origin.x;y=74.62;z=$origin.z};lastTrace=$trace.traces[-1];blocks=$blocks;interpretation='RCON cells only; distances/ray samples reconstructed using trace coordinates, not captured planner payload'}
$r|ConvertTo-Json -Depth 30|Set-Content (Join-Path $PSScriptRoot 'tree-materials-ray-diagnostic.json') -Encoding utf8
$blocks|Where-Object {$_.x -eq 44 -and $_.z -in @(-106,-105)}|Format-Table
