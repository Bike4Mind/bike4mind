import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';
import * as creditService from '../creditService';
import { grantFreeCredits, releasePendingFreeCredits, resolveFreeCreditAmount } from './freeCredits';

const buildAdapters = (defaultFreeCredits: string | null = '100') => {
  const logger = { error: vi.fn() };
  const adapters = {
    db: {
      adminSettings: {
        findBySettingName: vi
          .fn()
          .mockResolvedValue(defaultFreeCredits === null ? null : { settingValue: defaultFreeCredits }),
      },
      creditTransactions: { findOne: vi.fn().mockResolvedValue(null) },
      creditLots: {},
      users: {},
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
