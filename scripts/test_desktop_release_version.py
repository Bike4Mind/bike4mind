import os
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from desktop_release_version import bump_level, release_notes, select_version, with_reservations


class DesktopVersionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.cwd = os.getcwd()
        os.chdir(self.temp.name)
        self.git('init', '-q')
        self.git('config', 'user.email', 'test@example.com')
        self.git('config', 'user.name', 'Test')
        Path('apps/desktop').mkdir(parents=True)
        Path('apps/desktop/package.json').write_text('{"name":"@bike4mind/desktop"}')
        Path('package.json').write_text('{}')
        Path('pnpm-lock.yaml').write_text(json.dumps({'lockfileVersion': '9.0',
            'importers': {'.': {}, 'apps/desktop': {}}, 'snapshots': {}, 'packages': {}}))
        self.commit('feat(desktop): initial app')
        self.git('tag', 'desktop-v0.1.0')
        self.releases = [{'tag_name': 'desktop-v0.1.0', 'prerelease': False}]

    def tearDown(self):
        os.chdir(self.cwd)
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.check_output(['git', *args], text=True).strip()

    def commit(self, message, path='apps/desktop/src/app.ts'):
        file = Path(path)
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(file.read_text() + 'change\n' if file.exists() else 'change\n')
        self.git('add', '.')
        self.git('commit', '-qm', message)

    def test_initial_release_uses_package_baseline(self):
        self.assertEqual(select_version([], '0.1.0')[:2], ('0.1.0', True))

    def test_same_commit_reuses_version_including_draft(self):
        self.assertEqual(select_version(self.releases, '0.1.0')[:2], ('0.1.0', True))

    def test_draft_without_tag_reuses_reserved_version(self):
        self.commit('feat(desktop): feature')
        self.releases.append({'tag_name': 'desktop-v0.2.0', 'prerelease': False,
                              'draft': True, 'target_commitish': self.git('rev-parse', 'HEAD')})
        version, publish, previous = select_version(self.releases, '0.1.0')
        self.assertEqual((version, publish), ('0.2.0', True))
        self.assertEqual(previous, self.git('rev-parse', 'HEAD'))
        self.assertNotIn('desktop-v0.2.0', self.git('tag', '--list').splitlines())
        self.assertIn('# Desktop 0.2.0', release_notes(version, previous, 'example/repo', 'example/dist'))
        self.commit('fix(desktop): another fix')
        with self.assertRaises(ValueError):
            select_version(self.releases, '0.1.0')

    def test_initial_untagged_draft_can_generate_notes(self):
        self.git('tag', '-d', 'desktop-v0.1.0')
        releases = [{'tag_name': 'desktop-v0.1.0', 'prerelease': False,
                     'draft': True, 'target_commitish': self.git('rev-parse', 'HEAD')}]
        version, publish, previous = select_version(releases, '0.1.0')
        self.assertEqual((version, publish), ('0.1.0', True))
        self.assertEqual(self.git('tag', '--list'), '')
        self.assertIn('# Desktop 0.1.0', release_notes(version, previous, 'example/repo', 'example/dist'))

    def test_distribution_draft_wins_over_source_tag_reservation(self):
        self.releases.append({'tag_name': 'desktop-v0.1.0', 'prerelease': False,
                              'draft': True, 'target_commitish': self.git('rev-parse', 'HEAD')})
        self.commit('fix(desktop): next change')
        with self.assertRaises(ValueError):
            select_version(self.releases, '0.1.0')

    def test_source_reservation_without_destination_release_blocks_next_commit(self):
        self.commit('fix(desktop): reserved build')
        self.git('tag', 'desktop-v0.1.1')
        releases = with_reservations(self.releases, ['desktop-v0.1.0', 'desktop-v0.1.1'])
        self.assertEqual(select_version(releases, '0.1.0')[:2], ('0.1.1', True))
        self.commit('fix(desktop): next commit')
        with self.assertRaises(ValueError):
            select_version(releases, '0.1.0')

    def test_known_prerelease_tag_does_not_become_stable_reservation(self):
        self.git('tag', 'desktop-v9.0.0')
        self.releases.append({'tag_name': 'desktop-v9.0.0', 'prerelease': True})
        releases = with_reservations(self.releases, ['desktop-v0.1.0', 'desktop-v9.0.0'])
        self.commit('fix(desktop): next commit')
        self.assertEqual(select_version(releases, '0.1.0')[:2], ('0.1.1', True))

    def test_deleted_historical_releases_preserve_beta_baseline(self):
        self.commit('feat(desktop): historical release')
        self.git('tag', 'desktop-v0.4.0')
        self.commit('feat(desktop): next historical release')
        self.git('tag', 'desktop-v0.5.0')
        tags = ['desktop-v0.4.0', 'desktop-v0.5.0']
        releases = with_reservations(self.releases, tags)
        self.assertEqual(select_version(releases, '0.1.0')[:2], ('0.5.0', False))
        self.commit('feat(desktop): recovery feature')
        self.git('tag', 'desktop-v1.0.0')
        releases = with_reservations(releases, tags + ['desktop-v1.0.0'])
        self.assertEqual(select_version(releases, '0.1.0')[:2], ('0.6.0', True))
        self.git('tag', 'desktop-v0.6.0')
        releases = with_reservations(releases, ['desktop-v0.6.0'])
        self.commit('fix(desktop): later change')
        with self.assertRaises(ValueError):
            select_version(releases, '0.1.0')

    def test_real_destination_draft_still_blocks_at_withdrawn_version(self):
        self.git('tag', 'desktop-v0.5.0')
        releases = with_reservations(self.releases, ['desktop-v0.5.0'])
        releases.append({'tag_name': 'desktop-v0.5.0', 'prerelease': False,
                         'draft': True, 'target_commitish': self.git('rev-parse', 'HEAD')})
        self.commit('feat(desktop): next feature')
        with self.assertRaises(ValueError):
            select_version(releases, '0.1.0')

    def test_withdrawn_release_version_is_not_reused(self):
        self.commit('fix(desktop): broken build')
        self.git('tag', 'desktop-v0.1.1')
        # The rollback procedure marks a broken stable release as a prerelease.
        self.releases.append({'tag_name': 'desktop-v0.1.1', 'prerelease': True})
        releases = with_reservations(self.releases, ['desktop-v0.1.0', 'desktop-v0.1.1'])
        self.commit('fix(desktop): repair broken build')
        self.assertEqual(select_version(releases, '0.1.0')[:2], ('0.1.2', True))

    def test_dependency_update_is_patch(self):
        self.commit('chore(deps): update dependencies', 'pnpm-lock.yaml')
        self.assertEqual(select_version(self.releases, '0.1.0')[:2], ('0.1.1', True))

    def test_feature_wins_over_fix(self):
        self.commit('feat(desktop): add feature')
        self.commit('fix(desktop): correct feature')
        self.assertEqual(select_version(self.releases, '0.1.0')[0], '0.2.0')

    def test_explicit_breaking_change_is_minor_during_beta(self):
        self.commit('feat(desktop)!: change contract')
        self.assertEqual(select_version(self.releases, '0.1.0')[0], '0.2.0')

    def test_accidental_major_is_excluded_but_tag_preserved(self):
        self.git('tag', 'desktop-v0.5.0')
        self.releases.append({'tag_name': 'desktop-v0.5.0', 'prerelease': False})
        self.commit('feat(desktop)!: beta change')
        self.git('tag', 'desktop-v1.0.0')
        self.releases.append({'tag_name': 'desktop-v1.0.0', 'prerelease': False})
        releases = with_reservations(self.releases, ['desktop-v1.0.0'])
        self.assertEqual(select_version(releases, '0.1.0')[:2], ('0.6.0', True))
        self.assertIn('desktop-v1.0.0', self.git('tag', '--list'))
        self.releases[-1] = {'tag_name': 'desktop-v1.0.0', 'prerelease': False,
                             'draft': True, 'target_commitish': self.git('rev-parse', 'HEAD')}
        self.assertEqual(select_version(self.releases, '0.1.0')[0], '0.6.0')

    def test_other_stable_majors_and_major_baseline_fail_closed(self):
        with self.assertRaises(ValueError):
            select_version([], '1.0.0')
        self.releases.append({'tag_name': 'desktop-v2.0.0', 'prerelease': False})
        with self.assertRaises(ValueError):
            select_version(self.releases, '0.1.0')

    def test_unrelated_breaking_change_is_ignored(self):
        self.commit('feat(web)!: change web contract', 'apps/client/app.ts')
        self.commit('fix(desktop): fix app')
        self.assertEqual(select_version(self.releases, '0.1.0')[0], '0.1.1')

    def test_docs_only_does_not_release(self):
        self.commit('docs(desktop): explain app', 'apps/desktop/README.md')
        self.assertEqual(select_version(self.releases, '0.1.0')[:2], ('0.1.0', False))

    def test_preview_uses_pr_title_and_is_not_stable(self):
        self.commit('Merge branch into test merge')
        result = select_version(self.releases, '0.1.0', '12', 'feat(desktop): add feature', '42')
        self.assertEqual(result[:2], ('0.2.0-pr.12.42', True))

    def test_prereleases_and_other_tags_are_not_baselines(self):
        self.releases += [{'tag_name': 'v2026.10.15', 'prerelease': False},
                          {'tag_name': 'desktop-v9.0.0', 'prerelease': True}]
        self.commit('fix(desktop): fix app')
        self.assertEqual(select_version(self.releases, '0.1.0')[0], '0.1.1')

    def test_latest_version_is_semantic_not_lexicographic(self):
        self.commit('fix(desktop): fix app')
        self.git('tag', 'desktop-v0.10.0')
        self.releases.append({'tag_name': 'desktop-v0.10.0', 'prerelease': False})
        self.commit('fix(desktop): another fix')
        self.assertEqual(select_version(self.releases, '0.1.0')[0], '0.10.1')

    def test_stale_checkout_fails_closed(self):
        original = self.git('rev-parse', 'HEAD')
        self.commit('fix(desktop): fix app')
        self.git('tag', 'desktop-v0.1.1')
        self.releases.append({'tag_name': 'desktop-v0.1.1', 'prerelease': False})
        self.git('checkout', '-q', original)
        with self.assertRaises(subprocess.CalledProcessError):
            select_version(self.releases, '0.1.0')

    def test_merge_uses_first_parent_diff(self):
        main = self.git('branch', '--show-current')
        self.git('checkout', '-qb', 'feature')
        self.commit('fix(desktop): feature implementation')
        self.git('checkout', '-q', main)
        self.git('merge', '--no-ff', '-qm', 'feat(desktop): merged feature', 'feature')
        self.assertEqual(select_version(self.releases, '0.1.0')[0], '0.2.0')

    def test_commit_rules(self):
        for message, level in [('fix: repair', 1), ('perf: faster', 1),
                               ('build: rebuild', 1), ('ci: adjust workflow', 0),
                               ('feat: feature', 2), ('feat!: breaking', 3),
                               ('fix: change\n\nBREAKING CHANGE: new format', 3),
                               ('fix: change\n\nBREAKING-CHANGE: new format', 3)]:
            with self.subTest(message=message):
                self.assertEqual(bump_level(message), level)

    def test_release_notes_are_scoped_and_explain_bump(self):
        self.commit('feat(web): unrelated', 'apps/client/page.tsx')
        self.commit('feat(desktop): add feature')
        notes = release_notes('0.2.0', 'desktop-v0.1.0', 'example/repo', 'example/dist')
        self.assertIn('Version selection: minor', notes)
        self.assertIn('https://github.com/example/dist/releases/latest/download/install.sh', notes)
        self.assertIn('feat(desktop): add feature', notes)
        self.assertNotIn('feat(web): unrelated', notes)
        self.assertIn('https://github.com/example/repo/commit/', notes)

    def test_notes_exclude_server_code_and_release_bookkeeping(self):
        self.commit('fix(retrieval): server-only change', 'b4m-core/services/src/llm/retrieval.ts')
        self.commit('fix(api): backend-only change', 'apps/client/pages/api/chat.ts')
        Path('apps/desktop/package.json').write_text('{"name":"@bike4mind/desktop","version":"0.1.1"}')
        self.git('add', '.')
        self.git('commit', '-qm', 'chore(release): version packages')
        self.commit('test(desktop): expand coverage', 'apps/desktop/src/app.test.ts')
        self.commit('fix(desktop): repair window')
        notes = release_notes('0.1.1', 'desktop-v0.1.0', 'example/repo', 'example/dist')
        self.assertIn('fix(desktop): repair window', notes)
        for subject in ('fix(retrieval)', 'fix(api)', 'chore(release)', 'test(desktop)'):
            self.assertNotIn(subject, notes)

    def test_notes_keep_shared_desktop_modules_not_whole_packages(self):
        sources = {
            'apps/desktop/src/imports.ts': """import '@unused';
import { parse } from '@bike4mind/cli/skills';
import { scan } from '@bike4mind/utils/artifactParser';
import { model } from '@bike4mind/common';
import { client } from '@bike4mind/mcp';""",
            'b4m-core/utils/package.json': '{"name":"@bike4mind/utils"}',
            'packages/cli/package.json': '{"name":"@bike4mind/cli"}',
            'b4m-core/common/package.json': '{"name":"@bike4mind/common"}',
            'b4m-core/mcp/package.json': '{"name":"@bike4mind/mcp"}',
            'b4m-core/utils/src/artifactParser.ts': "export { scan } from './scanner';",
            'b4m-core/utils/src/scanner.ts': 'export const scan = 1;',
            'packages/cli/src/skills/index.ts': "export { parse } from '../utils/commandParser.js';",
            'packages/cli/src/utils/commandParser.ts': 'export const parse = 1;',
        }
        for path, source in sources.items():
            file = Path(path)
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(source)
        self.commit('chore: shared baseline')
        self.git('tag', 'desktop-v0.1.1')
        for subject, path in (
            ('fix(utils): artifact scan', 'b4m-core/utils/src/scanner.ts'),
            ('fix(cli): skill parsing', 'packages/cli/src/utils/commandParser.ts'),
            ('fix(cli): unrelated command', 'packages/cli/src/core/agent.ts'),
            ('fix(utils): server extraction', 'b4m-core/utils/src/server.ts'),
            ('fix(common): shared model', 'b4m-core/common/src/models.ts'),
            ('fix(mcp): shared transport', 'b4m-core/mcp/src/client.ts'),
        ):
            self.commit(subject, path)
        from desktop_release_version import note_relevant
        for sha in self.git('rev-list', 'desktop-v0.1.1..HEAD').splitlines():
            subject = self.git('show', '-s', '--format=%s', sha)
            self.assertEqual(note_relevant(sha), 'unrelated' not in subject and 'server extraction' not in subject)

    def test_notes_explain_empty_maintenance_release(self):
        self.commit('test(desktop): expand coverage', 'apps/desktop/src/app.test.ts')
        notes = release_notes('0.1.1', 'desktop-v0.1.0', 'example/repo', 'example/dist')
        self.assertIn('Maintenance release; no desktop-facing changes.', notes)
        self.assertNotIn('test(desktop): expand coverage', notes)


if __name__ == '__main__':
    unittest.main()
