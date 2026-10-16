import base64
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import zlib

import yaml

from distribution import assemble, embedded_blockmap_size, feed_url, verify_linux


def appimage(payload=b'AppImage fixture'):
    blockmap = {'version': '2', 'files': [{'name': 'file', 'offset': 0,
                'sizes': [len(payload)], 'checksums': ['fixture-checksum']}]}
    compressor = zlib.compressobj(wbits=-15)
    compressed = compressor.compress(json.dumps(blockmap).encode()) + compressor.flush()
    return payload + compressed + len(compressed).to_bytes(4, 'big')


class DistributionTest(unittest.TestCase):
    def test_builder_metadata_comparison_allows_exact_match_and_denies_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = appimage()
            (root / 'test.AppImage').write_bytes(payload)
            entry = {'url': 'test.AppImage', 'size': len(payload),
                     'sha512': base64.b64encode(hashlib.sha512(payload).digest()).decode(),
                     'blockMapSize': int.from_bytes(payload[-4:], 'big')}
            manifest = root / 'latest-linux.yml'
            manifest.write_text(yaml.safe_dump({'files': [entry]}))
            verify_linux(root)
            preview = root / 'pr-linux.yml'
            manifest.rename(preview)
            verify_linux(root)
            preview.unlink()
            with self.assertRaisesRegex(ValueError, 'Missing builder Linux'):
                verify_linux(root)
            preview.write_text(yaml.safe_dump({'files': [entry]}))
            for key in ('size', 'sha512', 'blockMapSize'):
                with self.subTest(key=key):
                    wrong = {**entry, key: 'incorrect'}
                    manifest.write_text(yaml.safe_dump({'files': [wrong]}))
                    with self.assertRaises(ValueError):
                        verify_linux(root)
                    missing = {name: value for name, value in entry.items() if name != key}
                    manifest.write_text(yaml.safe_dump({'files': [missing]}))
                    with self.assertRaises(ValueError):
                        verify_linux(root)

    def test_invalid_embedded_blockmaps_are_rejected(self):
        for payload in (b'', b'bad', b'data' + bytes(4), b'data' + (999).to_bytes(4, 'big'),
                        b'not deflated' + (4).to_bytes(4, 'big'), appimage()[:-5] + appimage()[-4:],
                        b'extra' + appimage()):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                embedded_blockmap_size(payload)

    def test_destination_gate(self):
        for value in ('', 'source/repo', 'SOURCE/REPO', 'owner/', '../repo', 'other/distribution', 'https://github.com/o/r'):
            with self.assertRaises(ValueError):
                feed_url(value, 'source/repo')
        self.assertEqual(feed_url('owner/dist', 'owner/source'),
                         'https://github.com/owner/dist/releases/latest/download/')

    def test_manifests_pin_payloads_and_hash_actual_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for suffix in ('arm64.dmg', 'arm64.zip', 'arm64.zip.blockmap', 'x64.AppImage'):
                (root / f'Bike4Mind-0.2.2-{suffix}').write_bytes(appimage() if suffix == 'x64.AppImage' else suffix.encode())
            assemble(root, '0.2.2', 'owner/dist', 'owner/source')
            original = (root / 'SHA256SUMS.txt').read_text()
            for platform in ('mac', 'linux'):
                manifest = yaml.safe_load((root / f'latest-{platform}.yml').read_text())
                self.assertEqual(manifest['version'], '0.2.2')
                for file in manifest['files']:
                    self.assertTrue(file['url'].startswith('https://github.com/owner/dist/releases/download/desktop-v0.2.2/'))
                    payload = (root / file['url'].split('/')[-1]).read_bytes()
                    self.assertEqual(file['size'], len(payload))
                    self.assertEqual(file['sha512'], base64.b64encode(hashlib.sha512(payload).digest()).decode())
                    if platform == 'linux':
                        self.assertEqual(file['blockMapSize'], int.from_bytes(payload[-4:], 'big'))
                    else:
                        self.assertNotIn('blockMapSize', file)
            assemble(root, '0.2.2', 'owner/dist', 'owner/source')
            self.assertEqual((root / 'SHA256SUMS.txt').read_text(), original)
            assemble(root, '0.2.2', 'owner/dist', 'owner/source', 'adhoc')
            self.assertFalse((root / 'latest-mac.yml').exists())
            self.assertTrue((root / 'latest-linux.yml').exists())
            self.assertNotIn('latest-mac.yml', (root / 'SHA256SUMS.txt').read_text())
            self.assertTrue((root / 'Bike4Mind-0.2.2-arm64.dmg').exists())
            with self.assertRaises(ValueError):
                assemble(root, '0.2.2', 'owner/dist', 'owner/source', '')
            (root / 'Bike4Mind-0.2.2-arm64.zip').write_bytes(b'')
            with self.assertRaises(ValueError):
                assemble(root, '0.2.2', 'owner/dist', 'owner/source')
