import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
import textwrap
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[3]
WORKFLOW = (ROOT / '.github/workflows/desktop-release.yml').read_text()
NEXT_JOB = re.compile(r'\n  [a-z][a-z-]*:\n')


def job(name):
    body = WORKFLOW.split(f'\n  {name}:\n', 1)[1]
    following = NEXT_JOB.search(body)
    return body[:following.start()] if following else body


class ReleaseWorkflowTest(unittest.TestCase):
    def test_publisher_is_main_only_and_scoped(self):
        publish = job('publish')
        steps = publish.partition('    steps:\n')[2]
        self.assertIn("if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')", publish)
        self.assertIsNone(re.search(r'^    permissions:', publish, re.M))
        self.assertIn('repositories: ${{ github.event.repository.name }}', publish)
        self.assertIn('permission-contents: write', publish)
        token = steps.split('- name: Generate release App token', 1)[1].split('- name:', 1)[0]
        self.assertIn('id: release-token', token)
        self.assertIn('uses: actions/create-github-app-token@v3', token)
        self.assertIn('GH_TOKEN: ${{ steps.distribution-token.outputs.token }}', publish)
        self.assertIn('repositories: ${{ needs.version.outputs.repository-name }}', publish)
        self.assertIn('private-key: ${{ secrets.DESKTOP_RELEASE_APP_PRIVATE_KEY }}', publish)
        self.assertNotIn('GH_TOKEN: ${{ github.token }}', publish)
        self.assertLess(publish.index('if [ -z "$GH_TOKEN" ]; then'), publish.index('publish-release.sh'))
        self.assertLess(publish.index('distribution.py prune installers'), publish.index('sha256sum --check'))
        self.assertNotIn('create-github-app-token', WORKFLOW.split('\n  publish:\n', 1)[0])

    def test_signing_default_denies_distribution(self):
        self.assertIn('mac-mode: ${{ steps.mac-policy.outputs.mode }}', job('version'))
        self.assertIn('ADHOC_BETA: ${{ vars.DESKTOP_MAC_ADHOC_BETA }}', job('version'))
        self.assertIn('python3 apps/desktop/scripts/mac_release_policy.py', job('publish'))
        self.assertIn("if: matrix.platform != 'mac' || needs.version.outputs.mac-mode == 'adhoc'", WORKFLOW)
        self.assertIn('grep -q \'^Authority=Developer ID Application:\'', WORKFLOW)
        self.assertIn('B4M_UPDATE_FEED_URL: ${{ needs.version.outputs.feed }}', WORKFLOW)
        self.assertIn("B4M_UPDATE_FEED_URL='' pnpm build", job('build'))
        self.assertIn('EXPECTED_MAC_MODE: ${{ needs.version.outputs.mac-mode }}', job('publish'))

    def test_embedded_blockmap_checks_run_after_linux_packaging(self):
        build = job('build')
        self.assertIn('node apps/desktop/scripts/smoke-differential.cjs', build)
        self.assertIn('distribution.py verify-linux apps/desktop/release', build)
        self.assertLess(build.index('--linux --publish never'), build.index('distribution.py verify-linux'))
        reserve = job('publish').split('- name: Reserve protected source version tag', 1)[1].split('- name:', 1)[0]
        self.assertIn('GH_TOKEN: ${{ steps.release-token.outputs.token }}', reserve)
        self.assertIn('run: python3 apps/desktop/scripts/reserve-source-tag.py', reserve)
        self.assertNotIn('2>/dev/null', reserve)

    def test_windows_leg_packages_installs_and_uploads(self):
        build = job('build')
        self.assertIn('--win --publish never', build)
        self.assertIn("if: matrix.platform != 'win'\n        run: pnpm --filter @bike4mind/desktop test", build)
        self.assertIn('node --test scripts/test_package_local.cjs', build)
        step = '- name: Install and launch packaged Windows installer'
        self.assertLess(build.index('--win --publish never'), build.index(step))
        smoke = build.split(step, 1)[1].split('- name:', 1)[0]
        self.assertIn('shell: pwsh', smoke)
        self.assertIn("'/S'", smoke)
        self.assertIn("EXPECT_UPDATES_ENABLED: 'true'", smoke)
        self.assertIn('smoke-packaged.mjs', smoke)
        self.assertIn('apps/desktop/release/*.exe', build)
        self.assertIn('installers/latest.yml', job('validate'))

    def test_windows_installer_carries_x64_and_arm64(self):
        config = yaml.safe_load((ROOT / 'apps/desktop/electron-builder.yml').read_text())
        self.assertEqual(config['win']['target'], [{'target': 'nsis', 'arch': ['x64', 'arm64']}])
        self.assertEqual(config['nsis']['artifactName'], '${productName}-${version}-setup.${ext}')
        build = job('build')
        command = next(line for line in build.splitlines() if 'electron-builder --win' in line)
        self.assertIsNone(re.search(r'--(x64|arm64|ia32|armv7l|universal)\b', command))
        packaging = build.split(command, 1)[1].split('\n          else\n', 1)[0]
        self.assertIn('7z l "release/Bike4Mind-$DESKTOP_VERSION-setup.exe"', packaging)
        self.assertIn('for archive in app-64.7z app-arm64.7z; do', packaging)

    def test_windows_installer_check_requires_both_archives(self):
        build = job('build')
        start = build.index('contents=$(7z l')
        check = textwrap.dedent(build[build.rindex('\n', 0, start) + 1:build.index('done\n', start) + 4])
        both = '$PLUGINSDIR\\app-arm64.7z\n$PLUGINSDIR\\app-64.7z\n'
        cases = [(both, 0, True), (both, 2, True), ('$PLUGINSDIR\\app-64.7z\n', 0, False), ('', 2, False)]
        for listing, status, passes in cases:
            with self.subTest(listing=listing, status=status), tempfile.TemporaryDirectory() as directory:
                fake = Path(directory) / '7z'
                fake.write_text(f'#!/bin/sh\nprintf %s {shlex.quote(listing)}\nexit {status}\n')
                fake.chmod(0o755)
                env = {**os.environ, 'PATH': f'{directory}{os.pathsep}{os.environ["PATH"]}', 'DESKTOP_VERSION': '0.1.1'}
                result = subprocess.run(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', check],
                                        env=env, capture_output=True)
                self.assertEqual(result.returncode == 0, passes)

    def test_installer_refuses_32_bit_windows(self):
        config = yaml.safe_load((ROOT / 'apps/desktop/electron-builder.yml').read_text())
        # electron-builder includes build/installer.nsh only when neither of these overrides it.
        self.assertNotIn('include', config['nsis'])
        self.assertNotIn('script', config['nsis'])
        self.assertEqual(config['directories']['buildResources'], 'build')
        script = (ROOT / 'apps/desktop/build/installer.nsh').read_text()
        macro = script.split('!macro customInit\n', 1)[1].split('!macroend', 1)[0]
        self.assertIn('${IfNot} ${RunningX64}', macro)
        self.assertIn('${AndIfNot} ${IsNativeARM64}', macro)
        self.assertIn('$(x64WinRequired)', macro)
        self.assertIn('/SD IDOK', macro)
        self.assertIn('Quit', macro)

    def test_curated_build_check_runs_between_each_build_and_packaging(self):
        build = job('build')
        self.assertIn('B4M_CURATED_MANIFEST_URL: ${{ vars.B4M_CURATED_MANIFEST_URL }}', build)
        self.assertIn('CURATED_PUBLIC_URL: ${{ vars.CURATED_PUBLIC_URL }}', build)
        check = 'pnpm --filter @bike4mind/scripts curated:check-build out --expect-url "$CURATED_PUBLIC_URL"'
        for step in ('- name: Package installers', '- name: Sign and notarize macOS installers'):
            body = build.split(step, 1)[1].split('- name:', 1)[0]
            with self.subTest(step=step):
                self.assertLess(body.rindex('pnpm build'), body.index(check))
                self.assertLess(body.index(check), body.index('electron-builder'))

    def test_orphaned_reservation_is_released_before_reserving(self):
        # The version job treats any reservation on an older main commit as abandoned; that holds only
        # while main runs share one group that never cancels a run in progress.
        concurrency = yaml.safe_load(WORKFLOW)['concurrency']
        self.assertEqual(concurrency['group'], 'desktop-release-${{ github.event.pull_request.number || github.ref }}')
        self.assertEqual(concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}")
        self.assertIn('reclaim: ${{ steps.version.outputs.reclaim }}', job('version'))
        publish = job('publish')
        discard = publish.split('- name: Discard orphaned distribution draft', 1)[1].split('- name:', 1)[0]
        self.assertIn("if: needs.version.outputs.reclaim != ''", discard)
        self.assertIn('GH_TOKEN: ${{ steps.distribution-token.outputs.token }}', discard)
        self.assertIn('run: python3 apps/desktop/scripts/discard-orphaned-draft.py', discard)
        reserve = publish.split('- name: Reserve protected source version tag', 1)[1].split('- name:', 1)[0]
        self.assertIn('RECLAIM_SHA: ${{ needs.version.outputs.reclaim }}', reserve)
        order = [publish.index(f'- name: {name}') for name in
                 ('Check distribution destination', 'Discard orphaned distribution draft',
                  'Reserve protected source version tag', 'Publish desktop release')]
        self.assertEqual(order, sorted(order))

    def test_token_guard_fails_closed(self):
        guard = next(line.strip() for line in WORKFLOW.splitlines()
                     if 'if [ -z "$GH_TOKEN" ]; then' in line)
        for token in (None, '', 'test-token'):
            env = {key: value for key, value in os.environ.items() if key != 'GH_TOKEN'}
            if token is not None:
                env['GH_TOKEN'] = token
            # Match the runner's shell: -e and pipefail, no -u.
            result = subprocess.run(
                ['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', guard],
                env=env, capture_output=True)
            self.assertEqual(result.returncode == 0, bool(token))


if __name__ == '__main__':
    unittest.main()
