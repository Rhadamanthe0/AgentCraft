$ErrorActionPreference='Stop'
$path=Join-Path $PSScriptRoot 'tree-complete-diagnostic.json'
$r=Get-Content $path -Raw | ConvertFrom-Json
$cells=[Collections.Generic.List[object]]::new()
foreach($x in 38..50){foreach($z in -112..-100){foreach($y in 65..78){$cells.Add([pscustomobject]@{x=$x;y=$y;z=$z})}}}
$commands=@($cells | ForEach-Object { "execute if block $($_.x) $($_.y) $($_.z) #minecraft:logs" })+@('exit')
$raw=($commands | docker compose exec -T minecraft rcon-cli) -join "`n"
$answers=@([regex]::Matches($raw,'> (Test passed|Test failed)') | ForEach-Object {$_.Groups[1].Value})
if($answers.Count -ne $cells.Count){throw "Unexpected scan response count $($answers.Count) != $($cells.Count)"}
$logs=@(for($i=0;$i -lt $cells.Count;$i++){if($answers[$i] -eq 'Test passed'){$cells[$i]}})
$scan=[ordered]@{at=[DateTime]::UtcNow.ToString('o'); bounds=@{x=@(38,50);y=@(65,78);z=@(-112,-100)};testedCells=$cells.Count;tag='minecraft:logs';logs=$logs;limitation='Bounded present-day scan, cannot attribute detached branches to a single natural tree with certainty without original topology.'}
$r | Add-Member -NotePropertyName branchScan -NotePropertyValue $scan -Force
$r | Add-Member -NotePropertyName dirtInventoryRcon -NotePropertyValue ((& docker compose exec -T minecraft rcon-cli 'data get entity TestBot Inventory[{id:"minecraft:dirt"}]') -join ' ') -Force
$r | ConvertTo-Json -Depth 75 | Set-Content $path -Encoding utf8
[pscustomobject]$scan | ConvertTo-Json -Depth 8
