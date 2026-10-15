"""Compare desktop workspace and resolved dependency inputs across Git revisions."""

import json
from functools import lru_cache
import posixpath
import subprocess

import yaml


def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()


def read(ref, path):
    result = subprocess.run(['git', 'show', f'{ref}:{path}'], capture_output=True, text=True)
    return result.stdout if result.returncode == 0 else None


@lru_cache(maxsize=128)
def dependency_inputs(ref):
    paths = git('ls-tree', '-r', '--name-only', ref).splitlines()
    manifests = {}
    for path in paths:
        if path.endswith('/package.json') and path.count('/') == 2 and path.startswith(('apps/', 'packages/', 'b4m-core/')):
            manifest = json.loads(read(ref, path))
            manifests[manifest.get('name', path)] = (posixpath.dirname(path), manifest)
    roots = set()
    pending = ['@bike4mind/desktop']
    while pending:
        name = pending.pop()
        if name not in manifests:
            continue
        folder, manifest = manifests[name]
        if folder in roots:
            continue
        roots.add(folder)
        for group in ('dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'):
            pending.extend(dep for dep in manifest.get(group, {}) if dep in manifests)
    if 'apps/desktop' not in roots:
        raise ValueError('Desktop workspace manifest missing')
    raw = read(ref, 'pnpm-lock.yaml')
    lock = yaml.safe_load(raw) if raw else {}
    if not isinstance(lock, dict):
        raise ValueError('Invalid lockfile')
    importers = {key: value for key, value in lock.get('importers', {}).items() if key in roots}
    tools = {'turbo', 'typescript', 'esbuild', '@types/node', '@typescript/native-preview'}
    root_importer = lock.get('importers', {}).get('.', {})
    importers['.'] = {group: {key: value for key, value in deps.items() if key in tools}
                      for group, deps in root_importer.items() if isinstance(deps, dict)}
    snapshots = lock.get('snapshots', {})
    packages = lock.get('packages', {})
    reachable = set()
    queue = []

    def enqueue(deps):
        for name, value in deps.items():
            version = value.get('version', '') if isinstance(value, dict) else str(value)
            if not version.startswith(('link:', 'workspace:')):
                queue.append(f'{name}@{version}')

    for importer in importers.values():
        for group in ('dependencies', 'devDependencies', 'optionalDependencies'):
            enqueue(importer.get(group, {}))
    while queue:
        key = queue.pop()
        if key in reachable:
            continue
        reachable.add(key)
        snapshot = snapshots.get(key, {})
        for group in ('dependencies', 'optionalDependencies'):
            enqueue(snapshot.get(group, {}))
    selected = {
        'importers': importers,
        'snapshots': {key: snapshots.get(key) for key in reachable},
        'packages': {key.split('(')[0]: packages.get(key.split('(')[0]) for key in reachable},
        'settings': lock.get('settings'),
        'overrides': lock.get('overrides'),
        'patchedDependencies': lock.get('patchedDependencies'),
    }
    root = json.loads(read(ref, 'package.json') or '{}')
    tooling = {key: root.get(key) for key in ('packageManager', 'engines', 'pnpm', 'overrides')}
    tooling['scripts'] = {key: value for key, value in root.get('scripts', {}).items()
                          if key in ('prepare', 'core:build', 'turbo:core:build')}
    tooling['devDependencies'] = {key: value for key, value in root.get('devDependencies', {}).items()
                                 if key in ('turbo', 'typescript', 'esbuild', '@types/node', '@typescript/native-preview')}
    return roots, selected, tooling


def affected(base, head):
    base, head = git('rev-parse', base), git('rev-parse', head)
    paths = git('diff', '--name-only', base, head).splitlines()
    if not paths:
        return False
    # Missing historical inputs cannot safely establish that a build is unaffected.
    try:
        old_roots, old_lock, old_tooling = dependency_inputs(base)
        new_roots, new_lock, new_tooling = dependency_inputs(head)
    except (ValueError, TypeError, yaml.YAMLError):
        return True
    roots = old_roots | new_roots
    for path in paths:
        if any(path.startswith(folder + '/') for folder in roots):
            return True
        if path.startswith(('scripts/desktop_', '.github/workflows/desktop-release.')):
            return True
        if path in ('pnpm-workspace.yaml', 'turbo.json', '.npmrc'):
            return True
        if path.startswith('patches/'):
            # A patch can be configured by either side's workspace config.
            if any(path in (read(ref, 'pnpm-workspace.yaml') or '') for ref in (base, head)):
                return True
    return old_lock != new_lock or old_tooling != new_tooling


def commit_affected(sha):
    parents = git('rev-list', '--parents', '-n', '1', sha).split()
    return affected(parents[1], sha) if len(parents) > 1 else True
