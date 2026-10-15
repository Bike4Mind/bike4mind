import { describe, expect, it } from 'vitest';
import type { ChatAutomaticOrigin } from '@shared/chat';
import type { PrBinding } from '@shared/pullRequest';
import { MAX_AUTO_FIX_ATTEMPTS } from './autoFix';
import { REF, TrackedMonitor, check, collector, fakeGithub, quietLogger, snapshot, tempStore } from './prTestSupport';

const SESSION = 'session-1';
const bound: PrBinding = {
  ...REF,
  source: 'shell',
  boundAt: '',
  lastState: 'OPEN',
  autoFix: true,
  autoFixMax: MAX_AUTO_FIX_ATTEMPTS,
};
const failing = snapshot({ headSha: 'sha-bad', checks: [check('Build', 'fail')] });

function setup({ busy = false, accept = true } = {}) {
  const store = tempStore();
  const fake = fakeGithub(failing);
  const out = collector();
  const started: { prompt: string; origin: ChatAutomaticOrigin }[] = [];
  const state = { busy, accept, refuseAsBusy: true };
  const monitor = new TrackedMonitor({
    store,
    github: fake.github,
    chat: {
      isCode: async () => true,
      project: async () => null,
      archive: async () => undefined,
      isBusy: () => state.busy,
      startAutoFix: async (_sessionId, prompt, origin) => {
        if (!state.accept) return { ok: false, busy: state.refuseAsBusy, error: 'Sign in to send a message.' };
        started.push({ prompt, origin });
        return { ok: true };
      },
    },
    emit: out.emit,
    logger: quietLogger,
    batchWindowMs: 0,
  });
  return { store, fake, out, monitor, started, state };
}

