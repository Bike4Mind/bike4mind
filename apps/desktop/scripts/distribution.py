"""Validate the distribution boundary and assemble a complete generic update feed."""

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import zlib

import yaml


def feed_url(repository, source):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9][A-Za-z0-9_.-]*', repository):
        raise ValueError('DESKTOP_RELEASE_REPOSITORY must be owner/repo')
    if repository.lower() == source.lower():
        raise ValueError('Distribution must not use the source repository')
    if repository.split('/')[0].lower() != source.split('/')[0].lower():
        raise ValueError('Distribution must be in the source organization')
    return f'https://github.com/{repository}/releases/latest/download/'


def embedded_blockmap_size(payload):
    size = int.from_bytes(payload[-4:], 'big')
    if len(payload) < 5 or not 0 < size < len(payload) - 4:
        raise ValueError('Invalid embedded AppImage blockmap length')
    try:
        decoder = zlib.decompressobj(-15)
        decoded = decoder.decompress(payload[-size - 4:-4], 16 * 1024 * 1024)
        if not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
            raise ValueError('Invalid embedded AppImage blockmap compression')
        blockmap = json.loads(decoded)
        if blockmap['version'] != '2' or not blockmap['files']:
            raise ValueError('Unsupported embedded AppImage blockmap')
        end = 0
        for file in blockmap['files']:
            sizes, checksums = file['sizes'], file['checksums']
            if (not sizes or len(sizes) != len(checksums)
                    or any(type(value) is not int or value <= 0 for value in sizes)
                    or any(not isinstance(value, str) or not value for value in checksums)
                    or type(file['offset']) is not int or file['offset'] != end):
                raise ValueError('Invalid embedded AppImage blockmap entries')
            end = file['offset'] + sum(sizes)
        if end != len(payload) - size - 4:
            raise ValueError('Embedded AppImage blockmap does not cover payload')
    except (zlib.error, json.JSONDecodeError, UnicodeDecodeError, KeyError, TypeError) as error:
        raise ValueError('Invalid embedded AppImage blockmap') from error
    return size


def verify_linux(folder):
    folder = Path(folder)
    manifests = sorted(folder.glob('*-linux.yml'))
    if not manifests:
        raise ValueError('Missing builder Linux update metadata')
    for manifest_path in manifests:
        manifest = yaml.safe_load(manifest_path.read_text())
        entry = next(file for file in manifest['files'] if file['url'].endswith('.AppImage'))
        payload = (folder / Path(entry['url']).name).read_bytes()
        expected = {'size': len(payload), 'sha512': base64.b64encode(hashlib.sha512(payload).digest()).decode(),
                    'blockMapSize': embedded_blockmap_size(payload)}
        if any(entry.get(key) != value for key, value in expected.items()):
            raise ValueError('Builder Linux metadata differs from embedded AppImage metadata')


def assemble(folder, version, repository, source, mac_mode='signed'):
    if mac_mode not in ('signed', 'adhoc'):
        raise ValueError('Invalid macOS release mode')
    feed_url(repository, source)
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-pr\.\d+\.\d+)?', version):
        raise ValueError('Invalid desktop version')
    folder = Path(folder)
    dmg = f'Bike4Mind-{version}-arm64.dmg'
    zip_name = f'Bike4Mind-{version}-arm64.zip'
    image = f'Bike4Mind-{version}-x64.AppImage'
    exe = f'Bike4Mind-{version}-setup.exe'
    # The mac and Windows updaters download the zip and exe blockmaps; the dmg blockmap is never read and the AppImage embeds its own.
    required = ({dmg, image, exe, exe + '.blockmap', 'install.sh'}
                | (set() if mac_mode == 'adhoc' else {zip_name, zip_name + '.blockmap'}))
    unpublished = {zip_name, zip_name + '.blockmap', dmg + '.blockmap', image + '.blockmap'} - required
    manifests = {'latest-mac.yml', 'latest-linux.yml', 'latest.yml', 'SHA256SUMS.txt'}
    actual = {p.name for p in folder.iterdir()}
    if not required <= actual or actual - required - unpublished - manifests:
        raise ValueError(f'Incomplete or unexpected distribution assets: {sorted(actual)}')
    for name in actual & unpublished:
        (folder / name).unlink()
    assets = sorted(required)
    if any(not (folder / name).is_file() or (folder / name).is_symlink()
           or (folder / name).stat().st_size == 0 for name in assets):
        raise ValueError('Empty or invalid distribution asset')
    # Pin payloads to this tag so a later Latest switch cannot invalidate an offered update.
    base = f'https://github.com/{repository}/releases/download/desktop-v{version}/'
    # electron-updater reads latest.yml on Windows, with no platform suffix.
    for manifest, names in [('latest-mac.yml', [zip_name, dmg]), ('latest-linux.yml', [image]), ('latest.yml', [exe])]:
        if manifest == 'latest-mac.yml' and mac_mode == 'adhoc':
            (folder / manifest).unlink(missing_ok=True)
            continue
        files = []
        for name in names:
            payload = (folder / name).read_bytes()
            files.append({'url': base + name, 'sha512': base64.b64encode(hashlib.sha512(payload).digest()).decode(),
                          'size': len(payload)})
            if name == image:
                files[-1]['blockMapSize'] = embedded_blockmap_size(payload)
        document = {'version': version, 'files': files, 'path': files[0]['url'], 'sha512': files[0]['sha512']}
        (folder / manifest).write_text(yaml.safe_dump(document, sort_keys=False))
    checksummed = sorted(assets + ['latest-linux.yml', 'latest.yml'] + (['latest-mac.yml'] if mac_mode == 'signed' else []))
    (folder / 'SHA256SUMS.txt').write_text(''.join(
        f'{hashlib.sha256((folder / name).read_bytes()).hexdigest()}  {name}\n' for name in checksummed))


def prune(folder):
    """Drop build outputs that the assembled checksum list does not publish."""
    folder = Path(folder)
    keep = {line.split('  ', 1)[1] for line in (folder / 'SHA256SUMS.txt').read_text().splitlines() if line}
    for path in folder.iterdir():
        if path.name != 'SHA256SUMS.txt' and path.name not in keep:
            path.unlink()


if __name__ == '__main__':
    repository = os.environ.get('DESKTOP_RELEASE_REPOSITORY', '')
    source = os.environ['GITHUB_REPOSITORY']
    if sys.argv[1] == 'verify-linux':
        verify_linux(sys.argv[2])
        print('Builder Linux metadata matches embedded AppImage metadata')
    elif sys.argv[1] == 'prune':
        prune(sys.argv[2])
    elif sys.argv[1] == 'feed':
        url = feed_url(repository, source)
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            output.write(f'feed={url}\n')
            output.write(f'repository-name={repository.split("/")[1]}\n')
    else:
        assemble(sys.argv[1], os.environ['DESKTOP_VERSION'], repository, source, os.environ['MAC_RELEASE_MODE'])
