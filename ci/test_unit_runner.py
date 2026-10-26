"""Real subprocess timeout, isolated fake container ownership, and fail-closed result."""
import ast
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))
import run as bench


class UnitRunner(unittest.TestCase):
    def test_hosted_parallelism_keeps_every_file_and_the_same_deadline(self):
        for hosted in ('', '0', '1'):
            with self.subTest(hosted=hosted), tempfile.TemporaryDirectory() as root:
                calls = []
                def compose(*argv, **kwargs):
                    calls.append((argv, kwargs))
                    return subprocess.CompletedProcess(argv, 0, 'all assertions passed', '')
                with patch.dict(os.environ, {'CI_GITHUB_HOSTED': hosted}):
                    result = bench.run_unit_regressions(compose, None, 'mc-ci-fixture', Path(root))
                self.assertTrue(result['success'])
                self.assertEqual(len(calls), 1)
                args, options = calls[0]
                extra = ['--test-concurrency=8'] if hosted == '1' else []
                self.assertEqual(args, ('run', '--rm', '--no-deps', '--name', 'mc-ci-fixture-unit',
                                        'harness', 'node', '--test', *extra,
                                        *['tmp/' + item for item in bench.UNIT]))
                self.assertEqual(options, {'timeout': 180, 'check': False})

    def test_timeout_preserves_output_and_cleans_only_own_container(self):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root)
            foreign = output / 'foreign-production-resource'
            foreign.write_text('untouched')
            owned = output / 'mc-ci-fixture-unique-unit'
            script = output / 'fixture.py'
            script.write_text("import pathlib,sys,time\npathlib.Path(sys.argv[1]).write_text('live')\nprint('assertions started',flush=True)\nprint('fixture stderr',file=sys.stderr,flush=True)\ntime.sleep(10)\n")
            operations = []
            def compose(*argv, **kwargs):
                self.assertEqual(kwargs['timeout'], 180)
                self.assertEqual(argv[:6], ('run', '--rm', '--no-deps', '--name', owned.name, 'harness'))
                extra = ['--test-concurrency=8'] if os.environ.get('CI_GITHUB_HOSTED') == '1' else []
                self.assertEqual(argv[6:], ('node', '--test', *extra, *['tmp/' + item for item in bench.UNIT]))
                return subprocess.run([sys.executable, str(script), str(owned)], capture_output=True, timeout=0.2)
            def command(argv, **kwargs):
                operations.append(argv)
                self.assertEqual(argv[-1], owned.name)
                if argv[1] == 'logs':
                    self.assertTrue(owned.exists())
                    return subprocess.CompletedProcess(argv, 0, 'container tail\n', '')
                if argv[1] == 'stop':
                    owned.write_text('stopped')
                if argv[1] == 'rm':
                    self.assertEqual(owned.read_text(), 'stopped')
                    owned.unlink()
                return subprocess.CompletedProcess(argv, 0, '', '')
            result = bench.run_unit_regressions(compose, command, 'mc-ci-fixture-unique', output)
            self.assertFalse(result['success'])
            self.assertIn('180 seconds', result['error'])
            log = (output / 'unit.log').read_text()
            for message in ('assertions started', 'fixture stderr', 'container tail', '180 seconds'):
                self.assertIn(message, log)
            self.assertEqual([op[1] for op in operations], ['logs', 'stop', 'rm'])
            self.assertFalse(owned.exists())
            self.assertEqual(foreign.read_text(), 'untouched')

    def test_cleanup_failure_cannot_erase_timeout_or_diagnostics(self):
        with tempfile.TemporaryDirectory() as root:
            def compose(*args, **kwargs):
                raise subprocess.TimeoutExpired('fixture', 180, output=b'partial stdout', stderr=b'partial stderr')
            calls = []
            def command(argv, **kwargs):
                calls.append(argv[1])
                raise RuntimeError('cleanup unavailable')
            result = bench.run_unit_regressions(compose, command, 'mc-ci-fixture', Path(root))
            self.assertFalse(result['success'])
            self.assertEqual(calls, ['logs', 'stop', 'rm'])
            self.assertIn('partial stdoutpartial stderr', (Path(root) / 'unit.log').read_text())

    def test_process_exit_and_admission_errors_fail(self):
        with tempfile.TemporaryDirectory() as root:
            for code in (0, 7):
                def compose(*args, **kwargs):
                    return subprocess.run([sys.executable, '-c', f"print('completed assertions');raise SystemExit({code})"], capture_output=True, text=True)
                result = bench.run_unit_regressions(compose, None, 'fixture', Path(root))
                self.assertEqual(result['success'], code == 0)
                self.assertIn('completed assertions', (Path(root) / 'unit.log').read_text())
            def refused(*args, **kwargs):
                raise RuntimeError('container name unavailable')
            result = bench.run_unit_regressions(refused, None, 'fixture', Path(root))
            self.assertFalse(result['success'])
            self.assertIn('name unavailable', result['error'])

    def test_missing_unit_result_rejects_otherwise_successful_levels(self):
        for required in (True, False):
            report = {'tests': [{'test': 'trees/pillar', 'success': True}], 'errors': []}
            bench.require_unit_result(report, required)
            self.assertEqual(bool(report['errors']), required)
        report = {'tests': [{'test': bench.UNIT_TEST_NAME, 'success': False}], 'errors': []}
        bench.require_unit_result(report, True)
        self.assertEqual(report['errors'], [])  # the explicit failed result itself blocks success

    def test_units_are_synchronous_before_probe_and_paper(self):
        tree = ast.parse(Path(bench.__file__).read_text())
        main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'main')
        nodes = list(ast.walk(main))
        unit = next(n for n in nodes if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == 'run_unit_regressions')
        probe = next(n for n in nodes if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'probe_thread' for t in n.targets) and isinstance(n.value, ast.Call))
        paper = next(n for n in nodes if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == 'compose' and n.args and isinstance(n.args[0], ast.Constant) and n.args[0].value == 'up')
        self.assertLess(unit.lineno, probe.lineno)
        self.assertLess(unit.lineno, paper.lineno)
        self.assertNotIn('unit_thread', Path(bench.__file__).read_text())


if __name__ == '__main__':
    unittest.main()
