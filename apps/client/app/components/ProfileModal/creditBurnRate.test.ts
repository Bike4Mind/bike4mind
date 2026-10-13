import { describe, it, expect } from 'vitest';
import { computeBurnStats, MIN_DAYS_FOR_PROJECTION } from './creditBurnRate';

const NOW = new Date('2026-10-11T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

describe('computeBurnStats', () => {
  it('averages a day-old account over one day, not the 30-day period, and withholds the projection', () => {
    const stats = computeBurnStats({
      usage: [{ credits: -760, createdAt: daysAgo(0.2) }],
      periodDays: 30,
      now: NOW,
      accountCreatedAt: daysAgo(0.5),
      balance: 9237,
    });
    expect(stats.burnRate).toBe(760);
    expect(stats.observedDays).toBe(1);
    expect(stats.daysRemaining).toBeNull();
  });

  it('averages over the account age once it is younger than the period', () => {
    const stats = computeBurnStats({
      usage: [{ credits: -100, createdAt: daysAgo(1) }],
      periodDays: 30,
      now: NOW,
      accountCreatedAt: daysAgo(10),
      balance: 1000,
    });
    expect(stats.observedDays).toBeCloseTo(10);
    expect(stats.burnRate).toBeCloseTo(10);
    expect(stats.daysRemaining).toBe(100);
  });

  it('starts projecting at exactly the minimum history', () => {
    const stats = computeBurnStats({
      usage: [{ credits: -70, createdAt: daysAgo(1) }],
      periodDays: 30,
      now: NOW,
      accountCreatedAt: daysAgo(MIN_DAYS_FOR_PROJECTION),
      balance: 700,
    });
    expect(stats.daysRemaining).toBe(70);
  });

  it('uses the full period for an account older than it', () => {
    const stats = computeBurnStats({
      usage: [{ credits: -300, createdAt: daysAgo(3) }],
      periodDays: 30,
      now: NOW,
      accountCreatedAt: daysAgo(400),
      balance: 3000,
    });
    expect(stats.observedDays).toBe(30);
    expect(stats.burnRate).toBe(10);
    expect(stats.daysRemaining).toBe(300);
  });

  it('falls back to the period when the account age is unknown', () => {
    const stats = computeBurnStats({ usage: [{ credits: -30, createdAt: daysAgo(1) }], periodDays: 30, now: NOW });
    expect(stats.observedDays).toBe(30);
    expect(stats.burnRate).toBe(1);
    expect(stats.daysRemaining).toBeNull();
  });

  it('reports no burn and no projection without usage or without a balance', () => {
    expect(computeBurnStats({ usage: [], periodDays: 7, now: NOW, balance: 100 })).toMatchObject({
      burnRate: 0,
      daysRemaining: null,
    });
    expect(
      computeBurnStats({ usage: [{ credits: -5, createdAt: daysAgo(1) }], periodDays: 7, now: NOW, balance: 0 })
        .daysRemaining
    ).toBeNull();
  });

  it('withholds the projection for an overdrawn balance instead of reporting negative days', () => {
    const stats = computeBurnStats({
      usage: [{ credits: -50, createdAt: daysAgo(3) }],
      periodDays: 30,
      now: NOW,
      accountCreatedAt: daysAgo(20),
      balance: -40,
    });
    expect(stats.burnRate).toBeGreaterThan(0);
    expect(stats.daysRemaining).toBeNull();
  });

  it('flags a rising trend when the second half of the window spends more', () => {
    const stats = computeBurnStats({
      usage: [
        { credits: -10, createdAt: daysAgo(25) },
        { credits: -100, createdAt: daysAgo(2) },
      ],
      periodDays: 30,
      now: NOW,
      accountCreatedAt: daysAgo(400),
    });
    expect(stats.usageTrend).toBe('increasing');
  });

  it('reports flat usage as stable over a 7-day window', () => {
    const usage = Array.from({ length: 14 }, (_, i) => ({ credits: -5, createdAt: daysAgo(0.25 + i * 0.5) }));
    const stats = computeBurnStats({ usage, periodDays: 7, now: NOW, balance: 1000 });
    expect(stats.usageTrend).toBe('stable');
  });

  it('counts a spring-forward week as 7 days so the projection is not withheld', () => {
    const originalTz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const now = new Date(2026, 2, 9, 12);
      const stats = computeBurnStats({
        usage: [{ credits: -70, createdAt: new Date(2026, 2, 8, 12) }],
        periodDays: 7,
        now,
        balance: 700,
      });
      expect(stats.daysRemaining).not.toBeNull();
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
});
