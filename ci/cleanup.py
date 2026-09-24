"""Fallback after a cancelled or interrupted CI run.

1. Tear down this checkout's recorded CI projects (test-results/mc-ci-*/active.json).
2. Sweep what any earlier `mc-ci-*` run left behind: containers, networks and
   volumes labelled with a compose project `mc-ci-*`, and the bench images
   (`minebot-ci:*`, and the per-service `mc-ci-*` images of older benches).

Nothing else is touched: no `prune`, never itzg/minecraft-server, never the
owner's `minecraft-bot-test-bot:*` backups. Do not run it while a bench run is
in progress on the same Docker engine: it would remove that run too.
"""
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PROJECT_LABEL = 'com.docker.compose.project'
PROJECT = re.compile(r'mc-ci-[0-9a-f]{12}')


def docker(*argv, check=False, env=None):
    return subprocess.run(['docker', *argv], capture_output=True, text=True, encoding='utf-8',
                          errors='replace', timeout=120, check=check, env=env)


def lines(result):
    return [line.split() for line in result.stdout.splitlines() if line.strip()]


def is_ci_project(name):
    return bool(name) and name.startswith('mc-ci-')


def is_ci_image(ref):
    repository = ref.rsplit(':', 1)[0]
    return repository == 'minebot-ci' or repository.startswith('mc-ci-')


def remove(kind, argv, names, removed):
    for name in names:
        result = docker(*argv, name)
        if result.returncode == 0:
            removed.append(f'{kind} {name}')
            print(f'removed {kind} {name}', flush=True)
        else:
            print(f'could not remove {kind} {name}: {result.stderr.strip()[:200]}', flush=True)


def recorded_projects(removed):
    env = dict(os.environ, COMPOSE_DISABLE_ENV_FILE='1')
    for key in list(env):
        if key.startswith('COMPOSE_') and key != 'COMPOSE_DISABLE_ENV_FILE':
            del env[key]
    for marker in (ROOT / 'test-results').glob('mc-ci-*/active.json'):
        project = json.loads(marker.read_text(encoding='utf-8'))['project']
        if not PROJECT.fullmatch(project) or marker.parent.name != project:
            raise ValueError('Invalid disposable project marker')
        env['CI_TAG'] = project
        base = ['compose', '--env-file', str(ROOT / 'ci/empty.env'),
                '--project-directory', str(ROOT / 'ci'), '-f', str(ROOT / 'ci/compose.yaml'), '-p', project]
        docker(*base, 'rm', '--stop', '--force', '--volumes', check=True, env=env)
        docker(*base, 'down', '--remove-orphans', check=True, env=env)
        # The shared test image has an explicit name, so `--rmi local` would skip it.
        remove('image', ['image', 'rm'], [f'minebot-ci:{project}'] if docker('image', 'inspect', f'minebot-ci:{project}').returncode == 0 else [], removed)
        removed.append(f'project {project}')
        print(f'removed project {project}', flush=True)
        marker.unlink()


def sweep(removed):
    label = ['--filter', 'label=' + PROJECT_LABEL]
    fmt = '{{.ID}} {{.Label "' + PROJECT_LABEL + '"}}'
    containers = [c for c, *p in lines(docker('ps', '-a', *label, '--format', fmt)) if p and is_ci_project(p[0])]
    # -v also removes the anonymous /data volumes of these containers.
    remove('container', ['rm', '--force', '--volumes'], containers, removed)
    networks = [n for n, *p in lines(docker('network', 'ls', *label, '--format', '{{.Name}} {{.Label "' + PROJECT_LABEL + '"}}'))
                if p and is_ci_project(p[0])]
    remove('network', ['network', 'rm'], networks, removed)
    volumes = [v for v, *p in lines(docker('volume', 'ls', *label, '--format', '{{.Name}} {{.Label "' + PROJECT_LABEL + '"}}'))
               if p and is_ci_project(p[0])]
    remove('volume', ['volume', 'rm'], volumes, removed)
    # Named bench images: minebot-ci:<project> and older mc-ci-<project>-<service>.
    images = [ref for (ref,) in lines(docker('image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'))
              if is_ci_image(ref) and not ref.endswith(':<none>')]
    # Untagged leftovers of those builds, identified by their compose project label.
    for (image_id,) in lines(docker('image', 'ls', '-q', '--no-trunc', '--filter', 'dangling=true', *label)):
        project = docker('image', 'inspect', '--format', '{{index .Config.Labels "' + PROJECT_LABEL + '"}}', image_id).stdout.strip()
        if is_ci_project(project):
            images.append(image_id)
    remove('image', ['image', 'rm'], images, removed)


def main():
    removed = []
    recorded_projects(removed)
    sweep(removed)
    print(f'cleanup: {len(removed)} item(s) removed' if removed else 'cleanup: nothing to remove', flush=True)


if __name__ == '__main__':
    main()
