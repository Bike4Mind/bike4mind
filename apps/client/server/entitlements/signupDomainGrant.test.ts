import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';

const { creditLotRepository } = vi.hoisted(() => ({ creditLotRepository: { id: 'lots' } }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  creditLotRepository,
  creditTransactionRepository: {},
  organizationRepository: {},
  userRepository: {},
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

const mockEntitlementsForEmail = vi.fn();
const mockSignupCreditsForKeys = vi.fn();
vi.mock('@client/lib/entitlements/registry', () => ({
  entitlementsForEmail: (...a: unknown[]) => mockEntitlementsForEmail(...a),
  signupCreditsForKeys: (...a: unknown[]) => mockSignupCreditsForKeys(...a),
}));

const mockPushInvalidation = vi.fn();
vi.mock('@server/entitlements/invalidate', () => ({
  pushEntitlementInvalidation: (...a: unknown[]) => mockPushInvalidation(...a),
}));

const mockNotifyRaised = vi.fn();
const mockNotifyAtCapacity = vi.fn();
vi.mock('@server/organizations/notifySeatCeilingRaised', () => ({
  notifySeatCeilingRaised: (...a: unknown[]) => mockNotifyRaised(...a),
  notifyPartnerSignupBlockedAtCapacity: (...a: unknown[]) => mockNotifyAtCapacity(...a),
}));

const { premiumPartnerSignupHooks } = vi.hoisted(() => ({
  premiumPartnerSignupHooks: [] as { name: string; run: (context: unknown) => Promise<void> }[],
}));
vi.mock('@server/premium-generated/premiumPartnerSignupHooks.generated', () => ({ premiumPartnerSignupHooks }));

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
      ruleId: 'rule-1',
      domain: 'partner.example',
      entitlements: new Set(['optihashi:pro']),
      signupCredits: 1000,
      organizationId: 'org-1',
    });
    premiumPartnerSignupHooks.length = 0;
    mockAddCredits.mockResolvedValue({ currentCredits: 1100 });
    mockApplyPartnerRuleMembership.mockResolvedValue({ added: true, reason: 'added' });
    mockEntitlementsForEmail.mockReturnValue(new Set());
    mockSignupCreditsForKeys.mockReturnValue(0);
  });

  it('grants the rule credits under the stable id, adds the org membership, and wakes the entitlement cache', async () => {
    const result = await run();

    expect(result).toEqual({ creditsGranted: 1000, currentCredits: 1100, joinedOrganizationId: 'org-1' });
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
    });
    mockEntitlementsForEmail.mockReturnValue(new Set(['optihashi:pro']));
    mockSignupCreditsForKeys.mockReturnValue(250);

    const result = await run();

    expect(result).toEqual({ creditsGranted: 250, currentCredits: 1100, joinedOrganizationId: null });
    expect(mockApplyPartnerRuleMembership).not.toHaveBeenCalled();
  });

  it('honours a matched rule with 0 credits without falling through to the env amount', async () => {
    mockPartnerGrant.mockResolvedValue({
      matched: true,
      ruleId: 'rule-1',
      domain: 'partner.example',
      entitlements: new Set(['optihashi:pro']),
      signupCredits: 0,
      organizationId: null,
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

    expect(result).toEqual({ creditsGranted: 0, currentCredits: null, joinedOrganizationId: 'org-1' });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('user-1'), expect.any(Error));
  });

  it('never throws when the membership write fails', async () => {
    mockApplyPartnerRuleMembership.mockRejectedValue(new Error('org store down'));
    const logger = makeLogger();

    const result = await run(logger);

    expect(result).toEqual({ creditsGranted: 1000, currentCredits: 1100, joinedOrganizationId: null });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('user-1'), expect.any(Error));
  });

  it('grants nothing and never throws when the rule lookup fails', async () => {
    mockPartnerGrant.mockRejectedValue(new Error('rules down'));
    const logger = makeLogger();

    const result = await run(logger);

    expect(result).toEqual({ creditsGranted: 0, currentCredits: null, joinedOrganizationId: null });
    expect(mockAddCredits).not.toHaveBeenCalled();
    expect(mockPushInvalidation).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('user-1'), expect.any(Error));
  });

  describe('partner signup hooks', () => {
    const mockHook = vi.fn();
    beforeEach(() => {
      mockHook.mockResolvedValue(undefined);
      premiumPartnerSignupHooks.push({ name: 'overlay-grant', run: mockHook });
    });

    it('runs with the matched rule after the core grant, before the entitlement wake-up', async () => {
      await run();

      expect(mockHook).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          rule: { id: 'rule-1', domain: 'partner.example', organizationId: 'org-1' },
          trigger: 'oauth-signup',
        })
      );
      expect(mockHook.mock.invocationCallOrder[0]).toBeGreaterThan(mockAddCredits.mock.invocationCallOrder[0]);
      expect(mockHook.mock.invocationCallOrder[0]).toBeGreaterThan(
        mockApplyPartnerRuleMembership.mock.invocationCallOrder[0]
      );
      expect(mockHook.mock.invocationCallOrder[0]).toBeLessThan(mockPushInvalidation.mock.invocationCallOrder[0]);
    });

    it('runs for a matched rule even when the org is at capacity', async () => {
      mockApplyPartnerRuleMembership.mockResolvedValue({ added: false, reason: 'at-capacity', seats: 10 });

      await run();

      expect(mockHook).toHaveBeenCalledTimes(1);
    });

    it('does not run when only the env registry matched', async () => {
      mockPartnerGrant.mockResolvedValue({
        matched: false,
        entitlements: new Set(),
        signupCredits: 0,
        organizationId: null,
      });
      mockEntitlementsForEmail.mockReturnValue(new Set(['optihashi:pro']));
      mockSignupCreditsForKeys.mockReturnValue(250);

      await run();

      expect(mockHook).not.toHaveBeenCalled();
    });

    it('does not run when the credit grant failed', async () => {
      mockAddCredits.mockRejectedValue(new Error('ledger down'));

      await run();

      expect(mockHook).not.toHaveBeenCalled();
    });

    it('does not run when the membership write failed', async () => {
      mockApplyPartnerRuleMembership.mockRejectedValue(new Error('org store down'));

      await run();

      expect(mockHook).not.toHaveBeenCalled();
    });

    it('does not run when the rule lookup failed', async () => {
      mockPartnerGrant.mockRejectedValue(new Error('rules down'));

      await run();

      expect(mockHook).not.toHaveBeenCalled();
    });

    it('logs a throwing hook and still returns the core grant result', async () => {
      mockHook.mockRejectedValue(new Error('overlay down'));
      const logger = makeLogger();

      const result = await run(logger);

      expect(result).toEqual({ creditsGranted: 1000, currentCredits: 1100, joinedOrganizationId: 'org-1' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('overlay-grant'), expect.any(Error));
      expect(mockPushInvalidation).toHaveBeenCalledWith('user-1', expect.anything());
    });
  });
});
