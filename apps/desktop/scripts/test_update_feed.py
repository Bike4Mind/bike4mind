import base64
from datetime import datetime, timezone
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from update_feed import build_feed, change_notes, feed_version

SCRIPT = Path(__file__).with_name('update_feed.py')
BASE = 'https://example.test/owner/repo/releases/download/desktop-v1.2.3'
NOTES = '''# Desktop 1.2.3

Version selection: minor.

## Changes

- feat(desktop): add a thing ([commit](https://example.test/owner/repo/commit/abc))
- fix(desktop): it's fixed ([commit](https://example.test/owner/repo/commit/def))

## Installation

- not a change
'''


class UpdateFeedTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.dir = Path(self.temp.name)
        for arch in ('arm64', 'x64'):
            (self.dir / f'Bike4Mind-1.2.3-{arch}.zip').write_bytes(arch.encode() * 10)
        (self.dir / 'notes.md').write_text(NOTES)

    def tearDown(self):
        self.temp.cleanup()

    def run_script(self, *extra):
        return subprocess.run(
            [sys.executable, str(SCRIPT), '--installers', str(self.dir), '--version', '1.2.3',
             '--asset-base', BASE, '--notes', str(self.dir / 'notes.md'), '--signed', 'false',
             '--out', str(self.dir / 'feed' / 'latest-mac.yml'), *extra],
            check=True, capture_output=True, text=True)

    def test_change_notes_keep_only_change_bullets_without_links(self):
        self.assertEqual(change_notes(NOTES), "- feat(desktop): add a thing\n- fix(desktop): it's fixed")

    def test_feed_lists_both_arches_with_absolute_urls_and_checksums(self):
        feed = build_feed(self.dir, '1.2.3', BASE + '/', 'notes', True,
                          now=datetime(2026, 1, 2, tzinfo=timezone.utc))
        sha = base64.b64encode(hashlib.sha512(b'arm64' * 10).digest()).decode()
        self.assertIn(f"  - url: '{BASE}/Bike4Mind-1.2.3-arm64.zip'\n    sha512: '{sha}'\n    size: 50", feed)
        self.assertIn(f"  - url: '{BASE}/Bike4Mind-1.2.3-x64.zip'", feed)
        self.assertIn(f"path: '{BASE}/Bike4Mind-1.2.3-arm64.zip'\nsha512: '{sha}'", feed)
        self.assertIn(f"  x64: '{BASE}/Bike4Mind-1.2.3-x64.dmg'", feed)
        self.assertIn("releaseDate: '2026-01-02T00:00:00.000Z'", feed)
        self.assertIn('signed: true', feed)
        self.assertEqual(feed_version(feed), (1, 2, 3))

    def test_missing_zip_fails(self):
        (self.dir / 'Bike4Mind-1.2.3-x64.zip').unlink()
        with self.assertRaises(SystemExit):
            build_feed(self.dir, '1.2.3', BASE, '', False)

    def test_writes_feed_with_notes_block(self):
        self.run_script()
        feed = (self.dir / 'feed' / 'latest-mac.yml').read_text()
        self.assertIn("version: '1.2.3'", feed)
        self.assertIn('signed: false', feed)
        self.assertIn("releaseNotes: |-\n  - feat(desktop): add a thing\n  - fix(desktop): it's fixed\n", feed)

    def test_refuses_to_roll_the_feed_back(self):
        (self.dir / 'previous.yml').write_text("version: '1.10.0'\n")
        result = self.run_script('--previous', str(self.dir / 'previous.yml'))
        self.assertFalse((self.dir / 'feed' / 'latest-mac.yml').exists())
        self.assertIn('leaving it', result.stdout)

    def test_leaves_a_feed_that_already_names_this_version(self):
        (self.dir / 'previous.yml').write_text("version: '1.2.3'\n")
        self.run_script('--previous', str(self.dir / 'previous.yml'))
        self.assertFalse((self.dir / 'feed' / 'latest-mac.yml').exists())

    def test_older_previous_is_replaced(self):
        (self.dir / 'previous.yml').write_text("version: '1.2.2'\n")
        self.run_script('--previous', str(self.dir / 'previous.yml'), '--signed', 'true')
        self.assertIn('signed: true', (self.dir / 'feed' / 'latest-mac.yml').read_text())


if __name__ == '__main__':
    unittest.main()
