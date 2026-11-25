import { describe, expect, it } from 'vitest';
import type { AccountProfile, BillingAccount } from '@shared/account';
import { creditOutlook, DAY_MS, nextRefillAt } from './creditOutlook';
import { compactCredits, creditsOrbLabel, creditsOrbState } from './creditsOrbState';
import type { CreditsGlance } from './useCreditsGlance';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const ORGANIZATION: BillingAccount = { id: 'org-1', name: 'Acme', personal: false, credits: 48_200 };

function personal(
  balance: number,
  burnPerDay: number,
  refillInDays: number | null,
  monthlyAllowance: number | null = 10_000
): CreditsGlance {
  const profile = { credits: { balance, monthlyAllowance }, tier: 'pro' } as AccountProfile;
  const outlook = creditOutlook({
    balance,
    burnPerDay,
    refillAt: refillInDays === null ? null : NOW + refillInDays * DAY_MS,
    expiring: undefined,
    now: NOW,
  });
  return { profile, organization: null, outlook, burnPerDay, readAt: NOW };
}

function organizationPays(credits: number): CreditsGlance {
  const organization = { ...ORGANIZATION, credits };
  const outlook = creditOutlook({ balance: credits, burnPerDay: 0, refillAt: null, expiring: undefined, now: NOW });
  return { ...personal(38_099, 500, null), organization, outlook };
}

describe('creditsOrbState', () => {
  it('is neutral with the compact balance and a runway line while the balance lasts', () => {
    expect(creditsOrbState(personal(38_099, 1800, null))).toEqual({
      tone: 'ok',
      balance: 38_099,
      compact: '38k',
      runway: 'About 3 weeks at your recent usage',
    });
  });

  it('stays neutral, with no runway claim, when there is no recent burn', () => {
    expect(creditsOrbState(personal(38_099, 0, null))).toMatchObject({ tone: 'ok', compact: '38k', runway: null });
  });

  it('projects a runway for an account with no monthly allowance', () => {
    const refillAt = nextRefillAt(null, null, NOW);
    expect(refillAt).toBeNull();
    const state = creditsOrbState(personal(38_099, 100, null, null));
    expect(state).toMatchObject({ tone: 'ok', compact: '38k' });
    expect(state.runway).toMatch(/at your recent usage$/);
  });

  it('is low inside a week of runway', () => {
    expect(creditsOrbState(personal(4212, 800, null))).toMatchObject({
      tone: 'low',
      compact: '4.2k',
      runway: 'About 5 days at your recent usage',
    });
  });

  it('is critical inside two days of runway', () => {
    expect(creditsOrbState(personal(900, 1000, null))).toMatchObject({
      tone: 'critical',
      runway: 'Under a day at your recent usage',
    });
  });

  it('is critical and out at zero credits', () => {
    expect(creditsOrbState(personal(0, 1000, 10))).toMatchObject({
      tone: 'critical',
      compact: '0',
      runway: 'Out of credits',
    });
  });

  it('does not turn amber for a long runway that falls a little short of the refill', () => {
    // 20 days of runway, refill in 25: the menu calls this short, the orb is a glance.
    expect(creditsOrbState(personal(20_000, 1000, 25)).tone).toBe('ok');
  });

  it('stays neutral inside a week of runway when the refill lands first', () => {
    // 5 days of runway, refill in 2: the menu calls this covered, so the orb must not go amber.
    expect(creditsOrbState(personal(5000, 1000, 2)).tone).toBe('ok');
  });

  it('is critical inside two days of runway even when the refill lands first', () => {
    expect(creditsOrbState(personal(1500, 1000, 1)).tone).toBe('critical');
  });

  it("shows an organization pool's balance, neutral, since its burn is not known", () => {
    expect(creditsOrbState(organizationPays(48_200))).toEqual({
      tone: 'ok',
      balance: 48_200,
      compact: '48k',
      runway: 'Organization pool',
    });
  });

  it('is critical and out for an organization pool at zero', () => {
    expect(creditsOrbState(organizationPays(0))).toMatchObject({
      tone: 'critical',
      compact: '0',
      runway: 'Out of credits',
    });
  });

  it('is unknown before any balance is read', () => {
    const glance: CreditsGlance = {
      profile: null,
      organization: null,
      outlook: { kind: 'unknown' },
      burnPerDay: null,
      readAt: null,
    };
    expect(creditsOrbState(glance)).toEqual({ tone: 'unknown', balance: null, compact: null, runway: null });
  });
});

describe('compactCredits', () => {
  it.each([
    [0, '0'],
    [-5, '0'],
    [Number.NaN, '0'],
    [850, '850'],
    [999.9, '999'],
    [1000, '1k'],
    [4212, '4.2k'],
    [9999, '9.9k'],
    [38_099, '38k'],
    [300_000, '300k'],
    [999_800, '999k'],
    [1_000_000, '1M'],
    [2_570_339, '2.5M'],
    [12_400_000, '12M'],
    [123_000_000, '123M'],
    [1_500_000_000, '1B'],
  ])('prints %s as %s, never rounding up', (value, expected) => {
    expect(compactCredits(value)).toBe(expected);
  });

  it('fits in four characters across every scale', () => {
    for (const value of [999, 9999, 99_999, 999_999, 9_999_999, 999_999_999, 999_999_999_999]) {
      expect(compactCredits(value).length).toBeLessThanOrEqual(4);
    }
  });
});

describe('creditsOrbLabel', () => {
  it.each([
    [{ tone: 'ok', balance: 1234, compact: '1.2k', runway: null }, `Credits: ok, ${(1234).toLocaleString()} credits`],
    [{ tone: 'low', balance: 500, compact: '500', runway: null }, 'Credits: running low, 500 credits'],
    [{ tone: 'critical', balance: 0, compact: '0', runway: 'Out of credits' }, 'Credits: almost out, 0 credits'],
    [{ tone: 'unknown', balance: null, compact: null, runway: null }, 'Credits: balance unavailable'],
  ] as const)('names the state for %j', (state, label) => {
    expect(creditsOrbLabel(state)).toBe(label);
  });
});
