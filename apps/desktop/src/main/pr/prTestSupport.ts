import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrBarState, PrBindingSource, PrCheck, PrMergeMethod, PrRef, PrSnapshot } from '@shared/pullRequest';
import type { PrGithub } from './github';
import { PrBindingStore } from './PrBindingStore';
import { PrMonitor } from './PrMonitor';

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
    baseSha: 'base-1',
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
  const batches: number[] = [];
  const github = {
    snapshot: async (_ref: PrRef, options: { threads: boolean }) => {
      calls.push(`snapshot${options.threads ? '+threads' : ''}`);
      if (next instanceof Error) throw next;
      return next;
    },
    snapshots: async (requests: readonly { ref: PrRef; threads: boolean; queue?: boolean }[]) => {
      batches.push(requests.length);
      for (const request of requests) {
        calls.push(`snapshot${request.threads ? '+threads' : ''}${request.queue ? '+queue' : ''}`);
      }
      if (next instanceof Error) throw next;
      const answer = next;
      return requests.map(request => ({ ...answer, ...request.ref }));
    },
    findOpenForBranch: async (_cwd: string, branch: string) => {
      calls.push(`branch:${branch}`);
      return null as string | null;
    },
    enableAutoMerge: async (_ref: PrRef, method: PrMergeMethod) => {
      calls.push(`enable-auto:${method}`);
    },
    disableAutoMerge: async (_ref: PrRef) => {
      calls.push('disable-auto');
    },
    merge: async (_ref: PrRef, method: PrMergeMethod, sha: string) => {
      calls.push(`merge:${method}:${sha}`);
    },
    enqueue: async (nodeId: string, sha: string) => {
      calls.push(`enqueue:${nodeId}:${sha}`);
      return 1;
    },
  };
  return {
    github: github as unknown as PrGithub,
    calls,
    batches,
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

/**
 * A monitor that tracks every read, bind, schedule, publish, branch lookup and auto-fix decision
 * it starts, including the ones it fires and forgets, so a test can wait for all of them instead
 * of sleeping. A fixed sleep raced the binding store's real disk writes and failed under load.
 */
export class TrackedMonitor extends PrMonitor {
  private readonly work = new Set<Promise<unknown>>();

  private track<T>(promise: Promise<T>): Promise<T> {
    this.work.add(promise);
    void promise.then(
      () => this.work.delete(promise),
      () => this.work.delete(promise)
    );
    return promise;
  }

  protected override read(sessionId: string): Promise<void> {
    return this.track(super.read(sessionId));
  }

  protected override bind(sessionId: string, ref: PrRef, source: PrBindingSource): Promise<void> {
    return this.track(super.bind(sessionId, ref, source));
  }

  protected override schedule(sessionId: string): Promise<void> {
    return this.track(super.schedule(sessionId));
  }

  protected override publish(sessionId: string): Promise<void> {
    return this.track(super.publish(sessionId));
  }

  protected override lookUpBranch(sessionId: string): Promise<void> {
    return this.track(super.lookUpBranch(sessionId));
  }

  protected override evaluateAutoFix(sessionId: string, snapshot: PrSnapshot): Promise<void> {
    return this.track(super.evaluateAutoFix(sessionId, snapshot));
  }

  /** Everything started so far, and anything that work started in turn, has finished. */
  async idle(): Promise<void> {
    while (this.work.size > 0) await Promise.allSettled([...this.work]);
  }
}
