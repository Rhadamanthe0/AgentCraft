param([switch]$Interpret)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
if (-not $Interpret) { Write-Output 'Prepared only; wait for orchestrator source-frozen GO.'; exit 0 }
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$name = 'tree-context-llm-probe'
$volume = 'tree-context-llm-data'
if (@(& docker ps -a --format '{{.Names}}') -contains $name) { throw 'Dedicated container already exists' }
if (@(& docker volume ls --format '{{.Name}}') -contains $volume) { throw 'Dedicated volume already exists' }
$js = @'
'use strict'
const fs = require('node:fs')
const planner = require('/candidate/planner.js')
const proof = JSON.parse(fs.readFileSync('/proof/tmp/tree-stuck-diagnostic.json', 'utf8').replace(/^\uFEFF/, ''))
const current = proof.before.objectifs.current
const context = {
  demandeur: current.auteur,
  mission: {
    id: current.id, revision: 0, objectif: current.texte, demandeur: current.auteur,
    etat: 'running', type: 'construction', etapes: 8, parcours: null,
    historique: [
      { action: 'casser', resultat: '1 bloc(s) casse(s) en 3.7 s (total 1) sur 4 s demandee', echec: false },
      { action: 'avancer', resultat: 'bloque apres 2.0 bloc(s) sur 4 demande(s) : obstacle trop haut, contourne (appuyer left ou right + forward + jump) puis re-pivote vers la cible.', echec: true },
      { action: 'appuyer', resultat: 'left+forward+jump tenu 1.2 s, deplacement de 0.00 bloc (immobile : probablement encastre)', echec: true },
      { action: 'sortir', resultat: 'degage', echec: false },
      { action: 'regarder_autour', resultat: 'tour d horizon -> nord : rien | ouest : rien | sud : rien | est : rien', echec: false }
    ], raison: null, autorisations: { degagement: { limite: 0, consomme: 0 } }
  }, precedent: null
}
const cases = [
  { message: "En fait là t'es trop bas, apprend de ça et il faut que tu place un bloc pour monter en hauteur", expected: 'context' },
  { message: "Surélève la maison d'un bloc", expected: 'amend' }
]
async function main () {
  console.log('TREE_CONTEXT_META ' + JSON.stringify({ model: planner.MODEL,
    maxTokens: planner.EFFECTIVE_MAX_TOKENS, timeoutMs: Number(process.env.PLANNER_TIMEOUT_MS),
    limitation: 'Reconstructed pre-amend context from original durable objective and actual pre-amend logs; not an original snapshot. Real remote calls, no chat routing or world effects.', context }))
  for (const item of cases) {
    const at = Date.now()
    try {
      const response = await planner.interpretMessage(item.message, context, { signal: AbortSignal.timeout(60000) })
      console.log('TREE_CONTEXT_CASE ' + JSON.stringify({ ...item, response, elapsedMs: Date.now() - at,
        relationMatches: response.relation === item.expected }))
    } catch (err) {
      console.log('TREE_CONTEXT_CASE ' + JSON.stringify({ ...item, error: err.message, elapsedMs: Date.now() - at, relationMatches: false }))
    }
  }
}
main().catch(err => { console.error(err.message); process.exitCode = 1 })
'@
$output = @()
$exitStatus = 1
try {
  & docker volume create $volume | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Dedicated volume creation failed' }
  $runArgs = @('compose','run','--rm','--no-deps','-T','--name',$name,
    '--volume', "${repo}/bot:/candidate:ro", '--volume', "${repo}:/proof:ro", '--volume', "${volume}:/data",
    '-e','NODE_PATH=/app/node_modules','--entrypoint','node','bot','-')
  $savedPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $output = @($js | & docker @runArgs 2>&1 | ForEach-Object { "$_" }); $exitStatus = $LASTEXITCODE }
  finally { $ErrorActionPreference = $savedPreference }
} finally {
  $containerNames = @(& docker ps -a --format '{{.Names}}')
  if ($containerNames -contains $name) { & docker rm -f $name | Out-Null }
  & docker volume rm $volume | Out-Null
  $volumeRemoved = ($LASTEXITCODE -eq 0)
  $proof = Get-Content (Join-Path $PSScriptRoot 'tree-stuck-diagnostic.json') -Raw | ConvertFrom-Json
  $meta = @($output | Where-Object { $_.StartsWith('TREE_CONTEXT_META ') } | ForEach-Object { $_.Substring(18) | ConvertFrom-Json })
  $casesOut = @($output | Where-Object { $_.StartsWith('TREE_CONTEXT_CASE ') } | ForEach-Object { $_.Substring(18) | ConvertFrom-Json })
  $evidence = [ordered]@{ at = [DateTime]::UtcNow.ToString('o'); exitStatus=$exitStatus; meta=$meta; cases=$casesOut; logs=$output; volumeRemoved=$volumeRemoved }
  $proof | Add-Member -NotePropertyName remoteInterpretation -NotePropertyValue $evidence -Force
  $proof | ConvertTo-Json -Depth 65 | Set-Content (Join-Path $PSScriptRoot 'tree-stuck-diagnostic.json') -Encoding utf8
}
$output | Write-Output
if ($exitStatus -ne 0 -or $casesOut.Count -ne 2 -or @($casesOut | Where-Object { -not $_.relationMatches }).Count -gt 0) { exit 1 }
