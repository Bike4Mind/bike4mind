import { describe, it, expect, vi } from 'vitest';
import type { ICounterLogRepository } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { getCounterTotalsForLast24Hours } from './getAllCounterFrom24Hours';

const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), log: vi.fn() } as unknown as Logger;

function run(facet: Record<string, unknown>) {
  const counterLogs = { metricsByDate: vi.fn().mockResolvedValue([facet]) } as unknown as ICounterLogRepository;
  return getCounterTotalsForLast24Hours({ date: '2026-06-01' }, { db: { counterLogs }, logger });
}

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
});
