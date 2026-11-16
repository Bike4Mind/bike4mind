import { CreditHolderType } from '@bike4mind/common';
import { describe, expect, it, vi } from 'vitest';

const { holdCredits } = vi.hoisted(() => ({ holdCredits: vi.fn() }));

vi.mock('@bike4mind/database', () => ({
  pendingCreditHoldRepository: { record: async () => ({ id: 'pending-hold' }) },
  withTransaction: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));
vi.mock('@bike4mind/services', () => ({ creditService: { holdCredits } }));
vi.mock('./reserveRequestCredits', () => ({
  CREDIT_HOLD_TTL_MS: 60_000,
  holdAdapters: { spendFreezes: {} },
  releaseHeldCredits: vi.fn(),
  settleHeldCredits: vi.fn(),
}));

import { imageCreditHolds } from './imageCreditHolds';

describe('imageCreditHolds.hold', () => {
  it('passes the job API key to the hold so its freeze is checked', async () => {
    holdCredits.mockResolvedValueOnce({ ownerId: 'u1', reservedCredits: 5 });
    const logger = {} as never;
    await imageCreditHolds.hold({
      userId: 'u1',
      organizationId: 'org1',
      requiredCredits: 5,
      featureLabel: 'image generation',
      logger,
      apiKeyId: 'k1',
      apiKeyBillingOwnerType: CreditHolderType.User,
    });
    expect(holdCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        organizationId: 'org1',
        apiKeyId: 'k1',
        apiKeyBillingOwnerType: CreditHolderType.User,
      }),
      expect.objectContaining({ spendFreezes: expect.anything() })
    );
  });

  it('lets a freeze refusal from the hold reach the worker', async () => {
    holdCredits.mockRejectedValueOnce(new Error('spend frozen'));
    await expect(
      imageCreditHolds.hold({
        userId: 'u1',
        organizationId: null,
        requiredCredits: 5,
        featureLabel: 'image generation',
        logger: {} as never,
      })
    ).rejects.toThrow('spend frozen');
  });
});
