import os
from pathlib import Path
import re
import subprocess
import unittest


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
