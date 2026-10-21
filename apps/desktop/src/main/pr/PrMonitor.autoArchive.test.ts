import { describe, expect, it } from 'vitest';
import type { PrBinding } from '@shared/pullRequest';
import { shouldAutoArchive } from './autoArchive';
import { PrMonitor } from './PrMonitor';
import { REF, collector, fakeGithub, quietLogger, snapshot, tempStore } from './prTestSupport';

const SESSION = 'session-1';
const bound: PrBinding = { ...REF, source: 'shell', boundAt: '' };

function setup() {
  const store = tempStore();
  const fake = fakeGithub();
  const archived: string[] = [];
  const monitor = new PrMonitor({
    store,
    github: fake.github,
    chat: {
      isCode: async () => true,
      project: async () => null,
      archive: async sessionId => {
        archived.push(sessionId);
      },
      isBusy: () => false,
      startAutoFix: async () => ({ ok: false as const, busy: true, error: 'busy' }),
    },
    emit: collector().emit,
    logger: quietLogger,
    batchWindowMs: 0,
  });
  return { store, fake, archived, monitor };
}

describe('shouldAutoArchive', () => {
  it('fires only on the open -> merged/closed transition, with the option on, once', () => {
    const on = { ...bound, autoArchive: true, lastState: 'OPEN' as const };
    expect(shouldAutoArchive(on, 'MERGED')).toBe(true);
    expect(shouldAutoArchive(on, 'CLOSED')).toBe(true);
    expect(shouldAutoArchive(on, 'OPEN')).toBe(false);
    expect(shouldAutoArchive({ ...on, autoArchive: false }, 'MERGED')).toBe(false);
    expect(shouldAutoArchive({ ...on, lastState: undefined }, 'MERGED')).toBe(false);
    expect(shouldAutoArchive({ ...on, lastState: 'MERGED' }, 'MERGED')).toBe(false);
    expect(shouldAutoArchive({ ...on, archivedOnClose: true }, 'CLOSED')).toBe(false);
  });
});

describe('PrMonitor auto-archive', () => {
  it('archives when an open PR it is watching merges, and never again', async () => {
    const { store, fake, archived, monitor } = setup();
    await store.set(SESSION, bound);
    await monitor.refresh(SESSION);
    expect(await monitor.setOption(SESSION, 'autoArchive', true)).toEqual({ ok: true });

    fake.answer(snapshot({ state: 'MERGED' }));
    await monitor.refresh(SESSION);
    expect(archived).toEqual([SESSION]);
    expect(await store.get(SESSION)).toMatchObject({ archivedOnClose: true, lastState: 'MERGED' });

    // The user unarchives; later reads must not archive it again.
    await monitor.refresh(SESSION);
    expect(archived).toEqual([SESSION]);
    monitor.dispose();
  });

  it('does not archive a PR that was already merged when it was bound', async () => {
    const { store, fake, archived, monitor } = setup();
    await store.set(SESSION, { ...bound, autoArchive: true });
    fake.answer(snapshot({ state: 'MERGED' }));
    await monitor.refresh(SESSION);
    expect(archived).toEqual([]);
  });

  it('does not archive with the option off', async () => {
    const { store, fake, archived, monitor } = setup();
    await store.set(SESSION, { ...bound, lastState: 'OPEN' });
    fake.answer(snapshot({ state: 'CLOSED' }));
    await monitor.refresh(SESSION);
    expect(archived).toEqual([]);
  });
});
