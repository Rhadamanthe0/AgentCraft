#!/usr/bin/env bash
# Prepare the runtime envelope on a disposable GitHub-hosted Linux VM.
# Never run this on MINIPC-CLEM: its Podman envelope is managed externally.
set -euo pipefail

if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_ENVIRONMENT:-}" != github-hosted ]]; then
  echo 'Cette preparation est reservee aux VM GitHub-hosted.' >&2
  exit 1
fi
: "${GITHUB_ENV:?Le fichier GITHUB_ENV est requis pour transmettre la configuration.}"

if [[ "$(docker info --format '{{.CgroupVersion}} {{.CgroupDriver}}')" != '2 systemd' ]]; then
  echo 'Le banc GitHub exige Docker avec cgroup v2 et le pilote systemd.' >&2
  exit 1
fi
docker compose version

# A slice with no dash has one unambiguous path under /sys/fs/cgroup.
# No daemon setting is changed; only this job's Compose services join it.
sudo tee /run/systemd/system/agentcraft.slice > /dev/null <<'SLICE'
[Unit]
Description=AgentCraft disposable benchmark

[Slice]
CPUAccounting=yes
MemoryAccounting=yes
CPUQuota=400%
MemoryMax=10G
SLICE
sudo systemctl daemon-reload
sudo systemctl start agentcraft.slice

cgroup=$(sudo systemctl show agentcraft.slice --property=ControlGroup --value)
if [[ "$cgroup" != /agentcraft.slice ]]; then
  echo "Chemin cgroup inattendu pour le banc : $cgroup" >&2
  exit 1
fi
cpu_limits=$(sudo cat "/sys/fs/cgroup$cgroup/cpu.max")
read -r quota period extra <<< "$cpu_limits"
if [[ ! "$quota" =~ ^[0-9]+$ || ! "$period" =~ ^[0-9]+$ || -n "$extra" ]] ||
   (( period <= 0 || quota != 4 * period )); then
  echo "Limite CPU du banc inattendue : $cpu_limits (400 % requis)." >&2
  exit 1
fi
memory_limit=$(sudo cat "/sys/fs/cgroup$cgroup/memory.max")
if [[ "$memory_limit" != 10737418240 ]]; then
  echo "Limite memoire du banc inattendue : $memory_limit (10 Gio requis)." >&2
  exit 1
fi

# Publish only after the real cgroup and both limits have been checked.
# ci/run.py and ci/cleanup.py use the same Compose overlay and endpoints.
{
  echo 'CI_GITHUB_HOSTED=1'
  echo "CI_METRICS_CGROUP=/sys/fs/cgroup$cgroup"
  echo 'CI_ENDPOINT_MODE=direct'
} >> "$GITHUB_ENV"
echo 'Enveloppe du banc : 400 % CPU, 10 Gio ; ports sur 127.0.0.1.'
