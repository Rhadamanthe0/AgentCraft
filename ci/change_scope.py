"""Fail-closed classification for optional Minecraft-free CI.

Only actual repository diffs, never commit trailers, branch names, or PR labels,
can authorize a reduced check. A dependency change still runs offline tests.
"""
import argparse
import json
import os
from pathlib import PurePosixPath
import re
import subprocess


DEPENDENCY_FILES = {'bot/package.json', 'bot/package-lock.json'}
CRITICAL_DEPENDENCIES = ('mineflayer', 'minecraft', 'prismarine', 'protodef', 'vec3', 'mojang')
VERSION_RE = re.compile(r'^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$')


def documentation(path):
    """Markdown documentation only; AGENTS.md and workflow files are policy/code."""
    if path in {'README.md', 'ARCHITECTURE.md'}:
        return True
    p = PurePosixPath(path)
    return len(p.parts) >= 2 and p.parts[0] == 'docs' and p.suffix.lower() == '.md' and 'AGENTS.md' not in p.parts


def lock_safe(before, after, *, old_manifest=None, new_manifest=None):
    """Disallow major upgrades, non-registry URLs, scripts and game dependencies."""
    if not isinstance(before, dict) or not isinstance(after, dict):
        return False
    a, b = before.get('packages'), after.get('packages')
    if not isinstance(a, dict) or not isinstance(b, dict):
        return False
    if {key: value for key, value in before.items() if key != 'packages'} != {
            key: value for key, value in after.items() if key != 'packages'}:
        return False
    root_before, root_after = a.get(''), b.get('')
    if not isinstance(root_before, dict) or not isinstance(root_after, dict):
        return False
    root_mutable = {'dependencies', 'devDependencies', 'optionalDependencies'}
    if old_manifest is None or new_manifest is None:
        if root_before != root_after:
            return False
    else:
        if {k: v for k, v in root_before.items() if k not in root_mutable} != {
                k: v for k, v in root_after.items() if k not in root_mutable}:
            return False
        for key in root_mutable:
            if root_before.get(key, {}) != old_manifest.get(key, {}):
                return False
            if root_after.get(key, {}) != new_manifest.get(key, {}):
                return False
    for name in a.keys() | b.keys():
        if name == '':
            continue  # Root package metadata checked above.
        old, new = a.get(name), b.get(name)
        if old == new:
            continue
        if not name.startswith('node_modules/') or not isinstance(new, dict):
            return False
        package = name.rsplit('node_modules/', 1)[-1].lower()
        if any(word in package for word in CRITICAL_DEPENDENCIES):
            return False
        url, integrity = new.get('resolved'), new.get('integrity')
        if not isinstance(url, str) or not url.startswith('https://registry.npmjs.org/'):
            return False
        if not isinstance(integrity, str) or not integrity.startswith('sha512-'):
            return False
        if old is not None:
            old_version, new_version = old.get('version'), new.get('version')
            va, vb = VERSION_RE.fullmatch(str(old_version)), VERSION_RE.fullmatch(str(new_version))
            if not va or not vb or va.group(1) != vb.group(1):
                return False
    return True


def package_manifest_safe(before, after):
    if not isinstance(before, dict) or not isinstance(after, dict):
        return False
    # Changing scripts, overrides, runtime version, package name, etc. is code.
    mutable = {'dependencies', 'devDependencies', 'optionalDependencies'}
    return ({k: v for k, v in before.items() if k not in mutable} ==
            {k: v for k, v in after.items() if k not in mutable})


def classify(changes, load_json):
    """changes: (status, path) pairs, load_json(path, version) callable."""
    if not changes:
        return 'full'
    if all(status in {'M', 'A', 'D'} and documentation(path) for status, path in changes):
        return 'docs'
    if any(status != 'M' or (path not in DEPENDENCY_FILES and not documentation(path))
           for status, path in changes):
        return 'full'
    changed = {path for _, path in changes}
    if 'bot/package-lock.json' not in changed:
        return 'full'
    try:
        original_manifest = updated_manifest = None
        if 'bot/package.json' in changed:
            original_manifest = load_json('bot/package.json', 'base')
            updated_manifest = load_json('bot/package.json', 'head')
            if not package_manifest_safe(original_manifest, updated_manifest):
                return 'full'
        if not lock_safe(load_json('bot/package-lock.json', 'base'),
                         load_json('bot/package-lock.json', 'head'),
                         old_manifest=original_manifest, new_manifest=updated_manifest):
            return 'full'
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        return 'full'
    return 'deps'


def git_output(*args):
    return subprocess.check_output(['git', *args])


def diff_changes(base, head):
    raw = git_output('diff', '--no-renames', '--name-status', '-z', base, head, '--')
    fields = raw.decode('utf-8', 'surrogateescape').split('\0')
    if fields[-1] == '':
        fields.pop()
    if len(fields) % 2:
        raise ValueError('unparseable name-status diff')
    return [(fields[i], fields[i + 1]) for i in range(0, len(fields), 2)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base')
    parser.add_argument('--head', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    # An unparseable diff must fail the required gate without launching a
    # potentially expensive full bench merely to diagnose CI input.
    mode = 'invalid'
    if args.base and re.fullmatch(r'[0-9a-f]{40}', args.base) and re.fullmatch(r'[0-9a-f]{40}', args.head):
        try:
            changes = diff_changes(args.base, args.head)
            def load(path, version):
                ref = args.base if version == 'base' else args.head
                return json.loads(git_output('show', f'{ref}:{path}'))
            mode = classify(changes, load)
            # A whitespace error on a reduced path still blocks the merge.
            if mode != 'full' and subprocess.run(
                    ['git', 'diff', '--check', args.base, args.head], check=False).returncode:
                mode = 'invalid'
            print(f'CI: {mode} ({len(changes)} fichier(s))', flush=True)
        except (subprocess.SubprocessError, OSError, ValueError) as exc:
            print(f'CI: classification fail-closed ({type(exc).__name__})', flush=True)
    with open(args.output, 'a', encoding='utf-8') as output:
        output.write(f'mode={mode}\n')


if __name__ == '__main__':
    main()
