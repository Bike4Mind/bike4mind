"""Select desktop SemVer from release tags and first-parent commits that affect desktop inputs."""

import json
import os
from pathlib import Path
import posixpath
import re
import subprocess
from functools import lru_cache
from desktop_affected import affected, commit_affected, read


VERSION = re.compile(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)')
# Retain the accidental release tag, but resume the beta line from its last 0.x release.
WITHDRAWN_BASELINES = {'desktop-v1.0.0'}
WITHDRAWN_SOURCE_RELEASES = {'desktop-v0.4.0', 'desktop-v0.5.0'}


def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()


def bump_level(message):
    header = message.splitlines()[0]
    match = re.match(r'([a-z]+)(?:\([^\n)]+\))?(!)?: .+', header)
    if (match and match[2]) or re.search(r'^BREAKING[ -]CHANGE: ', message, re.M):
        return 3
    if match and match[1] == 'feat':
        return 2
    if match and match[1] in {'docs', 'test', 'ci', 'style'}:
        return 0
    return 1


@lru_cache(maxsize=128)
def shared_note_inputs(ref):
    paths = set(git('ls-tree', '-r', '--name-only', ref).splitlines())
    manifests = {}
    for path in paths:
        if path.endswith('/package.json') and path.count('/') == 2 and path.startswith(('apps/', 'packages/', 'b4m-core/')):
            manifest = json.loads(read(ref, path) or '{}')
            manifests[manifest.get('name', path)] = posixpath.dirname(path)
    pending = []
    for path in paths:
        if path.startswith('apps/desktop/src/') and path.endswith(('.ts', '.tsx')) and not path.endswith(('.test.ts', '.test.tsx')):
            source = read(ref, path) or ''
            for specifier in re.findall(r'''(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](@bike4mind/[^'"]+)['"]''', source):
                parts = specifier.split('/')
                folder = manifests.get('/'.join(parts[:2]))
                if not folder:
                    continue
                if len(parts) == 2:
                    # Bare imports expose a package barrel; retain its source conservatively.
                    pending.extend(p for p in paths if p.startswith(folder + '/src/'))
                else:
                    target = folder + '/src/' + '/'.join(parts[2:])
                    pending.extend(p for p in (target + '.ts', target + '.tsx', target + '/index.ts') if p in paths)
    reachable = set()
    while pending:
        path = pending.pop()
        if path in reachable or path not in paths:
            continue
        reachable.add(path)
        source = read(ref, path) or ''
        for specifier in re.findall(r'''(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](\.[^'"]+)['"]''', source):
            target = posixpath.normpath(posixpath.join(posixpath.dirname(path), specifier))
            if target.endswith('.js'):
                target = target[:-3]
            for candidate in (target, target + '.ts', target + '.tsx', target + '/index.ts'):
                if candidate in paths:
                    pending.append(candidate)
                    break
    return reachable


def note_relevant(sha):
    parents = git('rev-list', '--parents', '-n', '1', sha).split()
    paths = git('diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '--no-renames',
                *([parents[1], sha] if len(parents) > 1 else [sha])).splitlines()
    shared = shared_note_inputs(sha)
    if len(parents) > 1:
        shared = shared | shared_note_inputs(parents[1])
    for path in paths:
        if (path.endswith(('.md', '.mdx', '.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx'))
                or '/__tests__/' in path or '/__fixtures__/' in path
                or posixpath.basename(path) == 'package.json'):
            continue
        if path.startswith(('apps/desktop/src/', 'apps/desktop/resources/')) or path in shared:
            return True
        if path.startswith('apps/desktop/') and not posixpath.basename(path).startswith(('test_', 'test.', 'vitest.')):
            return True
    return False


def release_notes(version, previous, repository, destination):
    changes = []
    revisions = git('rev-list', '--first-parent', f'{previous}..HEAD') if previous else git('rev-list', '-n', '1', 'HEAD')
    for sha in revisions.splitlines():
        if commit_affected(sha):
            message = git('show', '-s', '--format=%B', sha)
            changes.append((sha, message.splitlines()[0], bump_level(message)))
    reason = ['no semantic bump', 'patch', 'minor', 'major'][max((c[2] for c in changes), default=0)]
    if version.startswith('0.') and reason == 'major':
        reason = 'minor (breaking beta change)'
    if not previous:
        reason = 'initial package baseline'
    lines = [f'# Desktop {version}', '', f'Version selection: {reason}.', '', '## Changes', '']
    visible = [(sha, subject) for sha, subject, _ in changes
               if not re.match(r'(?:docs|test|ci|style|chore\(release\))(?:\(|:|!)', subject)
               and note_relevant(sha)]
    lines.extend(f'- {subject} ([`{sha[:7]}`](https://github.com/{repository}/commit/{sha}))'
                 for sha, subject in visible)
    if not visible:
        lines.append('- Maintenance release; no desktop-facing changes.')
    lines.extend(['', '## Installation', '',
                  'Run this in a terminal on macOS (Apple Silicon) or Linux (x64); rerun it to update:', '',
                  f'    curl -fsSL https://github.com/{destination}/releases/latest/download/install.sh | sh', '',
                  'Or download arm64.dmg for Apple Silicon or x64.AppImage for Linux. Intel Mac builds are temporarily paused.',
                  'SHA256SUMS.txt contains installer and update metadata checksums.',
                  'In-app updates require an installed build configured with this feed. Older unsigned macOS builds require a manual signed installation.', ''])
    return '\n'.join(lines)


