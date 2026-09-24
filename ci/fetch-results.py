"""Read a Minecraft Actions result for an exact commit (requires authenticated gh)."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True, help='owner/repository')
    parser.add_argument('--sha', required=True, help='Full commit SHA just pushed')
    parser.add_argument('--timeout', type=int, default=3000, help='Wait budget in seconds')
    parser.add_argument('--output', default='test-results/remote')
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9a-f]{40}', args.sha) or not re.fullmatch(r'[\w.-]+/[\w.-]+', args.repo):
        parser.error('Expected owner/repository and a full lowercase 40-character SHA')

    def gh(*argv):
        return subprocess.check_output(['gh', *argv, '--repo', args.repo], text=True, timeout=60)

    deadline = time.monotonic() + args.timeout
    while time.monotonic() < deadline:
        runs = json.loads(gh('run', 'list', '--workflow', 'minecraft.yml', '--commit', args.sha,
                             '--limit', '10', '--json', 'databaseId,headSha,status,conclusion,url'))
        runs = [r for r in runs if r['headSha'] == args.sha]
        if runs and runs[0]['status'] == 'completed':
            run = runs[0]
            metadata = json.loads(subprocess.check_output(
                ['gh', 'api', f"repos/{args.repo}/actions/runs/{run['databaseId']}"], text=True, timeout=60))
            output = Path(args.output) / str(run['databaseId']) / str(time.time_ns())
            output.mkdir(parents=True)
            gh('run', 'download', str(run['databaseId']), '--dir', str(output),
               '--name', f"minecraft-{args.sha}-{metadata['run_attempt']}")
            reports = [json.loads(p.read_text(encoding='utf-8')) for p in output.rglob('report.json')]
            matching = [r for r in reports if r.get('sha') == args.sha and r.get('dirty') is False]
            if not matching:
                raise RuntimeError('No clean-checkout report for the requested SHA: ' + run['url'])
            print(json.dumps({'run': run, 'reports': matching, 'downloadedTo': str(output)}, indent=2))
            return 0 if run['conclusion'] == 'success' and all(r['success'] for r in matching) else 1
        print('Waiting for Minecraft bench at ' + args.sha, file=sys.stderr, flush=True)
        time.sleep(min(10, max(0, deadline - time.monotonic())))
    raise TimeoutError('No completed run within wait budget; check runner is online and branch is main or claude/**')


if __name__ == '__main__':
    sys.exit(main())
