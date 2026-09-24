"""Fallback after a cancelled CI step. Only remove this checkout's recorded CI project."""
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def main():
    for marker in (ROOT / 'test-results').glob('mc-ci-*/active.json'):
        project = json.loads(marker.read_text(encoding='utf-8'))['project']
        if not re.fullmatch(r'mc-ci-[0-9a-f]{12}', project) or marker.parent.name != project:
            raise ValueError('Invalid disposable project marker')
        base = ['docker', 'compose', '--env-file', str(ROOT / 'ci/empty.env'),
                '--project-directory', str(ROOT / 'ci'), '-f', str(ROOT / 'ci/compose.yaml'), '-p', project]
        subprocess.run(base + ['rm', '--stop', '--force', '--volumes'], check=True, timeout=60)
        subprocess.run(base + ['down', '--remove-orphans', '--rmi', 'local'], check=True, timeout=60)
        marker.unlink()


if __name__ == '__main__':
    main()
