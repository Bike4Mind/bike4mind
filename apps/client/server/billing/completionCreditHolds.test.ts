import { CreditHolderType } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  record,
  claim,
  markSettledAndRead,
  findSettlement,
  transaction,
  findUser,
  assertSpendCap,
  claimBudget,
  releaseClaim,
  addRunClaimCredits,
  warm,
} = vi.hoisted(() => ({
  addRunClaimCredits: vi.fn(),
  warm: vi.fn(),
  claimBudget: vi.fn(),
  releaseClaim: vi.fn(),
  findUser: vi.fn(),
  assertSpendCap: vi.fn(),
  record: vi.fn(),
  claim: vi.fn(),
  markSettledAndRead: vi.fn(),
  findSettlement: vi.fn(),
  transaction: vi.fn(async <T>(callback: () => Promise<T>): Promise<T> => callback()),
}));
vi.mock('@bike4mind/database', () => ({
  cacheRepository: {},
  pendingCreditHoldRepository: { record, claim, markSettledAndRead, findSettlement, addRunClaimCredits },
  completionRunRepository: { claimBudget, releaseClaim },
  withTransaction: transaction,
  userRepository: { findById: findUser },
  newAccountSpendCapAdapters: { name: 'spend-cap-adapters' },
  warmExchangeAttribution: warm,
}));
vi.mock('@bike4mind/services', () => ({
  creditService: {
    assertNewAccountSpendWithinCap: assertSpendCap,
    assertInterventionSpendAllowed: async () => undefined,
  },
}));
import { COMPLETION_CLAIM_SHARE_OF_REMAINING, createCompletionCreditHolds } from './completionCreditHolds';
import { newAccountSpendCapAdaptersWithAlert } from '@bike4mind/server-utils/billing/newAccountSpendCapWithAlert';

const hold = {
  ownerId: 'user',
  ownerType: CreditHolderType.User,
  userId: 'user',
  organizationId: null,
  reservedCredits: 30,
};

// The hold as the repository stores it: what record() wrote, grown by every top-up it accepted.
const storedHold = async () => {
  const recorded = await record.mock.results.at(-1)?.value;
  if (!recorded?.runClaim) return recorded ?? null;
  let added = 0;
  for (const [index, [, credits]] of addRunClaimCredits.mock.calls.entries()) {
    if (await addRunClaimCredits.mock.results[index]?.value) added += credits;
  }
  return { ...recorded, runClaim: { ...recorded.runClaim, credits: recorded.runClaim.credits + added } };
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  transaction.mockImplementation(async callback => callback());
  record.mockResolvedValue({ ...hold, id: 'pending', balanceAfterHold: 70 });
  markSettledAndRead.mockImplementation(storedHold);
  findSettlement.mockResolvedValue(null);
  findUser.mockResolvedValue({ id: 'user' });
  assertSpendCap.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

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
    expect(vi.mocked(console.info).mock.calls.map(([event]) => JSON.parse(event))).toContainEqual(
      expect.objectContaining({
        ownerId: 'user',
        lifecycle: 'completion',
        outcome: 'held',
        HoldLatency: expect.any(Number),
      })
    );
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
  it.each([
    ['with a key', 'key-1' as string | undefined],
    ['without a key', undefined],
  ])('warms exchange attribution before the settle transaction %s', async (_label, keyId) => {
    const lifecycle = createCompletionCreditHolds(new Logger({ metadata: { test: 'warm' } }), keyId);
    await lifecycle.reserve(hold, async () => ({ id: 'user', currentCredits: 70 }));
    await lifecycle.settle(10, async () => {});
    expect(warm).toHaveBeenCalledTimes(1);
    expect(warm).toHaveBeenCalledWith(keyId);
    expect(warm.mock.invocationCallOrder[0]).toBeLessThan(transaction.mock.invocationCallOrder.at(-1) as number);
  });

  it.each([0, 10])('recognizes the %s-credit receipt after a lost commit acknowledgement', async chargedCredits => {
    const lifecycle = createCompletionCreditHolds(new Logger({ metadata: { test: 'hold receipt' } }));
    await lifecycle.reserve(hold, async () => ({ id: 'user', currentCredits: 70 }));
    transaction.mockImplementationOnce(async callback => {
      await callback();
      findSettlement.mockResolvedValue(chargedCredits);
      throw new Error('commit acknowledgement lost');
    });
    const settle = vi.fn(async () => 10);
    expect(await lifecycle.settle(chargedCredits, settle)).toBe(true);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(markSettledAndRead).toHaveBeenCalledTimes(1);
  });

  it('does not rerun settlement when a receipt already exists', async () => {
    const lifecycle = createCompletionCreditHolds(new Logger({ metadata: { test: 'hold receipt' } }));
    await lifecycle.reserve(hold, async () => ({ id: 'user', currentCredits: 70 }));
    markSettledAndRead.mockResolvedValue(null);
    findSettlement.mockResolvedValue(10);
    const settle = vi.fn(async () => 10);
    expect(await lifecycle.settle(10, settle)).toBe(true);
    expect(settle).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(console.info)
        .mock.calls.map(([event]) => JSON.parse(event))
        .some(event => event.SettlementsAfterSweep)
    ).toBe(false);
  });

  it('counts a missing-hold settlement once, outside transaction retries', async () => {
    const lifecycle = createCompletionCreditHolds(new Logger());
    await lifecycle.reserve(hold, async () => ({ id: 'user', currentCredits: 70 }));
    markSettledAndRead.mockResolvedValue(null);
    transaction.mockImplementationOnce(async callback => {
      await callback();
      return callback();
    });
    const settle = vi.fn();
    expect(await lifecycle.settle(10, settle)).toBe(false);
    expect(settle).not.toHaveBeenCalled();
    const events = vi.mocked(console.info).mock.calls.map(([event]) => JSON.parse(event));
    expect(events.filter(event => event.SettlementsAfterSweep === 1)).toEqual([
      expect.objectContaining({ ownerId: 'user', lifecycle: 'completion', holdId: 'pending' }),
    ]);
  });
});

