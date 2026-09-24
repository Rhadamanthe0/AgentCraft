$ErrorActionPreference = 'Stop'
$runnerRoot = Join-Path $env:LOCALAPPDATA 'MinebotLab/actions-runner'
$listener = Join-Path $runnerRoot 'bin/Runner.Listener.exe'
if (-not (Test-Path -LiteralPath (Join-Path $runnerRoot '.runner'))) {
    throw 'Runner non enregistre. Voir docs/remote-minecraft-tests.md.'
}
docker info --format '{{.ServerVersion}}'
if ($LASTEXITCODE -ne 0) { throw 'Demarrer Docker Desktop avant le runner.' }
$active = Get-CimInstance Win32_Process -Filter "Name='Runner.Listener.exe'" |
    Where-Object { $_.ExecutablePath -eq $listener }
if ($active) { Write-Output 'Runner deja demarre.'; exit 0 }
Start-Process -FilePath $env:ComSpec -ArgumentList @('/c', ('"' + (Join-Path $runnerRoot 'run.cmd') + '"')) `
    -WorkingDirectory $runnerRoot -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $runnerRoot 'runner.stdout.log') `
    -RedirectStandardError (Join-Path $runnerRoot 'runner.stderr.log')
Write-Output 'Runner lance en arriere-plan dans la session Windows.'
