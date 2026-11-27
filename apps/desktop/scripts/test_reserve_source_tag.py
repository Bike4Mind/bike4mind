import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class ReserveSourceTagTest(unittest.TestCase):
    def reserve(self, status, sha, reclaim=''):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mock = root / 'gh'
            mock.write_text('''#!/usr/bin/env python3
import os, sys
from pathlib import Path
with open(os.environ['CALLS'], 'a') as output: output.write(' '.join(sys.argv[1:]) + '\\n')
if '--include' in sys.argv:
    print(os.environ['RESPONSE'])
    if os.environ['STATUS'] != '200':
        print('lookup diagnostic', file=sys.stderr)
        sys.exit(1)
''')
            mock.chmod(0o755)
            response = (f'HTTP/2.0 {status} Status\nContent-Type: application/json\n\n'
                        + json.dumps({'object': {'sha': sha}})) if status else ''
            result = subprocess.run(['python3', str(Path(__file__).with_name('reserve-source-tag.py'))],
                env={**os.environ, 'PATH': f'{root}{os.pathsep}{os.environ["PATH"]}',
                     'GITHUB_REPOSITORY': 'example/source', 'DESKTOP_VERSION': '1.2.3',
                     'GITHUB_SHA': 'expected', 'RECLAIM_SHA': reclaim, 'STATUS': str(status),
                     'RESPONSE': response, 'CALLS': str(root / 'calls')}, capture_output=True, text=True)
            return result, (root / 'calls').read_text().splitlines()

    def test_only_explicit_404_creates_a_tag(self):
        for status, sha, allowed, creates in ((200, 'expected', True, False),
                (200, 'other', False, False), (404, '', True, True),
                (401, '', False, False), (403, '', False, False),
                (429, '', False, False), (500, '', False, False), (0, '', False, False)):
            with self.subTest(status=status, sha=sha):
                result, calls = self.reserve(status, sha)
                self.assertEqual(result.returncode == 0, allowed)
                self.assertEqual(len(calls), 2 if creates else 1)
                if status != 200:
                    self.assertIn('lookup diagnostic', result.stderr)
                if creates:
                    self.assertIn('-f ref=refs/tags/desktop-v1.2.3 -f sha=expected', calls[1])

    def test_only_the_reclaimed_commit_gives_up_its_tag(self):
        move = '--method PATCH repos/example/source/git/refs/tags/desktop-v1.2.3 -f sha=expected -F force=true'
        for status, sha, reclaim, allowed, second in (
                (200, 'orphan', 'orphan', True, move),
                (200, 'expected', 'orphan', True, None),
                (200, 'other', 'orphan', False, None),
                (200, 'orphan', '', False, None),
                (404, '', 'orphan', True, '-f ref=refs/tags/desktop-v1.2.3 -f sha=expected')):
            with self.subTest(sha=sha, reclaim=reclaim):
                result, calls = self.reserve(status, sha, reclaim)
                self.assertEqual(result.returncode == 0, allowed)
                self.assertEqual(calls[1:], [calls[1]] if second else [])
                if second:
                    self.assertIn(second, calls[1])
