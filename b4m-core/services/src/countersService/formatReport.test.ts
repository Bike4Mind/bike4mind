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

  it('orders sources by the preferred order (web -> cli -> desktop -> agent -> api -> system)', () => {
    const out = formatUsageBySource([
      { source: 'system', count: 1 },
      { source: 'api', count: 1 },
      { source: 'agent', count: 1 },
      { source: 'desktop', count: 1 },
      { source: 'cli', count: 1 },
      { source: 'web', count: 1 },
    ]);
    const ordered = ['web', 'cli', 'desktop', 'agent', 'api', 'system'].map(s => `${s}: 16.7%`);
    expect(out).toBe(ordered.join(' \u00b7 '));
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

describe('formatCustomSlackMessage - DAU/WAU', () => {
  const topUsers = Array.from({ length: 20 }, (_, i) => ({
    _id: `u${i}`,
    email: `u${i}@example.com`,
    interactions: 20 - i,
  }));
  const baseActivity: UserActivityMetrics = {
    totalUniqueUsers: 60,
    internalUsers: 5,
    externalUsers: 55,
    weeklyActiveUsers: 220,
    topUsers,
    topModels: [],
  };
  const render = (userActivity: UserActivityMetrics) => formatCustomSlackMessage('App', { metrics: {}, userActivity });

  it('reports DAU from externalUsers rather than the capped topUsers length', () => {
    const message = render({ ...baseActivity, externalUsers: 42 });

    expect(message).toContain('Daily Active (DAU): *42* users');
    expect(message).toContain('Active Users (24h, excl. staff): *42* users');
  });

  it('computes the DAU/WAU ratio against the 7-day weekly active count', () => {
    const message = render({ ...baseActivity, externalUsers: 55, weeklyActiveUsers: 220 });

    expect(message).toContain('Weekly Active (WAU): *220* users');
    expect(message).toContain('DAU/WAU Ratio: 🟠 25.0%');
  });

  it('moves the ratio with traffic instead of pinning it to 100%', () => {
    const lowMessage = render({ ...baseActivity, externalUsers: 5, weeklyActiveUsers: 500 });
    const highMessage = render({ ...baseActivity, externalUsers: 400, weeklyActiveUsers: 500 });

    expect(lowMessage).toContain('1.0%');
    expect(highMessage).toContain('80.0%');
  });

  it('renders DAU 0 and a 0.0% ratio when there are no external users or weekly count', () => {
    const message = render({ ...baseActivity, externalUsers: 0, weeklyActiveUsers: undefined });

    expect(message).toContain('Daily Active (DAU): *0* users');
    expect(message).toContain('Weekly Active (WAU): *0* users');
    expect(message).toContain('DAU/WAU Ratio: 🔴 0.0%');
  });

  it('describes the leaderboard overflow by what the list holds, not as active-user count', () => {
    const message = render({ ...baseActivity, externalUsers: 42 });

    expect(message).toContain('...and 10 more in the top 20');
  });
});

describe('formatCustomSlackMessage - most active users leaderboard', () => {
  const activity = (topUsers: UserActivityMetrics['topUsers']): UserActivityMetrics => ({
    totalUniqueUsers: topUsers.length,
    internalUsers: 0,
    externalUsers: topUsers.length,
    topUsers,
    topModels: [],
  });

  it('renders spend, events, the new-account tag and a profile link', () => {
    const message = formatCustomSlackMessage('App', {
      metrics: {},
      userActivity: activity([
        { _id: 'u1', email: 'alice@example.com', interactions: 120, creditsSpent: 420, isNew: true },
      ]),
      appUrl: 'https://app.example',
    });

    expect(message).toContain(
      '🏆 🔥 <https://app.example/admin?tab=users&userId=u1|alice@example.com> - 420 credits, 120 events 🆕'
    );
  });

  it('escapes Slack control characters in the link label', () => {
    const message = formatCustomSlackMessage('App', {
      metrics: {},
      userActivity: activity([{ _id: 'u1', email: 'a&b<c>@example.com', interactions: 1, creditsSpent: 1 }]),
      appUrl: 'https://app.example',
    });

    expect(message).toContain('|a&amp;b&lt;c&gt;@example.com>');
  });

  it('omits the link when no app URL is configured', () => {
    const message = formatCustomSlackMessage('App', {
      metrics: {},
      userActivity: activity([{ _id: 'u1', email: 'alice@example.com', interactions: 120, creditsSpent: 420 }]),
    });

    expect(message).toContain('🏆 🔥 alice@example.com - 420 credits, 120 events');
    expect(message).not.toContain('<https://');
  });

  it('escapes Slack control characters when no app URL is configured', () => {
    const message = formatCustomSlackMessage('App', {
      metrics: {},
      userActivity: activity([{ _id: 'u1', email: 'a&b<c>@example.com', interactions: 1, creditsSpent: 1 }]),
    });

    expect(message).toContain('a&amp;b&lt;c&gt;@example.com - 1 credits, 1 events');
    expect(message).not.toContain('a&b<c>');
  });

  it('measures engagement by events, not credits', () => {
    const message = formatCustomSlackMessage('App', {
      metrics: {},
      userActivity: activity([
        { _id: 'u1', email: 'a@example.com', interactions: 10, creditsSpent: 5 },
        { _id: 'u2', email: 'b@example.com', interactions: 1, creditsSpent: 5 },
      ]),
    });

    // 1 of 10 events is the lowest tier, though both spent the same.
    expect(message).toContain('🥈 ⭐ b@example.com - 5 credits, 1 events');
  });

  it('falls back to event counts for engagement when nobody spent', () => {
    const message = formatCustomSlackMessage('App', {
      metrics: {},
      userActivity: activity([
        { _id: 'u1', email: 'a@example.com', interactions: 10, creditsSpent: 0 },
        { _id: 'u2', email: 'b@example.com', interactions: 1, creditsSpent: 0 },
      ]),
    });

    // Proportional to events (10 of 10), not to credits (0 of 0).
    expect(message).toContain('🏆 🔥 a@example.com - 0 credits, 10 events');
  });

  it('keeps the empty state', () => {
    const message = formatCustomSlackMessage('App', { metrics: {}, userActivity: activity([]) });

    expect(message).toContain('_No user activity recorded in the last 24 hours_');
  });
});

describe('formatCustomSlackMessage - model names', () => {
  it('escapes Slack control characters in model names', () => {
    const message = formatCustomSlackMessage('App', {
      metrics: {},
      userActivity: {
        totalUniqueUsers: 0,
        internalUsers: 0,
        externalUsers: 0,
        topUsers: [],
        topModels: [{ modelName: 'custom <!channel>', count: 3 }],
      },
    });

    expect(message).toContain('custom &lt;!channel&gt;');
    expect(message).not.toContain('<!channel>');
  });
});
