import { describe, expect, it } from 'vitest';
import type { PrBinding, PrSnapshot } from '@shared/pullRequest';
import { desktopMergeReadiness } from './autoMerge';
import { GhError } from './gh';
import { PrMonitor } from './PrMonitor';
import { REF, check, collector, fakeGithub, quietLogger, snapshot, tempStore } from './prTestSupport';

const SESSION = 'session-1';
const bound: PrBinding = { ...REF, source: 'shell', boundAt: '', lastState: 'OPEN' };

const ready = (overrides: Partial<PrSnapshot> = {}) =>
  snapshot({
    reviewDecision: 'APPROVED',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    checks: [check('Build', 'pass'), check('Docs', 'skipped', false)],
    headSha: 'sha-ready',
    ...overrides,
  });

function setup(initial: PrSnapshot) {
  const store = tempStore();
  const fake = fakeGithub(initial);
  const out = collector();
  const monitor = new PrMonitor({
    store,
    github: fake.github,
    chat: {
      isCode: async () => true,
      project: async () => null,
      archive: async () => undefined,
      isBusy: () => false,
      startAutoFix: async () => ({ ok: false as const, busy: true, error: 'busy' }),
    },
    emit: out.emit,
    logger: quietLogger,
    batchWindowMs: 0,
  });
  return { store, fake, out, monitor };
}

describe('desktopMergeReadiness', () => {
  it('is ready only when approved, mergeable, clean and every check passed or skipped', () => {
    expect(desktopMergeReadiness(ready())).toEqual({ ready: true, via: 'merge', method: 'squash' });
  });

  it('enqueues instead on a base branch with a merge queue, whatever methods the repo allows', () => {
    const queue = { mergeQueue: { enabled: true } };
    expect(desktopMergeReadiness(ready(queue))).toEqual({ ready: true, via: 'queue' });
    expect(
      desktopMergeReadiness(ready({ ...queue, repoSettings: { autoMergeAllowed: false, allowedMethods: [] } }))
    ).toEqual({ ready: true, via: 'queue' });
  });

  it.each([
    ['a draft', { isDraft: true }],
    ['conflicts', { mergeable: 'CONFLICTING' as const }],
    ['unknown mergeability', { mergeable: 'UNKNOWN' as const }],
    ['no approval', { reviewDecision: 'REVIEW_REQUIRED' as const }],
    ['changes requested', { reviewDecision: 'CHANGES_REQUESTED' as const }],
    ['a required check running', { checks: [check('Build', 'pending')] }],
    ['a required check failing', { checks: [check('Build', 'fail')] }],
    ['an optional check failing', { checks: [check('Build', 'pass'), check('Lint', 'fail', false)] }],
    ['blocked by branch protection', { mergeStateStatus: 'BLOCKED' }],
    ['behind the base', { mergeStateStatus: 'BEHIND' }],
    ['unstable', { mergeStateStatus: 'UNSTABLE' }],
    ['closed', { state: 'CLOSED' as const }],
    ['no merge method', { repoSettings: { autoMergeAllowed: false, allowedMethods: [] } }],
  ])('is not ready with %s', (_label, overrides) => {
    expect(desktopMergeReadiness(ready(overrides)).ready).toBe(false);
  });
});

