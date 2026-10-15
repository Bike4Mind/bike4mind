"""Select desktop SemVer from release tags and desktop-relevant first-parent commits."""

import json
import os
from pathlib import Path
import re
import subprocess


PATHS = (
    'apps/desktop/', 'b4m-core/', 'packages/cli/', 'packages/database/',
    'packages/sdk/', 'packages/typescript-config/', 'patches/',
)
FILES = {
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'turbo.json', '.npmrc',
    '.github/workflows/desktop-release.yml', 'scripts/desktop_release_version.py',
    'scripts/test_desktop_release_version.py',
}
VERSION = re.compile(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)')


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


def relevant(path):
    return path in FILES or path.startswith(PATHS)


def select_version(releases, baseline, preview='', title='', run=''):
    if not VERSION.fullmatch(baseline):
        raise ValueError('Desktop baseline must be major.minor.patch')
    candidates = []
    for release in releases:
        tag = release['tag_name']
        match = re.fullmatch(r'desktop-v(' + VERSION.pattern + r')', tag)
        if match and not release['prerelease']:
            candidates.append((tuple(map(int, match[1].split('.'))), tag, release))
    head = git('rev-parse', 'HEAD')
    previous = ''
    if candidates:
        parts, previous, release = max(candidates, key=lambda candidate: candidate[0])
        target = release['target_commitish'] if release.get('draft') else previous
        released_sha = git('rev-parse', f'{target}^{{commit}}')
        # Never reuse a version for a different commit or release an older checkout.
        subprocess.run(['git', 'merge-base', '--is-ancestor', released_sha, head], check=True)
        if released_sha == head and not preview:
            return '.'.join(map(str, parts)), True, previous
        if release.get('draft') and not preview:
            raise ValueError('Finish or remove the pending desktop draft release before publishing another commit')
        revision_range = f'{released_sha}..HEAD'
    else:
        parts = tuple(map(int, baseline.split('.')))
        revision_range = 'HEAD'

    level = 0
    if candidates:
        for sha in git('rev-list', '--first-parent', revision_range).splitlines():
            parents = git('rev-list', '--parents', '-n', '1', sha).split()
            if len(parents) > 1:
                paths = git('diff', '--name-only', parents[1], sha).splitlines()
            else:
                paths = git('diff-tree', '--root', '--no-commit-id', '--name-only', '-r', sha).splitlines()
            if any(relevant(path) for path in paths):
                message = title if preview and sha == head else git('show', '-s', '--format=%B', sha)
                level = max(level, bump_level(message))
        major, minor, patch = parts
        if level == 3:
            parts = (major + 1, 0, 0)
        elif level == 2:
            parts = (major, minor + 1, 0)
        elif level == 1:
            parts = (major, minor, patch + 1)

    version = '.'.join(map(str, parts))
    if preview:
        if not re.fullmatch(r'[1-9]\d*', preview) or not re.fullmatch(r'[1-9]\d*', run):
            raise ValueError('Preview requires numeric PR and run numbers')
        version += f'-pr.{preview}.{run}'
    return version, bool(preview or not candidates or level), previous


def main():
    pages = json.loads(subprocess.check_output([
        'gh', 'api', '--paginate', '--slurp',
        f'repos/{os.environ["GITHUB_REPOSITORY"]}/releases?per_page=100',
    ], text=True))
    releases = [release for page in pages for release in page]
    baseline = json.loads(Path('apps/desktop/package.json').read_text())['version']
    version, publish, previous = select_version(
        releases, baseline, os.environ.get('PR_NUMBER', ''),
        os.environ.get('PR_TITLE', ''), os.environ.get('GITHUB_RUN_NUMBER', ''),
    )
    result = f'version={version}\nrelease={str(publish).lower()}\nprevious={previous}\n'
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write(result)
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
        summary.write(f'Desktop version: `{version}`. Build required: `{publish}`.\n')
    print(result)


if __name__ == '__main__':
    main()
