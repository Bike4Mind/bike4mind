import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PENDING_FREE_CREDITS_TAG, SIGNUP_GRANT_UNPROTECTED_LOG_MESSAGE } from '@bike4mind/common';
import * as creditService from '../creditService';
import * as stagedSignupGrant from './stagedSignupGrant';
import { grantFreeCredits, releasePendingFreeCredits, resolveFreeCreditAmount } from './freeCredits';
import * as signupProtection from './signupProtection';

const VALID_POLICY = {
  enabled: true,
  version: 'v1',
  rules: [
    { signal: 'datacenter', comparison: 'eq', threshold: 1, weight: 2, missing: 'score', missingWeight: 0 },
    { signal: 'ipSignups', comparison: 'gte', threshold: 3, weight: 2, missing: 'score', missingWeight: 0 },
  ],
  reducedAt: 3,
  reviewAt: 6,
  reducedFraction: 0.5,
};

const buildAdapters = (defaultFreeCredits: string | null = '100') => {
  const logger = { error: vi.fn(), warn: vi.fn() };
  const adapters = {
    db: {
      adminSettings: {
        findBySettingNames: vi.fn().mockResolvedValue([]),
        findBySettingName: vi
          .fn()
          .mockResolvedValue(defaultFreeCredits === null ? null : { settingValue: defaultFreeCredits }),
      },
      creditTransactions: { findOne: vi.fn().mockResolvedValue(null) },
      creditLots: {},
      users: { claimFreeCreditGrant: vi.fn().mockResolvedValue(true), findById: vi.fn().mockResolvedValue(null) },
    },
    reason: 'test grant',
    logger,
  };
  // Test doubles for repository interfaces the service only forwards to addCredits.
  return adapters as unknown as Parameters<typeof releasePendingFreeCredits>[1] & typeof adapters;
};

