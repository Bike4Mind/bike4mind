import base64
import hashlib
from pathlib import Path
import tempfile
import unittest

import yaml

from distribution import assemble, feed_url


class DistributionTest(unittest.TestCase):
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
                (root / f'Bike4Mind-0.2.2-{suffix}').write_bytes(suffix.encode())
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
            assemble(root, '0.2.2', 'owner/dist', 'owner/source')
            self.assertEqual((root / 'SHA256SUMS.txt').read_text(), original)
            (root / 'Bike4Mind-0.2.2-arm64.zip').write_bytes(b'')
            with self.assertRaises(ValueError):
                assemble(root, '0.2.2', 'owner/dist', 'owner/source')