describe('run budget claims', () => {
  const runClaim = { runId: 'run-1', wantedCredits: 120, minimumCredits: 20 };
  const logger = new Logger({ metadata: { test: 'run budget' } });
  const pendingWithClaim = (credits: number) => ({
    ...hold,
    id: 'pending',
    balanceAfterHold: 70,
    runClaim: { runId: 'run-1', credits },
  });

  it('claims run budget in the hold transaction and records the claim on the hold', async () => {
    claimBudget.mockResolvedValue({ kind: 'claimed', credits: 90 });
    record.mockResolvedValue(pendingWithClaim(90));
    const debit = vi.fn(async () => ({ id: 'user', currentCredits: 70 }));

    const claimed = await createCompletionCreditHolds(logger).reserve(hold, debit, runClaim);

    expect(claimed).toBe(90);
    expect(claimBudget).toHaveBeenCalledWith('run-1', 120, 20, COMPLETION_CLAIM_SHARE_OF_REMAINING);
    expect(claimBudget.mock.invocationCallOrder[0]).toBeLessThan(debit.mock.invocationCallOrder[0]);
    expect(record).toHaveBeenCalledWith(expect.anything(), 'platform-key completion', expect.any(Date), {
      runId: 'run-1',
      credits: 90,
    });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('refuses with run_budget_exhausted and debits nothing when the run cannot cover a short answer', async () => {
    claimBudget.mockResolvedValue({ kind: 'exhausted', budgetCredits: 500, committedCredits: 490 });
    const debit = vi.fn();

    const refusal = createCompletionCreditHolds(logger).reserve(hold, debit, runClaim);

    await expect(refusal).rejects.toMatchObject({
      statusCode: 422,
      additionalInfo: { errorCode: 'run_budget_exhausted' },
      message: expect.stringContaining('This call needs 20 credits, but this run has 10 of its 500 credits left'),
    });
    expect(debit).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('calls the budget used up only when nothing is left', async () => {
    claimBudget.mockResolvedValue({ kind: 'exhausted', budgetCredits: 500, committedCredits: 500 });

    await expect(createCompletionCreditHolds(logger).reserve(hold, vi.fn(), runClaim)).rejects.toMatchObject({
      message: expect.stringContaining('used up: 500 of its 500 credits'),
    });
  });

  it('records no claim for a run without a budget', async () => {
    claimBudget.mockResolvedValue({ kind: 'unbudgeted' });

    const claimed = await createCompletionCreditHolds(logger).reserve(
      hold,
      async () => ({ id: 'user', currentCredits: 70 }),
      runClaim
    );

    expect(claimed).toBeUndefined();
    expect(record).toHaveBeenCalledWith(expect.anything(), 'platform-key completion', expect.any(Date), undefined);
  });

  it('swaps the claim for the recorded charge inside the settlement transaction', async () => {
    claimBudget.mockResolvedValue({ kind: 'claimed', credits: 90 });
    record.mockResolvedValue(pendingWithClaim(90));
    const lifecycle = createCompletionCreditHolds(logger);
    await lifecycle.reserve(hold, async () => ({ id: 'user', currentCredits: 70 }), runClaim);

    // A concurrent spend drained the balance, so the floored debit recorded 28 of the 35 charged.
    expect(
      await lifecycle.settle(
        35,
        vi.fn(async () => 28)
      )
    ).toBe(true);

    expect(releaseClaim).toHaveBeenCalledExactlyOnceWith({ runId: 'run-1', credits: 90 }, 28);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('does not release the claim again when the receipt shows the settlement already committed', async () => {
    claimBudget.mockResolvedValue({ kind: 'claimed', credits: 90 });
    record.mockResolvedValue(pendingWithClaim(90));
    const lifecycle = createCompletionCreditHolds(logger);
    await lifecycle.reserve(hold, async () => ({ id: 'user', currentCredits: 70 }), runClaim);
    markSettledAndRead.mockResolvedValue(null);
    findSettlement.mockResolvedValue(35);

    expect(await lifecycle.settle(35, vi.fn())).toBe(true);
    expect(releaseClaim).not.toHaveBeenCalled();
  });

  it('returns the whole claim with a refund, and nothing when the sweep already claimed the hold', async () => {
    claimBudget.mockResolvedValue({ kind: 'claimed', credits: 90 });
    record.mockResolvedValue(pendingWithClaim(90));
    const lifecycle = createCompletionCreditHolds(logger);
    await lifecycle.reserve(hold, async () => ({ id: 'user', currentCredits: 70 }), runClaim);
    claim.mockResolvedValueOnce(pendingWithClaim(90)).mockResolvedValueOnce(null);

    expect(await lifecycle.refund(vi.fn(async () => {}))).toBe(true);
    expect(await lifecycle.refund(vi.fn(async () => {}))).toBe(false);

    expect(releaseClaim).toHaveBeenCalledExactlyOnceWith({ runId: 'run-1', credits: 90 }, 0);
  });

  describe('topUpRunClaim', () => {
    const reserveWithClaim = async () => {
      claimBudget.mockResolvedValue({ kind: 'claimed', credits: 90 });
      record.mockResolvedValue(pendingWithClaim(90));
      const lifecycle = createCompletionCreditHolds(logger);
      await lifecycle.reserve(hold, async () => ({ id: 'user', currentCredits: 70 }), runClaim);
      return lifecycle;
    };

    it('adds the claimed credits to the stored hold, and settlement releases the grown claim', async () => {
      const lifecycle = await reserveWithClaim();
      claimBudget.mockResolvedValue({ kind: 'claimed', credits: 40 });
      addRunClaimCredits.mockResolvedValue(true);

      expect(await lifecycle.topUpRunClaim!({ wantedCredits: 60, minimumCredits: 10 })).toBe(40);
      expect(claimBudget).toHaveBeenLastCalledWith('run-1', 60, 10, COMPLETION_CLAIM_SHARE_OF_REMAINING);
      expect(addRunClaimCredits).toHaveBeenCalledExactlyOnceWith('pending', 40);

      await lifecycle.settle(
        100,
        vi.fn(async () => 100)
      );
      expect(releaseClaim).toHaveBeenCalledExactlyOnceWith({ runId: 'run-1', credits: 130 }, 100);
    });

    it('releases the stored claim when a top-up committed but its acknowledgement was lost', async () => {
      const lifecycle = await reserveWithClaim();
      claimBudget.mockResolvedValue({ kind: 'claimed', credits: 40 });
      addRunClaimCredits.mockResolvedValue(true);
      transaction.mockImplementationOnce(async callback => {
        await callback();
        throw new Error('commit acknowledgement lost');
      });

      expect(await lifecycle.topUpRunClaim!({ wantedCredits: 60, minimumCredits: 10 })).toBe(0);
      await lifecycle.settle(
        100,
        vi.fn(async () => 100)
      );
      expect(releaseClaim).toHaveBeenCalledExactlyOnceWith({ runId: 'run-1', credits: 130 }, 100);
    });

    it('returns 0 without touching the hold when the run has no headroom', async () => {
      const lifecycle = await reserveWithClaim();
      claimBudget.mockResolvedValue({ kind: 'exhausted', budgetCredits: 500, committedCredits: 500 });

      expect(await lifecycle.topUpRunClaim!({ wantedCredits: 60, minimumCredits: 10 })).toBe(0);
      expect(addRunClaimCredits).not.toHaveBeenCalled();
    });

    it('gives the credits back when the hold was already settled or swept', async () => {
      const lifecycle = await reserveWithClaim();
      claimBudget.mockResolvedValue({ kind: 'claimed', credits: 40 });
      addRunClaimCredits.mockResolvedValue(false);

      expect(await lifecycle.topUpRunClaim!({ wantedCredits: 60, minimumCredits: 10 })).toBe(0);
      expect(releaseClaim).toHaveBeenCalledExactlyOnceWith({ runId: 'run-1', credits: 40 }, 0);
    });

    it('does nothing for a hold without a run claim', async () => {
      const lifecycle = createCompletionCreditHolds(logger);
      await lifecycle.reserve(hold, async () => ({ id: 'user', currentCredits: 70 }));
      claimBudget.mockClear();

      expect(await lifecycle.topUpRunClaim!({ wantedCredits: 60, minimumCredits: 10 })).toBe(0);
      expect(claimBudget).not.toHaveBeenCalled();
    });

    it('returns 0 instead of throwing when the top-up transaction fails', async () => {
      const lifecycle = await reserveWithClaim();
      transaction.mockRejectedValueOnce(new Error('write conflict'));

      expect(await lifecycle.topUpRunClaim!({ wantedCredits: 60, minimumCredits: 10 })).toBe(0);
    });
  });
});
