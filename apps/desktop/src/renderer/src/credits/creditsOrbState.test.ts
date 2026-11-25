import { describe, expect, it } from 'vitest';
import type { AccountProfile, BillingAccount } from '@shared/account';
import { creditOutlook, DAY_MS } from './creditOutlook';
import { creditsOrbLabel, creditsOrbState } from './creditsOrbState';
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
