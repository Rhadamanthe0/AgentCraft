"""Offline rejection tests for the required GitHub status check's fast path."""
import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parent))
from change_scope import classify, documentation, lock_safe


BASE_LOCK = {
    'name': 'minecraft-test-bot', 'version': '1.1.0', 'lockfileVersion': 3, 'requires': True,
    'packages': {
        '': {'name': 'minecraft-test-bot', 'version': '1.1.0', 'dependencies': {'express': '5.2.1'}},
        'node_modules/body-parser': {'version': '2.3.0', 'resolved': 'https://registry.npmjs.org/body-parser/-/body-parser-2.3.0.tgz', 'integrity': 'sha512-old'},
        'node_modules/qs': {'version': '6.16.0', 'resolved': 'https://registry.npmjs.org/qs/-/qs-6.16.0.tgz', 'integrity': 'sha512-old'},
    }
}
HEAD_LOCK = copy.deepcopy(BASE_LOCK)
HEAD_LOCK['packages']['node_modules/body-parser'].update(version='2.4.0', resolved='https://registry.npmjs.org/body-parser/-/body-parser-2.4.0.tgz', integrity='sha512-new')
HEAD_LOCK['packages']['node_modules/qs'].update(version='6.17.0', resolved='https://registry.npmjs.org/qs/-/qs-6.17.0.tgz', integrity='sha512-new')
BASE_MANIFEST = {'name': 'minecraft-test-bot', 'version': '1.1.0', 'scripts': {'start': 'node index.js'}, 'dependencies': {'express': '5.2.1'}, 'overrides': {'uuid': '11.1.1'}}


def classifier(changes, head_lock=None, head_package=None):
    current = {'bot/package-lock.json': (BASE_LOCK, head_lock or HEAD_LOCK),
               'bot/package.json': (BASE_MANIFEST, head_package or BASE_MANIFEST)}
    return classify(changes, lambda path, version: current[path][0 if version == 'base' else 1])


class ScopeTest(unittest.TestCase):
    def test_docs_only_and_unsafe_documentation(self):
        self.assertTrue(documentation('docs/remote-minecraft-tests.md'))
        self.assertFalse(documentation('AGENTS.md'))
        self.assertFalse(documentation('.github/workflows/minecraft.yml'))
        self.assertEqual(classifier([('M', 'README.md'), ('A', 'docs/usage.md')]), 'docs')
        self.assertEqual(classifier([('D', 'docs/old.md')]), 'docs')
        self.assertEqual(classifier([('M', 'AGENTS.md')]), 'full')

    def test_lockfile_only_patch_minor(self):
        self.assertEqual(classifier([('M', 'bot/package-lock.json')]), 'deps')
        self.assertEqual(classifier([('M', 'bot/package-lock.json'), ('M', 'README.md')]), 'deps')

    def test_manifest_non_dependency_change_denied(self):
        bad = copy.deepcopy(BASE_MANIFEST)
        bad['scripts']['start'] = 'echo skipped'
        self.assertEqual(classifier([('M', 'bot/package.json'), ('M', 'bot/package-lock.json')], head_package=bad), 'full')
        self.assertEqual(classifier([('M', 'bot/package.json')]), 'full')

    def test_direct_dependency_manifest_only_can_be_checked_without_minecraft(self):
        before = copy.deepcopy(BASE_MANIFEST)
        after = copy.deepcopy(BASE_MANIFEST)
        after['dependencies']['express'] = '5.2.2'
        initial_lock, updated_lock = copy.deepcopy(BASE_LOCK), copy.deepcopy(HEAD_LOCK)
        initial_lock['packages']['']['dependencies'] = before['dependencies']
        updated_lock['packages']['']['dependencies'] = after['dependencies']
        self.assertTrue(lock_safe(initial_lock, updated_lock, old_manifest=before, new_manifest=after))
        self.assertEqual(classify([('M', 'bot/package.json'), ('M', 'bot/package-lock.json')],
            lambda path, version: (initial_lock if version == 'base' else updated_lock)
                if path.endswith('package-lock.json') else (before if version == 'base' else after)), 'deps')

    def test_mixed_code_or_ci_changes_denied(self):
        for file in ('bot/mission.js', 'ci/run.py', '.github/workflows/minecraft.yml', 'AGENTS.md'):
            self.assertEqual(classifier([('M', 'bot/package-lock.json'), ('M', file)]), 'full')
        self.assertEqual(classifier([('D', 'bot/package-lock.json')]), 'full')
        self.assertEqual(classifier([]), 'full')

    def test_engine_or_major_dependency_upgrade_denied(self):
        bad = copy.deepcopy(HEAD_LOCK)
        bad['packages']['node_modules/mineflayer'] = {'version': '4.39.1', 'resolved': 'https://registry.npmjs.org/mineflayer/-/mineflayer-4.39.1.tgz', 'integrity': 'sha512-new'}
        self.assertFalse(lock_safe(BASE_LOCK, bad))
        major = copy.deepcopy(HEAD_LOCK)
        major['packages']['node_modules/qs']['version'] = '7.0.0'
        self.assertFalse(lock_safe(BASE_LOCK, major))

    def test_untrusted_resolved_or_no_integrity_denied(self):
        for value in ('https://evil.test/qs.tgz', 'http://registry.npmjs.org/qs.tgz'):
            bad = copy.deepcopy(HEAD_LOCK)
            bad['packages']['node_modules/qs']['resolved'] = value
            self.assertFalse(lock_safe(BASE_LOCK, bad))
        bad = copy.deepcopy(HEAD_LOCK)
        bad['packages']['node_modules/qs'].pop('integrity')
        self.assertFalse(lock_safe(BASE_LOCK, bad))

    def test_root_changed_denied(self):
        bad = copy.deepcopy(HEAD_LOCK)
        bad['packages']['']['dependencies']['express'] = '6.0.0'
        self.assertFalse(lock_safe(BASE_LOCK, bad))

    def test_no_renames_or_unknown_states(self):
        self.assertEqual(classifier([('R100', 'README.md')]), 'full')
        self.assertEqual(classifier([('?', 'docs/readme.md')]), 'full')


