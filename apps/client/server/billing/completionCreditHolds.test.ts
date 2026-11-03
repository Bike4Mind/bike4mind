import { CreditHolderType } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { record, claim, markSettled, findSettlement, transaction, findUser, assertSpendCap } = vi.hoisted(() => ({
  findUser: vi.fn(),
  assertSpendCap: vi.fn(),
  record: vi.fn(),
  claim: vi.fn(),
  markSettled: vi.fn(),
  findSettlement: vi.fn(),
  transaction: vi.fn(async <T>(callback: () => Promise<T>): Promise<T> => callback()),
}));
vi.mock('@bike4mind/database', () => ({
  pendingCreditHoldRepository: { record, claim, markSettled, findSettlement },
  withTransaction: transaction,
  userRepository: { findById: findUser },
  newAccountSpendCapAdapters: { name: 'spend-cap-adapters' },
}));
vi.mock('@bike4mind/services', () => ({ creditService: { assertNewAccountSpendWithinCap: assertSpendCap } }));
import { createCompletionCreditHolds } from './completionCreditHolds';
import { newAccountSpendCapAdaptersWithAlert } from './newAccountSpendCapWithAlert';

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
  findUser.mockResolvedValue({ id: 'user' });
  assertSpendCap.mockResolvedValue(undefined);
});

describe('new-account spend cap at reservation', () => {
  const logger = new Logger({ metadata: { test: 'spend cap' } });

  it('checks the requested reservation against the cap before debiting', async () => {
    const debit = vi.fn(async () => ({ id: 'user', currentCredits: 70 }));
    await createCompletionCreditHolds(logger).reserve(hold, debit);
    expect(assertSpendCap).toHaveBeenCalledWith(
      expect.objectContaining({ user: { id: 'user' }, requestedCredits: 30, billedToOrganization: false }),
      newAccountSpendCapAdaptersWithAlert
    );
    expect(assertSpendCap.mock.invocationCallOrder[0]).toBeLessThan(debit.mock.invocationCallOrder[0]);
  });

  it('refuses with nothing debited or recorded when the cap is reached', async () => {
    assertSpendCap.mockRejectedValue(new Error('New accounts can spend up to 10,000 credits per hour'));
    const debit = vi.fn();
    await expect(createCompletionCreditHolds(logger).reserve(hold, debit)).rejects.toThrow(/per hour/);
    expect(debit).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('leaves org-billed completions to the org limits', async () => {
    await createCompletionCreditHolds(logger).reserve(
      { ...hold, ownerId: 'org', ownerType: CreditHolderType.Organization, organizationId: 'org' },
      async () => ({ id: 'org', currentCredits: 70 })
    );
    expect(findUser).not.toHaveBeenCalled();
    expect(assertSpendCap).not.toHaveBeenCalled();
  });
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
