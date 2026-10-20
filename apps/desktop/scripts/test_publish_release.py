import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class PublishReleaseTest(unittest.TestCase):
    def publish(self, state='', fail='', source='example/source', tamper='', releases=None, version='0.1.1', latest='true', api_fail=False, tag_state='missing', tag_fail=''):
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
    path = next(arg for arg in args if arg.startswith('repos/'))
    if '/commits/' in path:
        if os.environ['TAG_FAIL'] == 'commit': sys.exit(1)
        print(json.dumps({'sha': 'target-commit'}))
    elif '/git/' in path:
        if os.environ['TAG_FAIL'] == 'lookup' and '--include' in args:
            print('HTTP/2.0 403 Forbidden\\n\\n{}')
            sys.exit(1)
        if '--include' in args:
            state = os.environ['TAG_STATE']
            if state == 'missing':
                print('HTTP/2.0 404 Not Found\\n\\n{}')
                sys.exit(1)
            obj = {'type': 'tag' if state.startswith('annotated') else 'commit',
                   'sha': 'existing-tag' if state.startswith('annotated') else 'other' if state == 'wrong' else 'target-commit'}
            print('HTTP/2.0 200 OK\\n\\n' + json.dumps({'object': obj}))
        elif '--input' in args:
            payload = json.load(sys.stdin)
            with open(os.environ['GH_CALLS'], 'a') as output:
                output.write(json.dumps(['payload', path, payload]) + '\\n')
            if os.environ['TAG_FAIL'] and path.endswith(os.environ['TAG_FAIL']): sys.exit(1)
            print(json.dumps({'sha': 'annotated-tag'}))
        else:
            if os.environ['TAG_FAIL'] == 'annotation': sys.exit(1)
            print(json.dumps({'object': {
                'type': 'tree' if os.environ['TAG_STATE'] == 'annotated-noncommit' else 'commit',
                'sha': 'other' if os.environ['TAG_STATE'] == 'annotated-wrong' else 'target-commit'}}))
    elif '--slurp' in args:
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
                     'TAG_STATE': tag_state, 'TAG_FAIL': tag_fail,
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
        self.assertEqual(create[create.index('--title') + 1], 'v0.1.1')
        self.assertEqual(create[2], 'desktop-v0.1.1')
        edit = next(call for call in calls if call[:2] == ['release', 'edit'])
        self.assertIn('--latest=true', edit)

    def test_draft_retry_skips_creation(self):
        status, calls = self.publish('true')
        self.assertEqual(status, 0)
        self.assertFalse(any(call[:2] == ['release', 'create'] for call in calls))

    def test_annotated_tag_precedes_publication_after_verification(self):
        status, calls = self.publish()
        self.assertEqual(status, 0)
        payloads = [(i, call[1], call[2]) for i, call in enumerate(calls) if call[0] == 'payload']
        index, path, tag = payloads[0]
        self.assertTrue(path.endswith('/git/tags'))
        self.assertEqual(tag['object'], 'target-commit')
        self.assertEqual(tag['type'], 'commit')
        self.assertEqual(tag['tag'], 'desktop-v0.1.1')
        self.assertRegex(tag['tagger']['date'], r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$')
        self.assertEqual(payloads[1][2], {'ref': 'refs/tags/desktop-v0.1.1', 'sha': 'annotated-tag'})
        self.assertGreater(index, next(i for i, c in enumerate(calls) if c[:2] == ['release', 'download']))
        self.assertLess(payloads[1][0], next(i for i, c in enumerate(calls) if c[:2] == ['release', 'edit']))

    def test_draft_lightweight_tag_keeps_commit_and_gets_date(self):
        status, calls = self.publish(state='true', tag_state='lightweight')
        self.assertEqual(status, 0)
        self.assertIn(['payload', 'repos/example/dist/git/refs/tags/desktop-v0.1.1',
                       {'sha': 'annotated-tag', 'force': True}], calls)

    def test_existing_annotated_tag_is_preserved(self):
        status, calls = self.publish(state='true', tag_state='annotated')
        self.assertEqual(status, 0)
        self.assertFalse(any(call[0] == 'payload' for call in calls))

    def test_invalid_annotated_target_never_writes_or_publishes(self):
        for tag_state in ('annotated-wrong', 'annotated-noncommit'):
            with self.subTest(tag_state=tag_state):
                status, calls = self.publish(state='true', tag_state=tag_state)
                self.assertNotEqual(status, 0)
                self.assertFalse(any(call[0] == 'payload' for call in calls))
                self.assertFalse(any(call[:2] == ['release', 'edit'] for call in calls))

    def test_target_lookup_failures_never_write_or_publish(self):
        for tag_fail in ('commit', 'annotation'):
            with self.subTest(tag_fail=tag_fail):
                status, calls = self.publish(state='true', tag_state='annotated', tag_fail=tag_fail)
                self.assertNotEqual(status, 0)
                self.assertFalse(any(call[0] == 'payload' for call in calls))
                self.assertFalse(any(call[:2] == ['release', 'edit'] for call in calls))

    def test_lightweight_tag_update_failure_never_publishes(self):
        status, calls = self.publish(state='true', tag_state='lightweight',
                                     tag_fail='/git/refs/tags/desktop-v0.1.1')
        self.assertNotEqual(status, 0)
        self.assertIn(['payload', 'repos/example/dist/git/refs/tags/desktop-v0.1.1',
                       {'sha': 'annotated-tag', 'force': True}], calls)
        self.assertFalse(any(call[:2] == ['release', 'edit'] for call in calls))

    def test_tag_failures_do_not_publish(self):
        for options in ({'tag_fail': 'lookup'}, {'tag_fail': '/git/tags'},
                        {'tag_fail': '/git/refs'}, {'tag_state': 'wrong'}):
            with self.subTest(options=options):
                status, calls = self.publish(**options)
                self.assertNotEqual(status, 0)
                self.assertFalse(any(call[:2] == ['release', 'edit'] for call in calls))

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
