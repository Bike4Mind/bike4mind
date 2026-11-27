import { describe, expect, it } from 'vitest';
import type { UsageBar } from '@shared/usage';
import {
  creditOutlook,
  dailyBurn,
  DAY_MS,
  formatRunway,
  nextRefillAt,
  projectRunwayDays,
  refillMarker,
  runwayBeyondStatedHorizon,
  upcomingExpiry,
} from './creditOutlook';

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
    expect(nextRefillAt(plan, 50_000, NOW)).toBe(Date.parse('2026-12-01T00:00:00Z'));
  });

  it('does not promise a refill for no plan, a yearly plan, a passed or a garbled date', () => {
    expect(nextRefillAt(null, 50_000, NOW)).toBeNull();
    expect(nextRefillAt({ ...plan, interval: 'yearly' }, 50_000, NOW)).toBeNull();
    expect(nextRefillAt({ ...plan, currentPeriodEndsAt: '2026-11-01T00:00:00Z' }, 50_000, NOW)).toBeNull();
    expect(nextRefillAt({ ...plan, currentPeriodEndsAt: 'soon' }, 50_000, NOW)).toBeNull();
  });

  it('does not read an org seat renewal as a personal refill', () => {
    // An org seat brings a plan but no personal allowance: its renewal fills the org's pool.
    expect(nextRefillAt(plan, null, NOW)).toBeNull();
    expect(nextRefillAt(plan, 0, NOW)).toBeNull();
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
    expect(creditOutlook({ balance: null, burnPerDay: 10, refillAt, expiring: undefined, now: NOW })).toEqual({
      kind: 'unknown',
    });
  });

  it('is empty and critical at zero, whatever the burn', () => {
    expect(creditOutlook({ balance: 0, burnPerDay: 0, refillAt, expiring: undefined, now: NOW })).toMatchObject({
      kind: 'empty',
      tone: 'critical',
      ringFill: 0,
    });
  });

  it('is idle with an empty ring when there is no recent spend, so a small balance never looks plentiful', () => {
    expect(creditOutlook({ balance: 50, burnPerDay: 0, refillAt: null, expiring: undefined, now: NOW })).toMatchObject({
      kind: 'idle',
      tone: 'ok',
      ringFill: 0,
    });
  });

  it('is covered when the balance outlasts the refill', () => {
    const outlook = creditOutlook({ balance: 1000, burnPerDay: 100, refillAt, expiring: undefined, now: NOW });
    expect(outlook).toMatchObject({ kind: 'covered', tone: 'ok', runwayDays: 10 });
    if (outlook.kind === 'covered') expect(outlook.ringFill).toBeCloseTo(10 / 30);
  });

  it('caps a banked balance at a full ring instead of overflowing', () => {
    // 300,000 credits on a 10,000/month plan, spending 2,000 a day: 150 days.
    const outlook = creditOutlook({ balance: 300_000, burnPerDay: 2000, refillAt, expiring: undefined, now: NOW });
    expect(outlook).toMatchObject({ kind: 'covered', tone: 'ok', ringFill: 1, runwayDays: 150 });
  });

  it('is short and low when it runs out before the refill', () => {
    const outlook = creditOutlook({ balance: 400, burnPerDay: 100, refillAt, expiring: undefined, now: NOW });
    expect(outlook).toMatchObject({ kind: 'short', tone: 'low', daysShort: 3, runsOutAt: NOW + 4 * DAY_MS });
  });

  it('is critical under two days of runway, refill or not', () => {
    expect(creditOutlook({ balance: 150, burnPerDay: 100, refillAt, expiring: undefined, now: NOW })).toMatchObject({
      kind: 'short',
      tone: 'critical',
    });
    expect(
      creditOutlook({ balance: 150, burnPerDay: 100, refillAt: NOW + DAY_MS, expiring: undefined, now: NOW })
    ).toMatchObject({
      kind: 'covered',
      tone: 'critical',
    });
  });

  it('without a refill, warns a week out', () => {
    expect(
      creditOutlook({ balance: 800, burnPerDay: 100, refillAt: null, expiring: undefined, now: NOW })
    ).toMatchObject({
      kind: 'no-refill',
      tone: 'ok',
    });
    expect(
      creditOutlook({ balance: 600, burnPerDay: 100, refillAt: null, expiring: undefined, now: NOW })
    ).toMatchObject({
      kind: 'no-refill',
      tone: 'low',
    });
  });
});

