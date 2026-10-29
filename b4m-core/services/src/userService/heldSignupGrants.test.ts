import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';
import { releasePendingFreeCredits } from './freeCredits';
import { bulkReleaseHeldGrants, releaseHeldGrantsAgainstBudget, revokeHeldGrantRelease } from './heldSignupGrants';

vi.mock('./freeCredits', () => ({ releasePendingFreeCredits: vi.fn() }));

const BATCH_ID = 'batch-1';

const buildRevokeAdapters = (balance: number) => {
  const state = { balance, claimed: false };
  const adapters = {
    batches: {
      createBatch: vi.fn(),
      findBatch: vi.fn().mockResolvedValue({
        id: BATCH_ID,
        actorId: 'admin-1',
        entries: [{ userId: 'user-1', outcome: 'released', credits: 40 }],
      }),
      claimReversal: vi.fn(async () => {
        if (state.claimed) return false;
        state.claimed = true;
        return true;
      }),
      unclaimReversal: vi.fn(async () => {
        state.claimed = false;
      }),
    },
    users: {
      findById: vi.fn(async () => ({ id: 'user-1', currentCredits: state.balance })),
      incrementCredits: vi.fn(async (_userId: string, credits: number) => {
        state.balance += credits;
      }),
      decrementCreditsFloored: vi.fn(async (_userId: string, credits: number) => {
        const taken = Math.min(credits, state.balance);
        state.balance -= taken;
        return taken;
      }),
    },
    creditTransactions: { createTransaction: vi.fn().mockResolvedValue({}) },
  };
  // Test doubles: revoke only calls the repository methods stubbed above.
  return { state, adapters: adapters as unknown as Parameters<typeof revokeHeldGrantRelease>[1] & typeof adapters };
};

const revoke = (adapters: Parameters<typeof revokeHeldGrantRelease>[1]) =>
  revokeHeldGrantRelease({ batchId: BATCH_ID, actorId: 'admin-1' }, adapters);

describe('revokeHeldGrantRelease', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('debits the released credits, records the ledger row and keeps the entry claimed', async () => {
    const { state, adapters } = buildRevokeAdapters(100);

    const result = await revoke(adapters);

    expect(result?.results).toEqual([{ userId: 'user-1', outcome: 'reversed', credits: 40 }]);
    expect(state).toEqual({ balance: 60, claimed: true });
    expect(adapters.creditTransactions.createTransaction).toHaveBeenCalledWith(
      'generic_deduct',
      expect.objectContaining({
        ownerId: 'user-1',
        credits: -40,
        metadata: { actorId: 'admin-1', releaseBatchId: BATCH_ID },
      })
    );
    expect(adapters.batches.unclaimReversal).not.toHaveBeenCalled();
  });

  it('restores the balance and unclaims the entry when the ledger write fails', async () => {
    const { state, adapters } = buildRevokeAdapters(100);
    adapters.creditTransactions.createTransaction.mockRejectedValueOnce(new Error('ledger down'));

    const result = await revoke(adapters);

    expect(result?.results).toEqual([{ userId: 'user-1', outcome: 'failed', credits: 40 }]);
    expect(state).toEqual({ balance: 100, claimed: false });
    expect(adapters.batches.unclaimReversal).toHaveBeenCalledWith(BATCH_ID, 'user-1');
  });

  it('leaves the entry claimed when neither the ledger write nor the refund lands', async () => {
    const { state, adapters } = buildRevokeAdapters(100);
    adapters.creditTransactions.createTransaction.mockRejectedValueOnce(new Error('ledger down'));
    adapters.users.incrementCredits.mockRejectedValueOnce(new Error('users down'));

    const result = await revoke(adapters);

    expect(result?.results).toEqual([{ userId: 'user-1', outcome: 'failed', credits: 40 }]);
    expect(state).toEqual({ balance: 60, claimed: true });
    expect(adapters.batches.unclaimReversal).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('manual repair'), expect.any(Error));

    expect((await revoke(adapters))?.results).toEqual([{ userId: 'user-1', outcome: 'already_reversed', credits: 40 }]);
    expect(adapters.users.decrementCreditsFloored).toHaveBeenCalledOnce();
  });
});

const buildReleaseAdapters = () => {
  const adapters = {
    grant: {
      db: {
        users: {
          findById: vi.fn(async (id: string) => ({
            id,
            tags: [PENDING_FREE_CREDITS_TAG],
            signupGrantHeldReason: 'budget_exhausted',
            emailVerified: true,
          })),
          update: vi.fn(),
        },
      },
      reason: 'test',
      logger: { error: vi.fn() },
    },
    clearPending: vi.fn().mockResolvedValue(undefined),
    batches: { createBatch: vi.fn().mockResolvedValue({ id: BATCH_ID }) },
  };
  // Test doubles: release only calls the repository methods stubbed above.
  return adapters as unknown as Parameters<typeof bulkReleaseHeldGrants>[1] & typeof adapters;
};

describe('held grant release', () => {
  beforeEach(() => {
    vi.mocked(releasePendingFreeCredits).mockReset();
  });

  it('records a grant whose payout threw as failed and counts it as failed in the cron', async () => {
    vi.mocked(releasePendingFreeCredits).mockResolvedValue({
      released: false,
      failed: true,
      creditsGranted: 0,
      currentCredits: null,
      patch: {},
    });
    const adapters = buildReleaseAdapters();

    const bulk = await bulkReleaseHeldGrants({ actorId: 'admin-1', userIds: ['user-1'] }, adapters);
    expect(bulk.results).toEqual([{ userId: 'user-1', outcome: 'failed', credits: 0 }]);

    const cron = await releaseHeldGrantsAgainstBudget(
      { ...adapters, listHeldIds: vi.fn().mockResolvedValueOnce(['user-1']).mockResolvedValue([]) },
      { maxUsers: 10 }
    );
    expect(cron).toMatchObject({ scanned: 1, failed: 1, withheld: 0 });
  });

  it('keeps a committed payout as released when clearing the hold fails', async () => {
    vi.mocked(releasePendingFreeCredits).mockResolvedValue({
      released: true,
      creditsGranted: 40,
      currentCredits: 40,
      patch: {},
    });
    const adapters = buildReleaseAdapters();
    const clearFailure = new Error('users down');
    adapters.clearPending.mockRejectedValueOnce(clearFailure);

    const bulk = await bulkReleaseHeldGrants({ actorId: 'admin-1', userIds: ['user-1'] }, adapters);

    expect(bulk.results).toEqual([{ userId: 'user-1', outcome: 'released', credits: 40 }]);
    expect(adapters.batches.createBatch).toHaveBeenCalledWith({ actorId: 'admin-1', entries: bulk.results });
    expect(adapters.grant.logger.error).toHaveBeenCalledWith(expect.stringContaining('user-1'), clearFailure);
  });
});
