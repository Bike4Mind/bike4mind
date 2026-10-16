from pathlib import Path
import tempfile
import unittest

from distribution import assemble
from test_distribution import appimage


WORKFLOW = (Path(__file__).resolve().parents[3] / '.github/workflows/desktop-release.yml').read_text()


class ReleasePlatformsTest(unittest.TestCase):
    def validate(self, missing=None, extra=None, mode='signed'):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            names = {'Bike4Mind-0.1.1-arm64.dmg', 'Bike4Mind-0.1.1-arm64.zip',
                     'Bike4Mind-0.1.1-x64.AppImage', 'Bike4Mind-0.1.1-arm64.zip.blockmap'}
            names.discard(missing)
            if extra:
                names.add(extra)
            for name in names:
                (root / name).write_bytes(appimage() if name.endswith('.AppImage') else b'installer')
            try:
                assemble(root, '0.1.1', 'example/dist', 'example/source', mode)
                return 0
            except ValueError:
                return 1

    def test_remaining_installers_pass(self):
        self.assertEqual(self.validate(), 0)

    def test_missing_linux_installer_fails(self):
        self.assertNotEqual(self.validate(missing='Bike4Mind-0.1.1-x64.AppImage'), 0)

    def test_missing_zip_or_blockmap_fails(self):
        for name in ('Bike4Mind-0.1.1-arm64.zip', 'Bike4Mind-0.1.1-arm64.zip.blockmap'):
            self.assertNotEqual(self.validate(missing=name), 0)
            self.assertEqual(self.validate(missing=name, mode='adhoc'), 0)

    def test_unexpected_intel_installer_fails(self):
        self.assertNotEqual(self.validate(extra='Bike4Mind-0.1.1-x64.dmg'), 0)

    def test_two_independent_platform_jobs(self):
        matrix = WORKFLOW.split('        include:\n', 1)[1].split('    runs-on:', 1)[0]
        self.assertEqual(matrix.count('- os:'), 2)
        self.assertIn('arch: arm64', matrix)
        self.assertIn('platform: linux', matrix)
        self.assertNotIn('macos-15-intel', matrix)
        self.assertNotIn('max-parallel: 1', WORKFLOW)

    def test_pr_mac_packages_are_explicitly_signed_and_verified(self):
        packaging = WORKFLOW.split('- name: Package installers', 1)[1].split('- name: Sign and notarize', 1)[0]
        self.assertIn('-c.mac.identity=-', packaging)
        self.assertIn('CSC_FOR_PULL_REQUEST=true pnpm exec electron-builder --mac', packaging)
        self.assertIn('for key in CSC_LINK CSC_KEY_PASSWORD CSC_KEYCHAIN CSC_NAME', packaging)
        self.assertNotIn('secrets.', packaging)
        self.assertIn('codesign --verify --deep --strict', packaging)
        self.assertNotIn('-c.forceCodeSigning=false', WORKFLOW)

    def test_macos_runner_is_configurable(self):
        matrix = WORKFLOW.split('        include:\n', 1)[1].split('    runs-on:', 1)[0]
        self.assertIn("- os: ${{ vars.OSX_RUNNER_LABEL || 'macos-26-runner' }}", matrix)
        self.assertIn('- os: ubuntu-24.04', matrix)
        self.assertIn('runs-on: ${{ matrix.os }}', WORKFLOW)


if __name__ == '__main__':
    unittest.main()
