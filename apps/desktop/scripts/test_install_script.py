"""Run install.sh against a fake release, with network and platform tools stubbed on PATH."""

import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / 'install.sh'
REPO = 'Example/desktop-releases'

STUBS = {
    'curl': r'''#!/bin/sh
out= url=
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift ;;
    -w|--proto|--retry) shift ;;
    https://*) url=$1 ;;
  esac
  shift
done
echo "$url" >> "$FAKE_ROOT/curl.log"
case "$url" in
  "https://github.com/$FAKE_REPO/releases/latest")
    [ -n "$FAKE_LATEST" ] || exit 22
    printf 'https://github.com/%s/releases/tag/%s' "$FAKE_REPO" "$FAKE_LATEST" ;;
  "https://github.com/$FAKE_REPO/releases/download/"*)
    file="$FAKE_ROOT/releases/${url#*/releases/download/}"
    [ -f "$file" ] || exit 22
    cp "$file" "$out" ;;
  *) exit 22 ;;
esac
''',
    'uname': '#!/bin/sh\ncase "$1" in -s) echo "$FAKE_OS" ;; -m) echo "$FAKE_ARCH" ;; esac\n',
    'sysctl': '#!/bin/sh\necho "${FAKE_ARM64:-0}"\n',
    'hdiutil': r'''#!/bin/sh
[ "$1" = attach ] || exit 0
dmg=$2
while [ $# -gt 0 ]; do [ "$1" = -mountpoint ] && mount=$2; shift; done
mkdir -p "$mount/Bike4Mind.app/Contents/MacOS"
cp "$dmg" "$mount/Bike4Mind.app/Contents/MacOS/Bike4Mind"
''',
    'ditto': '#!/bin/sh\ncp -R "$1" "$2"\n',
    'codesign': '#!/bin/sh\nexit "${FAKE_CODESIGN_EXIT:-0}"\n',
    'xattr': '#!/bin/sh\nexit 0\n',
    'open': '#!/bin/sh\necho "$@" >> "$FAKE_ROOT/open.log"\n',
    'pgrep': '#!/bin/sh\nexit "${FAKE_PGREP_EXIT:-1}"\n',
    'ldconfig': '#!/bin/sh\necho "libfuse.so.2 (libc6,x86-64) => /lib/libfuse.so.2"\n',
}


class InstallScriptTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.home = self.root / 'home'
        self.home.mkdir()
        stubs = self.root / 'bin'
        stubs.mkdir()
        for name, body in STUBS.items():
            (stubs / name).write_text(body)
            (stubs / name).chmod(0o755)
        self.env = {'PATH': f'{stubs}:/usr/bin:/bin', 'HOME': str(self.home), 'TMPDIR': str(self.root),
                    'FAKE_ROOT': str(self.root), 'FAKE_REPO': REPO, 'FAKE_LATEST': 'desktop-v0.7.0',
                    'B4M_RELEASE_REPOSITORY': REPO, 'FAKE_OS': 'Linux', 'FAKE_ARCH': 'x86_64'}
        self.release('0.7.0')

    def tearDown(self):
        self.temp.cleanup()

    def release(self, version):
        folder = self.root / 'releases' / f'desktop-v{version}'
        folder.mkdir(parents=True)
        sums = []
        for suffix in ('arm64.dmg', 'x64.AppImage'):
            name = f'Bike4Mind-{version}-{suffix}'
            payload = f'{name} payload'.encode()
            (folder / name).write_bytes(payload)
            sums.append(f'{hashlib.sha256(payload).hexdigest()}  {name}\n')
        (folder / 'SHA256SUMS.txt').write_text(''.join(sums))
        return folder

    def install(self, **env):
        return subprocess.run(['sh', str(SCRIPT)], env={**self.env, **env},
                              capture_output=True, text=True, timeout=60)

    def log(self, name):
        path = self.root / name
        return path.read_text().splitlines() if path.exists() else []

    def assertNoTempLeft(self):
        self.assertEqual(list(self.root.glob('bike4mind.*')), [])

    def test_linux_installs_then_updates_in_place(self):
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        dest = self.home / '.local/share/bike4mind/Bike4Mind.AppImage'
        self.assertEqual(dest.read_bytes(), b'Bike4Mind-0.7.0-x64.AppImage payload')
        self.assertTrue(os.access(dest, os.X_OK))
        self.assertEqual((self.home / '.local/bin/bike4mind').resolve(), dest.resolve())
        entry = (self.home / '.local/share/applications/bike4mind.desktop').read_text()
        self.assertIn(f'Exec="{dest}" %U', entry)
        self.assertIn('Installed Bike4Mind 0.7.0', result.stdout)
        self.assertNotIn('FUSE 2', result.stdout)
        self.assertNoTempLeft()

        self.release('0.8.0')
        result = self.install(FAKE_LATEST='desktop-v0.8.0')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(dest.read_bytes(), b'Bike4Mind-0.8.0-x64.AppImage payload')
        self.assertTrue(all(url.startswith(f'https://github.com/{REPO}/releases/') for url in self.log('curl.log')))
        self.assertNoTempLeft()

    def test_mac_rosetta_shell_installs_arm64_and_opens(self):
        apps = self.root / 'Applications'
        result = self.install(FAKE_OS='Darwin', FAKE_ARCH='x86_64', FAKE_ARM64='1', B4M_INSTALL_DIR=str(apps))
        self.assertEqual(result.returncode, 0, result.stderr)
        app = apps / 'Bike4Mind.app'
        self.assertEqual((app / 'Contents/MacOS/Bike4Mind').read_bytes(), b'Bike4Mind-0.7.0-arm64.dmg payload')
        self.assertFalse((apps / '.Bike4Mind.app.partial').exists())
        self.assertEqual(self.log('open.log'), [str(app)])
        self.assertNoTempLeft()

    def test_mac_running_app_is_replaced_but_not_reopened(self):
        result = self.install(FAKE_OS='Darwin', FAKE_ARCH='arm64', FAKE_PGREP_EXIT='0',
                              B4M_INSTALL_DIR=str(self.root / 'Applications'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Quit and reopen it to use 0.7.0', result.stdout)
        self.assertEqual(self.log('open.log'), [])

    def test_mac_signature_failure_keeps_existing_install(self):
        apps = self.root / 'Applications'
        existing = apps / 'Bike4Mind.app/Contents/MacOS/Bike4Mind'
        existing.parent.mkdir(parents=True)
        existing.write_bytes(b'previous')
        result = self.install(FAKE_OS='Darwin', FAKE_ARCH='arm64', FAKE_CODESIGN_EXIT='1', B4M_INSTALL_DIR=str(apps))
        self.assertEqual(result.returncode, 1)
        self.assertIn('failed signature verification', result.stderr)
        self.assertEqual(existing.read_bytes(), b'previous')
        self.assertFalse((apps / '.Bike4Mind.app.partial').exists())
        self.assertEqual(self.log('open.log'), [])
        self.assertNoTempLeft()

    def test_checksum_mismatch_installs_nothing(self):
        (self.root / 'releases/desktop-v0.7.0/Bike4Mind-0.7.0-x64.AppImage').write_bytes(b'tampered')
        result = self.install()
        self.assertEqual(result.returncode, 1)
        self.assertIn('checksum mismatch', result.stderr)
        self.assertFalse((self.home / '.local/share/bike4mind').exists())
        self.assertNoTempLeft()

    def test_pinned_version_skips_latest_lookup(self):
        result = self.install(B4M_VERSION='v0.7.0', FAKE_LATEST='')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(url.endswith('/releases/latest') for url in self.log('curl.log')))
        result = self.install(B4M_VERSION='9.9.9')
        self.assertEqual(result.returncode, 1)
        self.assertIn('release desktop-v9.9.9 was not found', result.stderr)

    def test_unreachable_latest_fails_cleanly(self):
        result = self.install(FAKE_LATEST='')
        self.assertEqual(result.returncode, 1)
        self.assertIn('could not reach GitHub', result.stderr)

    def test_unsupported_platforms_download_nothing(self):
        for env, message in [({'FAKE_OS': 'Darwin', 'FAKE_ARCH': 'x86_64', 'FAKE_ARM64': '0'}, 'Intel Macs'),
                             ({'FAKE_ARCH': 'aarch64'}, 'unsupported platform Linux/aarch64')]:
            with self.subTest(message=message):
                result = self.install(**env)
                self.assertEqual(result.returncode, 1)
                self.assertIn(message, result.stderr)
        self.assertEqual(self.log('curl.log'), [])

    def test_script_is_executable_posix_sh(self):
        self.assertTrue(os.access(SCRIPT, os.X_OK))
        self.assertTrue(SCRIPT.read_text().startswith('#!/bin/sh\n'))
        self.assertTrue(SCRIPT.read_text().rstrip().endswith('main "$@"'))


if __name__ == '__main__':
    unittest.main()
