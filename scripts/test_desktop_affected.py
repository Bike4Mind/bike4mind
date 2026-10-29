from fnmatch import fnmatchcase
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
        self.lock = {'lockfileVersion': '9.0', 'importers': {
            '.': {}, 'b4m-core/shared': {}, 'b4m-core/leaf': {},
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

    def test_desktop_docs_only_skips(self):
        self.commit('docs(desktop): document integration', 'apps/desktop/SPARKLE-INTEGRATION.md')
        self.assertFalse(affected(self.base, 'HEAD'))

    def test_desktop_runtime_change_runs(self):
        self.commit('fix(desktop): update runtime', 'apps/desktop/src/main/index.ts')
        self.assertTrue(affected(self.base, 'HEAD'))

    def test_docs_beside_runtime_change_runs(self):
        Path('apps/desktop/README.md').write_text('change\n')
        self.commit('fix(desktop): update runtime and docs', 'apps/desktop/src/main/index.ts')
        self.assertTrue(affected(self.base, 'HEAD'))

    def test_dependency_docs_only_skips(self):
        self.commit('docs: document shared package', 'b4m-core/leaf/README.md')
        self.assertFalse(affected(self.base, 'HEAD'))

    def test_desktop_renamed_runtime_file_to_markdown_runs(self):
        source = Path('apps/desktop/src/main/feature.ts')
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text('\n'.join(f'export const v{index} = {index};' for index in range(40)) + '\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'feat(desktop): add runtime module')
        base = self.git('rev-parse', 'HEAD')
        self.git('mv', 'apps/desktop/src/main/feature.ts', 'apps/desktop/src/main/feature.md')
        self.git('commit', '-qm', 'docs(desktop): turn module into notes')
        self.assertTrue(affected(base, 'HEAD'))

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

    def test_missing_lock_fails_safe(self):
        Path('pnpm-lock.yaml').unlink()
        self.assertTrue(self.changed())

    def test_missing_root_manifest_fails_safe(self):
        Path('package.json').unlink()
        self.assertTrue(self.changed())

    def test_missing_importer_fails_safe(self):
        del self.lock['importers']['b4m-core/leaf']
        self.write_lock()
        self.assertTrue(self.changed())

    def test_missing_snapshot_fails_safe(self):
        del self.lock['snapshots']['follow-redirects@1.0.0']
        self.write_lock()
        self.assertTrue(self.changed())

    def test_malformed_section_fails_safe(self):
        self.lock['snapshots'] = []
        self.write_lock()
        self.assertTrue(self.changed())

    def test_unavailable_push_base_fails_safe(self):
        self.assertTrue(affected('0' * 40, 'HEAD'))
        self.assertTrue(affected('1' * 40, 'HEAD'))

    def test_dev_workspace_runs(self):
        Path('apps/desktop/package.json').write_text(json.dumps({
            'name': '@bike4mind/desktop', 'devDependencies': {'@example/shared': 'workspace:*'}}))
        self.assertTrue(self.changed())

    def test_removed_workspace_still_runs(self):
        self.manifest('apps/desktop', '@bike4mind/desktop', {})
        self.git('add', '.')
        self.git('commit', '-qm', 'refactor: remove dependency')
        self.commit('fix: formerly reachable', 'b4m-core/leaf/src/index.ts')
        self.assertTrue(affected(self.base, 'HEAD'))

    def test_root_tool_resolution_runs(self):
        self.lock['importers']['.'] = {'devDependencies': {
            'husky': {'specifier': '^9.0.0', 'version': '9.0.0'}}}
        self.lock['snapshots']['husky@9.0.0'] = {}
        self.lock['packages']['husky@9.0.0'] = {}
        self.write_lock()
        self.assertTrue(self.changed())

    def test_shared_test_config_runs(self):
        self.commit('test: shared configuration', 'vitest.shared.ts')
        self.assertTrue(affected(self.base, 'HEAD'))

    def test_curated_catalog_runs(self):
        self.commit('fix(desktop): refresh curated pins', 'catalog/model-hub/curated-v2.json')
        self.assertTrue(affected(self.base, 'HEAD'))

    def test_curated_release_gate_changes_run(self):
        for name in ('checkDesktopBuild.ts', 'devKey.ts', 'cli.ts'):
            with self.subTest(file=name):
                base = self.git('rev-parse', 'HEAD')
                self.commit('fix(scripts): update curated release gate',
                            f'packages/scripts/src/curatedCatalog/{name}')
                self.assertTrue(affected(base, 'HEAD'))

    def test_curated_publisher_change_skips(self):
        self.commit('fix(scripts): update curated publisher',
                    'packages/scripts/src/curatedCatalog/publishCurated.ts')
        self.assertFalse(affected(self.base, 'HEAD'))

    def test_curated_catalog_docs_only_skips(self):
        self.commit('docs: catalog maintenance', 'catalog/model-hub/README.md')
        self.assertFalse(affected(self.base, 'HEAD'))

    def test_gate_test_runs(self):
        self.commit('test: dependency gate', 'scripts/test_desktop_affected.py')
        self.assertTrue(affected(self.base, 'HEAD'))

    def test_unrelated_changes_do_not_bump_or_enter_notes(self):
        self.git('tag', 'desktop-v0.1.1')
        releases = [{'tag_name': 'desktop-v0.1.1', 'prerelease': False}]
        self.commit('feat(shared)!: unrelated', 'b4m-core/unrelated/src/index.ts')
        self.assertEqual(version_tests.select_version(releases, '0.1.0')[:2], ('0.1.1', False))
        notes = version_tests.release_notes('0.1.1', 'desktop-v0.1.1', 'example/repo', 'example/dist')
        self.assertNotIn('feat(shared)!', notes)


class DesktopWorkflowTriggersTest(unittest.TestCase):
    def test_automatic_triggers_include_curated_trust_and_release_gate(self):
        workflow_path = Path(__file__).resolve().parents[1] / '.github/workflows/desktop-release.yml'
        workflow = yaml.load(workflow_path.read_text(), Loader=yaml.BaseLoader)
        expected = {
            'apps/desktop/**', '.github/workflows/desktop-release.yml',
            'scripts/desktop_release_version.py', 'scripts/test_desktop_release_version.py',
            'scripts/desktop_affected.py', 'scripts/test_desktop_affected.py',
            'catalog/model-hub/**',
            'b4m-core/local-models/**',
            'b4m-core/common/src/schemas/modelHub.ts',
            'packages/scripts/src/curatedCatalog/checkDesktopBuild.ts',
            'packages/scripts/src/curatedCatalog/devKey.ts',
            'packages/scripts/src/curatedCatalog/cli.ts',
        }
        for event in ('pull_request', 'push'):
            paths = workflow['on'][event]['paths']
            self.assertEqual(set(paths), expected)
            for path in ('apps/desktop/src/main/index.ts', 'catalog/model-hub/curated-v2.json',
                         'b4m-core/local-models/src/curatedSignature.ts',
                         *sorted(expected - {'apps/desktop/**', 'catalog/model-hub/**', 'b4m-core/local-models/**'})):
                with self.subTest(event=event, included=path):
                    self.assertTrue(any(fnmatchcase(path, pattern) for pattern in paths))
            for path in ('b4m-core/services/src/notebookExportService/index.ts',
                         'packages/cli/src/index.ts', 'apps/client/app.ts',
                         'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
                         'patches/example.patch', 'turbo.json', 'vitest.shared.ts', '.npmrc'):
                with self.subTest(event=event, excluded=path):
                    self.assertFalse(any(fnmatchcase(path, pattern) for pattern in paths))
        self.assertIn('workflow_dispatch', workflow['on'])


if __name__ == '__main__':
    unittest.main()