describe('PrMonitor auto-merge on a repo with GitHub auto-merge', () => {
  const native = (overrides: Partial<PrSnapshot> = {}) =>
    snapshot({
      repoSettings: { autoMergeAllowed: true, allowedMethods: ['squash', 'merge'], defaultMethod: 'merge' },
      ...overrides,
    });

  it('arms it on GitHub with the repo method, and cancels it on uncheck', async () => {
    const { store, fake, out, monitor } = setup(native());
    await store.set(SESSION, bound);
    fake.github.enableAutoMerge = async (_ref, method) => {
      fake.calls.push(`enable-auto:${method}`);
      fake.answer(native({ autoMergeArmed: true }));
    };
    expect(await monitor.setOption(SESSION, 'autoMerge', true)).toEqual({ ok: true });
    expect(fake.calls).toContain('enable-auto:merge');
    expect(await store.get(SESSION)).toMatchObject({ autoMerge: true, autoMergeMode: 'github' });
    expect(out.last()?.autoMerge.mode).toBe('github');

    expect(await monitor.setOption(SESSION, 'autoMerge', false)).toEqual({ ok: true });
    expect(fake.calls).toContain('disable-auto');
    expect((await store.get(SESSION))?.autoMerge).toBe(false);
    expect(fake.calls.some(call => call.startsWith('merge:'))).toBe(false);
  });

  it('keeps the box checked when cancelling fails and GitHub still has it armed', async () => {
    const { store, fake, monitor } = setup(native({ autoMergeArmed: true }));
    await store.set(SESSION, { ...bound, autoMerge: true, autoMergeMode: 'github' });
    fake.github.disableAutoMerge = async () => {
      throw new GhError('failed', 'network down');
    };
    expect(await monitor.setOption(SESSION, 'autoMerge', false)).toMatchObject({ ok: false });
    expect((await store.get(SESSION))?.autoMerge).toBe(true);
  });

  it('does not tick the box when GitHub refuses to arm it', async () => {
    const { store, fake, monitor } = setup(native());
    await store.set(SESSION, bound);
    fake.github.enableAutoMerge = async () => {
      throw new GhError('failed', 'Pull request is in clean status');
    };
    expect(await monitor.setOption(SESSION, 'autoMerge', true)).toMatchObject({ ok: false });
    expect((await store.get(SESSION))?.autoMerge).toBeUndefined();
  });

  it('clears the flag when GitHub turns auto-merge off on its own', async () => {
    const { store, fake, out, monitor } = setup(native({ autoMergeArmed: false }));
    await store.set(SESSION, { ...bound, autoMerge: true, autoMergeMode: 'github' });
    await monitor.refresh(SESSION);
    expect((await store.get(SESSION))?.autoMerge).toBe(false);
    expect(out.last()?.autoMerge.note).toMatch(/turned auto-merge off/);
    expect(fake.calls.some(call => call.startsWith('merge:'))).toBe(false);
  });
});

describe('PrMonitor auto-merge on a repo without it (desktop merges)', () => {
  it('waits while the PR is not ready, saying why', async () => {
    const { store, fake, out, monitor } = setup(snapshot({ reviewDecision: 'REVIEW_REQUIRED' }));
    await store.set(SESSION, bound);
    expect(await monitor.setOption(SESSION, 'autoMerge', true)).toEqual({ ok: true });
    expect(await store.get(SESSION)).toMatchObject({ autoMerge: true, autoMergeMode: 'desktop' });
    expect(fake.calls.some(call => call.startsWith('merge:'))).toBe(false);
    expect(out.last()?.autoMerge).toMatchObject({ mode: 'desktop', note: expect.stringMatching(/approving review/) });
  });

  it('merges once ready, pinned to the head commit it checked', async () => {
    const { store, fake, monitor } = setup(snapshot({ reviewDecision: 'REVIEW_REQUIRED' }));
    await store.set(SESSION, bound);
    await monitor.setOption(SESSION, 'autoMerge', true);
    fake.answer(ready());
    await monitor.refresh(SESSION);
    expect(fake.calls.filter(call => call.startsWith('merge:'))).toEqual(['merge:squash:sha-ready']);
  });

  it('disarms instead of retrying when GitHub refuses the merge', async () => {
    const { store, fake, out, monitor } = setup(ready());
    await store.set(SESSION, { ...bound, autoMerge: true, autoMergeMode: 'desktop' });
    fake.github.merge = async () => {
      throw new GhError('failed', 'Head branch was modified');
    };
    await monitor.refresh(SESSION);
    expect((await store.get(SESSION))?.autoMerge).toBe(false);
    expect(out.last()?.autoMerge).toMatchObject({
      mode: null,
      error: 'Auto-merge stopped: GitHub refused the merge: Head branch was modified',
    });
    expect(out.last()?.autoMerge.note).toBeUndefined();
  });

  it('cancels by unchecking before it is ready, and then never merges', async () => {
    const { store, fake, monitor } = setup(snapshot({ reviewDecision: 'REVIEW_REQUIRED' }));
    await store.set(SESSION, bound);
    await monitor.setOption(SESSION, 'autoMerge', true);
    expect(await monitor.setOption(SESSION, 'autoMerge', false)).toEqual({ ok: true });
    fake.answer(ready());
    await monitor.refresh(SESSION);
    expect(fake.calls.some(call => call.startsWith('merge:'))).toBe(false);
    expect(fake.calls).not.toContain('disable-auto');
  });

  it('starts a newly bound PR with auto-merge off, whatever the last one had', async () => {
    const { store, monitor } = setup(snapshot());
    await store.set(SESSION, { ...bound, autoMerge: false, autoArchive: false });
    await monitor.bindManual(SESSION, 'https://github.com/example-org/widgets/pull/700');
    const next = await store.get(SESSION);
    expect(next?.number).toBe(700);
    expect(next?.autoMerge).toBeUndefined();
    monitor.dispose();
  });
});

