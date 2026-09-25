"""Disposable Minecraft bench. Python 3.10+ and Docker Compose v2 required."""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import socket
import struct
import subprocess
import sys
import threading
import time
from http.client import RemoteDisconnected
import urllib.error
import urllib.request
import uuid

from cleanup import compose_files, paper_image
import capacity
from pool import LauncherControl, Pool
from trees import API_BASE_PORT, BOTS_SERVICE, POOL_MAX, POOL_SIZE, PROBES_SERVICE, arena_origins, levels, run_levels

ROOT = Path(__file__).resolve().parents[1]
# Acces aux ports publies : `direct` (TCP/HTTP sur 127.0.0.1, poste Windows +
# Docker Desktop) ou `exec` (docker compose exec). Sur un runner qui tourne
# lui-meme en conteneur (MINIPC-CLEM, Podman par socket), 127.0.0.1 est le
# conteneur du runner, pas l hote : les ports publies y sont injoignables.
# `ip` (MINIPC-CLEM) : IP du conteneur sur le reseau du projet (lue par
# `docker inspect`, change a chaque execution) et port interne ; le runner
# joint ce reseau directement (verifie par l agent de la machine), sans les
# ~1 600 `compose exec` du mode `exec` (niveaux 635 s au lieu de ~190 s).
ENDPOINT_MODE = os.environ.get('CI_ENDPOINT_MODE', 'direct')
if ENDPOINT_MODE not in ('direct', 'ip', 'exec'):
    raise SystemExit('CI_ENDPOINT_MODE doit valoir direct, ip ou exec')


# Classement d un echec (report.tests[].failureKind), pour ne jamais corriger le
# bot a cause d une panne du banc :
#   infrastructure : moteur/conteneur/Minecraft/banc (service arrete, commande
#                    compose en echec, RCON) ; invalide le banc s il est global.
#   api            : fournisseur du modele (HTTP 4xx/5xx, quota, delai du planificateur).
#   garde-fou      : plafond de duree ou d etapes du niveau atteint.
#   bot            : le reste (mauvaise action, mission non lancee, verification ratee) ;
#                    le modele et le code du bot se departagent en lisant la timeline.
INFRA_MARKERS = ('command failed', 'is not running', 'published port', 'rcon', 'connection refused',
                 'connection reset', 'no such container', 'cannot connect to the docker daemon')
API_MARKERS = ('http 4', 'http 5', 'gousagelimit', 'planificateur indisponible', 'upstream request failed',
               'pas de reponse en')


def failure_kind(test):
    # answerError : l ordre du joueur rejete par le bot (lecture d objectif sans
    # reponse du modele...), la mission n a alors jamais commence.
    text = ' '.join(str(test.get(k) or '') for k in ('error', 'endReason', 'answerError')).lower()
    if any(m in text for m in INFRA_MARKERS):
        return 'infrastructure'
    if any(m in text for m in API_MARKERS):
        return 'api'
    if 'plafond' in text:
        return 'garde-fou'
    return 'bot'


def classify_failures(report):
    failed = [t for t in report['tests'] if not t.get('success')]
    for t in failed:
        t['failureKind'] = failure_kind(t)
    infra = [t['test'] for t in failed if t['failureKind'] == 'infrastructure']
    reasons = []
    if report.get('servicesDown'):
        reasons.append('services arretes en fin de banc : ' + ', '.join(report['servicesDown']))
    if len(infra) >= 3:
        reasons.append(f'{len(infra)} niveaux en echec d infrastructure : ' + ', '.join(infra[:8]))
    if reasons:
        report['benchInvalid'] = ' ; '.join(reasons)


def planner_key_present():
    # Le banc tourne avec la seule cle secondaire (secret OPENCODE_SECONDARY_API_KEY) ;
    # PLANNER_API_KEY reste admise pour un poste local.
    return bool(os.environ.get('OPENCODE_SECONDARY_API_KEY') or os.environ.get('PLANNER_API_KEY'))
# Delai des appels HTTP aux bots : /api/instruction attend la lecture de
# l objectif (PLANNER_TIMEOUT_MS_BRIEF, 60 s, rejouee une fois si tronquee).
HTTP_TIMEOUT_S = 150
UNIT = ['navigation.test.js', 'navigation-drop.test.js', 'navigation-entrypoints.test.js',
        'motion-trace.test.js', 'mission-navigation.test.js', 'movement-task.test.js',
        'model-chain.test.js', 'fabrication-utile.test.js', 'conversation.test.js']



# Models served to the second OpenCode workspace key (secondary,
# PLANNER_KEY_FIRST in ci/models.env), to pick PLANNER_MODEL_<USAGE> from facts.
# Ids only, never the key; skipped when the secret is absent.
PROVIDER_MODEL_LISTS = {
    'go2': ('OPENCODE_SECONDARY_API_KEY', 'https://opencode.ai/zen/go/v1/models'),
}


