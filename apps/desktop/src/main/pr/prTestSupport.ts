import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrBarState, PrCheck, PrRef, PrSnapshot } from '@shared/pullRequest';
import type { PrGithub } from './github';
import { PrBindingStore } from './PrBindingStore';

/** Test-only fixtures for the PR monitor. Every repo and PR here is made up. */

export const REF: PrRef = {
  owner: 'example-org',
  repo: 'widgets',
  number: 611,
  url: 'https://github.com/example-org/widgets/pull/611',
};

export function snapshot(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    ...REF,
    title: 'feat: ladder',
    author: 'octo-dev',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'feat/widget-ladder',
    headSha: 'sha-1',
    baseRefName: 'main',
    additions: 157,
    deletions: 0,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'BLOCKED',
    reviewDecision: 'REVIEW_REQUIRED',
    autoMergeArmed: false,
    checks: [],
    repoSettings: { autoMergeAllowed: false, allowedMethods: ['squash'], defaultMethod: 'squash' },
    viewer: 'octo-dev',
    fetchedAt: 0,
    ...overrides,
  };
}

export function check(name: string, bucket: PrCheck['bucket'], required = true): PrCheck {
  return { name, bucket, required, url: `https://github.com/example-org/widgets/actions/runs/1/${name}` };
}

/** A PrGithub whose answers the test sets, recording every call. */
export function fakeGithub(initial: PrSnapshot = snapshot()) {
  let next: PrSnapshot | Error = initial;
  const calls: string[] = [];
  const github = {
    snapshot: async (_ref: PrRef, options: { threads: boolean }) => {
      calls.push(`snapshot${options.threads ? '+threads' : ''}`);
      if (next instanceof Error) throw next;
      return next;
    },
    findOpenForBranch: async (_cwd: string, branch: string) => {
      calls.push(`branch:${branch}`);
      return null as string | null;
    },
    enableAutoMerge: async () => {
      calls.push('enable-auto');
    },
    disableAutoMerge: async () => {
      calls.push('disable-auto');
    },
    merge: async (_ref: PrRef, method: string, sha: string) => {
      calls.push(`merge:${method}:${sha}`);
    },
  };
  return {
    github: github as unknown as PrGithub & typeof github,
    calls,
    answer(value: PrSnapshot | Error) {
      next = value;
    },
  };
}

export function tempStore(): PrBindingStore {
  return new PrBindingStore(join(mkdtempSync(join(tmpdir(), 'b4m-pr-')), 'pull-requests.json'));
}

export function collector() {
  const states: PrBarState[] = [];
  return { states, emit: (state: PrBarState) => states.push(state), last: () => states[states.length - 1] };
}

export const quietLogger = { debug: () => undefined, warn: () => undefined };
