import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The env registry is read at module load, so seed an env-only partner domain before any import.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_PREMIUM_DOMAIN_GRANTS = JSON.stringify([
    { domain: 'envonly.example', entitlements: ['questmaster:pro'] },
  ]);
});

// Only the enabled rules come back from the repository (the enabled filter is the query itself,
// pinned in PartnerSignupRuleModel.test.ts), so a disabled rule is simply absent here.
const mockFindActiveRules = vi.fn();
vi.mock('@bike4mind/database', () => ({
  partnerSignupRuleRepository: {
    findActiveRules: (...a: unknown[]) => mockFindActiveRules(...a),
  },
}));

import { invalidatePartnerRuleCache } from '@server/entitlements/partnerRules';
import { signupCreditsForEmail } from '@bike4mind/server-utils/lib/entitlements/registry';
import { isPartnerDomainSignupAllowed } from './partnerSignupBypass';

const ENABLED_RULE = { id: 'rule-1', domain: 'partner.example', entitlements: [], signupCredits: 0 };

describe('isPartnerDomainSignupAllowed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidatePartnerRuleCache();
    mockFindActiveRules.mockResolvedValue([ENABLED_RULE]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('allows a verified email on an enabled DB rule domain', async () => {
    expect(await isPartnerDomainSignupAllowed('someone@partner.example', true)).toBe(true);
  });

  it('matches the domain case-insensitively', async () => {
    expect(await isPartnerDomainSignupAllowed('Someone@PARTNER.Example', true)).toBe(true);
  });

  it('refuses an unverified email even on a rule domain', async () => {
    expect(await isPartnerDomainSignupAllowed('someone@partner.example', false)).toBe(false);
    expect(mockFindActiveRules).not.toHaveBeenCalled();
  });

  it('refuses a missing email', async () => {
    expect(await isPartnerDomainSignupAllowed(null, true)).toBe(false);
    expect(await isPartnerDomainSignupAllowed('', true)).toBe(false);
  });

  it('refuses a domain with no rule', async () => {
    expect(await isPartnerDomainSignupAllowed('someone@other.example', true)).toBe(false);
  });

  it('refuses when the rule is disabled (absent from the active set)', async () => {
    mockFindActiveRules.mockResolvedValue([]);
    expect(await isPartnerDomainSignupAllowed('someone@partner.example', true)).toBe(false);
  });

  it('refuses a disabled rule after the warm-instance cache expires', async () => {
    vi.useFakeTimers();
    expect(await isPartnerDomainSignupAllowed('someone@partner.example', true)).toBe(true);
    mockFindActiveRules.mockResolvedValue([]);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(await isPartnerDomainSignupAllowed('someone@partner.example', true)).toBe(false);
    expect(mockFindActiveRules).toHaveBeenCalledTimes(2);
  });

  it('refuses an env-registry-only domain', async () => {
    // Sanity: the env row is live, so a refusal below is the bypass ignoring it.
    expect(signupCreditsForEmail('someone@envonly.example', true)).toBeGreaterThan(0);
    expect(await isPartnerDomainSignupAllowed('someone@envonly.example', true)).toBe(false);
  });

  it.each([
    'someone@evilpartner.example',
    'someone@sub.partner.example',
    'someone@partner.example.attacker.com',
    'someone@partner.examplex',
    'partner.example@attacker.com',
    'someone@partner.example@attacker.com',
  ])('refuses the lookalike %s', async email => {
    expect(await isPartnerDomainSignupAllowed(email, true)).toBe(false);
  });

  it('fails closed when the rules cannot load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockFindActiveRules.mockRejectedValue(new Error('db down'));
    expect(await isPartnerDomainSignupAllowed('someone@partner.example', true)).toBe(false);
  });
});