describe('PrMonitor auto-fix', () => {
  it('starts one turn for a failing run, recording the attempt first', async () => {
    const { store, monitor, started, out, fake } = setup();
    await store.set(SESSION, bound);
    await monitor.refresh(SESSION);

    expect(fake.calls).toEqual(['snapshot+threads']);
    expect(started).toHaveLength(1);
    expect(started[0].origin).toEqual({
      kind: 'auto-fix',
      prUrl: REF.url,
      prNumber: 611,
      summary: '1 failing check on #611',
    });
    const stored = await store.get(SESSION);
    expect(stored?.autoFixAttempts).toBe(1);
    expect(stored?.autoFixHandled).toEqual(['ci:sha-bad']);
    expect(out.last().autoFix.status).toBe('started');

    await monitor.refresh(SESSION);
    expect(started).toHaveLength(1);
  });

  it('waits while a turn runs, then starts once it ends', async () => {
    const { store, monitor, started, state, out } = setup({ busy: true });
    await store.set(SESSION, bound);
    await monitor.refresh(SESSION);
    expect(started).toHaveLength(0);
    expect(out.last().autoFix.status).toBe('waiting');

    state.busy = false;
    monitor.turnSettled(SESSION);
    await monitor.idle();
    expect(started).toHaveLength(1);
    expect(out.last().autoFix.status).toBe('started');
  });

  it('spends nothing when the start is refused', async () => {
    const { store, monitor, started, out } = setup({ accept: false });
    await store.set(SESSION, bound);
    await monitor.refresh(SESSION);
    expect(started).toHaveLength(0);
    const stored = await store.get(SESSION);
    expect(stored?.autoFixAttempts ?? 0).toBe(0);
    expect(stored?.autoFixHandled ?? []).toEqual([]);
    expect(out.last().autoFix.status).toBe('waiting');
  });

  it('gives the attempt back and says why when the turn is refused', async () => {
    const { store, monitor, started, out, state } = setup({ accept: false });
    state.refuseAsBusy = false;
    await store.set(SESSION, bound);
    await monitor.refresh(SESSION);
    expect(started).toHaveLength(0);
    expect((await store.get(SESSION))?.autoFixAttempts ?? 0).toBe(0);
    expect(out.last().autoFix.note).toContain('Sign in to send a message.');
  });

  it('starts once when a read and a turn ending ask at the same time', async () => {
    const { store, monitor, started, state } = setup({ busy: true });
    await store.set(SESSION, bound);
    await monitor.refresh(SESSION);
    state.busy = false;
    await Promise.all([monitor.refresh(SESSION), Promise.resolve(monitor.turnSettled(SESSION))]);
    await monitor.idle();
    expect(started).toHaveLength(1);
    expect((await store.get(SESSION))?.autoFixAttempts).toBe(1);
  });

  it('keeps saying it gave up while checks run again', async () => {
    const { store, monitor, out, fake } = setup();
    await store.set(SESSION, { ...bound, autoFixAttempts: MAX_AUTO_FIX_ATTEMPTS });
    await monitor.refresh(SESSION);
    fake.answer(snapshot({ headSha: 'sha-next', checks: [check('Build', 'pending')] }));
    await monitor.refresh(SESSION);
    expect(out.last().autoFix.status).toBe('exhausted');
  });

  it('says so in the bar when it gives up', async () => {
    const { store, monitor, started, out } = setup();
    await store.set(SESSION, { ...bound, autoFixAttempts: MAX_AUTO_FIX_ATTEMPTS });
    await monitor.refresh(SESSION);
    expect(started).toHaveLength(0);
    expect(out.last().autoFix).toMatchObject({ status: 'exhausted', attempts: MAX_AUTO_FIX_ATTEMPTS });
    expect(out.last().autoFix.note).toContain('gave up');
  });

  it('leaves a PR that gave up at the old limit stopped until the box is re-checked', async () => {
    const { store, monitor, started, out } = setup();
    const { autoFixMax: _, ...legacy } = bound;
    await store.set(SESSION, { ...legacy, autoFixAttempts: 3 });
    await monitor.refresh(SESSION);
    expect(started).toHaveLength(0);
    expect(out.last().autoFix).toMatchObject({ status: 'exhausted', attempts: 3, max: 3 });
    expect(out.last().autoFix.note).toContain('gave up after 3 attempts');

    await monitor.setOption(SESSION, 'autoFix', true);
    await settle();
    expect(started).toHaveLength(1);
    expect(started[0].prompt).toContain(`Attempt 1 of ${MAX_AUTO_FIX_ATTEMPTS}`);
    expect(await store.get(SESSION)).toMatchObject({ autoFixAttempts: 1, autoFixMax: MAX_AUTO_FIX_ATTEMPTS });
    expect(out.last().autoFix.max).toBe(MAX_AUTO_FIX_ATTEMPTS);
  });

  it('keeps a binding part-way through the old budget at three attempts', async () => {
    const { store, monitor, started, out } = setup();
    const { autoFixMax: _, ...legacy } = bound;
    await store.set(SESSION, { ...legacy, autoFixAttempts: 2 });
    await monitor.refresh(SESSION);
    expect(started).toHaveLength(1);
    expect(out.last().autoFix).toMatchObject({ status: 'started', attempts: 3, max: 3 });
    expect(out.last().autoFix.note).toContain('attempt 3 of 3');
  });

  it('keeps a legacy binding that ran out at three stopped while checks run again', async () => {
    const { store, monitor, out, fake } = setup();
    const { autoFixMax: _, ...legacy } = bound;
    await store.set(SESSION, { ...legacy, autoFixAttempts: 3 });
    await monitor.refresh(SESSION);
    fake.answer(snapshot({ headSha: 'sha-next', checks: [check('Build', 'pending')] }));
    await monitor.refresh(SESSION);
    expect(out.last().autoFix.status).toBe('exhausted');
  });

  it('grants five attempts when the box is ticked', async () => {
    const { store, monitor, out } = setup();
    await store.set(SESSION, { ...bound, autoFix: false, autoFixAttempts: 0 });
    await monitor.setOption(SESSION, 'autoFix', true);
    await settle();
    expect((await store.get(SESSION))?.autoFixMax).toBe(5);
    expect(out.last().autoFix.max).toBe(5);
  });

  it('stops when the box is unchecked, and re-checking refills the attempts', async () => {
    const { store, monitor, started, fake } = setup();
    await store.set(SESSION, { ...bound, autoFix: false, autoFixAttempts: MAX_AUTO_FIX_ATTEMPTS });
    await monitor.refresh(SESSION);
    expect(fake.calls).toEqual(['snapshot']);
    expect(started).toHaveLength(0);

    await monitor.setOption(SESSION, 'autoFix', true);
    await monitor.idle();
    expect(started).toHaveLength(1);
    expect((await store.get(SESSION))?.autoFixAttempts).toBe(1);

    await monitor.setOption(SESSION, 'autoFix', false);
    fake.answer(snapshot({ headSha: 'sha-other', checks: [check('Build', 'fail')] }));
    await monitor.refresh(SESSION);
    expect(started).toHaveLength(1);
  });
  it('starts one turn for a merge conflict and says so on the bar until the turn ends', async () => {
    const { store, monitor, started, out, fake } = setup();
    fake.answer(snapshot({ headSha: 'sha-head', baseSha: 'sha-base', mergeable: 'CONFLICTING' }));
    await store.set(SESSION, bound);
    await monitor.refresh(SESSION);

    expect(started).toHaveLength(1);
    expect(started[0].origin.summary).toBe('merge conflicts on #611');
    expect(started[0].prompt).toContain('git fetch origin main');
    expect((await store.get(SESSION))?.autoFixHandled).toEqual(['conflict:sha-head:sha-base']);
    expect(out.last().autoFix).toMatchObject({ status: 'started', conflicts: true });

    await monitor.refresh(SESSION);
    expect(started).toHaveLength(1);

    monitor.turnSettled(SESSION);
    await monitor.idle();
    expect(out.last().autoFix.conflicts).toBeUndefined();
  });
});
