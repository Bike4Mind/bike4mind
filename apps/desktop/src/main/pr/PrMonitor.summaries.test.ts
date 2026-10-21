import { describe, expect, it } from 'vitest';
import type { PrSummaryEvent } from '@shared/pullRequest';
import { REF, TrackedMonitor, collector, fakeGithub, quietLogger, snapshot, tempStore } from './prTestSupport';

const SESSION = 'session-1';

function setup() {
  const store = tempStore();
  const fake = fakeGithub();
  const out = collector();
  const pushed: PrSummaryEvent[] = [];
  const monitor = new TrackedMonitor({
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
    emitSummary: event => pushed.push(event),
    logger: quietLogger,
    batchWindowMs: 0,
  });
  return { store, fake, out, monitor, pushed };
}

const bound = { ...REF, source: 'shell' as const, boundAt: '' };

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
      { sessionId: 'dismissed', summary: { number: 611, state: 'closed' } },
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

  it('keeps the icon when the bar is dismissed, and drops it when the session is deleted', async () => {
    const { monitor, pushed } = setup();
    await monitor.bindManual(SESSION, REF.url);
    await monitor.idle();
    const before = pushed.length;
    await monitor.dismiss(SESSION);
    expect(pushed).toHaveLength(before);
    expect(await monitor.summaries()).toEqual([{ sessionId: SESSION, summary: { number: 611, state: 'open' } }]);

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
});
