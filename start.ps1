$ErrorActionPreference = "Stop"

Write-Host "Checking Docker Desktop..."
docker info *> $null
if ($LASTEXITCODE -ne 0) {
    throw "Docker Desktop is not running or the Docker engine is unavailable."
}

docker compose config -q
if ($LASTEXITCODE -ne 0) {
    throw "compose.yaml is invalid."
}

Write-Host "Starting Minecraft 26.1 + TestBot..."
docker compose up --build --wait --wait-timeout 300
if ($LASTEXITCODE -ne 0) {
    Write-Host "Startup failed. Recent logs:"
    docker compose logs --tail=200
    throw "Docker Compose startup failed."
}

docker compose ps

Write-Host ""
Write-Host "Minecraft:      localhost:25565"
Write-Host "Bot controller: http://localhost:3000"
