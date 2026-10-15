import os
from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[3]
WORKFLOW = (ROOT / '.github/workflows/desktop-release.yml').read_text()


class ReleaseWorkflowTest(unittest.TestCase):
    def test_publisher_is_main_only_and_scoped(self):
        publish = WORKFLOW.split('\n  publish:\n', 1)[1]
        self.assertIn("if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')", publish)
        self.assertIn('repositories: ${{ github.event.repository.name }}', publish)
        self.assertIn('permission-contents: write', publish)
        self.assertIn('GH_TOKEN: ${{ steps.release-token.outputs.token }}', publish)
        self.assertIn('if [ -z "$GH_TOKEN" ]; then', publish)
        self.assertNotIn('GH_TOKEN: ${{ github.token }}', publish)
        self.assertNotIn('create-github-app-token', WORKFLOW.split('\n  publish:\n', 1)[0])

    def test_token_guard_fails_closed(self):
        guard = next(line.strip() for line in WORKFLOW.splitlines()
                     if 'if [ -z "$GH_TOKEN" ]; then' in line)
        for token in (None, '', 'test-token'):
            env = {key: value for key, value in os.environ.items() if key != 'GH_TOKEN'}
            if token is not None:
                env['GH_TOKEN'] = token
            result = subprocess.run(['bash', '-eu', '-c', guard], env=env, capture_output=True)
            self.assertEqual(result.returncode == 0, bool(token))


if __name__ == '__main__':
    unittest.main()
