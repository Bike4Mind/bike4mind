"""Compare desktop workspace and resolved dependency inputs across Git revisions."""

import json
from functools import lru_cache
import posixpath
import subprocess

import yaml

TOOLS = {'turbo', 'typescript', 'esbuild', '@types/node', '@typescript/native-preview',
         '@tsconfig/node24', 'vitest', 'husky'}
GROUPS = ('dependencies', 'devDependencies', 'optionalDependencies')


def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()


def read(ref, path):
    result = subprocess.run(['git', 'show', f'{ref}:{path}'], capture_output=True, text=True)
    return result.stdout if result.returncode == 0 else None


@lru_cache(maxsize=256)
def parsed_blob(blob, is_yaml):
    raw = git('cat-file', 'blob', blob)
    value = yaml.load(raw, Loader=getattr(yaml, 'CSafeLoader', yaml.SafeLoader)) if is_yaml else json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError('Expected a mapping')
    return value


def document(ref, path):
    blob = git('rev-parse', f'{ref}:{path}')
    return parsed_blob(blob, path.endswith('.yaml'))


@lru_cache(maxsize=128)
def dependency_inputs(ref):
    paths = git('ls-tree', '-r', '--name-only', ref).splitlines()
    manifests = {}
    for path in paths:
        if path.endswith('/package.json') and path.count('/') == 2 and path.startswith(('apps/', 'packages/', 'b4m-core/')):
            manifest = document(ref, path)
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
        for group in (*GROUPS, 'peerDependencies'):
            for dep, version in manifest.get(group, {}).items():
                if dep in manifests:
                    pending.append(dep)
                elif str(version).startswith(('workspace:', 'link:')):
                    raise ValueError('Unresolved workspace dependency')
    if 'apps/desktop' not in roots:
        raise ValueError('Desktop workspace manifest missing')
    lock = document(ref, 'pnpm-lock.yaml')
    if str(lock.get('lockfileVersion')) != '9.0':
        raise ValueError('Unsupported lockfile version')
    for section in ('importers', 'snapshots', 'packages'):
        if not isinstance(lock.get(section), dict):
            raise ValueError('Missing lockfile section')
    if not roots.issubset(lock['importers']) or '.' not in lock['importers']:
        raise ValueError('Missing workspace importer')
    importers = {key: value for key, value in lock['importers'].items() if key in roots}
    root_importer = lock['importers']['.']
    importers['.'] = {group: {key: value for key, value in deps.items() if key in TOOLS}
                      for group, deps in root_importer.items() if isinstance(deps, dict)}
    snapshots = lock.get('snapshots', {})
    packages = lock.get('packages', {})
    reachable = set()
    queue = []

    def enqueue(deps):
        if not isinstance(deps, dict):
            raise ValueError('Invalid dependency mapping')
        for name, value in deps.items():
            version = value.get('version', '') if isinstance(value, dict) else str(value)
            if not isinstance(version, str) or not version:
                raise ValueError('Missing resolved version')
            if not version.startswith(('link:', 'workspace:')):
                queue.append(version[4:] if version.startswith('npm:') else f'{name}@{version}')

    for importer in importers.values():
        for group in GROUPS:
            enqueue(importer.get(group, {}))
    while queue:
        key = queue.pop()
        if key in reachable:
            continue
        reachable.add(key)
        if key not in snapshots or key.split('(')[0] not in packages:
            raise ValueError('Missing resolved dependency')
        snapshot = snapshots[key]
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
    root = document(ref, 'package.json')
    tooling = {key: root.get(key) for key in ('packageManager', 'engines', 'pnpm', 'overrides')}
    tooling['scripts'] = {key: value for key, value in root.get('scripts', {}).items()
                          if key in ('prepare', 'core:build', 'turbo:core:build')}
    tooling['dependencies'] = {group: {key: value for key, value in root.get(group, {}).items()
                                      if key in TOOLS} for group in GROUPS}
    return roots, selected, tooling


def affected(base, head):
    # Missing historical inputs cannot safely establish that a build is unaffected.
    try:
        base, head = git('rev-parse', '--verify', f'{base}^{{commit}}'), git('rev-parse', '--verify', f'{head}^{{commit}}')
        paths = git('diff', '--name-only', base, head).splitlines()
        if not paths:
            return False
        old_roots, old_lock, old_tooling = dependency_inputs(base)
        new_roots, new_lock, new_tooling = dependency_inputs(head)
    except (ValueError, TypeError, AttributeError, subprocess.CalledProcessError, yaml.YAMLError):
        return True
    roots = old_roots | new_roots
    for path in paths:
        if path.endswith(('.md', '.mdx')):
            continue
        if any(path.startswith(folder + '/') for folder in roots):
            return True
        if path.startswith(('scripts/desktop_', 'scripts/test_desktop_', '.github/workflows/desktop-release.')):
            return True
        if path in ('pnpm-workspace.yaml', 'turbo.json', '.npmrc', 'vitest.shared.ts'):
            return True
        if path.startswith('patches/'):
            # A patch can be configured by either side's workspace config.
            if any(path in (read(ref, 'pnpm-workspace.yaml') or '') for ref in (base, head)):
                return True
    return old_lock != new_lock or old_tooling != new_tooling


def commit_affected(sha):
    parents = git('rev-list', '--parents', '-n', '1', sha).split()
    return affected(parents[1], sha) if len(parents) > 1 else True