describe('free credits service', () => {
  let addCreditsSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    addCreditsSpy = vi
      .spyOn(creditService, 'addCredits')
      .mockResolvedValue({ id: 'user-1', currentCredits: 100 } as Awaited<ReturnType<typeof creditService.addCredits>>);
  });

  describe('resolveFreeCreditAmount', () => {
    it('prefers an explicit pendingCreditGrant over the setting', async () => {
      const { db } = buildAdapters('100');
      expect(await resolveFreeCreditAmount(500, db.adminSettings)).toBe(500);
      expect(db.adminSettings.findBySettingName).not.toHaveBeenCalled();
    });

    it('treats an explicit 0 as an amount, not as missing', async () => {
      const { db } = buildAdapters('100');
      expect(await resolveFreeCreditAmount(0, db.adminSettings)).toBe(0);
    });

    it.each([null, undefined])('falls back to the defaultFreeCredits setting for %s', async pending => {
      const { db } = buildAdapters('100');
      expect(await resolveFreeCreditAmount(pending, db.adminSettings)).toBe(100);
    });

    it('returns 0 when the setting is missing or unparseable', async () => {
      expect(await resolveFreeCreditAmount(null, buildAdapters(null).db.adminSettings)).toBe(0);
      expect(await resolveFreeCreditAmount(null, buildAdapters('not-a-number').db.adminSettings)).toBe(0);
    });
  });

  describe('grantFreeCredits', () => {
    it('propagates a failed enrollment read without falling back to a flat grant', async () => {
      const adapters = buildAdapters('100');
      const readFailure = new Error('user store unavailable');
      adapters.db.users.findById.mockRejectedValueOnce(readFailure);

      await expect(grantFreeCredits({ id: 'user-1' }, adapters)).rejects.toBe(readFailure);

      expect(adapters.db.users.findById).toHaveBeenCalledExactlyOnceWith('user-1');
      expect(adapters.db.adminSettings.findBySettingName).not.toHaveBeenCalled();
      expect(adapters.db.creditTransactions.findOne).not.toHaveBeenCalled();
      expect(addCreditsSpy).not.toHaveBeenCalled();
    });

    it('withholds a staged signup tranche while the signup domain is held', async () => {
      const adapters = buildAdapters('100');
      adapters.db.users.findById.mockResolvedValue({
        id: 'user-1',
        emailVerified: true,
        signupGrant: { stage: 'pending_email' },
      });
      adapters.db.signupProtection = {
        repository: {
          findReview: async () => null,
          observe: async () => {},
          recent: async () => [],
          createHold: async () => false,
          isOrganizationDomain: async () => false,
        },
      };
      const addTags = vi.fn();
      Object.assign(adapters.db.users, { addTagsToUser: addTags });
      const protect = vi.spyOn(signupProtection, 'protectSignupCredits').mockResolvedValue(true);
      const tranche = vi.spyOn(stagedSignupGrant, 'releaseSignupTranche');

      const result = await grantFreeCredits({ id: 'user-1' }, adapters);

      expect(result).toEqual({ creditsGranted: 0, currentCredits: null, withheld: true });
      expect(tranche).toHaveBeenCalledExactlyOnceWith('user-1', expect.objectContaining({ db: adapters.db }));
      expect(protect).toHaveBeenCalledExactlyOnceWith('user-1', adapters.db);
      expect(addTags).toHaveBeenCalledExactlyOnceWith('user-1', [PENDING_FREE_CREDITS_TAG]);
      expect(addCreditsSpy).not.toHaveBeenCalled();
    });

    it('grants nothing when the resolved amount is 0', async () => {
      const result = await grantFreeCredits({ id: 'user-1' }, buildAdapters('0'));
      expect(result).toEqual({ creditsGranted: 0, currentCredits: null });
      expect(addCreditsSpy).not.toHaveBeenCalled();
    });

    it('uses the stable idempotent transaction id and forwards the reason and credit lots', async () => {
      const adapters = buildAdapters('100');
      const result = await grantFreeCredits({ id: 'user-1' }, adapters);

      expect(result).toEqual({ creditsGranted: 100, currentCredits: 100 });
      expect(addCreditsSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: 'user-1',
          credits: 100,
          type: 'generic_add',
          transactionId: 'verify-grant:user-1',
          reason: 'test grant',
        }),
        expect.objectContaining({ db: expect.objectContaining({ creditLots: adapters.db.creditLots }) })
      );
    });

    it('grants nothing when another account already claimed the same inbox', async () => {
      const adapters = buildAdapters('100');
      adapters.db.users.claimFreeCreditGrant.mockResolvedValue(false);

      const result = await grantFreeCredits({ id: 'user-2' }, adapters);

      expect(adapters.db.users.claimFreeCreditGrant).toHaveBeenCalledWith('user-2');
      expect(result).toEqual({ creditsGranted: 0, currentCredits: null });
      expect(addCreditsSpy).not.toHaveBeenCalled();
    });

    it('grants an invite-resolved amount without claiming the inbox', async () => {
      const adapters = buildAdapters('100');
      adapters.db.users.claimFreeCreditGrant.mockResolvedValue(false);

      const result = await grantFreeCredits({ id: 'user-2', pendingCreditGrant: 5000 }, adapters);

      expect(adapters.db.users.claimFreeCreditGrant).not.toHaveBeenCalled();
      expect(result.creditsGranted).toBe(5000);
    });

    it('does not spend the inbox claim when there is nothing to grant', async () => {
      const adapters = buildAdapters('0');
      await grantFreeCredits({ id: 'user-1' }, adapters);
      expect(adapters.db.users.claimFreeCreditGrant).not.toHaveBeenCalled();
    });
  });

  describe('staged grant routing', () => {
    it("forwards the risk collector to an enrolled account's tranche release", async () => {
      const release = vi
        .spyOn(stagedSignupGrant, 'releaseSignupTranche')
        .mockResolvedValue({ creditsGranted: 40, currentCredits: 40 });
      const adapters = buildAdapters('100');
      adapters.db.users.findById.mockResolvedValue({ id: 'user-1', signupGrant: { stage: 'pending_email' } });
      const collectRiskSignals = vi.fn();

      const result = await grantFreeCredits({ id: 'user-1' }, { ...adapters, collectRiskSignals });

      expect(result).toEqual({ creditsGranted: 40, currentCredits: 40 });
      expect(release).toHaveBeenCalledWith('user-1', expect.objectContaining({ collectRiskSignals }));
      expect(addCreditsSpy).not.toHaveBeenCalled();
    });
  });

  describe('legacy otc-register-grant transaction', () => {
    it('treats a grant committed under the legacy id as granted and still strips the tag', async () => {
      const adapters = buildAdapters('100');
      adapters.db.creditTransactions.findOne.mockResolvedValue({ id: 'tx-1' });

      const result = await releasePendingFreeCredits({ id: 'user-1', tags: [PENDING_FREE_CREDITS_TAG] }, adapters);

      expect(adapters.db.creditTransactions.findOne).toHaveBeenCalledWith({
        transactionId: 'otc-register-grant:user-1',
      });
      expect(addCreditsSpy).not.toHaveBeenCalled();
      expect(result).toEqual({
        released: true,
        creditsGranted: 0,
        currentCredits: null,
        patch: { tags: [], pendingCreditGrant: null },
      });
    });
  });

  describe('releasePendingFreeCredits', () => {
    it('keeps the pending grant and logs when the enrollment read fails', async () => {
      const adapters = buildAdapters('100');
      const readFailure = new Error('user store unavailable');
      adapters.db.users.findById.mockRejectedValueOnce(readFailure);
      const user = { id: 'user-1', tags: ['Customer', PENDING_FREE_CREDITS_TAG], pendingCreditGrant: 250 };

      const result = await releasePendingFreeCredits(user, adapters);

      expect(result).toEqual({ released: false, creditsGranted: 0, currentCredits: null, patch: {} });
      expect(user.tags).toEqual(['Customer', PENDING_FREE_CREDITS_TAG]);
      expect(user.pendingCreditGrant).toBe(250);
      expect(adapters.logger.error).toHaveBeenCalledExactlyOnceWith(
        `Free credit grant failed for user user-1; keeping ${PENDING_FREE_CREDITS_TAG} for retry`,
        readFailure
      );
      expect(adapters.db.adminSettings.findBySettingName).not.toHaveBeenCalled();
      expect(adapters.db.creditTransactions.findOne).not.toHaveBeenCalled();
      expect(addCreditsSpy).not.toHaveBeenCalled();
    });

    it('raises the signup alarm message when a large grant is released with protections off', async () => {
      const adapters = buildAdapters('500');
      adapters.db.adminSettings.findBySettingNames.mockResolvedValue([
        { settingName: 'defaultFreeCredits', settingValue: 500 },
      ]);
      const user = { id: 'user-1', tags: [PENDING_FREE_CREDITS_TAG], pendingCreditGrant: null };

      await releasePendingFreeCredits(user, adapters);

      expect(adapters.logger.warn).toHaveBeenCalledExactlyOnceWith(
        SIGNUP_GRANT_UNPROTECTED_LOG_MESSAGE,
        expect.objectContaining({ largestGrant: 500, unset: expect.arrayContaining(['signupGrantRiskPolicy']) })
      );
    });

    it('stays quiet when the grant is small or every protection is on', async () => {
      const small = buildAdapters('50');
      small.db.adminSettings.findBySettingNames.mockResolvedValue([
        { settingName: 'defaultFreeCredits', settingValue: 50 },
      ]);
      await releasePendingFreeCredits({ id: 'user-1', tags: [PENDING_FREE_CREDITS_TAG] }, small);
      expect(small.logger.warn).not.toHaveBeenCalled();

      const protectedAdapters = buildAdapters('500');
      protectedAdapters.db.adminSettings.findBySettingNames.mockResolvedValue([
        { settingName: 'defaultFreeCredits', settingValue: 500 },
        { settingName: 'signupGrantRiskPolicy', settingValue: VALID_POLICY },
        { settingName: 'maxSignupsPerIpPerDay', settingValue: 5 },
        { settingName: 'maxSignupsPerAsnPerHour', settingValue: 20 },
        { settingName: 'signupBurstAutoHold', settingValue: true },
      ]);
      await releasePendingFreeCredits({ id: 'user-1', tags: [PENDING_FREE_CREDITS_TAG] }, protectedAdapters);
      expect(protectedAdapters.logger.warn).not.toHaveBeenCalled();
    });

    it('ignores a large staged total while staging is disabled', async () => {
      const adapters = buildAdapters('50');
      adapters.db.adminSettings.findBySettingNames.mockResolvedValue([
        { settingName: 'defaultFreeCredits', settingValue: 50 },
        { settingName: 'signupGrantCredits', settingValue: 500 },
      ]);
      await releasePendingFreeCredits({ id: 'user-1', tags: [PENDING_FREE_CREDITS_TAG] }, adapters);
      expect(adapters.logger.warn).not.toHaveBeenCalled();
    });

    it('still releases the grant when the protection check cannot read settings', async () => {
      const adapters = buildAdapters('100');
      adapters.db.adminSettings.findBySettingNames.mockRejectedValue(new Error('settings unavailable'));

      const result = await releasePendingFreeCredits({ id: 'user-1', tags: [PENDING_FREE_CREDITS_TAG] }, adapters);

      expect(result.released).toBe(true);
      expect(adapters.logger.error).toHaveBeenCalledWith('signup-grant-protection-check-failed', expect.anything());
    });

    it('does nothing for a user without the pending tag', async () => {
      const result = await releasePendingFreeCredits({ id: 'user-1', tags: ['Customer'] }, buildAdapters());
      expect(result).toEqual({ released: false, creditsGranted: 0, currentCredits: null, patch: {} });
      expect(addCreditsSpy).not.toHaveBeenCalled();
    });

    it('strips only the pending tag and clears the amount after a successful grant', async () => {
      const result = await releasePendingFreeCredits(
        { id: 'user-1', tags: ['Customer', PENDING_FREE_CREDITS_TAG], pendingCreditGrant: 250 },
        buildAdapters()
      );
      expect(result.released).toBe(true);
      expect(result.creditsGranted).toBe(250);
      expect(result.patch).toEqual({ tags: ['Customer'], pendingCreditGrant: null });
    });

    it('releases the tag without a grant when the inbox was already claimed', async () => {
      const adapters = buildAdapters();
      adapters.db.users.claimFreeCreditGrant.mockResolvedValue(false);

      const result = await releasePendingFreeCredits({ id: 'user-2', tags: [PENDING_FREE_CREDITS_TAG] }, adapters);

      expect(result).toEqual({
        released: true,
        creditsGranted: 0,
        currentCredits: null,
        patch: { tags: [], pendingCreditGrant: null },
      });
      expect(addCreditsSpy).not.toHaveBeenCalled();
    });

    it('releases the tag when there is nothing to grant', async () => {
      const result = await releasePendingFreeCredits(
        { id: 'user-1', tags: [PENDING_FREE_CREDITS_TAG] },
        buildAdapters('0')
      );
      expect(result.released).toBe(true);
      expect(result.creditsGranted).toBe(0);
      expect(result.patch).toEqual({ tags: [], pendingCreditGrant: null });
    });

    it('keeps the tag, logs, and does not throw when the grant fails', async () => {
      addCreditsSpy.mockRejectedValueOnce(new Error('credit service down'));
      const adapters = buildAdapters();

      const result = await releasePendingFreeCredits({ id: 'user-1', tags: [PENDING_FREE_CREDITS_TAG] }, adapters);

      expect(result).toEqual({ released: false, creditsGranted: 0, currentCredits: null, patch: {} });
      expect(adapters.logger.error).toHaveBeenCalledWith(expect.stringContaining('user-1'), expect.any(Error));
    });
  });
});
