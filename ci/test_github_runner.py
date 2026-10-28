"""Hosted-runner envelope selection and setup without changing the test host."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cleanup


ROOT = Path(__file__).resolve().parents[1]
SETUP = ROOT / 'ci/setup-github-runner.sh'
COMMAND = r'''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys

root = Path(os.environ['FIXTURE_ROOT'])
name = Path(sys.argv[0]).name
args = sys.argv[1:]
with (root / 'commands.jsonl').open('a') as log:
    log.write(json.dumps([name, *args]) + '\n')
if name == 'docker':
    if args[0] == 'info':
        print(os.environ.get('FIXTURE_DRIVER', '2 systemd'))
    elif args == ['compose', 'version']:
        print('Docker Compose version v2.39.0')
    else:
        sys.exit(90)
elif args[:2] == ['tee', '/run/systemd/system/agentcraft.slice']:
    (root / 'slice.conf').write_text(sys.stdin.read())
elif args[:3] == ['systemctl', 'show', 'agentcraft.slice']:
    print(os.environ.get('FIXTURE_CGROUP', '/agentcraft.slice'))
elif args == ['systemctl', 'daemon-reload'] or args == ['systemctl', 'start', 'agentcraft.slice']:
    pass
elif args == ['cat', '/sys/fs/cgroup/agentcraft.slice/cpu.max']:
    print(os.environ.get('FIXTURE_CPU', '400000 100000'))
elif args == ['cat', '/sys/fs/cgroup/agentcraft.slice/memory.max']:
    print(os.environ.get('FIXTURE_MEMORY', '10737418240'))
else:
    sys.exit(91)
'''


class ComposeEnvelope(unittest.TestCase):
    def test_explicit_hosted_overlay_keeps_engine_compatibility(self):
        # The shared function supplies the same files to execution and cleanup.
        for flag in ('', '0', '1'):
            for api in ('1.41', '1.52'):
                with self.subTest(flag=flag, api=api):
                    with patch.dict(os.environ, {'CI_GITHUB_HOSTED': flag}), \
                         patch.object(cleanup, 'docker', return_value=SimpleNamespace(stdout=api)):
                        files = cleanup.compose_files()
                    selected = [Path(path).name for path in files[1::2]]
                    expected = ['compose.yaml']
                    if api == '1.41':
                        expected.append('compose.old-api.yaml')
                    if flag == '1':
                        expected.append('compose.github.yaml')
                    self.assertEqual(selected, expected)

    def test_mistyped_hosted_flag_does_not_silently_drop_limits(self):
        with patch.dict(os.environ, {'CI_GITHUB_HOSTED': 'true'}), \
             patch.object(cleanup, 'docker') as docker:
            with self.assertRaisesRegex(ValueError, 'CI_GITHUB_HOSTED'):
                cleanup.compose_files()
            docker.assert_not_called()


class HostedSetup(unittest.TestCase):
    def run_setup(self, **overrides):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ('docker', 'sudo'):
                command = root / name
                command.write_text(COMMAND)
                command.chmod(0o755)
            output = root / 'github.env'
            output.write_text('EXISTING=value\n')
            env = dict(os.environ, GITHUB_ACTIONS='true', RUNNER_ENVIRONMENT='github-hosted',
                       GITHUB_ENV=str(output), FIXTURE_ROOT=str(root),
                       PATH=str(root) + os.pathsep + os.environ['PATH'])
            env.update(overrides)
            result = subprocess.run(['bash', str(SETUP)], env=env, text=True,
                                    capture_output=True, timeout=15)
            log = root / 'commands.jsonl'
            commands = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
            config = root / 'slice.conf'
            return result, output.read_text(), commands, config.read_text() if config.exists() else None

    def test_final_merge_gate_uses_required_public_check_name(self):
        # The ruleset requires 'banc-complet', but the YAML job id remains
        # 'minecraft' so its existing needs and fail-closed verdict survive.
        workflow = (ROOT / '.github/workflows/minecraft.yml').read_text()
        self.assertEqual(workflow.count('    name: banc-complet\n'), 1)
        gate = workflow.split('\n  minecraft:\n', 1)[1]
        self.assertIn('    needs: minecraft-bench\n', gate)
        self.assertIn('    if: always()\n', gate)
        self.assertIn('if [ "$BENCH_RESULT" != success ]; then', gate)

    def test_never_changes_a_self_hosted_or_local_machine(self):
        for overrides in ({'RUNNER_ENVIRONMENT': 'self-hosted'}, {'GITHUB_ACTIONS': 'false'}):
            with self.subTest(overrides=overrides):
                result, output, commands, config = self.run_setup(**overrides)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(commands, [])
                self.assertIsNone(config)
                self.assertEqual(output, 'EXISTING=value\n')

    def test_unsupported_cgroups_fail_before_any_privileged_change(self):
        for driver in ('1 systemd', '2 cgroupfs'):
            with self.subTest(driver=driver):
                result, output, commands, config = self.run_setup(FIXTURE_DRIVER=driver)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(any(command[0] == 'sudo' for command in commands))
                self.assertIsNone(config)
                self.assertEqual(output, 'EXISTING=value\n')

    def test_exports_only_a_verified_common_envelope(self):
        result, output, commands, config = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('CPUQuota=400%\n', config)
        self.assertIn('MemoryMax=10G\n', config)
        self.assertIn(['sudo', 'systemctl', 'start', 'agentcraft.slice'], commands)
        self.assertEqual(output, 'EXISTING=value\nCI_GITHUB_HOSTED=1\n'
                         'CI_METRICS_CGROUP=/sys/fs/cgroup/agentcraft.slice\nCI_ENDPOINT_MODE=direct\n')

    def test_unenforced_limits_or_wrong_path_are_not_published(self):
        for overrides in ({'FIXTURE_CPU': 'max 100000'}, {'FIXTURE_CPU': '200000 100000'},
                          {'FIXTURE_MEMORY': 'max'}, {'FIXTURE_MEMORY': '8589934592'},
                          {'FIXTURE_CGROUP': '/wrong.slice'}):
            with self.subTest(overrides=overrides):
                result, output, _, _ = self.run_setup(**overrides)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(output, 'EXISTING=value\n')


if __name__ == '__main__':
    unittest.main()
