import { CreditHolderType } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { record, claim, markSettled, findSettlement, transaction } = vi.hoisted(() => ({
  record: vi.fn(),
  claim: vi.fn(),
  markSettled: vi.fn(),
  findSettlement: vi.fn(),
  transaction: vi.fn(async <T>(callback: () => Promise<T>): Promise<T> => callback()),
}));
vi.mock('@bike4mind/database', () => ({
  pendingCreditHoldRepository: { record, claim, markSettled, findSettlement },
  withTransaction: transaction,
}));
import { createCompletionCreditHolds } from './completionCreditHolds';

const hold = {
  ownerId: 'user',
  ownerType: CreditHolderType.User,
  userId: 'user',
  organizationId: null,
  reservedCredits: 30,
};

beforeEach(() => {
  vi.resetAllMocks();
  transaction.mockImplementation(async callback => callback());
  record.mockResolvedValue({ ...hold, id: 'pending', balanceAfterHold: 70 });
  markSettled.mockResolvedValue(true);
  findSettlement.mockResolvedValue(null);
});

describe('completion settlement commit recovery', () => {
  it.each([0, 10])('recognizes the %s-credit receipt after a lost commit acknowledgement', async chargedCredits => {
    const lifecycle = createCompletionCreditHolds(new Logger({ metadata: { test: 'hold receipt' } }));
    await lifecycle.reserve(hold, async () => ({ id: 'user', currentCredits: 70 }));
    transaction.mockImplementationOnce(async callback => {
      await callback();
      findSettlement.mockResolvedValue(chargedCredits);
      throw new Error('commit acknowledgement lost');
    });
    const settle = vi.fn(async () => {});
    expect(await lifecycle.settle(chargedCredits, settle)).toBe(true);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(markSettled).toHaveBeenCalledTimes(1);
  });

  it('does not rerun settlement when a receipt already exists', async () => {
    const lifecycle = createCompletionCreditHolds(new Logger({ metadata: { test: 'hold receipt' } }));
    await lifecycle.reserve(hold, async () => ({ id: 'user', currentCredits: 70 }));
    markSettled.mockResolvedValue(false);
    findSettlement.mockResolvedValue(10);
    const settle = vi.fn(async () => {});
    expect(await lifecycle.settle(10, settle)).toBe(true);
    expect(settle).not.toHaveBeenCalled();
  });
});
