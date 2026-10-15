import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest


WORKFLOW = (Path(__file__).resolve().parents[3] / '.github/workflows/desktop-release.yml').read_text()


class ReleasePlatformsTest(unittest.TestCase):
    def validate(self, missing=None, extra=None):
        code = textwrap.dedent(WORKFLOW.split("python3 <<'PY'\n", 1)[1].split('\n          PY', 1)[0])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            names = {'Bike4Mind-0.1.1-arm64.dmg', 'Bike4Mind-0.1.1-arm64.zip',
                     'Bike4Mind-0.1.1-x64.AppImage'}
            names.discard(missing)
            if extra:
                names.add(extra)
            for name in names:
                (root / name).write_text('installer')
            return subprocess.run(['python3', '-c', code], cwd=root, capture_output=True,
                                  env={**os.environ, 'GITHUB_OUTPUT': str(root / 'output')}).returncode

    def test_remaining_installers_pass(self):
        self.assertEqual(self.validate(), 0)

    def test_missing_linux_installer_fails(self):
        self.assertNotEqual(self.validate(missing='Bike4Mind-0.1.1-x64.AppImage'), 0)

    def test_unexpected_intel_installer_fails(self):
        self.assertNotEqual(self.validate(extra='Bike4Mind-0.1.1-x64.dmg'), 0)

    def test_two_independent_platform_jobs(self):
        matrix = WORKFLOW.split('        include:\n', 1)[1].split('    runs-on:', 1)[0]
        self.assertEqual(matrix.count('- os:'), 2)
        self.assertIn('arch: arm64', matrix)
        self.assertIn('platform: linux', matrix)
        self.assertNotIn('macos-15-intel', matrix)
        self.assertNotIn('max-parallel: 1', WORKFLOW)

    def test_macos_runner_is_configurable(self):
        matrix = WORKFLOW.split('        include:\n', 1)[1].split('    runs-on:', 1)[0]
        self.assertIn("- os: ${{ vars.OSX_RUNNER_LABEL || 'macos-26-runner' }}", matrix)
        self.assertIn('- os: ubuntu-24.04', matrix)
        self.assertIn('runs-on: ${{ matrix.os }}', WORKFLOW)


if __name__ == '__main__':
    unittest.main()
