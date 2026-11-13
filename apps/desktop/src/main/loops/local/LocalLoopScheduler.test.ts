import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatAutomaticOrigin, ChatStreamEvent } from '@shared/chat';
import type { LocalLoop, LocalRun } from '@shared/localLoops';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineSample } from '../budget';
import { LocalLoopScheduler, SCHEDULER_MS } from './LocalLoopScheduler';
import { LocalLoopStore } from './LocalLoopStore';
import { testLoop } from './testLoop';
import { createTicket } from './ticketTools';

const GB = 1024 ** 3;
const sample: MachineSample = {
  cores: 16,
  freeBytes: 8 * GB,
  swapUsedBytes: 0,
  loadRatio: 0.1,
  diskFreeBytes: 500 * GB,
  onBattery: false,
  idleSeconds: 600,
};

/** Flush the promise chains a poke or a finish starts; timers stay fake. */
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
};

function fakeChat() {
  const runs = new Map<string, string>();
  const turns: { sessionId: string; text: string; automatic: ChatAutomaticOrigin; model?: string }[] = [];
  const models = new Map<string, string>();
  let next = 0;
  return {
    turns,
    runs,
    stopped: [] as string[],
    createCodeSession: vi.fn(async () => ({ ok: true as const, session: { id: `s${++next}` } })),
    setApprovalMode: vi.fn(async () => undefined),
    setLoopRunModel: vi.fn(async (sessionId: string, model: string) => void models.set(sessionId, model)),
    deleteSession: vi.fn(async () => undefined),
    async startAutomaticTurn(sessionId: string, text: string, automatic: ChatAutomaticOrigin) {
      if (automatic.kind === 'local-loop') runs.set(sessionId, automatic.runId);
      turns.push({ sessionId, text, automatic, model: models.get(sessionId) });
      return { ok: true as const };
    },
    stop(sessionId: string) {
      this.stopped.push(sessionId);
    },
    isSessionBusy: () => false,
    getSession: async () => null,
    removeWorktrees: vi.fn(async () => undefined),
    loopRunOf: (sessionId: string) => runs.get(sessionId),
    loopRunSessions: (runId: string) => [...runs].filter(([, run]) => run === runId).map(([id]) => id),
    endLoopRun(runId: string) {
      for (const [id, run] of runs) if (run === runId) runs.delete(id);
    },
  };
}

