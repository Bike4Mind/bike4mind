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
  });
  return { store, fake, out, monitor };
}

describe('desktopMergeReadiness', () => {
  it('is ready only when approved, mergeable, clean and every check passed or skipped', () => {
    expect(desktopMergeReadiness(ready())).toEqual({ ready: true, method: 'squash' });
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
    expect(out.last()?.autoMerge.note).toMatch(/Auto-merge stopped/);
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
