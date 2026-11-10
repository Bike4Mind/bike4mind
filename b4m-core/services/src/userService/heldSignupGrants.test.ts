import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';
import { releasePendingFreeCredits } from './freeCredits';
import { previewSignupGrantAction } from './bulkSignupGrantActions';
import { bulkReleaseHeldGrants, releaseHeldGrantsAgainstBudget, revokeHeldGrantRelease } from './heldSignupGrants';

vi.mock('./freeCredits', () => ({ releasePendingFreeCredits: vi.fn() }));

const BATCH_ID = 'batch-1';

const RESTORE = {
  signupGrant: { stage: 'pending_email', creditsReleased: 0, signupCredits: 40 },
  signupGrantHeldReason: 'budget_exhausted',
  signupGrantHeldAt: new Date('2026-11-01T00:00:00Z'),
  pendingCreditGrant: null,
  riskReviewState: null,
};

const releasedUser = (creditsReleased: number) => ({
  id: 'user-1',
  signupGrant: { stage: 'signup', creditsReleased, signupCredits: 40 },
});

const buildRevokeAdapters = (balance: number, entry: Record<string, unknown> = {}) => {
  const state = { balance, claimed: false };
  const adapters = {
    batches: {
      createBatch: vi.fn(),
      findBatch: vi.fn().mockResolvedValue({
        id: BATCH_ID,
        actorId: 'admin-1',
        entries: [{ userId: 'user-1', outcome: 'released', credits: 40, ...entry }],
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
      incrementCredits: vi.fn(async (_userId: string, credits: number) => {
        state.balance += credits;
      }),
      decrementCreditsIfCovered: vi.fn(async (_userId: string, credits: number) => {
        if (state.balance < credits) return false;
        state.balance -= credits;
        return true;
      }),
      findById: vi.fn().mockResolvedValue(releasedUser(40)),
      update: vi.fn().mockResolvedValue({}),
      addTagsToUser: vi.fn().mockResolvedValue(undefined),
    },
    creditTransactions: {
      createTransaction: vi.fn().mockResolvedValue({}),
      rekeyTransaction: vi.fn().mockResolvedValue({}),
    },
    logger: { error: vi.fn() },
  };
  // Test doubles: revoke only calls the repository methods stubbed above.
  return { state, adapters: adapters as unknown as Parameters<typeof revokeHeldGrantRelease>[1] & typeof adapters };
};

const revoke = (adapters: Parameters<typeof revokeHeldGrantRelease>[1]) =>
  revokeHeldGrantRelease({ batchId: BATCH_ID, actorId: 'admin-1' }, adapters);

describe('revokeHeldGrantRelease', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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

  it('leaves a short balance untouched and unclaims the entry', async () => {
    const { state, adapters } = buildRevokeAdapters(30);

    const result = await revoke(adapters);

    expect(result?.results).toEqual([{ userId: 'user-1', outcome: 'insufficient_balance', credits: 40 }]);
    expect(state).toEqual({ balance: 30, claimed: false });
    expect(adapters.users.incrementCredits).not.toHaveBeenCalled();
    expect(adapters.creditTransactions.createTransaction).not.toHaveBeenCalled();
  });

  it('leaves the entry claimed when neither the ledger write nor the refund lands', async () => {
    const { state, adapters } = buildRevokeAdapters(100);
    adapters.creditTransactions.createTransaction.mockRejectedValueOnce(new Error('ledger down'));
    adapters.users.incrementCredits.mockRejectedValueOnce(new Error('users down'));

    const result = await revoke(adapters);

    expect(result?.results).toEqual([{ userId: 'user-1', outcome: 'failed', credits: 40 }]);
    expect(state).toEqual({ balance: 60, claimed: true });
    expect(adapters.batches.unclaimReversal).not.toHaveBeenCalled();
    expect(adapters.logger.error).toHaveBeenCalledWith(expect.stringContaining('manual repair'), expect.any(Error));

    expect((await revoke(adapters))?.results).toEqual([{ userId: 'user-1', outcome: 'already_reversed', credits: 40 }]);
    expect(adapters.users.decrementCreditsIfCovered).toHaveBeenCalledOnce();
  });

  it('leaves the account untouched when the batch predates the saved release state', async () => {
    const { adapters } = buildRevokeAdapters(100);

    await revoke(adapters);

    expect(adapters.users.findById).not.toHaveBeenCalled();
    expect(adapters.creditTransactions.rekeyTransaction).not.toHaveBeenCalled();
    expect(adapters.users.update).not.toHaveBeenCalled();
    expect(adapters.users.addTagsToUser).not.toHaveBeenCalled();
  });

  describe('with the saved release state', () => {
    it('frees the verify-grant id, restores the account and queues it last', async () => {
      const { state, adapters } = buildRevokeAdapters(100, { restore: RESTORE });

      const result = await revoke(adapters);

      expect(result?.results).toEqual([{ userId: 'user-1', outcome: 'reversed', credits: 40 }]);
      expect(state).toEqual({ balance: 60, claimed: true });
      expect(adapters.creditTransactions.rekeyTransaction).toHaveBeenCalledWith(
        'verify-grant:user-1',
        `reversed-signup-grant:user-1:${BATCH_ID}`
      );
      expect(adapters.users.update).toHaveBeenCalledWith({
        id: 'user-1',
        signupGrant: RESTORE.signupGrant,
        signupGrantHeldReason: 'budget_exhausted',
        signupGrantHeldAt: RESTORE.signupGrantHeldAt,
        pendingCreditGrant: null,
      });
      expect(adapters.users.addTagsToUser).toHaveBeenCalledWith('user-1', [PENDING_FREE_CREDITS_TAG]);
      expect(adapters.users.update.mock.invocationCallOrder[0]).toBeLessThan(
        adapters.users.addTagsToUser.mock.invocationCallOrder[0]
      );
    });

    it('restores the review state the release moved', async () => {
      const { adapters } = buildRevokeAdapters(100, { restore: { ...RESTORE, riskReviewState: 'pending' } });
      adapters.users.findById.mockResolvedValue({
        ...releasedUser(40),
        riskScore: { score: 3, signals: [], reviewState: 'none' },
      });

      await revoke(adapters);

      expect(adapters.users.update).toHaveBeenCalledWith(
        expect.objectContaining({ riskScore: { score: 3, signals: [], reviewState: 'pending' } })
      );
    });

    it('takes nothing when the account was granted more since the release', async () => {
      const { state, adapters } = buildRevokeAdapters(100, { restore: RESTORE });
      adapters.users.findById.mockResolvedValue(releasedUser(60));

      const result = await revoke(adapters);

      expect(result?.results).toEqual([{ userId: 'user-1', outcome: 'state_changed', credits: 40 }]);
      expect(state).toEqual({ balance: 100, claimed: false });
      expect(adapters.users.decrementCreditsIfCovered).not.toHaveBeenCalled();
      expect(adapters.users.update).not.toHaveBeenCalled();
    });

    it('takes nothing when the account no longer exists', async () => {
      const { state, adapters } = buildRevokeAdapters(100, { restore: RESTORE });
      adapters.users.findById.mockResolvedValue(null);

      const result = await revoke(adapters);

      expect(result?.results).toEqual([{ userId: 'user-1', outcome: 'state_changed', credits: 40 }]);
      expect(state).toEqual({ balance: 100, claimed: false });
    });

    it('leaves the entry claimed when the restore fails after the credits were taken back', async () => {
      const { state, adapters } = buildRevokeAdapters(100, { restore: RESTORE });
      adapters.users.update.mockRejectedValueOnce(new Error('users down'));

      const result = await revoke(adapters);

      expect(result?.results).toEqual([{ userId: 'user-1', outcome: 'failed', credits: 40 }]);
      expect(state).toEqual({ balance: 60, claimed: true });
      expect(adapters.batches.unclaimReversal).not.toHaveBeenCalled();
      expect(adapters.users.addTagsToUser).not.toHaveBeenCalled();
      expect(adapters.logger.error).toHaveBeenCalledWith(
        expect.stringContaining('did not restore the held grant'),
        expect.any(Error)
      );

      expect((await revoke(adapters))?.results).toEqual([
        { userId: 'user-1', outcome: 'already_reversed', credits: 40 },
      ]);
      expect(adapters.users.decrementCreditsIfCovered).toHaveBeenCalledOnce();
    });

    it('unclaims the entry when the ledger write fails, so the account is not restored', async () => {
      const { state, adapters } = buildRevokeAdapters(100, { restore: RESTORE });
      adapters.creditTransactions.createTransaction.mockRejectedValueOnce(new Error('ledger down'));

      await revoke(adapters);

      expect(state).toEqual({ balance: 100, claimed: false });
      expect(adapters.creditTransactions.rekeyTransaction).not.toHaveBeenCalled();
      expect(adapters.users.update).not.toHaveBeenCalled();
    });
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

  it('withholds a grant that is still in the risk review queue, like the dry-run classifier', async () => {
    const adapters = buildReleaseAdapters();
    adapters.grant.db.users.findById.mockResolvedValueOnce({
      id: 'user-1',
      tags: [PENDING_FREE_CREDITS_TAG],
      signupGrantHeldReason: 'budget_exhausted',
      emailVerified: true,
      signupGrantAssessment: { band: 'review', status: 'evaluated' },
      signupGrant: { stage: 'signup', creditsReleased: 0, signupCredits: 100 },
    } as never);

    const bulk = await bulkReleaseHeldGrants({ actorId: 'admin-1', userIds: ['user-1'] }, adapters);

    expect(bulk.results).toEqual([{ userId: 'user-1', outcome: 'withheld', credits: 0 }]);
    expect(releasePendingFreeCredits).not.toHaveBeenCalled();
  });

  it('saves the account as it was before the payout so a revoke can restore it', async () => {
    vi.mocked(releasePendingFreeCredits).mockResolvedValue({
      released: true,
      creditsGranted: 40,
      currentCredits: 40,
      patch: {},
    });
    const adapters = buildReleaseAdapters();
    const heldAt = new Date('2026-11-01T00:00:00Z');
    adapters.grant.db.users.findById.mockResolvedValueOnce({
      id: 'user-1',
      tags: [PENDING_FREE_CREDITS_TAG],
      signupGrantHeldReason: 'budget_exhausted',
      signupGrantHeldAt: heldAt,
      pendingCreditGrant: 25,
      emailVerified: true,
      riskScore: { score: 1, signals: [], reviewState: 'pending' },
    } as never);

    const bulk = await bulkReleaseHeldGrants({ actorId: 'admin-1', userIds: ['user-1'] }, adapters);

    expect(adapters.batches.createBatch).toHaveBeenCalledWith({
      actorId: 'admin-1',
      entries: [
        expect.objectContaining({
          outcome: 'released',
          restore: {
            signupGrant: null,
            signupGrantHeldReason: 'budget_exhausted',
            signupGrantHeldAt: heldAt,
            pendingCreditGrant: 25,
            riskReviewState: 'pending',
          },
        }),
      ],
    });
    expect(bulk.results[0]).not.toHaveProperty('restore');
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
    expect(adapters.batches.createBatch).toHaveBeenCalledWith({
      actorId: 'admin-1',
      entries: [expect.objectContaining({ userId: 'user-1', outcome: 'released', credits: 40 })],
    });
    expect(adapters.grant.logger.error).toHaveBeenCalledWith(expect.stringContaining('user-1'), clearFailure);
  });
});

describe('held release preview parity', () => {
  const heldUser = (overrides: Record<string, unknown> = {}) => ({
    id: 'user-1',
    tags: [PENDING_FREE_CREDITS_TAG],
    signupGrantHeldReason: 'budget_exhausted',
    emailVerified: true,
    signupGrant: { stage: 'signup', signupCredits: 100, unlockCredits: 400, creditsReleased: 100 },
    ...overrides,
  });

  it.each([
    ['healthy held', heldUser()],
    ['unverified email', heldUser({ emailVerified: false })],
    [
      'blocked held',
      heldUser({
        signupGrant: {
          stage: 'signup',
          signupCredits: 100,
          unlockCredits: 400,
          creditsReleased: 100,
          blocked: { at: new Date() },
        },
      }),
    ],
    [
      'review-held',
      heldUser({
        signupGrantAssessment: { band: 'review', status: 'evaluated' },
        signupGrant: { stage: 'signup', signupCredits: 100, unlockCredits: 400, creditsReleased: 0 },
      }),
    ],
    ['ai access revoked', heldUser({ isModerated: true })],
    ['account blocked', heldUser({ isBanned: true })],
    ['not held', heldUser({ tags: [], signupGrantHeldReason: null })],
  ])('preview would_apply matches the real run for %s', async (_name, user) => {
    vi.mocked(releasePendingFreeCredits).mockReset();
    vi.mocked(releasePendingFreeCredits).mockResolvedValue({
      released: true,
      creditsGranted: 40,
      currentCredits: 40,
      patch: {},
    });
    const adapters = buildReleaseAdapters();
    adapters.grant.db.users.findById.mockResolvedValue(user as never);

    const preview = await previewSignupGrantAction(
      { action: 'release_held', userIds: ['user-1'] },
      { users: adapters.grant.db.users }
    );
    const real = await bulkReleaseHeldGrants({ actorId: 'admin-1', userIds: ['user-1'] }, adapters);

    const applied = preview.results[0].outcome === 'would_apply';
    expect(applied).toBe(!['withheld', 'not_held'].includes(real.results[0].outcome));
    expect(applied).toBe(user.id === 'user-1' && real.results[0].outcome === 'released');
  });
});
