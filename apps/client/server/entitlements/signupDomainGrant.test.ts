import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';

const { creditLotRepository, mockAddTagsToUser } = vi.hoisted(() => ({
  creditLotRepository: { id: 'lots' },
  mockAddTagsToUser: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  creditLotRepository,
  creditTransactionRepository: {},
  organizationRepository: {},
  userRepository: { addTagsToUser: (...a: unknown[]) => mockAddTagsToUser(...a) },
}));

const mockAddCredits = vi.fn();
const mockApplyPartnerRuleMembership = vi.fn();
vi.mock('@bike4mind/services', () => ({
  creditService: { addCredits: (...a: unknown[]) => mockAddCredits(...a) },
  organizationService: { applyPartnerRuleMembership: (...a: unknown[]) => mockApplyPartnerRuleMembership(...a) },
}));

const mockPartnerGrant = vi.fn();
vi.mock('@server/entitlements/partnerRules', () => ({
  partnerSignupGrantForEmail: (...a: unknown[]) => mockPartnerGrant(...a),
}));

const mockGrantSubscription = vi.fn();
vi.mock('@server/subscriptions/grantIndividualAdminSubscription', () => ({
  grantIndividualAdminSubscription: (...a: unknown[]) => mockGrantSubscription(...a),
}));

const mockEntitlementsForEmail = vi.fn();
const mockSignupCreditsForKeys = vi.fn();
vi.mock('@client/lib/entitlements/registry', () => ({
  entitlementsForEmail: (...a: unknown[]) => mockEntitlementsForEmail(...a),
  signupCreditsForKeys: (...a: unknown[]) => mockSignupCreditsForKeys(...a),
}));

const mockPushInvalidation = vi.fn();
const mockPushSubscriptionsInvalidation = vi.fn();
vi.mock('@server/entitlements/invalidate', () => ({
  pushEntitlementInvalidation: (...a: unknown[]) => mockPushInvalidation(...a),
  pushSubscriptionsInvalidation: (...a: unknown[]) => mockPushSubscriptionsInvalidation(...a),
}));

const mockNotifyRaised = vi.fn();
const mockNotifyAtCapacity = vi.fn();
vi.mock('@server/organizations/notifySeatCeilingRaised', () => ({
  notifySeatCeilingRaised: (...a: unknown[]) => mockNotifyRaised(...a),
  notifyPartnerSignupBlockedAtCapacity: (...a: unknown[]) => mockNotifyAtCapacity(...a),
}));

import { applySignupDomainGrant } from './signupDomainGrant';

const makeLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
const run = (logger = makeLogger()) =>
  applySignupDomainGrant({
    userId: 'user-1',
    email: 'dee@partner.example',
    trigger: 'oauth-signup',
    // Only info/warn/error are called.
    logger: logger as unknown as Logger,
  });

