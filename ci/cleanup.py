"""Teardown of THIS checkout's bench runs, including after a failure or a cancel.

1. Tear down the compose projects recorded by this checkout
   (test-results/mc-ci-*/active.json): containers, anonymous volumes, network,
   and the run's own `minebot-ci:<project>` image.
2. Remove tags of the bench Paper image built from an older ci/paper/ (the
   current `minebot-ci-paper:<hash>` is kept between runs on purpose).

The runner is shared (MINIPC-CLEM runs the organisation's private projects, and
other branches of this repository may bench at the same time): nothing that
this checkout did not record is touched. `--sweep-stale` also removes every
`mc-ci-*` leftover of the engine; only for a local machine, never in CI.
No `prune`, never itzg/minecraft-server, never `minecraft-bot-test-bot:*`.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PROJECT_LABEL = 'com.docker.compose.project'
# mc-ci-<hex12>, or mc-ci-<GITHUB_RUN_ID>-<hex8> in GitHub Actions (ci/run.py).
PROJECT = re.compile(r'mc-ci-(?:[0-9]+-[0-9a-f]{8}|[0-9a-f]{12})')


PAPER_REPOSITORY = 'minebot-ci-paper'


def paper_image():
    """Stable tag of the bench's Paper image: changes only with ci/paper/ (Dockerfile, bukkit.yml)."""
    digest = hashlib.sha256()
    for name in ('Dockerfile', 'bukkit.yml'):
        digest.update((ROOT / 'ci/paper' / name).read_bytes().replace(b'\r\n', b'\n'))
    digest = digest.hexdigest()
    return f'{PAPER_REPOSITORY}:{digest[:12]}'


def compose_files():
    """`-f` arguments of the bench: ci/compose.yaml, plus ci/compose.old-api.yaml
    when the engine API is older than 1.44 (Podman: no healthcheck.start_interval).
    GitHub-hosted jobs explicitly add the common runtime resource envelope;
    the unset flag leaves local and private Podman runs unchanged.
    """
    github_hosted = os.environ.get('CI_GITHUB_HOSTED', '')
    if github_hosted not in ('', '0', '1'):
        raise ValueError('CI_GITHUB_HOSTED doit valoir 0 ou 1')
    files = ['-f', str(ROOT / 'ci/compose.yaml')]
    version = docker('version', '--format', '{{.Server.APIVersion}}').stdout.strip()
    try:
        old = tuple(int(n) for n in version.split('.')[:2]) < (1, 44)
    except ValueError:
        old = False  # Version illisible : fichier de base seul, l erreur de Compose parlera.
    if old:
        files += ['-f', str(ROOT / 'ci/compose.old-api.yaml')]
    if github_hosted == '1':
        files += ['-f', str(ROOT / 'ci/compose.github.yaml')]
    return files


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
    files = compose_files()
    env = dict(os.environ, COMPOSE_DISABLE_ENV_FILE='1')
    for key in list(env):
        if key.startswith('COMPOSE_') and key != 'COMPOSE_DISABLE_ENV_FILE':
            del env[key]
    for marker in (ROOT / 'test-results').glob('mc-ci-*/active.json'):
        try:
            project = json.loads(marker.read_text(encoding='utf-8'))['project']
        except FileNotFoundError:
            # A cancelled bench's own teardown (ci/run.py finally) removes the
            # same marker: gone before it is read means already cleaned up.
            print(f'skipped {marker.parent.name}: marker already removed', flush=True)
            continue
        if not PROJECT.fullmatch(project) or marker.parent.name != project:
            raise ValueError('Invalid disposable project marker')
        env['CI_TAG'] = project
        base = ['compose', '--env-file', str(ROOT / 'ci/empty.env'),
                '--project-directory', str(ROOT / 'ci'), *files, '-p', project]
        docker(*base, 'rm', '--stop', '--force', '--volumes', check=True, env=env)
        docker(*base, 'down', '--remove-orphans', check=True, env=env)
        # The shared test image has an explicit name, so `--rmi local` would skip it.
        remove('image', ['image', 'rm'], [f'minebot-ci:{project}'] if docker('image', 'inspect', f'minebot-ci:{project}').returncode == 0 else [], removed)
        removed.append(f'project {project}')
        print(f'removed project {project}', flush=True)
        # During a cancel, ci/run.py finally tears the same project down and
        # unlinks this marker first: that concurrent cleanup already finished.
        marker.unlink(missing_ok=True)


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
    refs = [ref for (ref,) in lines(docker('image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'))]
    images = [ref for ref in refs if is_ci_image(ref) and not ref.endswith(':<none>')]
    # Paper images built from an older ci/paper/Dockerfile; the current one stays.
    images += [ref for ref in refs if ref.rsplit(':', 1)[0] == PAPER_REPOSITORY and ref != paper_image()]
    # Untagged leftovers of those builds, identified by their compose project label.
    for (image_id,) in lines(docker('image', 'ls', '-q', '--no-trunc', '--filter', 'dangling=true', *label)):
        project = docker('image', 'inspect', '--format', '{{index .Config.Labels "' + PROJECT_LABEL + '"}}', image_id).stdout.strip()
        if is_ci_project(project):
            images.append(image_id)
    remove('image', ['image', 'rm'], images, removed)


def old_paper_images(removed):
    refs = [ref for (ref,) in lines(docker('image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'))]
    old = [ref for ref in refs if ref.rsplit(':', 1)[0] in (PAPER_REPOSITORY, 'localhost/' + PAPER_REPOSITORY)
           and ref.rsplit(':', 1)[1] != paper_image().rsplit(':', 1)[1]]
    remove('image', ['image', 'rm'], old, removed)


def main():
    removed = []
    recorded_projects(removed)
    old_paper_images(removed)
    if '--sweep-stale' in sys.argv[1:]:
        sweep(removed)
    print(f'cleanup: {len(removed)} item(s) removed' if removed else 'cleanup: nothing to remove', flush=True)


if __name__ == '__main__':
    main()