def select_version(releases, baseline, preview='', title='', run=''):
    if not VERSION.fullmatch(baseline) or not baseline.startswith('0.'):
        raise ValueError('Desktop baseline must be beta SemVer (0.minor.patch)')
    candidates = []
    for release in releases:
        tag = release['tag_name']
        match = re.fullmatch(r'desktop-v(' + VERSION.pattern + r')', tag)
        if match and not release['prerelease'] and tag not in WITHDRAWN_BASELINES:
            if not match[1].startswith('0.'):
                raise ValueError('Major desktop releases require an explicit beta policy change')
            candidates.append((tuple(map(int, match[1].split('.'))), tag, release))
    head = git('rev-parse', 'HEAD')
    previous = ''
    if candidates:
        parts, previous, release = max(candidates, key=lambda candidate: (candidate[0], bool(candidate[2].get('draft'))))
        target = release['target_commitish'] if release.get('draft') else previous
        released_sha = git('rev-parse', f'{target}^{{commit}}')
        if release.get('draft'):
            # Draft releases do not create a tag ref until publication.
            previous = released_sha
        # Never reuse a version for a different commit or release an older checkout.
        subprocess.run(['git', 'merge-base', '--is-ancestor', released_sha, head], check=True)
        if released_sha == head and not preview:
            return '.'.join(map(str, parts)), not release.get('withdrawn', False), previous
        if release.get('draft') and not preview:
            raise ValueError('Finish or remove the pending desktop draft release before publishing another commit')
        revision_range = f'{released_sha}..HEAD'
    else:
        parts = tuple(map(int, baseline.split('.')))
        revision_range = 'HEAD'

    level = 0
    if candidates:
        for sha in git('rev-list', '--first-parent', revision_range).splitlines():
            if commit_affected(sha):
                message = title if preview and sha == head else git('show', '-s', '--format=%B', sha)
                level = max(level, bump_level(message))
        major, minor, patch = parts
        if level >= 2:
            parts = (major, minor + 1, 0)
        elif level == 1:
            parts = (major, minor, patch + 1)
        # A withdrawn release (marked prerelease) is not a baseline, but its tag still holds the version.
        occupied = {release['tag_name'] for release in releases}
        while level and f'desktop-v{".".join(map(str, parts))}' in occupied:
            parts = (parts[0], parts[1], parts[2] + 1)

    version = '.'.join(map(str, parts))
    if preview:
        if not re.fullmatch(r'[1-9]\d*', preview) or not re.fullmatch(r'[1-9]\d*', run):
            raise ValueError('Preview requires numeric PR and run numbers')
        version += f'-pr.{preview}.{run}'
    return version, bool(preview or not candidates or level), previous


def with_reservations(releases, source_tags):
    known = {release['tag_name'] for release in releases}
    for tag in source_tags:
        if tag not in known and re.fullmatch(r'desktop-v(' + VERSION.pattern + r')', tag):
            withdrawn = tag in WITHDRAWN_SOURCE_RELEASES
            releases.append({'tag_name': tag, 'prerelease': False, 'draft': not withdrawn,
                             'withdrawn': withdrawn,
                             'target_commitish': git('rev-parse', f'{tag}^{{commit}}')})
    return releases


def main():
    base = os.environ.get('CHANGE_BASE', '')
    if base and not affected(base, 'HEAD'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            output.write('release=false\n')
        print('No desktop dependency inputs changed; skipping packaging and publication.')
        return
    pages = json.loads(subprocess.check_output([
        'gh', 'api', '--paginate', '--slurp',
        f'repos/{os.environ["GITHUB_REPOSITORY"]}/releases?per_page=100',
    ], text=True))
    releases = [release for page in pages for release in page]
    # Source tags retain source ancestry while distribution tags belong to a separate repository.
    source_tags = git('tag', '--list', 'desktop-v*').splitlines()
    destination = os.environ['DESKTOP_RELEASE_REPOSITORY']
    if not destination or destination.lower() == os.environ['GITHUB_REPOSITORY'].lower():
        raise ValueError('A separate distribution repository is required')
    pages = json.loads(subprocess.check_output([
        'gh', 'api', '--paginate', '--slurp', f'repos/{destination}/releases?per_page=100',
    ], text=True))
    for page in pages:
        for release in page:
            if not re.fullmatch(r'desktop-v(' + VERSION.pattern + r')', release['tag_name']):
                continue
            # Missing source reservations are an error, never a fresh baseline.
            release['target_commitish'] = git('rev-parse', f'{release["tag_name"]}^{{commit}}')
            releases.append(release)
    releases = with_reservations(releases, source_tags)
    baseline = json.loads(Path('apps/desktop/package.json').read_text())['version']
    version, publish, previous = select_version(
        releases, baseline, os.environ.get('PR_NUMBER', ''),
        os.environ.get('PR_TITLE', ''), os.environ.get('GITHUB_RUN_NUMBER', ''),
    )
    result = f'version={version}\nrelease={str(publish).lower()}\nprevious={previous}\n'
    Path('desktop-release-notes.md').write_text(
        release_notes(version, previous, os.environ['GITHUB_REPOSITORY'], destination))
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write(result)
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
        summary.write(f'Desktop version: `{version}`. Build required: `{publish}`.\n')
    print(result)


if __name__ == '__main__':
    main()