describe('applySignupDomainGrant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPartnerGrant.mockResolvedValue({
      matched: true,
      entitlements: new Set(['optihashi:pro']),
      signupCredits: 1000,
      organizationId: 'org-1',
      tags: ['Partner', 'cohort-a'],
    });
    mockAddTagsToUser.mockResolvedValue(undefined);
    mockGrantSubscription.mockResolvedValue({ status: 'granted', credits: 3000, currentCredits: 4100 });
    mockAddCredits.mockResolvedValue({ currentCredits: 1100 });
    mockApplyPartnerRuleMembership.mockResolvedValue({ added: true, reason: 'added' });
    mockEntitlementsForEmail.mockReturnValue(new Set());
    mockSignupCreditsForKeys.mockReturnValue(0);
  });

  it('grants the rule credits under the stable id, adds the org membership, and wakes the entitlement cache', async () => {
    const result = await run();

    expect(result).toEqual({
      creditsGranted: 1000,
      currentCredits: 1100,
      joinedOrganizationId: 'org-1',
      tagsApplied: ['Partner', 'cohort-a'],
      subscriptionGranted: false,
    });
    expect(mockAddCredits).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'user-1', credits: 1000, transactionId: 'domain-grant-credits:user-1' }),
      expect.objectContaining({ db: expect.objectContaining({ creditLots: creditLotRepository }) })
    );
    expect(mockApplyPartnerRuleMembership).toHaveBeenCalledWith(
      { userId: 'user-1', organizationId: 'org-1' },
      expect.anything()
    );
    expect(mockPushInvalidation).toHaveBeenCalledWith('user-1', expect.anything());
    expect(mockEntitlementsForEmail).not.toHaveBeenCalled();
  });

  it('falls back to the env registry when no DB rule matches, with no org membership', async () => {
    mockPartnerGrant.mockResolvedValue({
      matched: false,
      entitlements: new Set(),
      signupCredits: 0,
      organizationId: null,
      tags: [],
    });
    mockEntitlementsForEmail.mockReturnValue(new Set(['optihashi:pro']));
    mockSignupCreditsForKeys.mockReturnValue(250);

    const result = await run();

    expect(result).toEqual({
      creditsGranted: 250,
      currentCredits: 1100,
      joinedOrganizationId: null,
      tagsApplied: [],
      subscriptionGranted: false,
    });
    expect(mockApplyPartnerRuleMembership).not.toHaveBeenCalled();
    expect(mockAddTagsToUser).not.toHaveBeenCalled();
  });

  it('merges the matched rule tags into the user', async () => {
    await run();

    expect(mockAddTagsToUser).toHaveBeenCalledWith('user-1', ['Partner', 'cohort-a']);
  });

  it('skips the tag write when the matched rule has no tags', async () => {
    mockPartnerGrant.mockResolvedValue({
      matched: true,
      entitlements: new Set(['optihashi:pro']),
      signupCredits: 1000,
      organizationId: null,
      tags: [],
    });

    await run();

    expect(mockAddTagsToUser).not.toHaveBeenCalled();
  });

  it('wakes the entitlement cache when only tags were applied', async () => {
    mockPartnerGrant.mockResolvedValue({
      matched: true,
      entitlements: new Set(),
      signupCredits: 0,
      organizationId: null,
      tags: ['Partner'],
    });

    await run();

    expect(mockPushInvalidation).toHaveBeenCalledWith('user-1', expect.anything());
  });

  it('re-applies the same tags on a second run (the repository merge keeps it idempotent)', async () => {
    await run();
    await run();

    expect(mockAddTagsToUser).toHaveBeenCalledTimes(2);
    expect(mockAddTagsToUser).toHaveBeenNthCalledWith(2, 'user-1', ['Partner', 'cohort-a']);
  });

  it('logs and still applies credits and membership when the tag write fails', async () => {
    mockAddTagsToUser.mockRejectedValue(new Error('user store down'));
    const logger = makeLogger();

    const result = await run(logger);

    expect(result).toEqual({
      creditsGranted: 1000,
      currentCredits: 1100,
      joinedOrganizationId: 'org-1',
      tagsApplied: [],
      subscriptionGranted: false,
    });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('user-1'), expect.any(Error));
  });

  it('honours a matched rule with 0 credits without falling through to the env amount', async () => {
    mockPartnerGrant.mockResolvedValue({
      matched: true,
      entitlements: new Set(['optihashi:pro']),
      signupCredits: 0,
      organizationId: null,
      tags: [],
    });

    const result = await run();

    expect(result.creditsGranted).toBe(0);
    expect(mockAddCredits).not.toHaveBeenCalled();
    expect(mockSignupCreditsForKeys).not.toHaveBeenCalled();
  });

  it('alerts on a seat-ceiling raise with the caller trigger', async () => {
    mockApplyPartnerRuleMembership.mockResolvedValue({
      added: true,
      reason: 'added-seat-raised',
      previousSeats: 5,
      newSeats: 6,
    });

    await run();

    expect(mockNotifyRaised).toHaveBeenCalledWith(
      { organizationId: 'org-1', userId: 'user-1', previousSeats: 5, newSeats: 6, trigger: 'oauth-signup' },
      expect.anything()
    );
  });

  it('alerts when the org is at capacity and reports no join', async () => {
    mockApplyPartnerRuleMembership.mockResolvedValue({ added: false, reason: 'at-capacity', seats: 10 });

    const result = await run();

    expect(result.joinedOrganizationId).toBeNull();
    expect(mockNotifyAtCapacity).toHaveBeenCalledWith(
      { organizationId: 'org-1', userId: 'user-1', seats: 10, trigger: 'oauth-signup' },
      expect.anything()
    );
  });

  it('logs and still applies membership when the credit grant fails', async () => {
    mockAddCredits.mockRejectedValue(new Error('ledger down'));
    const logger = makeLogger();

    const result = await run(logger);

    expect(result).toEqual({
      creditsGranted: 0,
      currentCredits: null,
      joinedOrganizationId: 'org-1',
      tagsApplied: ['Partner', 'cohort-a'],
      subscriptionGranted: false,
    });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('user-1'), expect.any(Error));
  });

  it('never throws when the membership write fails', async () => {
    mockApplyPartnerRuleMembership.mockRejectedValue(new Error('org store down'));
    const logger = makeLogger();

    const result = await run(logger);

    expect(result).toEqual({
      creditsGranted: 1000,
      currentCredits: 1100,
      joinedOrganizationId: null,
      tagsApplied: ['Partner', 'cohort-a'],
      subscriptionGranted: false,
    });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('user-1'), expect.any(Error));
  });

  it('grants nothing and never throws when the rule lookup fails', async () => {
    mockPartnerGrant.mockRejectedValue(new Error('rules down'));
    const logger = makeLogger();

    const result = await run(logger);

    expect(result).toEqual({
      creditsGranted: 0,
      currentCredits: null,
      joinedOrganizationId: null,
      tagsApplied: [],
      subscriptionGranted: false,
    });
    expect(mockAddCredits).not.toHaveBeenCalled();
    expect(mockAddTagsToUser).not.toHaveBeenCalled();
    expect(mockPushInvalidation).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('user-1'), expect.any(Error));
  });

  describe('partner-rule subscription', () => {
    const subscriptionGrant = {
      matched: true,
      entitlements: new Set<string>(),
      signupCredits: 0,
      organizationId: null,
      tags: [],
      ruleId: 'rule-1',
      domain: 'partner.example',
      subscription: { priceId: 'price_pro', durationMonths: 3 },
    };

    it('grants the rule subscription through the admin-grant path and wakes the entitlement cache', async () => {
      mockPartnerGrant.mockResolvedValue(subscriptionGrant);

      const result = await run();

      expect(result.subscriptionGranted).toBe(true);
      expect(mockGrantSubscription).toHaveBeenCalledWith({
        userId: 'user-1',
        priceId: 'price_pro',
        durationMonths: 3,
        grantedBy: 'partner-rule:rule-1',
        grantedReason: 'partner signup rule partner.example',
        skipIfAnyActiveIndividual: true,
        creditTransactionId: 'partner-rule-subscription:user-1:price_pro',
      });
      expect(mockPushInvalidation).toHaveBeenCalledWith('user-1', expect.anything());
      expect(mockPushSubscriptionsInvalidation).toHaveBeenCalledWith('user-1', expect.anything());
    });

    it('folds the subscription credits and post-grant balance into the reported result', async () => {
      mockPartnerGrant.mockResolvedValue({ ...subscriptionGrant, signupCredits: 1000 });

      const result = await run();

      expect(result.creditsGranted).toBe(1000 + 3000);
      expect(result.currentCredits).toBe(4100);
    });

    it('skips the grant when the rule has no subscription', async () => {
      mockPartnerGrant.mockResolvedValue({ ...subscriptionGrant, subscription: null });

      const result = await run();

      expect(result.subscriptionGranted).toBe(false);
      expect(mockGrantSubscription).not.toHaveBeenCalled();
    });

    it('treats an already-active subscription as a normal outcome, not an error', async () => {
      mockPartnerGrant.mockResolvedValue(subscriptionGrant);
      mockGrantSubscription.mockResolvedValue({ status: 'already_active' });
      const logger = makeLogger();

      const result = await run(logger);

      expect(result.subscriptionGranted).toBe(false);
      expect(result.creditsGranted).toBe(0);
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('already has an active individual'));
      expect(mockPushSubscriptionsInvalidation).not.toHaveBeenCalled();
    });

    it('warns when the rule references a plan that no longer exists', async () => {
      mockPartnerGrant.mockResolvedValue(subscriptionGrant);
      mockGrantSubscription.mockResolvedValue({ status: 'unknown_plan' });
      const logger = makeLogger();

      const result = await run(logger);

      expect(result.subscriptionGranted).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unknown plan price_pro'));
    });

    it('logs and still applies credits, membership and tags when the subscription grant throws', async () => {
      mockPartnerGrant.mockResolvedValue({
        ...subscriptionGrant,
        signupCredits: 1000,
        organizationId: 'org-1',
        tags: ['Partner'],
      });
      mockGrantSubscription.mockRejectedValue(new Error('subscription store down'));
      const logger = makeLogger();

      const result = await run(logger);

      expect(result).toEqual({
        creditsGranted: 1000,
        currentCredits: 1100,
        joinedOrganizationId: 'org-1',
        tagsApplied: ['Partner'],
        subscriptionGranted: false,
      });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('rule-1'), expect.any(Error));
    });
  });
});
