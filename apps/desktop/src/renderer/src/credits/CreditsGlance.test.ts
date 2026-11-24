import { describe, expect, it } from 'vitest';
import { creditsRingLabel, creditsSubline, creditsVerdict } from './CreditsGlance';
import { creditOutlook, DAY_MS } from './creditOutlook';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const outlook = (balance: number, burnPerDay: number, refillInDays: number | null) =>
  creditOutlook({
    balance,
    burnPerDay,
    refillAt: refillInDays === null ? null : NOW + refillInDays * DAY_MS,
    now: NOW,
  });

describe('creditsVerdict', () => {
  it('never projects past a month, so expiring grants cannot make it a false promise', () => {
    // 300,000 credits at 2,000 a day is 150 days of naive runway.
    expect(creditsVerdict(outlook(300_000, 2000, 7))).toBe("More than a month left at last week's pace.");
    expect(creditsVerdict(outlook(300_000, 2000, null))).toBe("More than a month left at last week's pace.");
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
