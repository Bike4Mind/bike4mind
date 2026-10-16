import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class PublishReleaseTest(unittest.TestCase):
    def publish(self, state='', fail='', source='example/source', tamper='', releases=None, version='0.1.1', latest='true', api_fail=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mock = root / 'gh'
            mock.write_text('''#!/usr/bin/env python3
import json, os, sys, shutil
from pathlib import Path
args = sys.argv[1:]
with open(os.environ['GH_CALLS'], 'a') as output:
    output.write(json.dumps(args) + '\\n')
if args[0] == 'api':
    if '--slurp' in args:
        if os.environ['API_FAIL'] == 'true': sys.exit(1)
        print(os.environ['RELEASES'])
    else: print(os.environ['STATE'])
if args[:2] == ['release', os.environ['FAIL']]: sys.exit(1)
if args[:2] == ['release', 'download']:
    target = Path(args[args.index('--dir') + 1])
    for asset in Path(os.environ['ASSETS']).iterdir(): shutil.copy(asset, target)
    if os.environ['TAMPER'] == 'bytes': (target / 'probe.txt').write_text('altered')
    if os.environ['TAMPER'] == 'extra': (target / 'stray.txt').write_text('stray')
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
                     'DESKTOP_VERSION': version, 'RELEASE_TARGET': 'main', 'RELEASE_LATEST': latest,
                     'RELEASES': json.dumps(releases if releases is not None else [[]]),
                     'API_FAIL': str(api_fail).lower(),
                     'STATE': state, 'FAIL': fail, 'TAMPER': tamper, 'ASSETS': str(assets)},
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

    def test_publish_time_latest_uses_highest_published_stable_semver(self):
        for version, draft, prerelease, expected in (
                ('0.1.2', False, False, False), ('0.10.0', False, False, False),
                ('0.1.1', False, False, True), ('0.1.0', False, False, True),
                ('9.0.0', True, False, True), ('9.0.0', False, True, True),
                ('9.0.0-beta.1', False, False, True), ('0.1.2+build.1', False, False, False)):
            releases = [[{'tag_name': 'v99.0.0', 'draft': False, 'prerelease': False}],
                        [{'tag_name': 'desktop-v' + version, 'draft': draft, 'prerelease': prerelease}]]
            with self.subTest(version=version, draft=draft, prerelease=prerelease):
                status, calls = self.publish(releases=releases)
                self.assertEqual(status, 0)
                edit = next(call for call in calls if call[:2] == ['release', 'edit'])
                self.assertIn('--latest=' + str(expected).lower(), edit)
                lookup = next(i for i, call in enumerate(calls) if '--slurp' in call)
                self.assertGreater(lookup, next(i for i, call in enumerate(calls) if call[:2] == ['release', 'download']))
                self.assertIn('--paginate', calls[lookup])

    def test_latest_lookup_failure_or_invalid_version_never_publishes(self):
        for options in ({'api_fail': True}, {'version': '0.1.1-pr.1.1'}, {'releases': [[{}]]}):
            status, calls = self.publish(**options)
            self.assertNotEqual(status, 0)
            self.assertFalse(any(call[:2] == ['release', 'edit'] for call in calls))

    def test_explicit_non_latest_is_preserved(self):
        status, calls = self.publish(latest='false')
        self.assertEqual(status, 0)
        self.assertIn('--latest=false', next(call for call in calls if call[:2] == ['release', 'edit']))

    def test_published_retry_changes_nothing(self):
        status, calls = self.publish('false')
        self.assertEqual(status, 0)
        self.assertEqual(len(calls), 1)

    def test_failures_never_promote_latest(self):
        for failure in ('upload', 'download'):
            status, calls = self.publish(fail=failure)
            self.assertNotEqual(status, 0)
            self.assertFalse(any(call[:2] == ['release', 'edit'] for call in calls))

    def test_unverified_remote_assets_never_promote_latest(self):
        for tamper in ('bytes', 'extra'):
            status, calls = self.publish(tamper=tamper)
            self.assertNotEqual(status, 0)
            self.assertFalse(any(call[:2] == ['release', 'edit'] for call in calls))

    def test_source_destination_denied_before_api_call(self):
        status, calls = self.publish(source='EXAMPLE/DIST')
        self.assertNotEqual(status, 0)
        self.assertEqual(calls, [])
