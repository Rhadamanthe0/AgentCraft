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

from cleanup import paper_image
from trees import BOTS_SERVICE, PROBES_SERVICE, arena_origins, bot_services, levels, probe_names, run_levels

ROOT = Path(__file__).resolve().parents[1]
UNIT = ['navigation.test.js', 'navigation-drop.test.js', 'navigation-entrypoints.test.js',
        'motion-trace.test.js', 'mission-navigation.test.js', 'movement-task.test.js',
        'model-chain.test.js', 'fabrication-utile.test.js', 'conversation.test.js']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--suite', choices=['unit', 'minecraft', 'trees', 'all'], default='all')
    args = parser.parse_args()
    project = 'mc-ci-' + uuid.uuid4().hex[:12]
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
            '--project-directory', str(ROOT / 'ci'), '-f', str(ROOT / 'ci/compose.yaml'), '-p', project]
    report = {'schemaVersion': 1, 'project': project, 'image': image, 'suite': args.suite,
              'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'sha': None, 'dirty': None, 'success': False, 'tests': [], 'errors': [],
              'phases': {}}
    run_started = time.monotonic()

    def phase(name, started):
        # Wall time of one bench phase, in seconds (report.json and summary).
        report['phases'][name] = round(time.monotonic() - started, 1)
    try:
        report['sha'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT,
                                                stderr=subprocess.DEVNULL, text=True).strip()
        report['dirty'] = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip())
    except (OSError, subprocess.CalledProcessError):
        pass  # An exported source directory is supported, but never claims a tested SHA.

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

    def endpoint(service, port):
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
        try:
            value = rcon_direct(text).strip()
        except Exception:
            value = compose('exec', '-T', 'minecraft', 'rcon-cli', text).stdout.strip()
        if any(word in value.lower() for word in ['incorrect argument', 'unknown command', 'not loaded']):
            raise RuntimeError('Fixture command rejected: ' + value)
        return value

    unreachable = set()  # (service, port) whose published port refused or dropped the connection.

    def http(service, port, route, body=None, method=None):
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
            with urllib.request.urlopen(request, timeout=45) as response:
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
                                  *([] if body is None else [json.dumps(body)]), timeout=45).stdout)

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
            if args.suite in ('trees', 'all') and os.environ.get('PLANNER_API_KEY'):
                arena_thread.start()
            bots_wanted = args.suite in ('trees', 'all') and bool(os.environ.get('PLANNER_API_KEY'))
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
            if os.environ.get('PLANNER_API_KEY'):
                # The probes healthcheck only proves the process: wait until each one is in the world.
                started = time.monotonic()
                until = time.monotonic() + 60
                while not all(re.search(r':\s*0\s*$', rcon(f'data get entity {name} playerGameType')) for name in probe_names()):
                    if time.monotonic() > until:
                        raise RuntimeError('Probe players did not join')
                    time.sleep(1)
                ops = json.loads(compose('exec', '-T', 'minecraft', 'cat', '/data/ops.json').stdout)
                modes = {name: rcon(f'data get entity {name} playerGameType')
                         for name in [name for _, name in bot_services()] + probe_names()}
                if ops or not all(re.search(r':\s*0\s*$', mode) for mode in modes.values()):
                    raise RuntimeError('Expected tree bots in survival without ops: ' + json.dumps(modes))
                report['botSurvivalProof'] = {'ops': ops, 'playerGameType': modes}
                phase('probesJoined', started)
                arena_thread.join()
                if arena_errors:
                    raise arena_errors[0]
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
                            if 'resourceSnapshot' not in report and snap['atS'] >= 60:
                                report['resourceSnapshot'] = snap
                        except Exception as error:
                            report.setdefault('resourceErrors', []).append(str(error))
                        levels_done.wait(5)
                sampler = threading.Thread(target=sample, daemon=True)
                sampler.start()
                level_results = run_levels(output, rcon, bot_api)
                phase('levels', levels_started)
                levels_done.set()
                sampler.join(90)
                report['resourcePeaks'] = resource_peaks(samples)
                report['resourceSamples'] = [{'atS': s['atS'], 'totalMemMB': s['totalMemMB'],
                                              'totalCpuPercent': s['totalCpuPercent'],
                                              'containers': {(r['container'] or '').replace(project + '-', ''): [round(r['memMB'] or 0), r['cpuPercent']]
                                                             for r in s['containers']}} for s in samples]
                # Planner cost per bot: latency, prompt cache hit rate, reasoning tokens.
                stats = {}
                for service, username in bot_services():
                    try:
                        p = bot_api(service, '/api/status').get('planner') or {}
                    except Exception:
                        continue
                    stats[username] = {k: p.get(k) for k in ('appels', 'etapes_servies', 'echecs', 'moyenne_ms',
                                                              'jetons_total', 'jetons_en_cache_total',
                                                              'jetons_sortie_total', 'jetons_raisonnement_total',
                                                              'modele_servi', 'bascules', 'modeles_de_cote')}
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
                    # Chaine de modeles (ci/models.env) : dernier modele servi par bot, bascules.
                    'modeles_servis': sorted({v['modele_servi'] for v in stats.values() if v.get('modele_servi')}),
                    'bascules': sum(v.get('bascules') or 0 for v in stats.values()),
                }
            else:
                level_results = [{'test': level, 'success': False,
                                  'error': 'PLANNER_API_KEY absent : secret GitHub du depot non configure'}
                                 for level in [level['name'] for level in levels()]]
        else:
            level_results = []
        for thread in (unit_thread, nav_thread):
            if thread:
                thread.join()
        report['tests'].extend(unit_results + nav_results + level_results)
    except (Exception, KeyboardInterrupt) as error:
        report['errors'].append(str(error) or 'Interrupted')
    finally:
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
        report['success'] = bool(report['tests']) and all(t['success'] for t in report['tests']) and not report['errors']
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
        summary = '\n'.join([f"Commit: {report['sha'] or 'local export (no Git SHA)'}",
                             f"Result: {'PASS' if report['success'] else 'FAIL'}", '',
                             *[f"- {'PASS' if t['success'] else 'FAIL'} {t['test']}" + (f" [{t['type']}]" if t.get('type') else '') + detail(t)
                               for t in report['tests']],
                             *([f"Planificateur : {report['plannerSummary']}"] if report.get('plannerSummary') else []),
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
