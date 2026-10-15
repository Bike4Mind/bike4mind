import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[3]
WORKFLOW = (ROOT / '.github/workflows/desktop-release.yml').read_text()


class ReleaseWorkflowTest(unittest.TestCase):
    def validate(self, extra=None, missing=None, empty=None):
        code = textwrap.dedent(WORKFLOW.split("python3 <<'PY'\n", 1)[1].split('\n          PY', 1)[0])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            names = {'Bike4Mind-0.1.1-arm64.dmg', 'Bike4Mind-0.1.1-x64.dmg',
                     'Bike4Mind-0.1.1-x64.AppImage'}
            if missing:
                names.remove(missing)
            if extra:
                names.add(extra)
            for name in names:
                (root / name).write_text('' if name == empty else 'installer')
            return subprocess.run(['python3', '-c', code], cwd=root, capture_output=True,
                                  env={**os.environ, 'GITHUB_OUTPUT': str(root / 'output')})

    def test_three_installers_pass(self):
        self.assertEqual(self.validate().returncode, 0)

    def test_missing_installer_fails(self):
        self.assertNotEqual(self.validate(missing='Bike4Mind-0.1.1-x64.AppImage').returncode, 0)

    def test_zip_fails(self):
        self.assertNotEqual(self.validate(extra='Bike4Mind-0.1.1-arm64.zip').returncode, 0)

    def test_empty_installer_fails(self):
        self.assertNotEqual(self.validate(empty='Bike4Mind-0.1.1-arm64.dmg').returncode, 0)

    def test_publisher_is_main_only_and_scoped(self):
        publish = WORKFLOW.split('\n  publish:\n', 1)[1]
        self.assertIn("if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')", publish)
        self.assertIn('repositories: ${{ github.event.repository.name }}', publish)
        self.assertIn('permission-contents: write', publish)
        self.assertIn('GH_TOKEN: ${{ steps.release-token.outputs.token }}', publish)
        self.assertIn('if [ -z "$GH_TOKEN" ]; then', publish)
        self.assertNotIn('GH_TOKEN: ${{ github.token }}', publish)
        self.assertNotIn('create-github-app-token', WORKFLOW.split('\n  publish:\n', 1)[0])

    def test_no_zip_packaging_or_checksums(self):
        self.assertNotIn('--mac dmg zip', WORKFLOW)
        self.assertNotIn('*.zip', WORKFLOW)
        self.assertIn('sha256sum -- *.dmg *.AppImage', WORKFLOW)
        config = (ROOT / 'apps/desktop/electron-builder.yml').read_text()
        self.assertNotIn('target: zip', config)


if __name__ == '__main__':
    unittest.main()