describe('LocalLoopScheduler', () => {
  let store: LocalLoopStore;
  let chat: ReturnType<typeof fakeChat>;
  let scheduler: LocalLoopScheduler;
  let otherLanes: number;
  let alerts: string[];
  const blocker = { start: vi.fn(() => 7), stop: vi.fn() };

  const make = (loop: Partial<LocalLoop> = {}) => store.putLoop(testLoop(loop));
  const ticket = (title: string, priority: 'p0' | 'p1' | 'p2' | 'p3' = 'p2', loopId = 'loop-1') =>
    createTicket(store, store.loop(loopId)!, { title, priority }, 'owner');
  const done = (sessionId: string, content = 'ok') =>
    scheduler.observe({ type: 'done', sessionId, messageId: `m-${sessionId}`, content } as ChatStreamEvent);
  const spent = (credits: number, loopId = 'loop-1') =>
    store.putRun({
      id: `past-${credits}-${loopId}`,
      loopId,
      kind: 'ticket',
      model: 'm',
      fallback: false,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      endedAt: new Date(Date.now() - 30_000).toISOString(),
      outcome: 'done',
      credits,
    } satisfies LocalRun);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-01-02T12:00:00.000Z'));
    store = new LocalLoopStore(join(mkdtempSync(join(tmpdir(), 'b4m-sched-')), 'l.sqlite'), () => 'scope');
    chat = fakeChat();
    otherLanes = 0;
    alerts = [];
    blocker.start.mockClear();
    blocker.stop.mockClear();
    scheduler = new LocalLoopScheduler({
      store,
      chat,
      killSessionProcesses: () => undefined,
      machine: async () => ({ sample, settings: { runOnBattery: false } }),
      otherLanes: () => otherLanes,
      allLoopsCap: () => undefined,
      gh: vi.fn(),
      github: { snapshot: vi.fn(), merge: vi.fn(), enqueue: vi.fn() },
      powerSaveBlocker: blocker,
      alert: (_loop, event) => alerts.push(`${event.kind}: ${event.reason}`),
      onChange: () => undefined,
      logger: { warn: () => undefined },
    });
  });

  afterEach(() => {
    scheduler.stop();
    store.close();
    vi.useRealTimers();
  });

  it('claims a new ready ticket on the poke, with no polling wait', async () => {
    make();
    scheduler.start();
    await settle();
    expect(chat.turns).toEqual([]);

    const t = ticket('Write the guide');
    scheduler.poke();
    await settle();
    expect(chat.turns).toHaveLength(1);
    expect(chat.turns[0].automatic).toMatchObject({ kind: 'local-loop', ticketId: t.id, summary: 'Write the guide' });
    expect(chat.turns[0].text).toContain(`Ticket id: ${t.id}`);
    expect(store.ticket(t.id)).toMatchObject({ status: 'in_progress', runCount: 1, lastRunModel: 'stage-model' });
    expect(blocker.start).toHaveBeenCalledTimes(1);
  });

  it('triages untriaged tickets before working any', async () => {
    make();
    const t = createTicket(store, store.loop('loop-1')!, { title: 'No priority yet' }, 'owner');
    scheduler.start();
    await settle();
    expect(chat.turns[0].automatic).toMatchObject({ kind: 'local-loop', summary: 'Triage 1 tickets' });
    expect(chat.turns[0].automatic).not.toHaveProperty('ticketId');
    done(chat.turns[0].sessionId);
    await settle();
    // Shown and left untriaged: p2, so it cannot hold the loop on triage.
    expect(store.ticket(t.id)).toMatchObject({ priority: 'p2', prioritySetBy: 'agent' });
    expect(chat.turns[1].automatic).toMatchObject({ ticketId: t.id });
  });

  it('advances a ticket when its run is done, then takes the next one', async () => {
    make();
    const first = ticket('first', 'p1');
    const second = ticket('second');
    scheduler.start();
    await settle();
    expect(chat.turns).toHaveLength(1);
    done(chat.turns[0].sessionId, 'did it\n```loop-memory\n{"notes":"wrote it","nextAction":"next"}\n```');
    await settle();
    expect(store.ticket(first.id)).toMatchObject({ stage: 'doing', lastRunAdvanced: true });
    expect(store.ticket(first.id)?.stageHistory.map(entry => entry.by)).toEqual(['owner', 'scheduler']);
    expect(store.loop('loop-1')?.memory.notes).toBe('wrote it');
    // `first` is now ready in a later stage, so it goes before `second`.
    expect(chat.turns[1].automatic).toMatchObject({ ticketId: first.id });
    expect(store.runs('loop-1').find(run => run.ticketId === first.id && run.endedAt)?.outcome).toBe('done');
    expect(second.status).toBe('open');
  });

  it('never runs more lanes than the loop allows or the shared machine pool has', async () => {
    make({ maxConcurrent: 2 });
    for (const title of ['a', 'b', 'c']) ticket(title);
    scheduler.start();
    await settle();
    expect(chat.turns).toHaveLength(2);
    expect(scheduler.busy).toBe(2);

    scheduler.stop();
    store.putLoop(testLoop({ id: 'loop-2', maxConcurrent: 4 }));
    ticket('d', 'p2', 'loop-2');
    // LoopRunner holds the rest of the 4-lane machine cap.
    otherLanes = 2;
    scheduler.start();
    await settle();
    expect(chat.turns).toHaveLength(2);
    expect(scheduler.summary(store.loop('loop-2')!).idleReason).toBe('waiting: all lanes are busy');
  });

  it('caps a loop at its daily budget, says so, and resumes at the reset on its own', async () => {
    make({ budgetCreditsPerDay: 10 });
    spent(10);
    ticket('a');
    scheduler.start();
    await settle();
    expect(chat.turns).toEqual([]);
    expect(store.loop('loop-1')).toMatchObject({ cappedUntil: '2026-01-03T00:00:00.000Z', capReason: 'loop_budget' });
    expect(alerts).toEqual([
      `capped: Capped until ${new Date('2026-01-03T00:00:00.000Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })} (daily budget)`,
    ]);
    expect(alerts[0]).toMatch(/Capped until \d{2}:\d{2} \(/);
    expect(scheduler.summary(store.loop('loop-1')!).idleReason).toMatch(/^capped until \d{2}:\d{2} \(daily budget\)$/);

    await vi.advanceTimersByTimeAsync(12 * 60 * 60_000);
    await settle();
    expect(store.loop('loop-1')?.cappedUntil).toBeUndefined();
    expect(chat.turns).toHaveLength(1);
  });

  it('caps every loop on the all-loops budget', async () => {
    make();
    store.putLoop(testLoop({ id: 'loop-2' }));
    spent(50, 'loop-2');
    ticket('a');
    const capped = new LocalLoopScheduler({ ...schedulerDeps(), allLoopsCap: () => 50 });
    capped.start();
    await settle();
    expect(chat.turns).toEqual([]);
    expect(store.loop('loop-1')?.capReason).toBe('all_loops');
    capped.stop();
  });

  it('caps the loop on an account credit stop and hands the ticket back uncounted', async () => {
    make();
    const t = ticket('a');
    scheduler.start();
    await settle();
    scheduler.observe({
      type: 'error',
      sessionId: chat.turns[0].sessionId,
      messageId: 'm',
      message: 'Request failed with status 422',
    });
    await settle();
    expect(store.loop('loop-1')).toMatchObject({ capReason: 'credits', cappedUntil: '2026-01-03T00:00:00.000Z' });
    expect(store.ticket(t.id)).toMatchObject({ status: 'open', runCount: 0 });
    expect(store.runs('loop-1')[0]).toMatchObject({ outcome: 'budget_stopped' });
    expect(chat.stopped).toEqual([chat.turns[0].sessionId]);
  });

  it('stops a run past its credit cap and reopens its ticket uncounted', async () => {
    // At noon 13/24 of a 24-credit budget is allowed: the run's cap is 13.
    make({ budgetCreditsPerDay: 24 });
    const t = ticket('a');
    scheduler.start();
    await settle();
    const sessionId = chat.turns[0].sessionId;
    scheduler.observe({ type: 'usage', sessionId, messageId: 'm1', usage: { creditsUsed: 5 } } as ChatStreamEvent);
    await settle();
    expect(chat.stopped).toEqual([]);
    expect(store.runs('loop-1')[0].credits).toBe(5);
    scheduler.observe({ type: 'usage', sessionId, messageId: 'm2', usage: { creditsUsed: 9 } } as ChatStreamEvent);
    await settle();
    expect(chat.stopped).toEqual([sessionId]);
    expect(store.runs('loop-1').find(run => run.sessionId === sessionId)).toMatchObject({
      stopReason: 'credit_cap',
      credits: 14,
    });
    expect(store.ticket(t.id)).toMatchObject({ runCount: expect.any(Number) });
    expect(store.ticket(t.id)?.status).not.toBe('blocked');
  });

  describe('pacing', () => {
    // 22:30 UTC with 97 of 100 spent: 3% of the budget left for 6.25% of the day, so headroom is under 0.5,
    // while the paced allowance (23.5/24 of 100) still covers a run.
    beforeEach(() => vi.setSystemTime(new Date('2026-01-02T22:30:00.000Z')));

    it('takes the fallback model when the budget is running ahead of the day', async () => {
      make({ budgetCreditsPerDay: 100, fallbackModel: 'cheap-model' });
      spent(97);
      const t = ticket('a');
      scheduler.start();
      await settle();
      expect(chat.turns[0].model).toBe('cheap-model');
      expect(store.ticket(t.id)).toMatchObject({ lastRunModel: 'cheap-model', lastRunFallback: true });
    });

    it('re-runs one model up after a fallback run that did not advance', async () => {
      make({ budgetCreditsPerDay: 100, fallbackModel: 'cheap-model' });
      spent(97);
      const t = ticket('a');
      store.putTicket({ ...t, runCount: 1, lastRunFallback: true, lastRunAdvanced: false });
      scheduler.start();
      await settle();
      expect(chat.turns[0].model).toBe('stage-model');
    });

    it('never stops a running lane, only holds new ones', async () => {
      vi.setSystemTime(new Date('2026-01-02T12:00:00.000Z'));
      make({ budgetCreditsPerDay: 100, maxConcurrent: 2 });
      ticket('a');
      ticket('b');
      ticket('c');
      scheduler.start();
      await settle();
      expect(chat.turns).toHaveLength(2);
      spent(60);
      await scheduler.tick();
      await settle();
      expect(chat.stopped).toEqual([]);
      expect(scheduler.busy).toBe(2);
      expect(chat.turns).toHaveLength(2);
    });
  });

  it('re-queues a run the app was killed in, uncounted, and dispatches at once', async () => {
    make();
    const t = ticket('a');
    store.putTicket({ ...t, status: 'in_progress', runCount: 1 });
    store.putRun({
      id: 'cut-off',
      loopId: 'loop-1',
      ticketId: t.id,
      kind: 'ticket',
      model: 'stage-model',
      fallback: false,
      startedAt: new Date().toISOString(),
      credits: 2,
    });
    scheduler.start();
    await settle();
    expect(store.run('cut-off')).toMatchObject({ stopReason: 'requeued', endedAt: expect.any(String) });
    expect(chat.turns).toHaveLength(1);
    expect(chat.turns[0].automatic).toMatchObject({ ticketId: t.id });
    // Taken again: the cut-off run was not counted, this one is.
    expect(store.ticket(t.id)).toMatchObject({ status: 'in_progress', runCount: 1 });
  });

  it('blocks a ticket whose every action was declined, and tells the owner', async () => {
    make();
    const t = ticket('a');
    scheduler.start();
    await settle();
    const sessionId = chat.turns[0].sessionId;
    scheduler.observe({
      type: 'tool-end',
      sessionId,
      call: { id: 'c', name: 'bash_execute', input: {}, status: 'denied', error: 'not allowed' },
    } as ChatStreamEvent);
    done(sessionId);
    await settle();
    expect(store.ticket(t.id)).toMatchObject({
      status: 'blocked',
      statusReason: 'Every action was declined: not allowed',
    });
    expect(alerts).toEqual(['blocked: Every action was declined: not allowed']);
    expect(scheduler.summary(store.loop('loop-1')!)).toMatchObject({ needsYou: 1, idleReason: 'waiting on you' });
  });

  it('puts the loop in error after three failed runs in a row', async () => {
    make();
    for (const title of ['a', 'b', 'c']) ticket(title);
    scheduler.start();
    for (let i = 0; i < 3; i++) {
      await settle();
      scheduler.observe({ type: 'error', sessionId: chat.turns[i].sessionId, messageId: 'm', message: 'boom' });
    }
    await settle();
    expect(store.loop('loop-1')).toMatchObject({ status: 'error', errorStreak: 3 });
    expect(chat.turns).toHaveLength(3);
  });

  it('lets a run ask the owner, parks the ticket, and shows the answer to its next run', async () => {
    make();
    const t = ticket('a');
    scheduler.start();
    await settle();
    const sessionId = chat.turns[0].sessionId;
    scheduler.ticketTool(sessionId, 'loop_ticket_unsure', { id: t.id, question: 'Which color?' });
    done(sessionId);
    await settle();
    expect(store.ticket(t.id)).toMatchObject({ status: 'blocked', statusReason: 'Unsure: Which color?' });
    expect(alerts).toEqual(['asked: Which color?']);
    expect(chat.turns).toHaveLength(1);
  });

  it('waits before re-running a loop whose run stopped at its credit cap', async () => {
    // At noon the cap is 1300 of 2400; pacing alone would let the next run start at 12:01.
    make({ budgetCreditsPerDay: 2400 });
    ticket('a');
    scheduler.start();
    await settle();
    const sessionId = chat.turns[0].sessionId;
    scheduler.observe({ type: 'usage', sessionId, messageId: 'm1', usage: { creditsUsed: 1300.5 } } as ChatStreamEvent);
    await settle();
    expect(chat.turns).toHaveLength(1);
    expect(scheduler.summary(store.loop('loop-1')!).idleReason).toBe('paced until 2026-01-02T12:10:00.000Z');
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(chat.turns).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(SCHEDULER_MS.creditCapBackoff);
    await settle();
    expect(chat.turns).toHaveLength(2);
  });

  it('hands the owner a cut-off run that had opened a PR instead of re-running it', async () => {
    make();
    const t = ticket('a');
    store.putTicket({ ...t, status: 'in_progress', runCount: 1 });
    store.putRun({
      id: 'cut-off',
      loopId: 'loop-1',
      ticketId: t.id,
      kind: 'ticket',
      model: 'stage-model',
      fallback: false,
      startedAt: new Date().toISOString(),
      credits: 2,
      prUrl: 'https://github.com/o/r/pull/1',
    });
    scheduler.start();
    await settle();
    expect(store.run('cut-off')).toMatchObject({ outcome: 'blocked', reason: expect.stringContaining('pull/1') });
    expect(store.ticket(t.id)?.status).toBe('blocked');
    expect(chat.turns).toEqual([]);
  });

  it('reopens a ticket left in progress with no run', async () => {
    make();
    const t = ticket('a');
    store.putTicket({ ...t, status: 'in_progress', runCount: 1 });
    make({ status: 'paused' });
    scheduler.start();
    await settle();
    expect(store.ticket(t.id)?.status).toBe('open');
  });

  it('frees the lane even when recording the run end fails', async () => {
    make();
    ticket('a');
    scheduler.start();
    await settle();
    expect(scheduler.busy).toBe(1);
    vi.spyOn(store, 'run').mockImplementation(() => {
      throw new Error('disk gone');
    });
    done(chat.turns[0].sessionId);
    await settle();
    expect(scheduler.busy).toBe(0);
    expect(blocker.stop).toHaveBeenCalledWith(7);
  });

  it('holds the lane while the session opens, so a quit then re-queues the ticket and starts nothing', async () => {
    make();
    const t = ticket('a');
    let open!: (value: { ok: true; session: { id: string } }) => void;
    chat.createCodeSession.mockImplementationOnce(() => new Promise(resolve => (open = resolve)));
    scheduler.start();
    await settle();
    expect(scheduler.busy).toBe(1);
    await scheduler.releaseAll(true);
    expect(store.ticket(t.id)).toMatchObject({ status: 'open', runCount: 0 });
    open({ ok: true, session: { id: 'late' } });
    await settle();
    expect(chat.turns).toEqual([]);
    expect(scheduler.busy).toBe(0);
  });

  it('does not spin on a stale pacing time once its loop is paused', async () => {
    let changes = 0;
    const paced = new LocalLoopScheduler({ ...schedulerDeps(), onChange: () => changes++ });
    make({ budgetCreditsPerDay: 24 });
    store.putLoop(testLoop({ id: 'loop-2' }));
    spent(13);
    ticket('a');
    paced.start();
    await settle();
    expect(paced.summary(store.loop('loop-1')!).idleReason).toMatch(/^paced until/);
    store.putLoop({ ...store.loop('loop-1')!, status: 'paused' });
    await paced.tick();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    changes = 0;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(changes).toBe(0);
    paced.stop();
  });

  it('re-checks the machine gate on a timer while a loop is live', async () => {
    make();
    ticket('a');
    otherLanes = 4;
    scheduler.start();
    await settle();
    expect(chat.turns).toEqual([]);
    otherLanes = 0;
    await vi.advanceTimersByTimeAsync(SCHEDULER_MS.recheck);
    await settle();
    expect(chat.turns).toHaveLength(1);
  });

  function schedulerDeps() {
    return {
      store,
      chat,
      killSessionProcesses: () => undefined,
      machine: async () => ({ sample, settings: { runOnBattery: false } }),
      otherLanes: () => otherLanes,
      allLoopsCap: () => undefined,
      gh: vi.fn(),
      github: { snapshot: vi.fn(), merge: vi.fn(), enqueue: vi.fn() },
      powerSaveBlocker: blocker,
      alert: () => undefined,
      onChange: () => undefined,
      logger: { warn: () => undefined },
    };
  }
});
