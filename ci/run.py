"""Disposable Minecraft bench. Python 3.10+ and Docker Compose v2 required."""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

from trees import arena_origins, bot_services, levels, run_levels

ROOT = Path(__file__).resolve().parents[1]
UNIT = ['navigation.test.js', 'navigation-drop.test.js', 'navigation-entrypoints.test.js',
        'motion-trace.test.js', 'mission-navigation.test.js', 'movement-task.test.js']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--suite', choices=['unit', 'minecraft', 'trees', 'all'], default='all')
    args = parser.parse_args()
    project = 'mc-ci-' + uuid.uuid4().hex[:12]
    output = ROOT / 'test-results' / project
    output.mkdir(parents=True)
    marker = output / 'active.json'
    marker.write_text(json.dumps({'project': project}), encoding='utf-8')
    env = dict(os.environ, COMPOSE_DISABLE_ENV_FILE='1', MSYS_NO_PATHCONV='1')
    # Ignore inherited Compose settings; the CLI pins file, directory and project.
    for key in list(env):
        if key.startswith('COMPOSE_') and key != 'COMPOSE_DISABLE_ENV_FILE':
            del env[key]
    base = ['docker', 'compose', '--env-file', str(ROOT / 'ci/empty.env'),
            '--project-directory', str(ROOT / 'ci'), '-f', str(ROOT / 'ci/compose.yaml'), '-p', project]
    report = {'schemaVersion': 1, 'project': project, 'suite': args.suite,
              'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'sha': None, 'dirty': None, 'success': False, 'tests': [], 'errors': []}
    try:
        report['sha'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT,
                                                stderr=subprocess.DEVNULL, text=True).strip()
        report['dirty'] = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip())
    except (OSError, subprocess.CalledProcessError):
        pass  # An exported source directory is supported, but never claims a tested SHA.

    def command(argv, timeout=60, check=True):
        result = subprocess.run(argv, cwd=ROOT, env=env, capture_output=True,
                                text=True, encoding='utf-8', errors='replace', timeout=timeout)
        with (output / 'commands.log').open('a', encoding='utf-8') as log:
            log.write('\n$ ' + ' '.join(argv) + '\n' + result.stdout + result.stderr)
        if check and result.returncode:
            raise RuntimeError(f"Command failed ({result.returncode}): {' '.join(argv[:8])}; see commands.log")
        return result

    def compose(*argv, **kwargs):
        return command(base + list(argv), **kwargs)

    def rcon(text):
        value = compose('exec', '-T', 'minecraft', 'rcon-cli', text).stdout.strip()
        if any(word in value.lower() for word in ['incorrect argument', 'unknown command', 'not loaded']):
            raise RuntimeError('Fixture command rejected: ' + value)
        return value

    def http(service, port, route, body=None):
        script = """const [port, route, body] = process.argv.slice(1);
fetch('http://127.0.0.1:'+port+route, body ? {method:'POST',headers:{'content-type':'application/json'},body} : {})
.then(async r=>{const s=await r.text();if(!r.ok)throw Error(s);console.log(s)})
.catch(e=>{console.error(e.message);process.exitCode=1})"""
        return json.loads(compose('exec', '-T', service, 'node', '-e', script, str(port),
                                  route, *([] if body is None else [json.dumps(body)]), timeout=45).stdout)

    def api(route, body=None):
        return http('harness', 3101, route, body)

    def bot_api(service, route, body=None):
        return http(service, 3000, route, body)

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
        print('Building test image...', flush=True)
        # Tree bots share the harness Dockerfile; their builds hit the same cache.
        compose('build', 'harness', *[service for service, _ in bot_services()], timeout=600)
        if args.suite in ('unit', 'all'):
            print('Running focused offline regression tests...', flush=True)
            result = compose('run', '--rm', '--no-deps', 'harness', 'node', '--test',
                             *['tmp/' + name for name in UNIT], timeout=180, check=False)
            (output / 'unit.log').write_text(result.stdout + result.stderr, encoding='utf-8')
            report['tests'].append({'test': 'unit/navigation-regression', 'success': result.returncode == 0})
        if args.suite in ('minecraft', 'trees', 'all'):
            print('Starting isolated Paper server...', flush=True)
            compose('up', '-d', '--wait', '--wait-timeout', '240', 'minecraft', timeout=270)
            rcon('forceload add 0 0 32 32')
            for x0 in arena_origins():  # Tree arenas and their block-count scratch areas.
                rcon(f'forceload add {x0 - 1} -1 {x0 + 37} 37')  # Arena and its fence.
                rcon(f'forceload add {x0} 200 {x0 + 36} 236')
            rcon('fill 0 199 0 32 199 32 stone')
            rcon('fill 0 200 0 32 208 32 air')
            rcon('setworldspawn 2 200 2')
            compose('up', '-d', '--wait', '--wait-timeout', '90', 'harness', timeout=120)
            ops = json.loads(compose('exec', '-T', 'minecraft', 'cat', '/data/ops.json').stdout)
            mode = rcon('data get entity TestProbe1 playerGameType')
            if ops or not re.search(r':\s*0\s*$', mode):
                raise RuntimeError('Expected empty ops.json and survival mode: ' + mode)
            report['survivalProof'] = {'ops': ops, 'playerGameType': mode}
        if args.suite in ('minecraft', 'all'):
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
                    report['tests'].append(dict(test=name, success=bool(passed), **value))
                except Exception as error:
                    report['tests'].append({'test': name, 'success': False, 'error': str(error)})
        if args.suite in ('trees', 'all'):
            if os.environ.get('PLANNER_API_KEY'):
                services = [service for service, _ in bot_services()]
                compose('up', '-d', '--wait', '--wait-timeout', '120', *services, timeout=180)
                ops = json.loads(compose('exec', '-T', 'minecraft', 'cat', '/data/ops.json').stdout)
                modes = {name: rcon(f'data get entity {name} playerGameType') for _, name in bot_services()}
                if ops or not all(re.search(r':\s*0\s*$', mode) for mode in modes.values()):
                    raise RuntimeError('Expected tree bots in survival without ops: ' + json.dumps(modes))
                report['botSurvivalProof'] = {'ops': ops, 'playerGameType': modes}
                report['tests'].extend(run_levels(output, rcon, bot_api))
            else:
                report['tests'].extend({'test': level, 'success': False,
                                        'error': 'PLANNER_API_KEY absent : secret GitHub du depot non configure'}
                                       for level in [level['name'] for level in levels()])
    except (Exception, KeyboardInterrupt) as error:
        report['errors'].append(str(error) or 'Interrupted')
    finally:
        # Only the generated project and the explicit ci/compose.yaml are addressed.
        # Anonymous test volumes are removed with their containers; no global prune.
        try:
            logs = compose('logs', '--no-color', timeout=30, check=False)
            (output / 'containers.log').write_text(logs.stdout + logs.stderr, encoding='utf-8')
            compose('rm', '--stop', '--force', '--volumes', timeout=60)
            compose('down', '--remove-orphans', '--rmi', 'local', timeout=60)
            marker.unlink(missing_ok=True)
        except Exception as error:
            report['errors'].append('Cleanup failed: ' + str(error))
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
                             *[f"- {'PASS' if t['success'] else 'FAIL'} {t['test']}" + detail(t) for t in report['tests']],
                             *report['errors']]) + '\n'
        (output / 'summary.md').write_text(summary, encoding='utf-8')
        if os.environ.get('GITHUB_STEP_SUMMARY'):
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as file:
                file.write(summary)
        print(summary, flush=True)
    return 0 if report['success'] else 1


if __name__ == '__main__':
    sys.exit(main())