describe('projectRunwayDays', () => {
  const expires = (days: number, amount: number) => ({ amount, expiresAt: NOW + days * DAY_MS });

  it('is balance over burn when nothing expires', () => {
    expect(projectRunwayDays({ balance: 1000, burnPerDay: 100, expiring: [], now: NOW })).toBe(10);
  });

  it('loses only the part of a grant left unspent at its expiry', () => {
    // 500 no grant covers is spent first (days 0-5); the 1000 grant expiring on day 4 is untouched, so all of it is lost on day 4.
    const runway = projectRunwayDays({ balance: 1500, burnPerDay: 100, expiring: [expires(4, 1000)], now: NOW });
    expect(runway).toBe(5);
  });

  it('spends credits no grant covers before a grant that is still counted', () => {
    // 200 uncovered lasts 2 days, then the 1000 grant is spent for 8 of the 10 days it has.
    const runway = projectRunwayDays({ balance: 1200, burnPerDay: 100, expiring: [expires(10, 1000)], now: NOW });
    expect(runway).toBe(10);
  });

  it('changes nothing when a grant is spent before it expires', () => {
    const runway = projectRunwayDays({ balance: 1000, burnPerDay: 100, expiring: [expires(20, 1000)], now: NOW });
    expect(runway).toBe(10);
  });

  it('draws the soonest-expiring grant first, as the sweep assigns it', () => {
    // Day 0-3 spends the day-3 grant in full; the day-5 grant then has 2 days before 300 of it is lost.
    const runway = projectRunwayDays({
      balance: 800,
      burnPerDay: 100,
      expiring: [expires(5, 500), expires(3, 300)],
      now: NOW,
    });
    expect(runway).toBe(5);
  });

  it('runs out at the expiry itself when the expiring grant was the whole balance', () => {
    expect(projectRunwayDays({ balance: 1000, burnPerDay: 100, expiring: [expires(2, 1000)], now: NOW })).toBe(2);
  });

  it('deducts a grant already expired but not yet swept straight away', () => {
    expect(projectRunwayDays({ balance: 1000, burnPerDay: 100, expiring: [expires(-0.5, 400)], now: NOW })).toBe(6);
  });

  it('trims a schedule that sums past the balance to the balance', () => {
    expect(projectRunwayDays({ balance: 300, burnPerDay: 100, expiring: [expires(30, 1000)], now: NOW })).toBe(3);
  });
});

describe('creditOutlook with an expiry schedule', () => {
  const refillAt = NOW + 7 * DAY_MS;

  it('turns covered into short when a big grant expires before the refill', () => {
    // 2000 credits at 100/day would last 20 days, well past the day-7 refill...
    expect(creditOutlook({ balance: 2000, burnPerDay: 100, refillAt, expiring: undefined, now: NOW })).toMatchObject({
      kind: 'covered',
      runwayDays: 20,
    });
    // ...but 1800 of it expires on day 3: the other 200 is spent first, then 100 of the grant, and the rest is lost.
    const outlook = creditOutlook({
      balance: 2000,
      burnPerDay: 100,
      refillAt,
      expiring: [{ amount: 1800, expiresAt: NOW + 3 * DAY_MS }],
      now: NOW,
    });
    expect(outlook).toMatchObject({ kind: 'short', tone: 'low', runwayDays: 3, daysShort: 4, expiryKnown: true });
  });

  it('marks a projection made without a schedule, so its claim stays capped', () => {
    expect(
      creditOutlook({ balance: 1000, burnPerDay: 10, refillAt: null, expiring: undefined, now: NOW })
    ).toMatchObject({
      expiryKnown: false,
    });
    expect(creditOutlook({ balance: 1000, burnPerDay: 10, refillAt: null, expiring: [], now: NOW })).toMatchObject({
      expiryKnown: true,
    });
  });
});

describe('upcomingExpiry', () => {
  const at = (days: number) => NOW + days * DAY_MS;

  it('is the soonest grant expiring within two weeks, with same-day grants summed', () => {
    const expiring = [
      { amount: 100, expiresAt: at(5) },
      { amount: 50, expiresAt: at(5) + 60_000 },
      { amount: 999, expiresAt: at(9) },
    ];
    expect(upcomingExpiry(expiring, NOW)).toEqual({ amount: 150, expiresAt: at(5) });
  });

  it('is null past two weeks, for a grant already expired, or with no schedule', () => {
    expect(upcomingExpiry([{ amount: 100, expiresAt: at(15) }], NOW)).toBeNull();
    expect(upcomingExpiry([{ amount: 100, expiresAt: at(-1) }], NOW)).toBeNull();
    expect(upcomingExpiry(undefined, NOW)).toBeNull();
  });
});

describe('formatRunway', () => {
  it.each([
    [0.5, 'under a day'],
    [1, '1 day'],
    [13.9, '13 days'],
    [21, '3 weeks'],
    [30, '4 weeks'],
    [31, 'over a month'],
    [150, 'over a month'],
  ])('without an expiry schedule, %s days reads "%s"', (days, text) => {
    expect(formatRunway(days, false)).toBe(text);
  });

  it.each([
    [21, '3 weeks'],
    [31, '1 month'],
    [150, '5 months'],
    [365, '12 months'],
    [400, 'over a year'],
  ])('with an expiry schedule, %s days reads "%s"', (days, text) => {
    expect(formatRunway(days, true)).toBe(text);
  });

  it('states a runway as "more than" past a month without a schedule, past a year with one', () => {
    expect(runwayBeyondStatedHorizon(31, false)).toBe(true);
    expect(runwayBeyondStatedHorizon(150, true)).toBe(false);
    expect(runwayBeyondStatedHorizon(400, true)).toBe(true);
  });
});
