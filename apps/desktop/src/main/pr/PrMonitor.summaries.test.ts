import { describe, expect, it } from 'vitest';
import type { ChatToolCall } from '@shared/chat';
import type { PrSummaryEvent } from '@shared/pullRequest';
import type { PrMonitorDeps } from './PrMonitor';
import { REF, TrackedMonitor, collector, fakeGithub, quietLogger, snapshot, tempStore } from './prTestSupport';

const SESSION = 'session-1';

function setup(branch: string | null = null) {
  const store = tempStore();
  const fake = fakeGithub();
  const github = Object.assign(fake.github, { findOpenForBranch: async () => REF.url });
  const out = collector();
  const pushed: PrSummaryEvent[] = [];
  const deps: PrMonitorDeps = {
    store,
    github,
    chat: {
      isCode: async () => true,
      project: async () => (branch ? { workingDirectory: '/repo', branch } : null),
      archive: async () => undefined,
      isBusy: () => false,
      startAutoFix: async () => ({ ok: false as const, busy: true, error: 'busy' }),
    },
    emit: out.emit,
    emitSummary: event => pushed.push(event),
    logger: quietLogger,
    batchWindowMs: 0,
  };
  const monitor = new TrackedMonitor(deps);
  return { store, fake, out, monitor, pushed, deps };
}

const bound = { ...REF, source: 'shell' as const, boundAt: '' };

function shellCall(command: string, preview: string): ChatToolCall {
  return { id: 'c1', name: 'bash_execute', input: { command }, status: 'done', preview };
}

