import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class PublishReleaseTest(unittest.TestCase):
    def publish(self, state='', fail='', source='example/source'):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mock = root / 'gh'
            mock.write_text('''#!/usr/bin/env python3
import json, os, sys, shutil
from pathlib import Path
args = sys.argv[1:]
with open(os.environ['GH_CALLS'], 'a') as output:
    output.write(json.dumps(args) + '\\n')
if args[0] == 'api': print(os.environ['STATE'])
if args[:2] == ['release', os.environ['FAIL']]: sys.exit(1)
if args[:2] == ['release', 'download']:
    target = Path(args[args.index('--dir') + 1])
    for asset in Path(os.environ['ASSETS']).iterdir(): shutil.copy(asset, target)
''')
            mock.chmod(0o755)
            assets = root / 'installers'
            assets.mkdir()
            (assets / 'probe.txt').write_text('installer')
            notes = root / 'notes.md'
            notes.write_text('Release notes')
            calls_file = root / 'calls.jsonl'
            result = subprocess.run(
                ['bash', str(Path(__file__).with_name('publish-release.sh')), str(assets), str(notes)],
                capture_output=True,
                env={**os.environ, 'PATH': f'{root}{os.pathsep}{os.environ["PATH"]}',
                     'GH_CALLS': str(calls_file), 'GH_REPO': 'example/dist', 'GITHUB_REPOSITORY': source,
                     'DESKTOP_VERSION': '0.1.1', 'RELEASE_TARGET': 'main',
                     'STATE': state, 'FAIL': fail, 'ASSETS': str(assets)},
            )
            calls = [json.loads(line) for line in calls_file.read_text().splitlines()] if calls_file.exists() else []
            return result.returncode, calls

    def test_new_release_is_verified_before_latest(self):
        status, calls = self.publish()
        self.assertEqual(status, 0)
        actions = [call[1] for call in calls if call[0] == 'release']
        self.assertEqual(actions, ['create', 'upload', 'download', 'edit', 'view'])
        create = next(call for call in calls if call[:2] == ['release', 'create'])
        self.assertIn('--draft', create)
        self.assertIn('Bike4Mind Desktop 0.1.1', create)
        edit = next(call for call in calls if call[:2] == ['release', 'edit'])
        self.assertIn('--latest=true', edit)

    def test_draft_retry_skips_creation(self):
        status, calls = self.publish('true')
        self.assertEqual(status, 0)
        self.assertFalse(any(call[:2] == ['release', 'create'] for call in calls))

    def test_published_retry_changes_nothing(self):
        status, calls = self.publish('false')
        self.assertEqual(status, 0)
        self.assertEqual(len(calls), 1)

    def test_failures_never_promote_latest(self):
        for failure in ('upload', 'download'):
            status, calls = self.publish(fail=failure)
            self.assertNotEqual(status, 0)
            self.assertFalse(any(call[:2] == ['release', 'edit'] for call in calls))

    def test_source_destination_denied_before_api_call(self):
        status, calls = self.publish(source='EXAMPLE/DIST')
        self.assertNotEqual(status, 0)
        self.assertEqual(calls, [])
