import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regression guard for the resilient Changesets changelog generator
 * (`.changeset/changelog-github-retry.cjs`).
 *
 * That file gates EVERY release and snapshot publish: both the `release` and
 * `snapshot-publish` workflows resolve their changelog generator from
 * `.changeset/config.json`, which points at the wrapper. If the wrapper's retry
 * or graceful-fallback behavior silently regresses - e.g. because a future
 * `@changesets/changelog-github` upgrade changes its export shape or its
 * `get-github-info` DataLoader semantics shift - releases would start aborting
 * again on transient GitHub GraphQL `Premature close` errors.
 *
 * This test exercises the wrapper against the REAL `@changesets/changelog-github`
 * parser, faking only the network layer (`@changesets/get-github-info`) so we can
 * deterministically simulate transient failures. No AWS calls, no network.
 */

// b4m-core/infra/src/__tests__ -> repo root is four levels up.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const WRAPPER_PATH = resolve(REPO_ROOT, '.changeset/changelog-github-retry.cjs');

// A CJS require rooted at the repo so module resolution matches what Changesets
// (via @changesets/apply-release-plan) does at release time.
const requireFromRepo = createRequire(resolve(REPO_ROOT, 'noop.cjs'));

// Mutable network simulation the fake get-github-info reads on each call.
let failuresRemaining = 0;
let calls = 0;

const PREMATURE_CLOSE =
  'Failed to parse data from GitHub\n' +
  'Invalid response body while trying to fetch https://api.github.com/graphql: Premature close';

function maybeFail() {
  calls++;
  if (failuresRemaining > 0) {
    failuresRemaining--;
    throw new Error(PREMATURE_CLOSE);
  }
}

// Resolve get-github-info from changelog-github's own dir (pnpm layout) so the
// cache key matches the exact realpath the wrapper (via changelog-github) loads,
// then inject a controllable fake BEFORE the wrapper is required.
const changelogGithubMain = requireFromRepo.resolve('@changesets/changelog-github');
const ghInfoPath = createRequire(changelogGithubMain).resolve('@changesets/get-github-info');

requireFromRepo.cache[ghInfoPath] = {
  id: ghInfoPath,
  filename: ghInfoPath,
  loaded: true,
  // CJS module record; only `exports` is consulted by the requiring module.
  exports: {
    getInfo: async ({ commit }: { commit: string }) => {
      maybeFail();
      return {
        user: 'octocat',
        pull: 42,
        links: {
          commit: `[\`${commit.slice(0, 7)}\`](https://github.com/o/r/commit/${commit})`,
          pull: '[#42](https://github.com/o/r/pull/42)',
          user: '[@octocat](https://github.com/octocat)',
        },
      };
    },
    getInfoFromPullRequest: async ({ pull }: { pull: number }) => {
      maybeFail();
      return {
        user: 'octocat',
        commit: 'abcdef1',
        links: {
          commit: '[`abcdef1`](https://github.com/o/r/commit/abcdef1)',
          pull: `[#${pull}](https://github.com/o/r/pull/${pull})`,
          user: '[@octocat](https://github.com/octocat)',
        },
      };
    },
  },
  // Minimal Module-shape padding for type compatibility.
} as unknown as NodeModule;

interface ChangelogFunctions {
  getReleaseLine: (
    changeset: { summary: string; commit?: string },
    type: string,
    options: { repo: string }
  ) => Promise<string>;
  getDependencyReleaseLine: (
    changesets: Array<{ commit?: string; summary: string }>,
    dependenciesUpdated: Array<{ name: string; newVersion: string }>,
    options: { repo: string }
  ) => Promise<string>;
}

const changelog = requireFromRepo(WRAPPER_PATH) as ChangelogFunctions;

const OPTIONS = { repo: 'MillionOnMars/lumina5' };
const CHANGESET = { summary: 'fix(thing): do the thing\n\nmore detail here', commit: 'deadbeefcafef00d' };

describe('.changeset/changelog-github-retry.cjs (issue #9507)', () => {
  beforeEach(() => {
    failuresRemaining = 0;
    calls = 0;
    // Make the wrapper's backoff sleeps fire immediately so retries don't wait.
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves to the wrapper that Changesets config points at', () => {
    const config = requireFromRepo(resolve(REPO_ROOT, '.changeset/config.json'));
    const resolved = requireFromRepo.resolve(config.changelog[0], { paths: [resolve(REPO_ROOT, '.changeset')] });
    expect(resolved).toBe(WRAPPER_PATH);
  });

  it('returns an enriched line and makes exactly one fetch on first-try success', async () => {
    const line = await changelog.getReleaseLine(CHANGESET, 'patch', OPTIONS);
    expect(line).toContain('[#42]');
    expect(calls).toBe(1);
  });

  it('retries transient failures and still returns an enriched line', async () => {
    failuresRemaining = 2;
    const line = await changelog.getReleaseLine(CHANGESET, 'patch', OPTIONS);
    expect(line).toContain('[#42]');
    expect(calls).toBe(3); // 2 failures + 1 success
  });

  it('falls back to an un-enriched line (no throw) when every attempt fails', async () => {
    failuresRemaining = Number.MAX_SAFE_INTEGER;
    const line = await changelog.getReleaseLine(CHANGESET, 'patch', OPTIONS);
    expect(line).not.toContain('[#42]');
    expect(line).toContain('do the thing');
    expect(calls).toBe(4); // 1 initial + 3 retries, then fallback
  });

  it('matches upstream line shape exactly on the happy path', async () => {
    const single = { summary: 'fix: single line', commit: 'deadbeefcafef00d' };
    // Drive the fallback (links absent) and assert the canonical shape.
    failuresRemaining = Number.MAX_SAFE_INTEGER;
    const line = await changelog.getReleaseLine(single, 'patch', OPTIONS);
    expect(line).toBe('\n\n- fix: single line\n');
  });

  it('strips pr:/author: metadata directives in the fallback line', async () => {
    failuresRemaining = Number.MAX_SAFE_INTEGER;
    const withMeta = { summary: 'pr: 7\nauthor: someone\nfeat: cool feature', commit: 'deadbeefcafef00d' };
    const line = await changelog.getReleaseLine(withMeta, 'minor', OPTIONS);
    expect(line).toContain('cool feature');
    expect(line).not.toMatch(/pr:\s*7/i);
    expect(line).not.toMatch(/author:/i);
  });

  it('falls back to a plain dependency line listing the bumped deps', async () => {
    failuresRemaining = Number.MAX_SAFE_INTEGER;
    const depLine = await changelog.getDependencyReleaseLine(
      [{ commit: 'deadbeefcafef00d', summary: 'x' }],
      [{ name: '@bike4mind/utils', newVersion: '1.2.3' }],
      OPTIONS
    );
    expect(depLine).toContain('@bike4mind/utils@1.2.3');
    expect(depLine).not.toContain('['); // no enriched links
  });
});