describe('PrMonitor sidebar summaries', () => {
  it('builds every summary from the binding file without reading GitHub', async () => {
    const { store, fake, monitor } = setup();
    await store.set('open', { ...bound, lastState: 'OPEN' });
    await store.set('draft', { ...bound, number: 7, lastState: 'OPEN', lastDraft: true });
    await store.set('merged', {
      ...bound,
      lastState: 'MERGED',
      finalSnapshot: { ...snapshot({ state: 'MERGED' }), checks: [] },
    });
    await store.set('dismissed', { ...bound, lastState: 'CLOSED', dismissed: true });
    await store.set('never-read', bound);

    expect(await monitor.summaries()).toEqual([
      { sessionId: 'open', summary: { number: 611, state: 'open' } },
      { sessionId: 'draft', summary: { number: 7, state: 'draft' } },
      { sessionId: 'merged', summary: { number: 611, state: 'merged' } },
    ]);
    await monitor.idle();
    expect(fake.calls).toEqual([]);
    expect(fake.batches).toEqual([]);
    monitor.dispose();
  });

  it('pushes only when a session icon actually changes', async () => {
    const { fake, monitor, pushed } = setup();
    await monitor.bindManual(SESSION, REF.url);
    await monitor.idle();
    expect(pushed).toEqual([{ sessionId: SESSION, summary: { number: 611, state: 'open' } }]);

    await monitor.refresh(SESSION);
    expect(pushed).toHaveLength(1);

    fake.answer(snapshot({ isDraft: true }));
    await monitor.refresh(SESSION);
    fake.answer(snapshot({ state: 'MERGED' }));
    await monitor.refresh(SESSION);
    expect(pushed.slice(1).map(event => event.summary?.state)).toEqual(['draft', 'merged']);
    monitor.dispose();
  });

  it('matches what the bar shows for the same read', async () => {
    const { fake, out, monitor, pushed } = setup();
    fake.answer(snapshot({ state: 'CLOSED' }));
    await monitor.bindManual(SESSION, REF.url);
    await monitor.idle();
    expect(out.last()?.snapshot?.state).toBe('CLOSED');
    expect(pushed[pushed.length - 1]?.summary?.state).toBe('closed');
    monitor.dispose();
  });

  it('drops the icon when the bar is dismissed, also after a relaunch', async () => {
    const { monitor, pushed, deps } = setup();
    await monitor.bindManual(SESSION, REF.url);
    await monitor.idle();
    await monitor.dismiss(SESSION);
    expect(pushed[pushed.length - 1]).toEqual({ sessionId: SESSION, summary: null });
    expect(await monitor.summaries()).toEqual([]);
    monitor.dispose();

    const relaunched = new TrackedMonitor(deps);
    expect(await relaunched.summaries()).toEqual([]);
    relaunched.dispose();
  });

  it('keeps a dismissed icon gone when the same PR is detected again', async () => {
    const { monitor, pushed } = setup('feature');
    await monitor.bindManual(SESSION, REF.url);
    await monitor.idle();
    await monitor.dismiss(SESSION);
    const before = pushed.length;

    monitor.observeToolEnd(SESSION, shellCall('git push', `remote:   ${REF.url}`));
    monitor.observeToolEnd(SESSION, shellCall('gh pr create', REF.url));
    await monitor.watch(1, SESSION);
    await monitor.idle();
    expect(pushed).toHaveLength(before);
    expect(await monitor.summaries()).toEqual([]);
    monitor.dispose();
  });

  it('brings the icon back on a manual bind of the same PR, or when another PR is detected', async () => {
    const { monitor, pushed } = setup();
    await monitor.bindManual(SESSION, REF.url);
    await monitor.idle();
    await monitor.dismiss(SESSION);

    await monitor.bindManual(SESSION, REF.url);
    await monitor.idle();
    expect(pushed[pushed.length - 1]).toEqual({ sessionId: SESSION, summary: { number: 611, state: 'open' } });

    await monitor.dismiss(SESSION);
    monitor.observeToolEnd(SESSION, shellCall('gh pr create', 'https://github.com/example-org/widgets/pull/700'));
    await monitor.idle();
    expect(pushed[pushed.length - 1]).toEqual({ sessionId: SESSION, summary: { number: 700, state: 'open' } });
    monitor.dispose();
  });

  it('drops the icon when the session is deleted', async () => {
    const { monitor, pushed } = setup();
    await monitor.bindManual(SESSION, REF.url);
    await monitor.idle();
    await monitor.forget(SESSION);
    expect(pushed[pushed.length - 1]).toEqual({ sessionId: SESSION, summary: null });
    expect(await monitor.summaries()).toEqual([]);
    monitor.dispose();
  });

  it('remembers a draft across a relaunch', async () => {
    const { store, fake, monitor } = setup();
    fake.answer(snapshot({ isDraft: true }));
    await monitor.bindManual(SESSION, REF.url);
    await monitor.idle();
    expect(await store.get(SESSION)).toMatchObject({ lastState: 'OPEN', lastDraft: true });
    monitor.dispose();
  });

  it('shows a PR in the merge queue as queued, open again once it leaves, and merged when it lands', async () => {
    const { fake, out, monitor, pushed } = setup();
    const inQueue = { enabled: true, entry: { state: 'QUEUED', position: 1 } };
    fake.answer(snapshot({ mergeQueue: inQueue }));
    await monitor.bindManual(SESSION, REF.url);
    await monitor.idle();
    expect(out.last()?.autoMerge.queued).toEqual({ position: 1 });
    expect(pushed[pushed.length - 1]?.summary?.state).toBe('queued');

    fake.answer(snapshot({ mergeQueue: { enabled: true } }));
    await monitor.refresh(SESSION);
    expect(pushed[pushed.length - 1]?.summary?.state).toBe('open');

    fake.answer(snapshot({ mergeQueue: inQueue }));
    await monitor.refresh(SESSION);
    fake.answer(snapshot({ state: 'MERGED', mergeQueue: inQueue }));
    await monitor.refresh(SESSION);
    expect(pushed.slice(-2).map(event => event.summary?.state)).toEqual(['queued', 'merged']);
    monitor.dispose();
  });

  it('never shows queued from the binding file: only a read this launch says a PR is in the queue', async () => {
    const first = setup();
    first.fake.answer(snapshot({ mergeQueue: { enabled: true, entry: { state: 'QUEUED', position: 1 } } }));
    await first.monitor.bindManual(SESSION, REF.url);
    await first.monitor.idle();
    expect((await first.monitor.summaries())[0]?.summary?.state).toBe('queued');
    first.monitor.dispose();

    const relaunched = new TrackedMonitor(first.deps);
    expect(await relaunched.summaries()).toEqual([{ sessionId: SESSION, summary: { number: 611, state: 'open' } }]);
    relaunched.dispose();
  });
});
