import { describe, it, expect } from 'vitest';
import type { CompletionSource } from '@bike4mind/common';
import type { UserActivityMetrics } from './types';
import { formatCustomSlackMessage, formatUsageBySource } from './formatReport';

describe('formatUsageBySource', () => {
  it('returns null for undefined or empty input', () => {
    expect(formatUsageBySource(undefined)).toBeNull();
    expect(formatUsageBySource([])).toBeNull();
  });

  it('returns null when all counts sum to zero (avoids divide-by-zero in %)', () => {
    expect(
      formatUsageBySource([
        { source: 'web', count: 0 },
        { source: 'cli', count: 0 },
      ])
    ).toBeNull();
  });

  it('orders sources by the preferred order (web → cli → agent → api → system)', () => {
    const out = formatUsageBySource([
      { source: 'system', count: 1 },
      { source: 'api', count: 1 },
      { source: 'agent', count: 1 },
      { source: 'cli', count: 1 },
      { source: 'web', count: 1 },
    ]);
    expect(out).toBe('web: 20.0% · cli: 20.0% · agent: 20.0% · api: 20.0% · system: 20.0%');
  });

  it('places unknown sources after preferred ones, ordered by descending count', () => {
    const out = formatUsageBySource([
      { source: 'web', count: 90 },
      { source: 'mystery-low' as CompletionSource, count: 1 },
      { source: 'mystery-high' as CompletionSource, count: 5 },
    ]);
    expect(out).toBe('web: 93.8% · mystery-high: 5.2% · mystery-low: 1.0%');
  });

  it('renders percentages of total with one decimal place', () => {
    const out = formatUsageBySource([
      { source: 'web', count: 89 },
      { source: 'cli', count: 10 },
      { source: 'agent', count: 1 },
    ]);
    expect(out).toBe('web: 89.0% · cli: 10.0% · agent: 1.0%');
  });
});

describe('formatCustomSlackMessage - DAU', () => {
  const topUsers = Array.from({ length: 20 }, (_, i) => ({
    _id: `u${i}`,
    email: `u${i}@example.com`,
    interactions: 20 - i,
  }));
  const baseActivity: UserActivityMetrics = {
    totalUniqueUsers: 60,
    internalUsers: 5,
    externalUsers: 55,
    topUsers,
    topModels: [],
  };

  it('reports DAU from activeUsers24h rather than the capped topUsers length', () => {
    const message = formatCustomSlackMessage('App', {
      metrics: {},
      userActivity: { ...baseActivity, activeUsers24h: 42 },
    });

    expect(message).toContain('Daily Active (DAU): *42* users');
    expect(message).toContain('Active Users: *42* users');
  });

  it('uses staff-excluded externalUsers as the DAU/WAU denominator', () => {
    const message = formatCustomSlackMessage('App', {
      metrics: {},
      userActivity: { ...baseActivity, activeUsers24h: 55, externalUsers: 55 },
    });

    expect(message).toContain('Weekly Active (WAU): *55* users');
    expect(message).toContain('DAU/WAU Ratio:');
    // Against totalUniqueUsers (60, staff included) this would read 91.7%.
    expect(message).toContain('100.0%');
  });

  it('describes the leaderboard overflow by what the list holds, not as active-user count', () => {
    const message = formatCustomSlackMessage('App', {
      metrics: {},
      userActivity: { ...baseActivity, activeUsers24h: 42 },
    });

    expect(message).toContain('...and 10 more in the top 20');
  });
});
