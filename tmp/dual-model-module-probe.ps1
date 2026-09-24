param([switch]$Run)
$ErrorActionPreference='Stop'
if(-not $Run){Write-Output 'Prepared only: requires deployed dual image and orchestrator GO for four bounded module calls.';return}
$path=Join-Path $PSScriptRoot 'dual-model-module-probe.json'
if((Test-Path $path) -or (Test-Path (Join-Path $PSScriptRoot 'dual-model-module-probe-partial.txt'))){throw 'Existing proof: no duplicate remote campaign'}
$frozen=(Get-Content (Join-Path $PSScriptRoot 'tree-materials-blocked.json') -Raw|ConvertFrom-Json).after
$source=(Get-Content (Join-Path $PSScriptRoot 'dual-model-module-probe.js') -Raw).Replace('__FROZEN_STATUS__',($frozen|ConvertTo-Json -Depth 70 -Compress))
$lines=[Collections.Generic.List[string]]::new()
$source|docker exec -i minecraft-bot-test-bot-1 node|ForEach-Object {
  $lines.Add($_)
  if($_ -like 'PROBE_CASE *'){$case=$_.Substring(11)|ConvertFrom-Json;$case|Select-Object name,actualCalls,transportCorrect,validatedModuleResult,latencyMs|ConvertTo-Json -Compress}
}
$final=@($lines|Where-Object {$_ -like 'PROBE_FINAL *'})
if($final.Count -ne 1){$lines|Set-Content (Join-Path $PSScriptRoot 'dual-model-module-probe-partial.txt') -Encoding utf8;throw 'No complete report; partial sanitized results retained'}
$proof=$final[0].Substring(12)|ConvertFrom-Json
$proof|ConvertTo-Json -Depth 75|Set-Content $path -Encoding utf8
$proof.cases|Select-Object name,expectedModel,actualCalls,transportCorrect,validatedModuleResult,latencyMs|ConvertTo-Json
