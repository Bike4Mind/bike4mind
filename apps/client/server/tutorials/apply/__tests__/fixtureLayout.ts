import type { TutorialRepoLayout } from '../layout';

export const FIXTURE_OWNER = 'fixture-pkg';

/** A layout unlike core's: another owner, a version array named differently and located by position. */
export function fixtureLayout(patch: Partial<TutorialRepoLayout> = {}): TutorialRepoLayout {
  return {
    owner: FIXTURE_OWNER,
    repoOf: owner => (owner === 'core' ? 'the core repo' : undefined),
    root: '/repo',
    modulesDir: 'src/tutorials/modules',
    version: { path: 'src/tutorials/entries.ts', arrayName: 'ENTRIES', locate: 'index' },
    repoModules: () => [],
    policy: {
      editable: {
        'fixture-mod': {
          opening: ['body'],
          'score-alone': ['title', 'body', 'prompt'],
          'hand-over-sheet': ['prompt'],
          read: ['body'],
        },
      },
      pinned: { 'fixture-mod': { 'forte-runs': ['title'] } },
    },
    header: '',
    moduleFiles: (_content, dir) => ({ dir, files: [], issues: [], registration: [] }),
    registers: ['src/tutorials/entries.ts'],
    fieldsCommand: 'pnpm tutorials:fields',
    guard: { test: 'src/tutorials/guard.test.ts' },
    ...patch,
  };
}
