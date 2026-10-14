import { describe, it, expect, vi } from 'vitest';
import type { ICounterLogRepository } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { getCounterTotalsForLast24Hours } from './getAllCounterFrom24Hours';

const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), log: vi.fn() } as unknown as Logger;

function run(facet: Record<string, unknown>) {
  const counterLogs = { metricsByDate: vi.fn().mockResolvedValue([facet]) } as unknown as ICounterLogRepository;
  return getCounterTotalsForLast24Hours({ date: '2026-06-01' }, { db: { counterLogs }, logger });
}

describe('getCounterTotalsForLast24Hours - activeUsers24h', () => {
  const topUsers = Array.from({ length: 20 }, (_, i) => ({
    _id: `u${i}`,
    email: `u${i}@example.com`,
    interactions: 1,
  }));

  it('maps the uncapped activeUsers facet to activeUsers24h instead of topUsers length', async () => {
    const result = await run({
      activeUsers: [{ count: 42 }],
      topUsers,
      allUsers: [{ count: 50 }],
      internalUsers: [{ count: 8 }],
    });

    expect(result.userActivity.activeUsers24h).toBe(42);
    expect(result.userActivity.topUsers).toHaveLength(20);
  });

  it('defaults activeUsers24h to 0 when no active users are found', async () => {
    const result = await run({ activeUsers: [], topUsers: [] });

    expect(result.userActivity.activeUsers24h).toBe(0);
  });

  it('defaults activeUsers24h to 0 when the facet is absent from the aggregation result', async () => {
    const result = await run({ topUsers });

    expect(result.userActivity.activeUsers24h).toBe(0);
  });
});
