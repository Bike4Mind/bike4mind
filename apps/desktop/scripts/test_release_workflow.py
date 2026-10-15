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
        self.assertIn('GH_TOKEN: ${{ steps.release-token.outputs.token }}', publish)
        self.assertNotIn('GH_TOKEN: ${{ github.token }}', publish)
        self.assertLess(publish.index('if [ -z "$GH_TOKEN" ]; then'), publish.index('publish-release.sh'))
        self.assertNotIn('create-github-app-token', WORKFLOW.split('\n  publish:\n', 1)[0])

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
