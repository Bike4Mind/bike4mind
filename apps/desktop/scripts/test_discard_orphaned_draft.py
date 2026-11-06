import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class DiscardOrphanedDraftTest(unittest.TestCase):
    def discard(self, releases, source='example/source', lookup_fails=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mock = root / 'gh'
            mock.write_text('''#!/usr/bin/env python3
import json, os, sys
with open(os.environ['CALLS'], 'a') as output: output.write(json.dumps(sys.argv[1:]) + '\\n')
if '--slurp' in sys.argv:
    if os.environ['LOOKUP_FAILS'] == 'true': sys.exit(1)
    print(os.environ['RELEASES'])
''')
            mock.chmod(0o755)
            calls_file = root / 'calls'
            result = subprocess.run(['python3', str(Path(__file__).with_name('discard-orphaned-draft.py'))],
                env={**os.environ, 'PATH': f'{root}{os.pathsep}{os.environ["PATH"]}',
                     'GH_REPO': 'example/dist', 'GITHUB_REPOSITORY': source, 'DESKTOP_VERSION': '0.2.0',
                     'RELEASES': json.dumps(releases), 'LOOKUP_FAILS': str(lookup_fails).lower(),
                     'CALLS': str(calls_file)}, capture_output=True, text=True)
            calls = [json.loads(line) for line in calls_file.read_text().splitlines()] if calls_file.exists() else []
            return result.returncode, [call[-1] for call in calls if call[:3] == ['api', '--method', 'DELETE']]

    def test_deletes_every_draft_of_the_reclaimed_version_only(self):
        releases = [[{'id': 1, 'tag_name': 'desktop-v0.2.0', 'draft': True, 'assets': []},
                     {'id': 2, 'tag_name': 'desktop-v0.1.0', 'draft': False}],
                    [{'id': 3, 'tag_name': 'desktop-v0.2.0', 'draft': True, 'assets': [{}]},
                     {'id': 4, 'tag_name': 'desktop-v0.3.0', 'draft': True}]]
        self.assertEqual(self.discard(releases),
                         (0, ['repos/example/dist/releases/1', 'repos/example/dist/releases/3']))

    def test_missing_draft_is_nothing_to_discard(self):
        self.assertEqual(self.discard([[{'id': 2, 'tag_name': 'desktop-v0.1.0', 'draft': False}]]), (0, []))

    def test_published_version_is_never_touched(self):
        releases = [[{'id': 1, 'tag_name': 'desktop-v0.2.0', 'draft': True},
                     {'id': 5, 'tag_name': 'desktop-v0.2.0', 'draft': False}]]
        status, deleted = self.discard(releases)
        self.assertNotEqual(status, 0)
        self.assertEqual(deleted, [])

    def test_lookup_failure_or_source_repository_deletes_nothing(self):
        for options in ({'lookup_fails': True}, {'source': 'EXAMPLE/DIST'}):
            with self.subTest(options=options):
                status, deleted = self.discard([[{'id': 1, 'tag_name': 'desktop-v0.2.0', 'draft': True}]], **options)
                self.assertNotEqual(status, 0)
                self.assertEqual(deleted, [])
