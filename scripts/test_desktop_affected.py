import json
from pathlib import Path
import unittest

import yaml

from desktop_affected import affected
import test_desktop_release_version as version_tests


class DesktopAffectedTest(unittest.TestCase):
    git = version_tests.DesktopVersionTest.git
    commit = version_tests.DesktopVersionTest.commit
    tearDown = version_tests.DesktopVersionTest.tearDown

    def setUp(self):
        version_tests.DesktopVersionTest.setUp(self)
        self.manifest('apps/desktop', '@bike4mind/desktop', {'@example/shared': 'workspace:*', 'axios': '1.0.0'})
        self.manifest('b4m-core/shared', '@example/shared', {'@example/leaf': 'workspace:*'})
        self.manifest('b4m-core/leaf', '@example/leaf', {})
        self.manifest('b4m-core/unrelated', '@example/unrelated', {})
        self.lock = {'importers': {
            'apps/desktop': {'dependencies': {'axios': {'specifier': '1.0.0', 'version': '1.0.0'}}},
            'apps/client': {'dependencies': {'web-only': {'specifier': '1.0.0', 'version': '1.0.0'}}},
        }, 'snapshots': {'axios@1.0.0': {'dependencies': {'follow-redirects': '1.0.0'}},
                         'follow-redirects@1.0.0': {}, 'web-only@1.0.0': {}},
            'packages': {'axios@1.0.0': {'resolution': {'integrity': 'axios'}},
                         'follow-redirects@1.0.0': {}, 'web-only@1.0.0': {}}}
        self.write_lock()
        self.git('add', '.')
        self.git('commit', '-qm', 'build: fixture')
        self.base = self.git('rev-parse', 'HEAD')

    def manifest(self, folder, name, deps):
        Path(folder).mkdir(parents=True, exist_ok=True)
        Path(folder, 'package.json').write_text(json.dumps({'name': name, 'dependencies': deps}))

    def write_lock(self):
        Path('pnpm-lock.yaml').write_text(yaml.safe_dump(self.lock))

    def changed(self):
        self.git('add', '.')
        self.git('commit', '-qm', 'chore: change inputs')
        return affected(self.base, 'HEAD')

    def test_unrelated_workspace_skips(self):
        self.commit('feat: unrelated', 'b4m-core/unrelated/src/index.ts')
        self.assertFalse(affected(self.base, 'HEAD'))

    def test_transitive_workspace_runs(self):
        self.commit('fix: shared', 'b4m-core/leaf/src/index.ts')
        self.assertTrue(affected(self.base, 'HEAD'))

    def test_unrelated_lock_resolution_skips(self):
        self.lock['packages']['web-only@1.0.0'] = {'resolution': {'integrity': 'changed'}}
        self.lock['importers']['apps/client']['dependencies']['web-only']['version'] = '2.0.0'
        self.write_lock()
        self.assertFalse(self.changed())

    def test_transitive_lock_resolution_runs(self):
        self.lock['packages']['follow-redirects@1.0.0'] = {'resolution': {'integrity': 'changed'}}
        self.write_lock()
        self.assertTrue(self.changed())

    def test_deleted_dependency_source_runs(self):
        self.manifest('apps/desktop', '@bike4mind/desktop', {})
        self.assertTrue(self.changed())

    def test_root_web_dependency_skips(self):
        Path('package.json').write_text('{"dependencies":{"web-only":"2.0.0"}}')
        self.assertFalse(self.changed())

    def test_root_tooling_runs(self):
        Path('package.json').write_text('{"devDependencies":{"turbo":"2.0.0"}}')
        self.assertTrue(self.changed())

    def test_invalid_lock_fails_safe(self):
        Path('pnpm-lock.yaml').write_text('invalid: [')
        self.assertTrue(self.changed())


if __name__ == '__main__':
    unittest.main()