def latency_summary(stats):
    """p50/p95/max (ms) and outcomes per planner usage, over every bot of the run."""
    merged = {}
    for bot in stats.values():
        for task, entry in (bot.get('latences') or {}).items():
            m = merged.setdefault(task, {'ms': [], 'ok': 0, 'delai': 0, 'erreur': 0, 'annule': 0})
            m['ms'] += entry.get('ms') or []
            for k in ('ok', 'delai', 'erreur', 'annule'):
                m[k] += entry.get(k) or 0
    out = {}
    for task, m in sorted(merged.items()):
        ms = sorted(m.pop('ms'))
        pick = lambda q: ms[min(len(ms) - 1, int(q * len(ms)))] if ms else None
        out[task] = {'n': len(ms), 'p50': pick(.5), 'p95': pick(.95), 'max': ms[-1] if ms else None, **m}
    return out


def provider_models():
    found = {}
    for name, (var, url) in PROVIDER_MODEL_LISTS.items():
        key = os.environ.get(var, '').strip()
        if not key:
            continue
        request = urllib.request.Request(url, headers={'Authorization': f'Bearer {key}',
                                                          'User-Agent': 'minecraft-bot/1.0',
                                                          'x-opencode-session': 'minebot-ci-models'})
        try:
            with urllib.request.urlopen(request, timeout=8) as response:
                data = json.load(response).get('data', [])
            ids = sorted(str(model.get('id')) for model in data)
            found[name] = ids
        except (OSError, ValueError) as error:
            found[name] = {'error': str(error)[:200]}
    return found


