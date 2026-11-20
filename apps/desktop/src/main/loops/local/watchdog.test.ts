import { describe, expect, it } from 'vitest';
import { idleAlarms, laneChecks, RestartBudget, schedulerStalled, WATCHDOG_MS, type LaneState } from './watchdog';

const MIN = 60_000;

describe('schedulerStalled', () => {
  const idle = { liveLoops: 1, ticking: false, tickStartedAt: 0, lastTickAt: 0 };

  it('flags a tick hung past five minutes', () => {
    expect(schedulerStalled({ ...idle, ticking: true }, 5 * MIN)).toBe(false);
    expect(schedulerStalled({ ...idle, ticking: true }, 5 * MIN + 1)).toBe(true);
  });

  it('flags no tick for three minutes only while a loop is live', () => {
    expect(schedulerStalled(idle, 3 * MIN + 1)).toBe(true);
    expect(schedulerStalled({ ...idle, liveLoops: 0 }, 60 * MIN)).toBe(false);
  });

  it('does not flag a capped loop, which still ticks every minute', () => {
    expect(schedulerStalled({ ...idle, lastTickAt: 10 * MIN }, 11 * MIN)).toBe(false);
  });
});

describe('RestartBudget', () => {
  it('allows five restarts an hour with doubling gaps, then gives up', () => {
    const budget = new RestartBudget();
    let t = 0;
    expect(budget.next(t)).toBe('restart');
    for (const gap of [1, 2, 4, 8]) {
      expect(budget.next(t + gap * MIN - 1)).toBe('wait');
      t += gap * MIN;
      expect(budget.next(t)).toBe('restart');
    }
    expect(budget.used).toBe(5);
    expect(budget.next(t + 16 * MIN)).toBe('give_up');
  });

  it('frees a restart an hour after it', () => {
    const budget = new RestartBudget();
    budget.next(0);
    expect(budget.next(61 * MIN)).toBe('restart');
    expect(budget.used).toBe(1);
  });
});

describe('laneChecks', () => {
  const lane = (patch: Partial<LaneState>): LaneState => ({
    runId: 'r',
    opening: false,
    busy: true,
    startedAt: 0,
    lastEventAt: 0,
    alarmed: false,
    ...patch,
  });

  it('alarms a silent run at 15 minutes once, and aborts it at 45', () => {
    expect(laneChecks([lane({})], 15 * MIN + 1).alarm).toEqual(['r']);
    expect(laneChecks([lane({ alarmed: true })], 15 * MIN + 1).alarm).toEqual([]);
    expect(laneChecks([lane({ alarmed: true })], WATCHDOG_MS.runAbort + 1)).toMatchObject({ abort: ['r'], alarm: [] });
  });

  it('never calls a busy lane dead; frees an idle one silent for two minutes', () => {
    expect(laneChecks([lane({})], 2 * MIN + 1).dead).toEqual([]);
    expect(laneChecks([lane({ busy: false })], 2 * MIN).dead).toEqual([]);
    expect(laneChecks([lane({ busy: false })], 2 * MIN + 1).dead).toEqual(['r']);
  });

  it('frees a lane stuck opening its session for five minutes', () => {
    expect(laneChecks([lane({ opening: true, busy: false })], 4 * MIN).dead).toEqual([]);
    expect(laneChecks([lane({ opening: true, busy: false })], 5 * MIN + 1).dead).toEqual(['r']);
  });
});

describe('idleAlarms', () => {
  it('alarms once per idle stretch, and starts over when the loop gets a lane', () => {
    const since = new Map<string, number>();
    const alarmed = new Set<string>();
    expect(idleAlarms([{ id: 'l', stuck: true }], since, alarmed, 0)).toEqual([]);
    expect(idleAlarms([{ id: 'l', stuck: true }], since, alarmed, 30 * MIN + 1)).toEqual(['l']);
    expect(idleAlarms([{ id: 'l', stuck: true }], since, alarmed, 60 * MIN)).toEqual([]);
    idleAlarms([{ id: 'l', stuck: false }], since, alarmed, 61 * MIN);
    expect(idleAlarms([{ id: 'l', stuck: true }], since, alarmed, 62 * MIN)).toEqual([]);
    expect(idleAlarms([{ id: 'l', stuck: true }], since, alarmed, 92 * MIN + 1)).toEqual(['l']);
  });

  it('never alarms a capped or paused loop (not stuck)', () => {
    const since = new Map<string, number>();
    expect(idleAlarms([{ id: 'l', stuck: false }], since, new Set(), 999 * MIN)).toEqual([]);
    expect(since.size).toBe(0);
  });
});
