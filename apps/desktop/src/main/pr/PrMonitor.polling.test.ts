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
      await settle();
    },
  };
}

/**
 * A monitor that tracks every read, schedule and publish it starts, including the ones it fires
 * and forgets, so a test can wait for all of them instead of sleeping. A fixed sleep raced the
 * binding store's real disk writes and failed under load.
 */
class TrackedMonitor extends PrMonitor {
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

  protected override schedule(sessionId: string): Promise<void> {
    return this.track(super.schedule(sessionId));
  }

  protected override publish(sessionId: string): Promise<void> {
    return this.track(super.publish(sessionId));
  }

  async idle(): Promise<void> {
    while (this.work.size > 0) await Promise.allSettled([...this.work]);
  }
}

const monitors: TrackedMonitor[] = [];

/** Every monitor this file made has finished what it started. */
async function settle(): Promise<void> {
  for (const monitor of monitors) await monitor.idle();
}

function setup(initial = snapshot({ checks: [check('Build', 'pending')] }), store = tempStore()) {
  // On the 15s grid, so the delays below are the cadences themselves.
  let now = 990_000;
  const fake = fakeGithub(initial);
  const clock = manualTimers();
  const out = collector();
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
    logger: quietLogger,
    timers: clock.timers,
    now: () => now,
    random: () => 0,
    batchWindowMs: 0,
  });
  monitors.push(monitor);
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

  it('reads every conversation due on the same tick in one query', async () => {
    const { store, fake, clock, monitor } = setup();
    await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
    await store.set('session-2', { ...REF, number: 612, source: 'shell', boundAt: '' });
    await monitor.watch(1, SESSION);
    await monitor.watch(2, 'session-2');
    await settle();
    expect(clock.delays()).toEqual([POLL_MS.onScreenActive, POLL_MS.onScreenActive]);

    fake.batches.length = 0;
    await clock.fire();
    expect(fake.batches).toEqual([2]);
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

  it.each([
    ['open', snapshot()],
    ['draft', snapshot({ isDraft: true })],
    ['merged', snapshot({ state: 'MERGED' })],
    ['closed', snapshot({ state: 'CLOSED' })],
  ])('clears the spinner once a read of a %s PR lands', async (_name, answer) => {
    const { store, out, monitor } = setup(answer);
    await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
    await monitor.refresh(SESSION);
    await settle();
    expect(out.last()?.refreshing).toBe(false);
  });

  it('clears the spinner when a read fails', async () => {
    const { store, fake, out, monitor } = setup();
    await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
    fake.answer(new GhError('failed', 'boom'));
    await monitor.refresh(SESSION);
    await settle();
    expect(out.last()).toMatchObject({ refreshing: false, error: 'boom' });
  });

  it('clears the spinner when a read is skipped during a rate-limit pause', async () => {
    const { store, fake, out, monitor } = setup();
    await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
    fake.answer(new GhError('rate-limited', 'API rate limit exceeded'));
    await monitor.refresh(SESSION);
    await monitor.refresh(SESSION);
    await settle();
    expect(fake.calls).toEqual(['snapshot']);
    expect(out.last()?.refreshing).toBe(false);
  });

  describe('a finished PR', () => {
    const merged = snapshot({ state: 'MERGED', mergedAt: '2026-10-01T00:00:00Z', checks: [check('Build', 'pass')] });

    async function finishOnScreen(answer = merged) {
      const env = setup();
      await env.store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
      await env.monitor.watch(1, SESSION);
      await settle();
      env.fake.answer(answer);
      await env.clock.fire();
      env.fake.calls.length = 0;
      return env;
    }

    it.each([
      ['merged', merged],
      ['closed', snapshot({ state: 'CLOSED' })],
    ])('arms no timer once %s', async (_name, answer) => {
      const { clock, out } = await finishOnScreen(answer);
      expect(clock.delays()).toEqual([]);
      expect(out.last()).toMatchObject({ refreshing: false, snapshot: { state: answer.state } });
    });

    it('is not read again when it leaves the screen and comes back', async () => {
      const { fake, clock, monitor, advance } = await finishOnScreen();
      await monitor.watch(1, 'another-session');
      advance(POLL_MS.openedSettled);
      const state = await monitor.watch(1, SESSION);
      await settle();
      expect(fake.calls).toEqual([]);
      expect(clock.delays()).toEqual([]);
      expect(state).toMatchObject({ refreshing: false, snapshot: { state: 'MERGED' } });
    });

    it('keeps its last read across a relaunch, so opening it reads nothing', async () => {
      const { store } = await finishOnScreen();
      expect((await store.get(SESSION))?.finalSnapshot).toMatchObject({ state: 'MERGED', checks: [] });

      const relaunched = setup(merged, store);
      await relaunched.monitor.start();
      const state = await relaunched.monitor.watch(1, SESSION);
      await settle();
      expect(relaunched.fake.calls).toEqual([]);
      expect(relaunched.clock.delays()).toEqual([]);
      expect(state?.snapshot).toMatchObject({ state: 'MERGED', additions: 157, mergedAt: '2026-10-01T00:00:00Z' });
      expect(state?.binding?.finalSnapshot).toBeUndefined();
    });

    it('reads a merged PR stored before its last read was kept, once', async () => {
      const { store, fake, monitor } = setup(merged);
      await store.set(SESSION, { ...REF, source: 'shell', boundAt: '', lastState: 'MERGED' });
      await monitor.watch(1, SESSION);
      await settle();
      await monitor.watch(1, 'another-session');
      await monitor.watch(1, SESSION);
      await settle();
      expect(fake.calls).toEqual(['snapshot']);
    });

    it('is not re-armed by a push or a finished turn', async () => {
      const { fake, clock, monitor } = await finishOnScreen();
      monitor.observeToolEnd(SESSION, {
        id: 'c',
        name: 'bash_execute',
        input: { command: 'git push' },
        status: 'done',
        preview: 'Everything up-to-date',
      });
      monitor.turnSettled(SESSION);
      await settle();
      expect(clock.delays()).toEqual([]);
      expect(fake.calls).toEqual([]);
    });

    it('refuses to switch an automation on, without reading', async () => {
      const { fake, clock, monitor } = await finishOnScreen();
      for (const option of ['autoFix', 'autoMerge', 'autoArchive'] as const) {
        expect(await monitor.setOption(SESSION, option, true)).toMatchObject({ ok: false });
      }
      await settle();
      expect(fake.calls).toEqual([]);
      expect(clock.delays()).toEqual([]);
    });

    it('arms nothing after the bar is dismissed', async () => {
      const { fake, clock, monitor } = await finishOnScreen();
      await monitor.dismiss(SESSION);
      await monitor.watch(1, 'another-session');
      await monitor.watch(1, SESSION);
      await settle();
      expect(fake.calls).toEqual([]);
      expect(clock.delays()).toEqual([]);
    });

    it('reads a closed PR once on a manual refresh, still unarmed', async () => {
      const { fake, clock, monitor, out } = await finishOnScreen(snapshot({ state: 'CLOSED' }));
      await monitor.refresh(SESSION);
      await settle();
      expect(fake.calls).toEqual(['snapshot']);
      expect(clock.delays()).toEqual([]);
      expect(out.last()?.refreshing).toBe(false);
    });

    it('polls again, and forgets its kept read, once a closed PR is reopened', async () => {
      const { store, fake, clock, monitor } = await finishOnScreen(snapshot({ state: 'CLOSED' }));
      fake.answer(snapshot({ checks: [check('Build', 'pending')] }));
      await monitor.refresh(SESSION);
      expect(clock.delays()).toEqual([POLL_MS.onScreenActive]);
      expect(await store.get(SESSION)).toMatchObject({ lastState: 'OPEN' });
      expect((await store.get(SESSION))?.finalSnapshot).toBeUndefined();
    });
  });
});
