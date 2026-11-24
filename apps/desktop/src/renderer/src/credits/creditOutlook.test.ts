import { describe, expect, it } from 'vitest';
import type { UsageBar } from '@shared/usage';
import { creditOutlook, dailyBurn, DAY_MS, formatRunway, nextRefillAt, refillMarker } from './creditOutlook';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const day = (offset: number) => new Date(Date.parse('2026-11-24T00:00:00Z') + offset * DAY_MS).toISOString();
const bar = (offset: number, creditsSpent: number): UsageBar => ({ startsAt: day(offset), creditsSpent, requests: 1 });

describe('dailyBurn', () => {
  it('is zero with no bars', () => {
    expect(dailyBurn([], NOW)).toBe(0);
  });

  it('averages the last seven bars over the time since the oldest began', () => {
    // Days -6..0 at 100 each: 700 credits over 6.5 days (today is half over).
    const bars = Array.from({ length: 10 }, (_, i) => bar(i - 9, 100));
    expect(dailyBurn(bars, NOW)).toBeCloseTo(700 / 6.5);
  });

  it('ignores older bars, future bars and order', () => {
    const bars = [bar(0, 70), bar(-20, 10_000), bar(3, 10_000)];
    expect(dailyBurn(bars, NOW)).toBe(70); // one partial day, floored to a one-day divisor
  });

  it('never counts a negative bar as income', () => {
    expect(dailyBurn([bar(-1, -500), bar(0, 30)], NOW)).toBeCloseTo(30 / 1.5);
  });
});

describe('nextRefillAt', () => {
  const plan = { name: 'Pro', interval: 'monthly' as const, currentPeriodEndsAt: '2026-12-01T00:00:00Z' };

  it('reads a monthly period end in the future', () => {
    expect(nextRefillAt(plan, NOW)).toBe(Date.parse('2026-12-01T00:00:00Z'));
  });

  it('does not promise a refill for no plan, a yearly plan, a passed or a garbled date', () => {
    expect(nextRefillAt(null, NOW)).toBeNull();
    expect(nextRefillAt({ ...plan, interval: 'yearly' }, NOW)).toBeNull();
    expect(nextRefillAt({ ...plan, currentPeriodEndsAt: '2026-11-01T00:00:00Z' }, NOW)).toBeNull();
    expect(nextRefillAt({ ...plan, currentPeriodEndsAt: 'soon' }, NOW)).toBeNull();
  });
});

describe('refillMarker', () => {
  it('places the refill along a 30-day ring, clamped', () => {
    expect(refillMarker(null, NOW)).toBeNull();
    expect(refillMarker(NOW + 15 * DAY_MS, NOW)).toBeCloseTo(0.5);
    expect(refillMarker(NOW + 90 * DAY_MS, NOW)).toBe(1);
  });
});

describe('creditOutlook', () => {
  const refillAt = NOW + 7 * DAY_MS;

  it('is unknown when the balance could not be read', () => {
    expect(creditOutlook({ balance: null, burnPerDay: 10, refillAt, now: NOW })).toEqual({ kind: 'unknown' });
  });

  it('is empty and critical at zero, whatever the burn', () => {
    expect(creditOutlook({ balance: 0, burnPerDay: 0, refillAt, now: NOW })).toMatchObject({
      kind: 'empty',
      tone: 'critical',
      ringFill: 0,
    });
  });

  it('is idle and full with no recent spend', () => {
    expect(creditOutlook({ balance: 50, burnPerDay: 0, refillAt: null, now: NOW })).toMatchObject({
      kind: 'idle',
      tone: 'ok',
      ringFill: 1,
    });
  });

  it('is covered when the balance outlasts the refill', () => {
    const outlook = creditOutlook({ balance: 1000, burnPerDay: 100, refillAt, now: NOW });
    expect(outlook).toMatchObject({ kind: 'covered', tone: 'ok', runwayDays: 10 });
    if (outlook.kind === 'covered') expect(outlook.ringFill).toBeCloseTo(10 / 30);
  });

  it('caps a banked balance at a full ring instead of overflowing', () => {
    // 300,000 credits on a 10,000/month plan, spending 2,000 a day: 150 days.
    const outlook = creditOutlook({ balance: 300_000, burnPerDay: 2000, refillAt, now: NOW });
    expect(outlook).toMatchObject({ kind: 'covered', tone: 'ok', ringFill: 1, runwayDays: 150 });
  });

  it('is short and low when it runs out before the refill', () => {
    const outlook = creditOutlook({ balance: 400, burnPerDay: 100, refillAt, now: NOW });
    expect(outlook).toMatchObject({ kind: 'short', tone: 'low', daysShort: 3, runsOutAt: NOW + 4 * DAY_MS });
  });

  it('is critical under two days of runway, refill or not', () => {
    expect(creditOutlook({ balance: 150, burnPerDay: 100, refillAt, now: NOW })).toMatchObject({
      kind: 'short',
      tone: 'critical',
    });
    expect(creditOutlook({ balance: 150, burnPerDay: 100, refillAt: NOW + DAY_MS, now: NOW })).toMatchObject({
      kind: 'covered',
      tone: 'critical',
    });
  });

  it('without a refill, warns a week out', () => {
    expect(creditOutlook({ balance: 800, burnPerDay: 100, refillAt: null, now: NOW })).toMatchObject({
      kind: 'no-refill',
      tone: 'ok',
    });
    expect(creditOutlook({ balance: 600, burnPerDay: 100, refillAt: null, now: NOW })).toMatchObject({
      kind: 'no-refill',
      tone: 'low',
    });
  });
});

describe('formatRunway', () => {
  it.each([
    [0.5, 'under a day'],
    [1, '1 day'],
    [13.9, '13 days'],
    [21, '3 weeks'],
    [150, '5 months'],
    [400, 'over a year'],
  ])('%s days reads "%s"', (days, text) => {
    expect(formatRunway(days)).toBe(text);
  });
});
