import { describe, expect, it } from 'vitest';
import { GhError } from './gh';
import { PrMonitor, type PrTimers } from './PrMonitor';
import { POLL_MS } from './pollSchedule';
import { REF, check, collector, fakeGithub, quietLogger, snapshot, tempStore } from './prTestSupport';

const SESSION = 'session-1';

/** Timers the test fires by hand. Only the latest per session matters, as in the monitor. */
function manualTimers() {
  const pending = new Map<number, { callback: () => void; ms: number }>();
  let id = 0;
  const timers: PrTimers = {
    set: (callback, ms) => {
      id += 1;
      pending.set(id, { callback, ms });
      return id;
    },
    clear: handle => {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    delays: () => [...pending.values()].map(entry => entry.ms),
    async fire() {
      const entries = [...pending.entries()];
      pending.clear();
      for (const [, entry] of entries) entry.callback();
      await new Promise(resolve => setTimeout(resolve, 20));
    },
  };
}

function setup(initial = snapshot({ checks: [check('Build', 'pending')] })) {
  let now = 1_000_000;
  const store = tempStore();
  const fake = fakeGithub(initial);
  const clock = manualTimers();
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
    timers: clock.timers,
    now: () => now,
    random: () => 0,
  });
  return {
    store,
    fake,
    clock,
    out,
    monitor,
    advance(ms: number) {
      now += ms;
    },
  };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

describe('PrMonitor polling', () => {
  it('does no GitHub work at start, and arms only PRs with automation on', async () => {
    const { store, fake, clock, monitor } = setup();
    await store.set('armed', { ...REF, source: 'shell', boundAt: '', autoArchive: true, lastState: 'OPEN' });
    await store.set('plain', { ...REF, source: 'shell', boundAt: '', lastState: 'OPEN' });
    await store.set('merged', { ...REF, source: 'shell', boundAt: '', autoArchive: true, lastState: 'MERGED' });
    await monitor.start();
    expect(fake.calls).toEqual([]);
    expect(clock.delays()).toEqual([POLL_MS.unopenedArmed]);
  });

  it('polls the conversation on screen every 30s while checks run, slower once they settle', async () => {
    const { store, fake, clock, monitor } = setup();
    await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
    await monitor.watch(1, SESSION);
    await settle();
    expect(clock.delays()).toEqual([POLL_MS.onScreenActive]);

    fake.answer(snapshot({ checks: [check('Build', 'pass')] }));
    await clock.fire();
    expect(fake.calls).toEqual(['snapshot', 'snapshot']);
    expect(clock.delays()).toEqual([POLL_MS.onScreenSettled]);
  });

  it('slows down when the conversation leaves the screen', async () => {
    const { store, clock, monitor } = setup();
    await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
    await monitor.watch(1, SESSION);
    await settle();
    await monitor.watch(1, 'another-session');
    await settle();
    expect(clock.delays()).toEqual([POLL_MS.openedActive]);
  });

  it('stops polling once the PR is merged', async () => {
    const { store, fake, clock, monitor } = setup();
    await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
    await monitor.watch(1, SESSION);
    await settle();
    fake.answer(snapshot({ state: 'MERGED' }));
    await clock.fire();
    expect(clock.delays()).toEqual([]);
    expect((await store.get(SESSION))?.lastState).toBe('MERGED');
  });

  it('backs off after failures and resets once a read succeeds', async () => {
    const { store, fake, clock, monitor } = setup();
    await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
    fake.answer(new GhError('failed', 'boom'));
    await monitor.watch(1, SESSION);
    await settle();
    expect(clock.delays()).toEqual([POLL_MS.backoffFloor * 2]);
    await clock.fire();
    expect(clock.delays()).toEqual([POLL_MS.backoffFloor * 4]);
    fake.answer(snapshot({ checks: [check('Build', 'pending')] }));
    await clock.fire();
    expect(clock.delays()).toEqual([POLL_MS.onScreenActive]);
  });

  it('pauses every read for a while after a rate limit', async () => {
    const { store, fake, clock, monitor, advance } = setup();
    await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
    fake.answer(new GhError('rate-limited', 'API rate limit exceeded'));
    await monitor.watch(1, SESSION);
    await settle();
    expect(Math.min(...clock.delays())).toBeGreaterThanOrEqual(POLL_MS.rateLimitPause);

    // Opening the conversation again during the pause does not read.
    advance(60_000);
    await monitor.watch(1, 'other');
    await monitor.watch(1, SESSION);
    await settle();
    expect(fake.calls).toEqual(['snapshot']);
  });

  it('stops polling everything while gh is missing, until the user refreshes', async () => {
    const { store, fake, clock, monitor } = setup();
    await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
    fake.answer(new GhError('missing', 'gh is not installed'));
    await monitor.watch(1, SESSION);
    await settle();
    expect(clock.delays()).toEqual([]);
    fake.answer(snapshot());
    await monitor.refresh(SESSION);
    expect(clock.delays().length).toBe(1);
  });

  it('runs one read at a time per conversation', async () => {
    const { store, fake, monitor } = setup();
    await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
    await Promise.all([monitor.refresh(SESSION), monitor.refresh(SESSION), monitor.refresh(SESSION)]);
    expect(fake.calls).toEqual(['snapshot']);
  });

  it('reads soon after the agent pushes to a bound PR', async () => {
    const { store, clock, monitor } = setup(snapshot({ checks: [check('Build', 'pass')] }));
    await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
    await monitor.watch(1, SESSION);
    await settle();
    monitor.observeToolEnd(SESSION, {
      id: 'c',
      name: 'bash_execute',
      input: { command: 'git push' },
      status: 'done',
      preview: 'Everything up-to-date',
    });
    await settle();
    expect(clock.delays()).toEqual([15_000]);
  });
});