describe('PrMonitor auto-merge on a merge-queue base (desktop enqueues)', () => {
  const queued = (overrides: Partial<PrSnapshot> = {}) =>
    ready({ nodeId: 'PR_node', mergeQueue: { enabled: true }, ...overrides });
  const armed: PrBinding = { ...bound, autoMerge: true, autoMergeMode: 'desktop' };

  it('enqueues on refresh, straight from that read, and never merges directly', async () => {
    const { store, fake, out, monitor } = setup(queued());
    await store.set(SESSION, armed);
    await monitor.refresh(SESSION);
    expect(fake.calls.filter(call => call.startsWith('enqueue:') || call.startsWith('merge:'))).toEqual([
      'enqueue:PR_node:sha-ready',
    ]);
    expect((await store.get(SESSION))?.mergeQueuedAt).toEqual(expect.any(String));
    expect(out.last()?.autoMerge).toMatchObject({
      mode: 'desktop',
      queued: { position: 1 },
      note: expect.stringMatching(/Queued to merge \(position 1\)/),
    });
    monitor.dispose();
  });

  it('still merges directly on a base without a queue', async () => {
    const { store, fake, monitor } = setup(ready({ mergeQueue: { enabled: false } }));
    await store.set(SESSION, armed);
    await monitor.refresh(SESSION);
    expect(fake.calls.filter(call => call.startsWith('enqueue:') || call.startsWith('merge:'))).toEqual([
      'merge:squash:sha-ready',
    ]);
    monitor.dispose();
  });

  it('shows a refused enqueue in place of a waiting note, and stops', async () => {
    const { store, fake, out, monitor } = setup(queued());
    await store.set(SESSION, armed);
    fake.github.enqueue = async () => {
      throw new GhError('failed', 'Pull request is not mergeable');
    };
    await monitor.refresh(SESSION);
    const binding = await store.get(SESSION);
    expect(binding?.autoMerge).toBe(false);
    expect(binding?.mergeQueuedAt).toBeUndefined();
    expect(out.last()?.autoMerge).toEqual({
      mode: null,
      error: 'Auto-merge stopped: GitHub would not queue it: Pull request is not mergeable',
    });
    monitor.dispose();
  });

  it('treats a queued PR as merging, reads why it left, and does not queue it again', async () => {
    const { store, fake, out, monitor } = setup(
      queued({ mergeQueue: { enabled: true, entry: { state: 'AWAITING_CHECKS', position: 2 } } })
    );
    await store.set(SESSION, { ...armed, mergeQueuedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
    await monitor.refresh(SESSION);
    expect(out.last()?.autoMerge).toMatchObject({ queued: { position: 2 }, note: 'Queued to merge (position 2).' });
    expect(fake.calls).toContain('snapshot+queue');
    expect(await monitor.setOption(SESSION, 'autoMerge', false)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/merge queue/),
    });

    fake.answer(
      queued({
        mergeQueue: {
          enabled: true,
          removed: { at: new Date().toISOString(), reason: 'Required status check failed' },
        },
      })
    );
    await monitor.refresh(SESSION);
    expect(fake.calls.some(call => call.startsWith('enqueue:'))).toBe(false);
    expect((await store.get(SESSION))?.autoMerge).toBe(false);
    expect(out.last()?.autoMerge).toEqual({
      mode: null,
      error: 'Auto-merge stopped: the merge queue removed this PR: Required status check failed',
    });
    monitor.dispose();
  });

  it('waits out GitHub catching up right after the enqueue', async () => {
    const { store, fake, out, monitor } = setup(queued());
    await store.set(SESSION, { ...armed, mergeQueuedAt: new Date().toISOString() });
    await monitor.refresh(SESSION);
    expect((await store.get(SESSION))?.autoMerge).toBe(true);
    expect(out.last()?.autoMerge.note).toBe('Queued to merge.');
    expect(fake.calls.some(call => call.startsWith('enqueue:'))).toBe(false);
    monitor.dispose();
  });

  it('clears the queue mark once the PR has merged', async () => {
    const { store, monitor } = setup(queued({ state: 'MERGED' }));
    await store.set(SESSION, { ...armed, mergeQueuedAt: new Date().toISOString() });
    await monitor.refresh(SESSION);
    const binding = await store.get(SESSION);
    expect(binding?.autoMerge).toBe(false);
    expect(binding?.mergeQueuedAt).toBeUndefined();
    monitor.dispose();
  });
});
