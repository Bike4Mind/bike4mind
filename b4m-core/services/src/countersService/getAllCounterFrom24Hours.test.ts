import { describe, it, expect, vi } from 'vitest';
import type { ICounterLogRepository } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { getCounterTotalsForLast24Hours } from './getAllCounterFrom24Hours';

const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), log: vi.fn() } as unknown as Logger;

function run(facet: Record<string, unknown>) {
  const counterLogs = { metricsByDate: vi.fn().mockResolvedValue([facet]) } as unknown as ICounterLogRepository;
  return getCounterTotalsForLast24Hours({ date: '2026-06-01' }, { db: { counterLogs }, logger });
}

describe('getCounterTotalsForLast24Hours - report window passed to metricsByDate', () => {
  function metricsByDateFor(parameters: { date: string; endDate?: string }) {
    const metricsByDate = vi.fn().mockResolvedValue([{ topUsers: [] }]);
    const counterLogs = { metricsByDate } as unknown as ICounterLogRepository;
    return { metricsByDate, run: () => getCounterTotalsForLast24Hours(parameters, { db: { counterLogs }, logger }) };
  }

  it('passes the whole Monday-Sunday range for a weekly report, not just its last day', async () => {
    const { metricsByDate, run } = metricsByDateFor({ date: '2026-06-01', endDate: '2026-06-07' });

    await run();

    expect(metricsByDate).toHaveBeenCalledWith('2026-06-07', '2026-06-01');
  });

  it('passes only the report date for a daily report', async () => {
    const { metricsByDate, run } = metricsByDateFor({ date: '2026-06-03' });

    await run();

    expect(metricsByDate).toHaveBeenCalledWith('2026-06-03', undefined);
  });

  it('derives the 4-week average from the 4-week baseline total', async () => {
    const counterLogs = {
      metricsByDate: vi.fn().mockResolvedValue([
        {
          thisWeek: [{ _id: 'Model Started', count: 6 }],
          lastWeek: [{ _id: 'Model Started', count: 4 }],
          thisMonth: [{ _id: 'Model Started', count: 8 }],
          topUsers: [],
        },
      ]),
    } as unknown as ICounterLogRepository;

    const result = await getCounterTotalsForLast24Hours(
      { date: '2026-06-01', endDate: '2026-06-07' },
      { db: { counterLogs }, logger }
    );

    expect(result.metrics['Model Started']).toEqual(
      expect.objectContaining({ weeklyTotal: 6, lastWeekTotal: 4, fourWeekAverage: 2, last24h: 0 })
    );
  });
});

describe('getCounterTotalsForLast24Hours - DAU/WAU inputs', () => {
  const topUsers = Array.from({ length: 20 }, (_, i) => ({
    _id: `u${i}`,
    email: `u${i}@example.com`,
    interactions: 1,
  }));

  it('derives externalUsers from the uncapped facets, not the capped topUsers length', async () => {
    const result = await run({
      allUsers: [{ count: 50 }],
      internalUsers: [{ count: 8 }],
      topUsers,
    });

    expect(result.userActivity.externalUsers).toBe(42);
    expect(result.userActivity.topUsers).toHaveLength(20);
  });

  it('maps the weeklyActiveUsers facet to the 7-day weekly active count', async () => {
    const result = await run({ weeklyActiveUsers: [{ count: 120 }], topUsers });

    expect(result.userActivity.weeklyActiveUsers).toBe(120);
  });

  it('defaults weeklyActiveUsers to 0 when the facet is empty or absent', async () => {
    const empty = await run({ weeklyActiveUsers: [], topUsers: [] });
    const absent = await run({ topUsers: [] });

    expect(empty.userActivity.weeklyActiveUsers).toBe(0);
    expect(absent.userActivity.weeklyActiveUsers).toBe(0);
  });

  it('passes leaderboard spend and the new-account flag through', async () => {
    const result = await run({
      topUsers: [{ _id: 'u1', email: 'u1@example.com', interactions: 3, creditsSpent: 420, isNew: true }],
    });

    expect(result.userActivity.topUsers[0]).toEqual(
      expect.objectContaining({ _id: 'u1', interactions: 3, creditsSpent: 420, isNew: true })
    );
  });

  it('defaults spend and the new-account flag when the weekly facet omits them', async () => {
    const result = await run({ topUsers: [{ _id: 'u1', email: 'u1@example.com', interactions: 3 }] });

    expect(result.userActivity.topUsers[0]).toEqual(expect.objectContaining({ creditsSpent: 0, isNew: false }));
  });
});
