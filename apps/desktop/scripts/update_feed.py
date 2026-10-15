"""Write the electron-updater feed (latest-mac.yml) for one published desktop release.

The app reads this from a fixed URL, the `desktop-feed` release, because GitHub has no stable
URL for "the newest desktop-v* release": /releases/latest is repo-wide and these releases are
published with --latest=false. Every file URL in the feed is absolute, pointing at the
versioned release that actually holds the installers.

Prints the reason and writes nothing when the feed already names this version or a newer one,
so a rerun can neither roll installed apps back nor rewrite a feed they are already reading.
"""

import argparse
import base64
from datetime import datetime, timezone
import hashlib
from pathlib import Path
import re


VERSION = re.compile(r'(\d+)\.(\d+)\.(\d+)')
ARCHES = ('arm64', 'x64')


def parse_version(text):
    match = VERSION.match(text.strip().strip('\'"'))
    return tuple(map(int, match.groups())) if match else None


def feed_version(feed_text):
    match = re.search(r'^version:\s*(.+)$', feed_text, re.M)
    return parse_version(match[1]) if match else None


def change_notes(markdown):
    """The bullets under `## Changes`, without the commit links the release page carries."""
    lines, inside = [], False
    for line in markdown.splitlines():
        if line.startswith('## '):
            inside = line.strip() == '## Changes'
            continue
        if inside and line.startswith('- '):
            lines.append(re.sub(r'\s*\(\[commit\]\([^)]*\)\)\s*$', '', line))
    return '\n'.join(lines)


def quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def digest(path):
    sha = hashlib.sha512()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b''):
            sha.update(chunk)
    return base64.b64encode(sha.digest()).decode()


def build_feed(installers, version, asset_base, notes, signed, now=None):
    base = asset_base.rstrip('/') + '/'
    zips, dmgs = {}, {}
    for arch in ARCHES:
        zip_path = Path(installers) / f'Bike4Mind-{version}-{arch}.zip'
        if not zip_path.is_file():
            raise SystemExit(f'Missing {zip_path.name}')
        zips[arch] = (base + zip_path.name, digest(zip_path), zip_path.stat().st_size)
        dmgs[arch] = base + f'Bike4Mind-{version}-{arch}.dmg'

    released = (now or datetime.now(timezone.utc)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    lines = [f'version: {quote(version)}', 'files:']
    for url, sha512, size in zips.values():
        lines += [f'  - url: {quote(url)}', f'    sha512: {quote(sha512)}', f'    size: {size}']
    # Top-level path/sha512 are the legacy single-file fields; arm64 is the primary build.
    lines += [
        f'path: {quote(zips["arm64"][0])}',
        f'sha512: {quote(zips["arm64"][1])}',
        f'releaseDate: {quote(released)}',
        # Read by the app, not by electron-updater: an unsigned release cannot be installed by
        # Squirrel.Mac, so the app offers the installer download instead.
        f'signed: {"true" if signed else "false"}',
        'installers:',
        *(f'  {arch}: {quote(url)}' for arch, url in dmgs.items()),
    ]
    if notes:
        lines.append('releaseNotes: |-')
        lines += [f'  {line}' if line else '' for line in notes.splitlines()]
    return '\n'.join(lines) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--installers', required=True, help='Directory holding the release zips')
    parser.add_argument('--version', required=True)
    parser.add_argument('--asset-base', required=True, help='URL the versioned release serves its assets from')
    parser.add_argument('--notes', help='Release notes markdown with a "## Changes" section')
    parser.add_argument('--signed', choices=('true', 'false'), required=True)
    parser.add_argument('--previous', help='The feed currently published, if any')
    parser.add_argument('--out', required=True)
    args = parser.parse_args()

    new = parse_version(args.version)
    if new is None:
        raise SystemExit(f'Not a release version: {args.version}')
    previous = Path(args.previous) if args.previous else None
    if previous and previous.is_file():
        current = feed_version(previous.read_text())
        if current and current >= new:
            print(f'Feed already offers {".".join(map(str, current))}; leaving it for {args.version}.')
            return

    notes = change_notes(Path(args.notes).read_text()) if args.notes else ''
    feed = build_feed(args.installers, args.version, args.asset_base, notes, args.signed == 'true')
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(feed)
    print(feed)


if __name__ == '__main__':
    main()
