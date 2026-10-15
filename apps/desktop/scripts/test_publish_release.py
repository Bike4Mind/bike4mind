import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class PublishReleaseTest(unittest.TestCase):
    def test_new_release_display_title(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mock = root / 'gh'
            mock.write_text(
                '#!/usr/bin/env python3\n'
                'import json, os, sys\n'
                'with open(os.environ["GH_CALLS"], "a") as output:\n'
                '    output.write(json.dumps(sys.argv[1:]) + "\\n")\n'
            )
            mock.chmod(0o755)
            assets = root / 'installers'
            assets.mkdir()
            (assets / 'Bike4Mind-0.1.1-arm64.dmg').write_text('installer')
            notes = root / 'notes.md'
            notes.write_text('Release notes')
            calls_file = root / 'calls.jsonl'
            subprocess.run(
                ['bash', str(Path(__file__).with_name('publish-release.sh')), str(assets), str(notes)],
                check=True,
                env={**os.environ, 'PATH': f'{root}{os.pathsep}{os.environ["PATH"]}',
                     'GH_CALLS': str(calls_file), 'GH_REPO': 'example/repo',
                     'DESKTOP_VERSION': '0.1.1', 'RELEASE_TARGET': 'main',
                     'RELEASE_TAG_PREFIX': 'desktop-v'},
            )
            calls = [json.loads(line) for line in calls_file.read_text().splitlines()]
            create = next(call for call in calls if call[:2] == ['release', 'create'])
            self.assertEqual(create[2], 'desktop-v0.1.1')
            self.assertEqual(create[create.index('--title') + 1], 'Bike4Mind Desktop 0.1.1')
            upload = next(call for call in calls if call[:2] == ['release', 'upload'])
            self.assertEqual(upload[2:4], ['desktop-v0.1.1', str(assets / 'Bike4Mind-0.1.1-arm64.dmg')])


if __name__ == '__main__':
    unittest.main()
