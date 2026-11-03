import { describe, it, expect, vi } from 'vitest';

vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: {} }));
vi.mock('@server/utils/startAgentExecution', () => ({ startAgentExecution: vi.fn() }));

import { backoffMinutes, pacedAllowance, pacedReadyAt, runCreditCap, ticketRunLimit } from './loopScheduler';

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
