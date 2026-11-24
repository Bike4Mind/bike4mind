import { describe, expect, it } from 'vitest';
import type { CreditExpiry } from '@shared/account';
import { creditsExpiryNotice, creditsRingLabel, creditsSubline, creditsVerdict } from './CreditsGlance';
import { creditOutlook, DAY_MS } from './creditOutlook';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const outlook = (
  balance: number,
  burnPerDay: number,
  refillInDays: number | null,
  expiring: CreditExpiry[] | undefined = undefined
) =>
  creditOutlook({
    balance,
    burnPerDay,
    refillAt: refillInDays === null ? null : NOW + refillInDays * DAY_MS,
    expiring,
    now: NOW,
  });

describe('creditsVerdict', () => {
  it('without an expiry schedule, never projects past a month, so expiring grants cannot make it a false promise', () => {
    // 300,000 credits at 2,000 a day is 150 days of naive runway.
    expect(creditsVerdict(outlook(300_000, 2000, 7))).toBe("More than a month left at last week's pace.");
    expect(creditsVerdict(outlook(300_000, 2000, null))).toBe("More than a month left at last week's pace.");
  });

  it('with an expiry schedule, dates a long runway and only caps it past a year', () => {
    // Nothing expires: 150 days, stated as a date. 3,000,000 at 2,000 a day is 1,500 days.
    expect(creditsVerdict(outlook(300_000, 2000, null, []))).toMatch(/^Lasts to about .+ at last week's pace\.$/);
    expect(creditsVerdict(outlook(3_000_000, 2000, null, []))).toBe("More than a year left at last week's pace.");
  });

  it('says short when a big grant expiring soon cuts the runway before the renewal', () => {
    const expiring = [{ amount: 1800, expiresAt: NOW + 3 * DAY_MS }];
    expect(creditsVerdict(outlook(2000, 100, 7, expiring))).toMatch(
      /^Runs out about .+ at last week's pace, 4 days before the renewal on .+\.$/
    );
  });

  it('names the pace and the renewal inside the month', () => {
    expect(creditsVerdict(outlook(2000, 100, 7))).toMatch(
      /^Lasts to about .+ at last week's pace, past the renewal on .+\.$/
    );
    expect(creditsVerdict(outlook(400, 100, 7))).toMatch(
      /^Runs out about .+ at last week's pace, 3 days before the renewal on .+\.$/
    );
  });

  it('makes no judgement call, and says why there is no projection when idle', () => {
    for (const value of [outlook(2000, 100, 7), outlook(400, 100, 7), outlook(800, 100, null)]) {
      expect(creditsVerdict(value)).not.toMatch(/fine/i);
    }
    expect(creditsVerdict(outlook(50, 0, null))).toBe('No spend in the last 7 days, so nothing to project.');
  });
});

describe('creditsSubline', () => {
  it('says renews, not refill', () => {
    expect(creditsSubline(outlook(2000, 100, 7), 'pro')).toMatch(/^Renews .+ \u00b7 100\/day$/);
  });
});

describe('creditsRingLabel', () => {
  it('explains the ring in words', () => {
    expect(creditsRingLabel(outlook(2000, 100, 7))).toBe(
      "About 3 weeks left at last week's pace. A full ring is 30 days or more. The dot marks the renewal."
    );
    expect(creditsRingLabel(outlook(50, 0, null))).toBe('No spend in the last 7 days, so nothing to project.');
  });
});

describe('creditsExpiryNotice', () => {
  it('states the amount and the day', () => {
    expect(creditsExpiryNotice({ amount: 1800, expiresAt: Date.parse('2026-11-27T12:00:00Z') })).toMatch(
      /^1,800 credits expire Nov 27$/
    );
    expect(creditsExpiryNotice({ amount: 1, expiresAt: Date.parse('2026-11-27T12:00:00Z') })).toMatch(
      /^1 credit expires Nov 27$/
    );
  });
});
