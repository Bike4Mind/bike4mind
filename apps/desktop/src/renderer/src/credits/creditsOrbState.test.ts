import { describe, expect, it } from 'vitest';
import type { AccountProfile, BillingAccount } from '@shared/account';
import { creditOutlook, DAY_MS, nextRefillAt } from './creditOutlook';
import {
  creditsOrbLabel,
  creditsOrbState,
  ORB_FILL_CEILING_PERCENT,
  ORB_FILL_FLOOR_PERCENT,
  orbFillPercent,
} from './creditsOrbState';
import type { CreditsGlance } from './useCreditsGlance';

const NOW = Date.parse('2026-11-24T12:00:00Z');

function personal(balance: number, burnPerDay: number, refillInDays: number | null): CreditsGlance {
  const profile = { credits: { balance, monthlyAllowance: 10_000 }, tier: 'pro' } as AccountProfile;
  const outlook = creditOutlook({
    balance,
    burnPerDay,
    refillAt: refillInDays === null ? null : NOW + refillInDays * DAY_MS,
    expiring: undefined,
    now: NOW,
  });
  return { profile, organization: null, outlook, burnPerDay, readAt: NOW };
}

describe('creditsOrbState', () => {
  it('is ok, filled to the runway, while the balance outlasts the period', () => {
    const state = creditsOrbState(personal(300_000, 1000, 7));
    expect(state).toMatchObject({ tone: 'ok', level: 1, balance: 300_000 });
  });

  it('is low when credits run out before the refill, with a partial fill', () => {
    const state = creditsOrbState(personal(4000, 1000, 10));
    expect(state.tone).toBe('low');
    expect(state.level).toBeCloseTo(4 / 30);
  });

  it('is critical inside two days of runway', () => {
    expect(creditsOrbState(personal(1500, 1000, 10)).tone).toBe('critical');
  });

  it('is critical and empty at zero credits', () => {
    expect(creditsOrbState(personal(0, 1000, 10))).toMatchObject({ tone: 'critical', level: 0, balance: 0 });
  });

  it('is full, not empty, for a positive balance with no recent burn', () => {
    expect(creditsOrbState(personal(10_000, 0, null))).toMatchObject({ tone: 'ok', level: 1 });
  });

  it('is unknown, with no fill, before any balance is read', () => {
    const glance: CreditsGlance = {
      profile: null,
      organization: null,
      outlook: { kind: 'unknown' },
      burnPerDay: null,
      readAt: null,
    };
    expect(creditsOrbState(glance)).toEqual({ tone: 'unknown', level: 0, balance: null });
  });

  it("reports an organization pool's balance, not the personal one", () => {
    const organization: BillingAccount = { id: 'org-1', name: 'Acme', personal: false, credits: 48_200 };
    const outlook = creditOutlook({ balance: 48_200, burnPerDay: 0, refillAt: null, expiring: undefined, now: NOW });
    const glance: CreditsGlance = { ...personal(5, 1, null), organization, outlook };
    expect(creditsOrbState(glance)).toMatchObject({ balance: 48_200, level: 1, tone: 'ok' });
  });
});

describe('creditsOrbState for the denominators the runway may lack', () => {
  const organization: BillingAccount = { id: 'org-1', name: 'Acme', personal: false, credits: 48_200 };

  it('is full for a personal payer with no monthly allowance and no burn', () => {
    const refillAt = nextRefillAt(null, null, NOW);
    const outlook = creditOutlook({ balance: 38_099, burnPerDay: 0, refillAt, expiring: undefined, now: NOW });
    const profile = { credits: { balance: 38_099, monthlyAllowance: null }, tier: 'free' } as AccountProfile;
    const glance: CreditsGlance = { profile, organization: null, outlook, burnPerDay: null, readAt: NOW };
    expect(creditsOrbState(glance)).toMatchObject({ tone: 'ok', level: 1, balance: 38_099 });
  });

  it('projects a runway with no allowance once there is burn, and is ok while it is long', () => {
    expect(creditsOrbState(personal(38_099, 200, null))).toMatchObject({ tone: 'ok', level: 1 });
  });

  it('is low with a partial fill when the balance is small and no refill is coming', () => {
    const state = creditsOrbState(personal(1000, 200, null));
    expect(state.tone).toBe('low');
    expect(state.level).toBeCloseTo(5 / 30);
  });

  it('falls back to full, not empty, when the projected fill is not a number', () => {
    const projected = creditOutlook({ balance: 38_099, burnPerDay: 1, refillAt: null, expiring: undefined, now: NOW });
    if (projected.kind !== 'no-refill') throw new Error(`expected a no-refill projection, got ${projected.kind}`);
    const glance: CreditsGlance = { ...personal(38_099, 0, null), outlook: { ...projected, ringFill: Number.NaN } };
    expect(creditsOrbState(glance).level).toBe(1);
  });

  it('shows the organization pool for an org payer and the personal balance otherwise', () => {
    const personalGlance = personal(38_099, 0, null);
    const orgOutlook = creditOutlook({ balance: 48_200, burnPerDay: 0, refillAt: null, expiring: undefined, now: NOW });
    expect(creditsOrbState(personalGlance)).toMatchObject({ balance: 38_099, level: 1, tone: 'ok' });
    expect(creditsOrbState({ ...personalGlance, organization, outlook: orgOutlook })).toMatchObject({
      balance: 48_200,
      level: 1,
      tone: 'ok',
    });
  });

  it('is critical and empty for an organization pool at zero', () => {
    const empty = { ...organization, credits: 0 };
    const outlook = creditOutlook({ balance: 0, burnPerDay: 0, refillAt: null, expiring: undefined, now: NOW });
    expect(creditsOrbState({ ...personal(38_099, 0, null), organization: empty, outlook })).toMatchObject({
      tone: 'critical',
      level: 0,
      balance: 0,
    });
  });
});

describe('orbFillPercent', () => {
  it('stops a full orb below the rim so its surface stays visible', () => {
    expect(orbFillPercent(1)).toBe(ORB_FILL_CEILING_PERCENT);
    expect(ORB_FILL_CEILING_PERCENT).toBeLessThan(100);
  });

  it('shows at least a sliver for any positive level', () => {
    expect(orbFillPercent(0.001)).toBeGreaterThanOrEqual(ORB_FILL_FLOOR_PERCENT);
  });

  it.each([0, -1, Number.NaN, Number.NEGATIVE_INFINITY])('is empty for %s', level => {
    expect(orbFillPercent(level)).toBe(0);
  });

  it('rises with the level', () => {
    expect(orbFillPercent(0.25)).toBeLessThan(orbFillPercent(0.75));
  });
});

describe('creditsOrbLabel', () => {
  it.each([
    [{ tone: 'ok', level: 1, balance: 1234 }, `Credits: ok, ${(1234).toLocaleString()} credits`],
    [{ tone: 'low', level: 0.2, balance: 500 }, 'Credits: running low, 500 credits'],
    [{ tone: 'critical', level: 0, balance: 0 }, 'Credits: almost out, 0 credits'],
    [{ tone: 'unknown', level: 0, balance: null }, 'Credits: balance unavailable'],
  ] as const)('names the state for %j', (state, label) => {
    expect(creditsOrbLabel(state)).toBe(label);
  });
});