def compare_variants(tests):
    """One line per A/B pair: success, time, model calls, damage, end."""
    by_name = {t['test']: t for t in tests}

    def brief(t):
        parts = ['PASS' if t.get('success') else 'FAIL']
        if t.get('elapsedS') is not None:
            parts.append(f"{t['elapsedS']} s")
        if t.get('plannerCalls') is not None:
            parts.append(f"{t['plannerCalls']} appels")
        if t.get('damageTaken'):
            parts.append(f"{t['damageTaken']} degats")
        for key in ('itemsHeld', 'blocksPlaced', 'bonusItems'):
            if t.get(key) is not None:
                parts.append(f"{key}={t[key]}")
        return ', '.join(parts)

    out = []
    for t in tests:
        base = by_name.get(t.get('variantOf') or '')
        if t.get('informative') and base:
            out.append({'level': base['test'], 'variant': t['test'].split('~', 1)[-1],
                        'features': t.get('features'), 'base': brief(base), 'other': brief(t)})
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--suite', choices=['unit', 'minecraft', 'trees', 'all'], default='all')
    args = parser.parse_args()
    # Un nom par job : deux executions en parallele (branches, depots du
    # runner mutualise) ne partagent ni conteneur, ni reseau, ni volume.
    run_id = os.environ.get('GITHUB_RUN_ID', '')
    project = f'mc-ci-{run_id}-{uuid.uuid4().hex[:8]}' if run_id.isdigit() else 'mc-ci-' + uuid.uuid4().hex[:12]
    output = ROOT / 'test-results' / project
    output.mkdir(parents=True)
    marker = output / 'active.json'
    marker.write_text(json.dumps({'project': project}), encoding='utf-8')
    # One test image per run, shared by every service and removed at the end.
    image = f'minebot-ci:{project}'
    # Paper image: stable tag per content of ci/paper/ (kept between runs).
    paper = paper_image()
    env = dict(os.environ, COMPOSE_DISABLE_ENV_FILE='1', MSYS_NO_PATHCONV='1', CI_TAG=project, PAPER_IMAGE=paper)
    # Ignore inherited Compose settings; the CLI pins file, directory and project.
    for key in list(env):
        if key.startswith('COMPOSE_') and key != 'COMPOSE_DISABLE_ENV_FILE':
            del env[key]
    base = ['docker', 'compose', '--env-file', str(ROOT / 'ci/empty.env'),
            '--project-directory', str(ROOT / 'ci'), *compose_files(), '-p', project]
    report = {'schemaVersion': 1, 'project': project, 'image': image, 'suite': args.suite,
              'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'sha': None, 'dirty': None, 'success': False, 'tests': [], 'errors': [],
              'phases': {}}
    run_started = time.monotonic()
    # CI envelope and host metrics, 10 Hz, from files only (ci/capacity.py):
    # measured in every mode, they gate the pool only in adaptive mode.
    pool_mode = os.environ.get('CI_POOL_MODE', 'fixed')
    if pool_mode not in ('fixed', 'adaptive'):
        raise SystemExit('CI_POOL_MODE doit valoir fixed ou adaptive')
    capacity_config = capacity.Config.from_env(POOL_MAX)
    envelope, host, sources = capacity.open_sources(capacity_config)
    collector = capacity.Collector(envelope, host, capacity_config)
    collector.start()
    report['capacity'] = {'sources': sources}

    def phase(name, started):
        # Wall time of one bench phase, in seconds (report.json and summary).
        report['phases'][name] = round(time.monotonic() - started, 1)
    try:
        report['sha'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT,
                                                stderr=subprocess.DEVNULL, text=True).strip()
        report['dirty'] = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip())
    except (OSError, subprocess.CalledProcessError):
        pass  # An exported source directory is supported, but never claims a tested SHA.
    report['providerModels'] = provider_models()

    log_lock = threading.Lock()

    def command(argv, timeout=60, check=True):
        started = time.monotonic()
        result = subprocess.run(argv, cwd=ROOT, env=env, capture_output=True,
                                text=True, encoding='utf-8', errors='replace', timeout=timeout)
        # Start offset (s since the run began) and duration: where the time goes.
        stamp = f'[+{started - run_started:.1f}s, {time.monotonic() - started:.1f}s] '
        with log_lock, (output / 'commands.log').open('a', encoding='utf-8') as log:
            log.write('\n' + stamp + '$ ' + ' '.join(argv) + '\n' + result.stdout + result.stderr)
        if check and result.returncode:
            raise RuntimeError(f"Command failed ({result.returncode}): {' '.join(argv[:8])}; see commands.log")
        return result

    def compose(*argv, **kwargs):
        return command(base + list(argv), **kwargs)

    # Direct RCON over the loopback port published by compose: one TCP
    # connection shared by all level threads (lock), instead of one
    # `docker compose exec` (~1 s on Windows) per fixture command.
    rcon_state = {'sock': None, 'id': 0}
    rcon_lock = threading.Lock()
    endpoints = {}

    def load_endpoints():
        if ENDPOINT_MODE == 'ip':
            return  # IP lues a la demande (service_ip).
        # Every published port of the project in ONE call (a `compose port`
        # costs ~1 s on Windows, and there are 18 of them).
        out = compose('ps', '--format', 'json', timeout=30, check=False).stdout.strip()
        try:
            rows = json.loads(out) if out.startswith('[') else [json.loads(line) for line in out.splitlines() if line.strip()]
        except ValueError:
            return  # endpoint() falls back to `compose port`.
        for row in rows:
            for pub in row.get('Publishers') or []:
                if pub.get('PublishedPort') and pub.get('URL') in ('127.0.0.1', '0.0.0.0'):
                    endpoints.setdefault((row.get('Service'), int(pub['TargetPort'])),
                                         ('127.0.0.1', int(pub['PublishedPort'])))

    service_ips = {}

    def service_ip(service):
        if service not in service_ips:
            ids = compose('ps', '-q', service, timeout=30).stdout.split()
            if not ids:
                raise ConnectionError(f'{service} : aucun conteneur')
            out = command(['docker', 'inspect', '--format',
                           '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', ids[0]], timeout=30).stdout.split()
            if not out:
                raise ConnectionError(f'{service} : aucune IP')
            service_ips[service] = out[0]
        return service_ips[service]

    def endpoint(service, port):
        if ENDPOINT_MODE == 'ip':
            return service_ip(service), port
        key = (service, port)
        if key not in endpoints:
            out = compose('port', service, str(port), timeout=30).stdout.strip().splitlines()[-1]
            host, _, mapped = out.rpartition(':')
            endpoints[key] = (host.strip('[]') or '127.0.0.1', int(mapped))
        return endpoints[key]

    def rcon_packet(sock, kind, body):
        rcon_state['id'] += 1
        payload = struct.pack('<ii', rcon_state['id'], kind) + body.encode('utf-8') + b'\x00\x00'
        sock.sendall(struct.pack('<i', len(payload)) + payload)

        def read(n):
            data = b''
            while len(data) < n:
                chunk = sock.recv(n - len(data))
                if not chunk:
                    raise ConnectionError('RCON closed')
                data += chunk
            return data
        size = struct.unpack('<i', read(4))[0]
        packet = read(size)
        request_id = struct.unpack('<i', packet[:4])[0]
        if request_id == -1:
            raise RuntimeError('RCON authentication refused')
        return packet[8:-2].decode('utf-8', 'replace')

    def rcon_direct(text):
        with rcon_lock:
            for attempt in range(2):
                try:
                    if rcon_state['sock'] is None:
                        sock = socket.create_connection(endpoint('minecraft', 25575), timeout=30)
                        rcon_packet(sock, 3, 'disposable-ci-only')
                        rcon_state['sock'] = sock
                    return rcon_packet(rcon_state['sock'], 2, text)
                except (OSError, ConnectionError):
                    try:
                        rcon_state['sock'] and rcon_state['sock'].close()
                    except OSError:
                        pass
                    rcon_state['sock'] = None
                    if attempt:
                        raise

    def rcon(text):
        value = None
        if ENDPOINT_MODE != 'exec' and not rcon_state.get('exec'):
            try:
                value = rcon_direct(text).strip()
            except Exception as error:
                # Une seule tentative : sans cela chaque commande repayait le delai.
                rcon_state['exec'] = True
                print(f'RCON direct indisponible ({error}) : docker compose exec pour la suite', flush=True)
        if value is None:
            value = compose('exec', '-T', 'minecraft', 'rcon-cli', text).stdout.strip()
        if any(word in value.lower() for word in ['incorrect argument', 'unknown command', 'not loaded']):
            raise RuntimeError('Fixture command rejected: ' + value)
        return value

    def services_down():
        out = compose('ps', '-a', '--format', 'json', timeout=30, check=False).stdout.strip()
        try:
            rows = json.loads(out) if out.startswith('[') else [json.loads(line) for line in out.splitlines() if line.strip()]
        except ValueError:
            return None
        return sorted({row.get('Service') for row in rows if str(row.get('State', '')).lower() != 'running'} - {None})

    unreachable = set()  # (service, port) whose published port refused or dropped the connection.

    def http(service, port, route, body=None, method=None):
        if ENDPOINT_MODE == 'exec':
            return http_exec(service, port, route, body, method)
        try:
            if (service, port) in unreachable:
                raise ConnectionError('published port unusable')
            host, mapped = endpoint(service, port)
        except Exception:
            return http_exec(service, port, route, body, method)
        data = None if body is None else json.dumps(body).encode('utf-8')
        request = urllib.request.Request(f'http://{host}:{mapped}{route}', data=data,
                                         method=method or ('GET' if body is None else 'POST'),
                                         headers={'content-type': 'application/json'})
        try:
            # 150 s : /api/instruction attend la lecture de l objectif (muse,
            # 60 s, rejouee une fois si tronquee) ; 45 s coupait craft/sticks.
            with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_S) as response:
                return json.loads(response.read().decode('utf-8'))
        except urllib.error.HTTPError as error:
            raise RuntimeError(f'{service}:{port}{route}: HTTP {error.code} {error.read().decode("utf-8", "replace")[:300]}')
        except (ConnectionError, RemoteDisconnected):
            # The request never reached a listener (e.g. a process bound to the
            # container's 127.0.0.1 only): switch this endpoint to docker exec.
            unreachable.add((service, port))
            return http_exec(service, port, route, body, method)
        except urllib.error.URLError as error:
            if isinstance(error.reason, ConnectionError):
                unreachable.add((service, port))
                return http_exec(service, port, route, body, method)
            raise

    def http_exec(service, port, route, body=None, method=None):
        # Runs inside the target container, so it reaches the process that
        # listens on `port` there (each pool bot has its own port in `bots`).
        script = """const [port, route, method, body] = process.argv.slice(1);
fetch('http://127.0.0.1:'+port+route, body ? {method,headers:{'content-type':'application/json'},body} : {method})
.then(async r=>{const s=await r.text();if(!r.ok)throw Error(s);console.log(s)})
.catch(e=>{console.error(e.message);process.exitCode=1})"""
        return json.loads(compose('exec', '-T', service, 'node', '-e', script, str(port),
                                  route, method or ('GET' if body is None else 'POST'),
                                  *([] if body is None else [json.dumps(body)]), timeout=HTTP_TIMEOUT_S).stdout)

    def api(route, body=None):
        return http('harness', 3101, route, body)

    def bot_api(port, route, body=None, method=None):
        # Every pool bot is a process of the shared `bots` container; its API
        # port (3000+N, see trees.bot_services) is its identity.
        return http(BOTS_SERVICE, port, route, body, method)

    def size_mb(text):
        match = re.match(r'([\d.]+)\s*([kKMG]i?B|B)', text.strip())
        if not match:
            return None
        scale = {'B': 1 / 2**20, 'kB': 1 / 1024, 'KiB': 1 / 1024, 'MB': 1, 'MiB': 1, 'GB': 1024, 'GiB': 1024}
        return float(match.group(1)) * scale.get(match.group(2), 1)

    def resource_snapshot():
        # One `docker stats` sample of this project's containers only.
        ids = compose('ps', '-q', timeout=30).stdout.split()
        out = command(['docker', 'stats', '--no-stream', '--format', '{{json .}}', *ids], timeout=60).stdout
        rows = []
        for line in out.splitlines():
            if line.strip():
                row = json.loads(line)
                rows.append({'container': row.get('Name'),
                             'cpuPercent': float((row.get('CPUPerc') or '0').rstrip('%') or 0),
                             'memUsage': row.get('MemUsage'),
                             'memMB': size_mb((row.get('MemUsage') or '').split('/')[0]),
                             'memLimitMB': size_mb(((row.get('MemUsage') or '').split('/') + [''])[1]),
                             'pids': row.get('PIDs')})
        return {'takenAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'containers': rows,
                'totalCpuPercent': round(sum(r['cpuPercent'] for r in rows), 1),
                'totalMemMB': round(sum(r['memMB'] or 0 for r in rows))}

    def resource_peaks(samples):
        # Peak (max over samples) and mean per container, plus peak totals.
        peaks = {}
        for sample in samples:
            for row in sample['containers']:
                name = (row['container'] or '').replace(project + '-', '')
                entry = peaks.setdefault(name, {'memPeakMB': 0, 'cpuPeakPercent': 0, 'cpu': []})
                entry['memPeakMB'] = round(max(entry['memPeakMB'], row['memMB'] or 0))
                entry['cpuPeakPercent'] = round(max(entry['cpuPeakPercent'], row['cpuPercent']), 1)
                entry['cpu'].append(row['cpuPercent'])
        for entry in peaks.values():
            cpu = entry.pop('cpu')
            entry['cpuMeanPercent'] = round(sum(cpu) / len(cpu), 1)
        return {'samples': len(samples), 'containers': peaks,
                'totalMemPeakMB': max((s['totalMemMB'] for s in samples), default=None),
                'totalCpuPeakPercent': max((s['totalCpuPercent'] for s in samples), default=None),
                'totalCpuMeanPercent': round(sum(s['totalCpuPercent'] for s in samples) / len(samples), 1) if samples else None}

    def gc_summary(text):
        # Paper's -Xlog:gc lines: "GC(12) Pause Young (...) 812M->143M(3072M) 9.1ms".
        found = [(int(a), int(b), int(c)) for a, b, c in
                 re.findall(r'minecraft-1\s*\|.*?GC\(\d+\) Pause.*?(\d+)M->(\d+)M\((\d+)M\)', text)]
        if not found:
            return None
        return {'collections': len(found), 'heapBeforeMaxMB': max(f[0] for f in found),
                'liveAfterMaxMB': max(f[1] for f in found), 'committedMaxMB': max(f[2] for f in found)}

    def fixture(start, blocks):
        rcon('fill 0 200 0 32 208 32 air')
        for block in blocks:
            rcon(block)
        rcon('tp TestProbe1 ' + ' '.join(map(str, start)))
        until = time.monotonic() + 15
        while time.monotonic() < until:
            current = api('/state')
            p = current.get('position', {})
            if current.get('onGround') and all(abs(p.get(k, -999) - v) < .15 for k, v in zip('xyz', start)):
                time.sleep(.5)  # Block packets and physical settling before navigation.
                return
            time.sleep(.25)
        raise RuntimeError('Harness did not settle at fixture start')

    print(f'Bench {project}; reports: {output}', flush=True)
    try:
        compose('config', '--quiet')
        print(f'Building test image {image} (shared by every service)...', flush=True)
        # Only `harness` has a build section; `bots` and `probes` reuse its image.
        started = time.monotonic()
        # The Paper image is built only when its content tag is missing.
        missing = command(['docker', 'image', 'inspect', '--format', '{{.Id}}', paper], timeout=60, check=False).returncode
        compose('build', 'harness', *(['minecraft'] if missing else []), timeout=900)
        phase('build', started)
        # Everything independent runs at once: offline unit tests start while
        # Paper boots, navigation scenarios run beside the mission levels.
        unit_results, nav_results = [], []

        def run_unit():
            unit_started = time.monotonic()
            result = compose('run', '--rm', '--no-deps', 'harness', 'node', '--test',
                             *['tmp/' + name for name in UNIT], timeout=180, check=False)
            (output / 'unit.log').write_text(result.stdout + result.stderr, encoding='utf-8')
            unit_results.append({'test': 'unit/navigation-regression', 'success': result.returncode == 0})
            phase('unit', unit_started)

        # Candidate planner models (ci/model-probe.js): latency and validity of
        # plans, chat and brief with the real prompts, next to the levels.
        probe_results = []

        def run_model_probe():
            started = time.monotonic()
            result = compose('run', '--rm', '--no-deps', BOTS_SERVICE, 'node', '/work/ci/model-probe.js',
                             timeout=300, check=False)
            try:
                probe_results.extend(json.loads(result.stdout.strip().splitlines()[-1]))
            except (ValueError, IndexError):
                probe_results.append({'error': (result.stderr or result.stdout)[-500:]})
            phase('modelProbe', started)

        probe_thread = None
        if args.suite in ('trees', 'all') and planner_key_present():
            probe_thread = threading.Thread(target=run_model_probe, daemon=True)
            probe_thread.start()

        unit_thread = None
        if args.suite in ('unit', 'all'):
            print('Running focused offline regression tests (in parallel)...', flush=True)
            unit_thread = threading.Thread(target=run_unit, daemon=True)
            unit_thread.start()
        if args.suite in ('minecraft', 'trees', 'all'):
            print('Starting isolated Paper server...', flush=True)
            started = time.monotonic()
            compose('up', '-d', '--wait', '--wait-timeout', '240', 'minecraft', timeout=270)
            phase('paper', started)
            started = time.monotonic()
            load_endpoints()
            rcon('forceload add 0 0 32 32')
            rcon('fill 0 199 0 32 199 32 stone')
            rcon('fill 0 200 0 32 208 32 air')
            rcon('setworldspawn 2 200 2')
            phase('forceload', started)
            started = time.monotonic()

            def forceload_arenas():
                # Tree arenas and their block-count scratch areas (~6 s of RCON,
                # each `forceload add` loads its chunks): only the levels need
                # them, so this runs while the players start. Joined before the levels.
                arena_started = time.monotonic()
                try:
                    for x0 in arena_origins():
                        rcon(f'forceload add {x0 - 1} -1 {x0 + 37} 37')  # Arena and its fence.
                        rcon(f'forceload add {x0} 200 {x0 + 36} 236')
                except Exception as error:
                    arena_errors.append(error)
                phase('forceloadArenas', arena_started)
            arena_errors = []
            arena_thread = threading.Thread(target=forceload_arenas, daemon=True)
            if args.suite in ('trees', 'all') and planner_key_present():
                arena_thread.start()
            bots_wanted = args.suite in ('trees', 'all') and bool(planner_key_present())
            # Two containers host all pool bots and all probe players.
            extra = [BOTS_SERVICE, PROBES_SERVICE] if bots_wanted else []
            compose('up', '-d', '--wait', '--wait-timeout', '240', 'harness', *extra, timeout=290)
            load_endpoints()
            ops = json.loads(compose('exec', '-T', 'minecraft', 'cat', '/data/ops.json').stdout)
            mode = rcon('data get entity TestProbe1 playerGameType')
            if ops or not re.search(r':\s*0\s*$', mode):
                raise RuntimeError('Expected empty ops.json and survival mode: ' + mode)
            report['survivalProof'] = {'ops': ops, 'playerGameType': mode}
            phase('players', started)

        def run_navigation():
            nav_started = time.monotonic()
            scenarios = [
                ('navigation/simple-obstacle', (2.5, 200, 2.5), (14.5, 200, 2.5),
                 ['fill 8 200 0 8 202 6 stone'], None),
                ('navigation/stairs', (2.5, 200, 18.5), (10.5, 203, 18.5),
                 ['fill 6 200 16 11 200 20 stone', 'fill 7 201 16 11 201 20 stone',
                  'fill 8 202 16 11 202 20 stone'], None),
                ('navigation/abort', (2.5, 200, 2.5), (30.5, 200, 2.5), [], 1200),
                ('navigation/unreachable', (2.5, 200, 5.5), (20.5, 200, 5.5),
                 ['fill 18 200 3 22 203 7 bedrock', 'fill 19 200 4 21 202 6 air'], None),
            ]
            for name, start, target, blocks, abort in scenarios:
                print(name, flush=True)
                try:
                    fixture(start, blocks)
                    value = api('/navigate', {'target': dict(zip('xyz', target)), 'abortAfterMs': abort})
                    trace = value.pop('trace')
                    (output / (name.split('/')[-1] + '-trace.json')).write_text(json.dumps(trace), encoding='utf-8')
                    code = value['result']['code']
                    if abort is not None:
                        passed = (code == 'cancelled' and not value['result']['reached']
                                  and value['abortLatencyMs'] is not None and value['abortLatencyMs'] <= 1500
                                  and value['result']['travelled'] > .25)
                    elif name.endswith('unreachable'):
                        passed = not value['result']['reached'] and code in ('no_path', 'timeout', 'stuck')
                    else:
                        passed = value['result']['reached'] and value['finalDistanceXZ'] <= 1 and value['finalDeltaY'] <= .75
                    passed = passed and not value['after']['controls']
                    nav_results.append(dict(test=name, success=bool(passed), **value))
                except Exception as error:
                    nav_results.append({'test': name, 'success': False, 'error': str(error)})
            phase('navigation', nav_started)

        nav_thread = None
        if args.suite in ('minecraft', 'all'):
            nav_thread = threading.Thread(target=run_navigation, daemon=True)
            nav_thread.start()
        if args.suite in ('trees', 'all'):
            if planner_key_present():
                ops = json.loads(compose('exec', '-T', 'minecraft', 'cat', '/data/ops.json').stdout)
                if ops:
                    raise RuntimeError('Expected empty ops.json: ' + json.dumps(ops))
                # Footprint all through the levels: one `docker stats` sample
                # every ~5 s (peaks, means), and the first sample taken >= 60 s
                # in as `resourceSnapshot` (the single sample of older reports).
                levels_done = threading.Event()
                samples = []
                levels_started = time.monotonic()

                def sample():
                    while not levels_done.is_set():
                        try:
                            snap = resource_snapshot()
                            snap['atS'] = round(time.monotonic() - levels_started, 1)
                            samples.append(snap)
                            # Container caps for admission (bots 12g, probes 1536m).
                            collector.set_containers({
                                (r['container'] or '').replace(project + '-', '').rsplit('-', 1)[0]:
                                    ((r['memMB'] or 0) * 2**20, (r['memLimitMB'] or 0) * 2**20 or None)
                                for r in snap['containers'] if r['container'] and 'minecraft' not in r['container']})
                            try:
                                ticks = {'atS': snap['atS'], 'tps': rcon('tps'), 'mspt': rcon('mspt')}
                                report.setdefault('serverTicks', []).append(
                                    {k: re.sub(r'\u00a7.', '', v) if isinstance(v, str) else v for k, v in ticks.items()})
                            except Exception as error:
                                report['serverTicksError'] = str(error)[:200]
                            if 'resourceSnapshot' not in report and snap['atS'] >= 60:
                                report['resourceSnapshot'] = snap
                        except Exception as error:
                            report.setdefault('resourceErrors', []).append(str(error))
                        levels_done.wait(5)
                sampler = threading.Thread(target=sample, daemon=True)
                sampler.start()
                # Pool: fixed size (CI_POOL_SIZE, benchmark between commits) or
                # adaptive (ci/capacity.py). Adaptive without trustworthy metrics
                # falls back to the fixed size, said in the report and the log.
                validation = []
                if pool_mode == 'adaptive':
                    snap = resource_snapshot()
                    validation = capacity.validate(collector, sources, container_mem_total=sum(
                        (r['memMB'] or 0) for r in snap['containers']) * 2**20)
                    report['capacity']['validation'] = validation or 'ok'
                    if validation:
                        print('Pool adaptatif impossible, repli fixe a %d : %s' % (POOL_SIZE, ' ; '.join(validation)), flush=True)
                controller = capacity.Controller(capacity_config, mode='fixe-repli' if validation else pool_mode,
                                                 fixed_size=POOL_SIZE)
                stats = {}

                def planner_stats(worker):
                    # Read before a bot is retired: its counters die with its process.
                    try:
                        p = bot_api(worker.bot, '/api/status').get('planner') or {}
                    except Exception:
                        return
                    stats[worker.username] = {k: p.get(k) for k in (
                        'appels', 'etapes_servies', 'echecs', 'moyenne_ms', 'jetons_total', 'jetons_en_cache_total',
                        'jetons_sortie_total', 'jetons_raisonnement_total', 'modele_servi', 'cle_servie', 'bascules_cle',
                        'latences')}

                def pool_factory(queue, run_one):
                    return Pool(queue, run_one, LauncherControl(http), controller, collector, rcon, capacity_config,
                                api_base_port=API_BASE_PORT, pool_max=POOL_MAX, before_retire=planner_stats,
                                log=lambda line: print(line, flush=True))
                def arenas_ready():
                    # Workers start while the arenas load; a level waits for them.
                    arena_thread.join()
                    if arena_errors:
                        raise arena_errors[0]
                level_results, report['pool'] = run_levels(output, rcon, bot_api, pool_factory, before_level=arenas_ready)
                phase('levels', levels_started)
                levels_done.set()
                sampler.join(90)
                ops = json.loads(compose('exec', '-T', 'minecraft', 'cat', '/data/ops.json').stdout)
                report['botSurvivalProof'] = {'ops': ops, 'playerGameType': report['pool'].pop('survival', {})}
                if ops:
                    report['errors'].append('ops.json non vide en fin de banc : ' + json.dumps(ops))
                report['resourcePeaks'] = resource_peaks(samples)
                report['resourceSamples'] = [{'atS': s['atS'], 'totalMemMB': s['totalMemMB'],
                                              'totalCpuPercent': s['totalCpuPercent'],
                                              'containers': {(r['container'] or '').replace(project + '-', ''): [round(r['memMB'] or 0), r['cpuPercent']]
                                                             for r in s['containers']}} for s in samples]
                # Planner cost per bot: latency, prompt cache hit rate, reasoning tokens.
                report['plannerStats'] = stats
                calls = sum(v.get('appels') or 0 for v in stats.values())
                prompt = sum(v.get('jetons_total') or 0 for v in stats.values())
                cached = sum(v.get('jetons_en_cache_total') or 0 for v in stats.values())
                report['plannerSummary'] = {
                    'appels': calls,
                    'moyenne_ms': round(sum((v.get('moyenne_ms') or 0) * (v.get('appels') or 0) for v in stats.values()) / calls) if calls else None,
                    'cache_ratio': round(cached / prompt, 3) if prompt else None,
                    'jetons_raisonnement': sum(v.get('jetons_raisonnement_total') or 0 for v in stats.values()),
                    'jetons_sortie': sum(v.get('jetons_sortie_total') or 0 for v in stats.values()),
                    # Modeles par usage (ci/models.env) : dernier modele servi par bot.
                    'modeles_servis': sorted({v['modele_servi'] for v in stats.values() if v.get('modele_servi')}),
                    # Repli de cle (PLANNER_KEY_FIRST) : cle du dernier appel servi, bascules.
                    'cles_servies': sorted({v['cle_servie'] for v in stats.values() if v.get('cle_servie')}),
                    'bascules_cle': sum(v.get('bascules_cle') or 0 for v in stats.values()),
                    # Duree reelle par usage (plan, chat, brief, compact, repair), tous bots.
                    'latences': latency_summary(stats),
                }
                for v in stats.values():
                    v.pop('latences', None)
                # Cle attendue (CI_EXPECT_KEY, `secondary` au banc) : toute autre cle
                # servie, ou une bascule, rend le banc non conforme.
                expected = os.environ.get('CI_EXPECT_KEY')
                if expected:
                    served = report['plannerSummary']['cles_servies']
                    switches = report['plannerSummary']['bascules_cle']
                    ok = served == [expected] and not switches
                    report['keyCheck'] = {'expected': expected, 'served': served, 'switches': switches, 'ok': ok}
                    print(f"Cle du planificateur : attendue {expected}, servie {served}, bascules {switches} -> {'OK' if ok else 'NON CONFORME'}", flush=True)
                    if not ok:
                        report['errors'].append(f'Cle du planificateur non conforme : attendue {expected}, servie {served}, {switches} bascule(s)')
            else:
                level_results = [{'test': level, 'success': False,
                                  'error': 'aucune cle du planificateur (OPENCODE_SECONDARY_API_KEY ou PLANNER_API_KEY) : secret GitHub non configure'}
                                 for level in [level['name'] for level in levels()]]
        else:
            level_results = []
        for thread in (unit_thread, nav_thread):
            if thread:
                thread.join()
        if probe_thread:
            probe_thread.join(timeout=320)
            report['modelProbe'] = probe_results
        report['tests'].extend(unit_results + nav_results + level_results)
        # Services arretes en fin de banc (conteneur tue de l exterieur, moteur
        # redemarre...) : le banc est invalide, pas le code (vu sur b2da858).
        report['servicesDown'] = services_down()
    except (Exception, KeyboardInterrupt) as error:
        report['errors'].append(str(error) or 'Interrupted')
    finally:
        collector.stop()
        try:
            report['capacity'].update(collector.report(run_started))
        except Exception as error:
            report['capacity']['error'] = str(error)[:300]
        # Only the generated project and the explicit ci/compose.yaml are addressed.
        # Anonymous test volumes are removed with their containers; no global prune.
        started = time.monotonic()
        try:
            logs = compose('logs', '--no-color', '--timestamps', timeout=30, check=False)
            (output / 'containers.log').write_text(logs.stdout + logs.stderr, encoding='utf-8')
            report['paperGc'] = gc_summary(logs.stdout)
            # Everything is disposable and its logs are saved: no graceful
            # stop (Paper would save a world nobody reads).
            compose('kill', timeout=60, check=False)
            compose('rm', '--stop', '--force', '--volumes', timeout=60)
            compose('down', '--remove-orphans', timeout=60)
            # `--rmi local` skips images with an explicit name: remove this
            # run's image by its exact tag, never anything else.
            removed = command(['docker', 'image', 'rm', image], timeout=60, check=False)
            if removed.returncode and 'no such image' not in (removed.stderr or '').lower():
                raise RuntimeError(f'Could not remove {image}; see commands.log')
            marker.unlink(missing_ok=True)
        except Exception as error:
            report['errors'].append('Cleanup failed: ' + str(error))
        phase('teardown', started)
        report['phases']['total'] = round(time.monotonic() - run_started, 1)
        classify_failures(report)
        # A/B variants (a mode switched off, or the view switched on) measure,
        # they never gate: only the levels as written decide PASS/FAIL.
        report['success'] = bool(report['tests']) and all(t['success'] or t.get('informative') for t in report['tests']) and not report['errors']
        report['comparisons'] = compare_variants(report['tests'])
        report['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (output / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        # Convenience copy, deliberately ignored by Git; artifacts retain per-run files.
        (ROOT / 'test-results/latest.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        def detail(t):
            if t.get('error'):
                return ' : ' + t['error']
            failed = [k for k, ok in (t.get('checks') or {}).items() if not ok]
            if 'checks' not in t:
                return ''
            info = f" ({t['logsInInventory']}/{t['expectedLogs']} buches, {t['elapsedS']} s, {t['endReason']})"
            return info + (' ; echec : ' + ', '.join(failed) if failed else '')
        def line(t):
            tag = ('INFO-' if t.get('informative') else '') + ('PASS' if t['success'] else 'FAIL')
            return f"- {tag} {t['test']}" + (f" [{t['type']}]" if t.get('type') else '') \
                + (f" <{t['failureKind']}>" if t.get('failureKind') else '') + detail(t)
        summary = '\n'.join([f"Commit: {report['sha'] or 'local export (no Git SHA)'}",
                             f"Result: {'PASS' if report['success'] else 'FAIL'}",
                             *([f"BANC INVALIDE (infrastructure) : {report['benchInvalid']}"] if report.get('benchInvalid') else []),
                             *([f"Cle du planificateur : {report['keyCheck']}"] if report.get('keyCheck') else []), '',
                             *[line(t) for t in report['tests']],
                             *(['', 'Comparaisons A/B (niveau tel quel -> variante) :'] + [
                                 f"- {c['level']} vs {c['variant']} : {c['base']} -> {c['other']}"
                                 for c in report['comparisons']] if report.get('comparisons') else []),
                             *([f"Planificateur : {report['plannerSummary']}"] if report.get('plannerSummary') else []),
                             *([f"Pool : mode {report['pool']['mode']}, {report['pool']['maxActive']} workers au plus, "
                                f"{report['pool']['workersStarted']} lances, morts {report['pool']['dead'] or 'aucun'}, "
                                f"budget memoire {report['pool']['workerMemBudgetGiB']} Gio/worker"]
                               if report.get('pool') else []),
                             *([f"Capacite (enveloppe CI {report['capacity'].get('sources', {}).get('envelope') or 'introuvable'}) : "
                                + ', '.join(f'{k} {report["capacity"].get(k)}' for k in (
                                    'cpuSeconds', 'cpuMeanPct', 'cpu1sP95Pct', 'cpu1sMaxPct', 'throttledPeriodsShareMax10s',
                                    'cpuPressureMax10s', 'memPeakGiB', 'minMemMarginGiB', 'minHostAvailableGiB', 'memEventsDelta'))
                                + (f" ; validation : {report['capacity']['validation']}" if report['capacity'].get('validation') else '')]
                               if report.get('capacity') else []),
                             f"Phases (s) : {report['phases']}",
                             *([f"Pics (docker stats toutes les ~5 s pendant les niveaux, {report['resourcePeaks']['samples']} mesures) : "
                                f"memoire totale {report['resourcePeaks']['totalMemPeakMB']} MB, CPU total max {report['resourcePeaks']['totalCpuPeakPercent']} % "
                                f"(moyenne {report['resourcePeaks']['totalCpuMeanPercent']} %) ; "
                                + ', '.join(f"{k} {v['memPeakMB']} MB / {v['cpuPeakPercent']} % (moy. {v['cpuMeanPercent']} %)"
                                            for k, v in sorted(report['resourcePeaks']['containers'].items()))]
                               if (report.get('resourcePeaks') or {}).get('samples') else []),
                             *([f"Tas Java de Paper (-Xlog:gc) : {report['paperGc']}"] if report.get('paperGc') else []),
                             *([f"Ressources (docker stats, ~60 s apres le debut des niveaux) : "
                                f"{report['resourceSnapshot']['totalMemMB']} MB, CPU {report['resourceSnapshot']['totalCpuPercent']} % "
                                f"sur {len(report['resourceSnapshot']['containers'])} conteneurs"]
                               if (report.get('resourceSnapshot') or {}).get('containers') else []),
                             *report['errors']]) + '\n'
        (output / 'summary.md').write_text(summary, encoding='utf-8')
        if os.environ.get('GITHUB_STEP_SUMMARY'):
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as file:
                file.write(summary)
        print(summary, flush=True)
    return 0 if report['success'] else 1


if __name__ == '__main__':
    sys.exit(main())
