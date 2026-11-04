import { describe, it, expect, vi } from 'vitest';

vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: {} }));
vi.mock('@server/utils/startAgentExecution', () => ({ startAgentExecution: vi.fn() }));

import {
  backoffMinutes,
  idleAlarmCandidate,
  idleAlarmThresholdMin,
  longRunThresholdMs,
  median,
  pacedAllowance,
  pacedReadyAt,
  runCreditCap,
  ticketRunLimit,
} from './loopScheduler';

const at = (time: string) => new Date(`2026-10-29T${time}Z`);

describe('loop pacing and caps', () => {
  it('paces a daily budget from 1/24 in the first hour to all of it in the last', () => {
    expect(pacedAllowance(24, at('00:00:00'))).toBe(1);
    expect(pacedAllowance(24, at('02:30:00'))).toBe(3.5);
    expect(pacedAllowance(24, at('23:00:00'))).toBe(24);
    expect(pacedAllowance(24, at('23:59:59'))).toBe(24);
  });

  it('finds when the allowance covers the spend plus one iteration, or null past the budget', () => {
    expect(pacedReadyAt(24, 5, 1, at('02:30:00'))).toEqual(at('05:00:00'));
    expect(pacedReadyAt(24, 0, 0.5, at('02:30:00'))).toEqual(at('00:00:00'));
    expect(pacedReadyAt(24, 5, 0.01, at('02:30:00'))).toEqual(at('04:01:00'));
    expect(pacedReadyAt(24, 20, 5, at('02:30:00'))).toBeNull();
  });

  it('caps a run at the lowest set limit, and not at all with none set', () => {
    expect(runCreditCap([19, 8, undefined, 4.5])).toBe(4.5);
    expect(runCreditCap([undefined, undefined])).toBeUndefined();
    expect(runCreditCap([-2])).toBe(0);
  });

  it('gives a ticket three runs per stage it moves through', () => {
    expect(ticketRunLimit(['todo', 'doing', 'done'])).toBe(6);
    expect(ticketRunLimit(['todo', 'done'])).toBe(3);
  });

  it('doubles the wait per idle run, up to 8x the interval and a day', () => {
    expect([0, 1, 2, 3, 4].map(streak => backoffMinutes(15, streak))).toEqual([15, 30, 60, 120, 120]);
    expect(backoffMinutes(240, 3)).toBe(24 * 60);
    expect(backoffMinutes(2880, 2)).toBe(2880);
  });
});

describe('loop liveness thresholds', () => {
  const MIN = 60_000;

  it('takes the median of odd and even samples, unsorted', () => {
    expect(median([30, 10, 20])).toBe(20);
    expect(median([40, 10, 30, 20])).toBe(25);
  });

  it('flags a long run past the 60 min floor until 3 runs exist, then past 3x their median if higher', () => {
    expect(longRunThresholdMs([])).toBe(60 * MIN);
    expect(longRunThresholdMs([50 * MIN, 50 * MIN])).toBe(60 * MIN);
    expect(longRunThresholdMs([5 * MIN, 10 * MIN, 15 * MIN])).toBe(60 * MIN);
    expect(longRunThresholdMs([30 * MIN, 40 * MIN, 50 * MIN])).toBe(120 * MIN);
  });

  it('waits 3 intervals and at least 30 min before an idle alarm', () => {
    expect(idleAlarmThresholdMin(5)).toBe(30);
    expect(idleAlarmThresholdMin(60)).toBe(180);
  });

  it('flags only a live loop with no run, claim, hold or back-off, far enough past due', () => {
    const now = new Date('2026-10-29T12:00:00Z');
    const ago = (minutes: number) => new Date(now.getTime() - minutes * MIN);
    const base = { status: 'live' as const, intervalMinutes: 15, nextRunAt: ago(45) };
    expect(idleAlarmCandidate(base, now)).toBe(true);
    expect(idleAlarmCandidate({ ...base, nextRunAt: ago(44) }, now)).toBe(false);
    expect(idleAlarmCandidate({ ...base, status: 'paused' }, now)).toBe(false);
    expect(idleAlarmCandidate({ ...base, status: 'error' }, now)).toBe(false);
    expect(idleAlarmCandidate({ ...base, activeExecutionId: 'exec-1' }, now)).toBe(false);
    expect(idleAlarmCandidate({ ...base, leaseUntil: new Date(now.getTime() + MIN) }, now)).toBe(false);
    expect(idleAlarmCandidate({ ...base, leaseUntil: ago(1) }, now)).toBe(true);
    expect(idleAlarmCandidate({ ...base, idleStreak: 1 }, now)).toBe(false);
    expect(idleAlarmCandidate({ ...base, hold: { kind: 'capacity', at: now } }, now)).toBe(false);
    const pacedUntil = (until: Date) => ({ ...base, hold: { kind: 'pacing' as const, until, at: ago(60) } });
    expect(idleAlarmCandidate(pacedUntil(new Date(now.getTime() + MIN)), now)).toBe(false);
    // A lapsed pacing hold (owner rescheduled since) no longer hides an idle loop.
    expect(idleAlarmCandidate(pacedUntil(ago(50)), now)).toBe(true);
  });
});