class GitDiffTest(unittest.TestCase):
    def test_git_diff_name_status_zero_terminated(self):
        import subprocess
        import tempfile
        import os
        from pathlib import Path
        from change_scope import diff_changes
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(['git', 'init', '-q'], cwd=root, check=True)
            subprocess.run(['git', 'config', 'user.name', 'CI'], cwd=root, check=True)
            subprocess.run(['git', 'config', 'user.email', 'ci@example.test'], cwd=root, check=True)
            (root/'docs').mkdir()
            (root/'docs'/'guide.md').write_text('Old\n')
            subprocess.run(['git','add','.'],cwd=root,check=True)
            subprocess.run(['git','commit','-qm','base'],cwd=root,check=True)
            a=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
            (root/'docs'/'guide.md').write_text('New\n')
            (root/'README.md').write_text('Read\n')
            subprocess.run(['git','add','.'],cwd=root,check=True)
            subprocess.run(['git','commit','-qm','docs'],cwd=root,check=True)
            b=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
            previous=Path.cwd()
            os.chdir(root)
            try:
                changes=diff_changes(a,b)
            finally:
                os.chdir(previous)
            self.assertEqual(changes, [('A','README.md'),('M','docs/guide.md')])
            self.assertEqual(classify(changes,lambda *_: None), 'docs')


    def test_real_git_commit_dep_only_then_code_requires_full(self):
        import json
        import subprocess
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root/'bot').mkdir()
            subprocess.run(['git', 'init', '-q'], cwd=root, check=True)
            subprocess.run(['git', 'config', 'user.name', 'CI'], cwd=root, check=True)
            subprocess.run(['git', 'config', 'user.email', 'ci@example.test'], cwd=root, check=True)
            lock = root/'bot'/'package-lock.json'
            lock.write_text(json.dumps(BASE_LOCK))
            subprocess.run(['git', 'add', '.'], cwd=root, check=True)
            subprocess.run(['git', 'commit', '-qm', 'base'], cwd=root, check=True)
            base = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
            lock.write_text(json.dumps(HEAD_LOCK))
            subprocess.run(['git', 'add', '.'], cwd=root, check=True)
            subprocess.run(['git', 'commit', '-qm', 'dep'], cwd=root, check=True)
            dep = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
            output = root/'out'
            code = Path(__file__).with_name('change_scope.py')
            subprocess.run([sys.executable, str(code), '--base', base, '--head', dep, '--output', str(output)], cwd=root, check=True)
            self.assertEqual(output.read_text(), 'mode=deps\n')
            (root/'bot'/'mission.js').write_text('// real code change\n')
            subprocess.run(['git', 'add', '.'], cwd=root, check=True)
            subprocess.run(['git', 'commit', '-qm', 'code'], cwd=root, check=True)
            changed = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
            output.write_text('')
            subprocess.run([sys.executable, str(code), '--base', base, '--head', changed, '--output', str(output)], cwd=root, check=True)
            self.assertEqual(output.read_text(), 'mode=full\n')
            output.write_text('')
            subprocess.run([sys.executable, str(code), '--base', '0' * 40, '--head', changed, '--output', str(output)], cwd=root, check=True)
            self.assertEqual(output.read_text(), 'mode=invalid\n')


if __name__ == '__main__':
    unittest.main()
