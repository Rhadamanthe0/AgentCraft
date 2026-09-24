$ErrorActionPreference = "Stop"

docker compose config -q
if ($LASTEXITCODE -ne 0) {
    throw "compose.yaml is invalid."
}

docker compose ps
if ($LASTEXITCODE -ne 0) {
    throw "Unable to query Docker Compose."
}

$status = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/status" -TimeoutSec 5
if (-not $status.spawned) {
    throw "The bot API responds, but the Minecraft bot is not spawned."
}
if ($status.minecraftVersion -ne "26.1") {
    throw "Unexpected Minecraft protocol version: $($status.minecraftVersion)"
}

Write-Host "OK - server and bot are ready"
Write-Host ("Minecraft version: " + $status.minecraftVersion)
Write-Host ("Bot: " + $status.username)
Write-Host ("Position: {0}, {1}, {2}" -f $status.position.x, $status.position.y, $status.position.z)
