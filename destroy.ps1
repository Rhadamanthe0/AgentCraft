$ErrorActionPreference = "Stop"

Write-Host "Removing containers, network and Minecraft test volume..."
docker compose down -v --remove-orphans
Write-Host "Test environment removed."
