import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    projectExists: vi.fn(),
    agentCount: vi.fn(),
    dataLakeFindOne: vi.fn(),
    fabFileExists: vi.fn(),
    publishedExists: vi.fn(),
    txFind: vi.fn(),
    txFindOne: vi.fn(),
    addCredits: vi.fn(),
    artifactExists: vi.fn(),
    apiKeyExists: vi.fn(),
    usageDistinct: vi.fn(),
    stampedKeys: vi.fn(),
    miscExists: vi.fn(),
    miscFindOne: vi.fn(),
    importFindOne: vi.fn(),
    overridesByKey: vi.fn(),
    hearthHasAnyChannel: vi.fn(),
    withTransaction: vi.fn(),
    userFindById: vi.fn(),
    gearMinAgeSetting: vi.fn(),
    heldFind: vi.fn(),
    hold: vi.fn(),
    rewardOutcome: vi.fn(),
    buildAdapters: vi.fn(),
    refundBudgetOnFailure: vi.fn(),
  },
}));

// baseApi mock: callable chain routed by req.method (same shape as the serve tests).
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
        post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.POST = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: unknown) => fn,
}));

vi.mock('@bike4mind/database', () => ({
  Project: { exists: (...a: unknown[]) => mocks.projectExists(...a) },
  FabFile: { exists: (...a: unknown[]) => mocks.fabFileExists(...a) },
  PublishedArtifact: { exists: (...a: unknown[]) => mocks.publishedExists(...a) },
  Artifact: { exists: (...a: unknown[]) => mocks.artifactExists(...a) },
  ApiKey: { exists: (...a: unknown[]) => mocks.apiKeyExists(...a) },
  UsageEvent: { distinct: (...a: unknown[]) => mocks.usageDistinct(...a) },
  User: {
    exists: (...a: unknown[]) => mocks.miscExists(...a),
    findById: (...a: unknown[]) => mocks.userFindById(...a),
  },
  Session: { exists: (...a: unknown[]) => mocks.miscExists(...a) },
  Agent: { exists: (...a: unknown[]) => mocks.miscExists(...a) },
  Memento: { exists: (...a: unknown[]) => mocks.miscExists(...a) },
  QuestMasterPlan: { exists: (...a: unknown[]) => mocks.miscExists(...a) },
  McpServer: { exists: (...a: unknown[]) => mocks.miscExists(...a) },
  agentRepository: { countByUserId: (...a: unknown[]) => mocks.agentCount(...a) },
  dataLakeRepository: { findOne: (...a: unknown[]) => mocks.dataLakeFindOne(...a) },
  creditTransactionRepository: {
    find: (...a: unknown[]) => mocks.txFind(...a),
    findOne: (...a: unknown[]) => mocks.txFindOne(...a),
  },
  gearStampRepository: {
    stampedKeys: (...a: unknown[]) => mocks.stampedKeys(...a),
  },
  gearOverrideRepository: { byKey: (...a: unknown[]) => mocks.overridesByKey(...a) },
  adminSettingsRepository: { getSettingsValue: (...a: unknown[]) => mocks.gearMinAgeSetting(...a) },
  hearthRepository: { hasAnyChannelForUser: (...a: unknown[]) => mocks.hearthHasAnyChannel(...a) },
  importHistoryJobRepository: { findOne: (...a: unknown[]) => mocks.importFindOne(...a) },
  rapidReplyAuditLogRepository: { findOne: (...a: unknown[]) => mocks.miscFindOne(...a) },
  researchDataRepository: { findOne: (...a: unknown[]) => mocks.miscFindOne(...a) },
  heldCreditRewardRepository: { findByTransactionIds: (...a: unknown[]) => mocks.heldFind(...a) },
  withTransaction: (fn: () => Promise<unknown>) => mocks.withTransaction(fn),
}));
// Stand-in for creditService.payCreditReward: the ledger check, then the outcome the test picks
// (default paid). Its real behavior is covered on a real DB in server/credits/creditReward.e2e.test.ts.
vi.mock('@bike4mind/services', () => ({
  creditService: {
    payCreditReward: async (reward: Record<string, unknown>) => {
      if (await mocks.txFindOne({ transactionId: reward.transactionId })) return { outcome: 'duplicate' };
      const outcome = (mocks.rewardOutcome() as string | undefined) ?? 'paid';
      if (outcome === 'queued') mocks.hold(reward);
      if (outcome !== 'paid') return { outcome };
      await mocks.addCredits({
        ownerId: reward.userId,
        credits: reward.credits,
        type: 'generic_add',
        transactionId: reward.transactionId,
        reason: reward.reason,
        description: reward.description,
        source: reward.source,
      });
      return { outcome: 'paid', creditTransactionId: 'tx1' };
    },
    // Stand-in for the payout gate catalog.evaluateGears mirrors (the real one is covered in creditReward.e2e).
    isRewardRecipientBlocked: (party: {
      isBanned?: boolean;
      moderation?: { status?: string };
      signupGrant?: { blocked?: unknown };
    }) => !!party.isBanned || party.moderation?.status === 'suspend_pending' || !!party.signupGrant?.blocked,
  },
  userService: { refundBudgetOnFailure: (fn: () => Promise<unknown>) => mocks.refundBudgetOnFailure(fn) },
}));
vi.mock('@bike4mind/server-utils/credits/creditRewardAdapters', () => ({
  buildCreditRewardAdapters: (...a: unknown[]) => mocks.buildAdapters(...a),
}));

import handler from '../claim';

const claim = (body: unknown, user: { id: string } | null = { id: 'u1' }) => {
  const { req, res } = createMocks({ method: 'POST', body: body as Record<string, unknown> });
  if (user) (req as Record<string, unknown>).user = user;
  return {
    res,
    promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res),
  };
};

const unlockProjects = () =>
  mocks.projectExists.mockImplementation((q: { $or?: unknown }) => Promise.resolve(q.$or ? { _id: 'p1' } : null));

// An account that passes all trust checks (email verified, older than 7 days).
const makeTrustedUser = () =>
  mocks.userFindById.mockReturnValue({
    lean: () => Promise.resolve({ createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000), emailVerified: true }),
  });

const lockEverything = () => {
  mocks.projectExists.mockResolvedValue(null);
  mocks.agentCount.mockResolvedValue(0);
  mocks.dataLakeFindOne.mockResolvedValue(null);
  mocks.fabFileExists.mockResolvedValue(null);
  mocks.publishedExists.mockResolvedValue(null);
  mocks.artifactExists.mockResolvedValue(null);
  mocks.apiKeyExists.mockResolvedValue(null);
  mocks.usageDistinct.mockResolvedValue([]);
  mocks.stampedKeys.mockResolvedValue(new Set());
  mocks.miscExists.mockResolvedValue(null);
  mocks.miscFindOne.mockResolvedValue(null);
  mocks.importFindOne.mockResolvedValue(null);
  mocks.overridesByKey.mockResolvedValue(new Map());
  mocks.hearthHasAnyChannel.mockResolvedValue(false);
  mocks.txFind.mockResolvedValue([]);
  mocks.txFindOne.mockResolvedValue(null);
  mocks.heldFind.mockResolvedValue([]);
  // Default: trusted account so existing tests that expect payouts continue to pass.
  makeTrustedUser();
};

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  lockEverything();
  mocks.addCredits.mockResolvedValue({ currentCredits: 100 });
  mocks.withTransaction.mockImplementation((fn: () => Promise<unknown>) => fn());
  mocks.buildAdapters.mockReturnValue({});
  mocks.refundBudgetOnFailure.mockImplementation((fn: () => Promise<unknown>) => fn());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/gears/claim', () => {
  it('propagates a failed trust lookup without starting a payout', async () => {
    unlockProjects();
    const lookupError = new Error('User lookup unavailable');
    mocks.userFindById.mockReturnValue({ lean: () => Promise.reject(lookupError) });

    const { res, promise } = claim({ key: 'projects' });

    await expect(promise).rejects.toBe(lookupError);
    expect(res._isEndCalled()).toBe(false);
    expect(mocks.withTransaction).not.toHaveBeenCalled();
    expect(mocks.addCredits).not.toHaveBeenCalled();
  });

  it('401s without a user', async () => {
    const { res, promise } = claim({ key: 'projects' }, null);
    await promise;
    expect(res._getStatusCode()).toBe(401);
  });

  it('400s on a key that is not a gear', async () => {
    const { res, promise } = claim({ key: 'not-a-gear' });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(mocks.addCredits).not.toHaveBeenCalled();
  });

  it('pays an unlocked gear once, under its stable transactionId', async () => {
    unlockProjects();
    const { res, promise } = claim({ key: 'projects' });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ key: 'projects', creditsAwarded: 1000 });
    expect(mocks.userFindById).toHaveBeenCalledExactlyOnceWith('u1', {
      createdAt: 1,
      emailVerified: 1,
      isBanned: 1,
      disputePending: 1,
      moderation: 1,
      deletedAt: 1,
      isSynthetic: 1,
      'signupGrant.blocked': 1,
    });
    expect(mocks.addCredits).toHaveBeenCalledTimes(1);
    expect(mocks.addCredits.mock.calls[0][0]).toMatchObject({
      ownerId: 'u1',
      credits: 1000,
      type: 'generic_add',
      transactionId: 'gear-unlock:u1:projects',
      reason: 'gear unlock: projects',
      description: 'Gear unlock reward: projects',
    });
  });

  it('pays inside a refund scope with adapters that throw on a duplicate and run in the caller transaction', async () => {
    unlockProjects();
    const { promise } = claim({ key: 'projects' });
    await promise;

    expect(mocks.refundBudgetOnFailure).toHaveBeenCalledTimes(1);
    expect(mocks.buildAdapters).toHaveBeenCalledExactlyOnceWith({
      duplicateTransactionId: 'throw',
      inTransaction: true,
    });
  });

  it('tags the payout with its reward source', async () => {
    unlockProjects();
    const { promise } = claim({ key: 'projects' });
    await promise;
    expect(mocks.addCredits.mock.calls[0][0]).toMatchObject({ source: 'gear' });
  });

  it('answers 202 queued without paying while the trickle pool is dry', async () => {
    unlockProjects();
    mocks.rewardOutcome.mockReturnValue('queued');
    const { res, promise } = claim({ key: 'projects' });
    await promise;
    expect(res._getStatusCode()).toBe(202);
    expect(res._getJSONData()).toEqual({ key: 'projects', queued: true });
    expect(mocks.addCredits).not.toHaveBeenCalled();
    expect(mocks.hold).toHaveBeenCalledTimes(1);
  });

  it('treats a queued reward as claimed, so a second claim neither pays nor queues again', async () => {
    unlockProjects();
    mocks.heldFind.mockResolvedValue([{ transactionId: 'gear-unlock:u1:projects', status: 'held' }]);
    const { res, promise } = claim({ key: 'projects' });
    await promise;
    expect(res._getJSONData()).toEqual({ key: 'projects', alreadyClaimed: true });
    expect(mocks.addCredits).not.toHaveBeenCalled();
    expect(mocks.hold).not.toHaveBeenCalled();
  });

  it('pays nothing and queues nothing for a blocked account', async () => {
    unlockProjects();
    mocks.rewardOutcome.mockReturnValue('blocked');
    const { res, promise } = claim({ key: 'projects' });
    await promise;
    expect(res._getStatusCode()).toBe(403);
    expect(mocks.addCredits).not.toHaveBeenCalled();
    expect(mocks.hold).not.toHaveBeenCalled();
  });

  it('writes the ledger row and the balance inside one transaction', async () => {
    unlockProjects();
    const { promise } = claim({ key: 'projects' });
    await promise;
    expect(mocks.withTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.addCredits).toHaveBeenCalledTimes(1);
  });

  it('stops without paying when the ledger row appears inside the transaction', async () => {
    // A concurrent claim committed between this request's check and its transaction.
    unlockProjects();
    mocks.txFindOne.mockResolvedValue({ transactionId: 'gear-unlock:u1:projects' });
    const { res, promise } = claim({ key: 'projects' });
    await promise;
    expect(res._getJSONData()).toEqual({ key: 'projects', alreadyClaimed: true });
    expect(mocks.addCredits).not.toHaveBeenCalled();
  });

  it('does not answer alreadyClaimed when the payout failed and rolled back', async () => {
    // A failed balance write rolls the ledger row back with it, so the gear still reads as
    // unpaid: the error surfaces (500 via asyncHandler) and a retry can pay.
    unlockProjects();
    mocks.withTransaction.mockRejectedValue(new Error('balance write failed'));
    const { res, promise } = claim({ key: 'projects' });
    await expect(promise).rejects.toThrow('balance write failed');
    expect(res._isEndCalled()).toBe(false);
  });

  it('answers alreadyClaimed when the transaction lost a race to a claim that committed first', async () => {
    unlockProjects();
    // Unpaid when this request checks, paid by the time its own insert collides.
    mocks.txFind.mockResolvedValueOnce([]).mockResolvedValue([{ transactionId: 'gear-unlock:u1:projects' }]);
    mocks.withTransaction.mockRejectedValue(Object.assign(new Error('Transaction aborted'), { code: 251 }));
    const { res, promise } = claim({ key: 'projects' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ key: 'projects', alreadyClaimed: true });
  });

  it('refuses a locked gear - the client cannot claim what the server has not seen', async () => {
    const { res, promise } = claim({ key: 'projects' });
    await promise;
    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData()).toEqual({ error: 'not_unlocked' });
    expect(mocks.addCredits).not.toHaveBeenCalled();
  });

  it('refuses while the payout condition is still pending (published, no outside view)', async () => {
    mocks.publishedExists.mockImplementation((q: { externalViewCount?: unknown }) =>
      Promise.resolve(q.externalViewCount ? null : { _id: 'a1' })
    );
    const { res, promise } = claim({ key: 'published' });
    await promise;
    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData()).toEqual({ error: 'reward_pending', reason: 'reward_check' });
    expect(mocks.addCredits).not.toHaveBeenCalled();
  });

  it.each([
    { emailVerified: false, ageInDays: 8, reason: 'unverified' },
    { emailVerified: true, ageInDays: 3, reason: 'too_new' },
  ])('holds a viewed Published reward for a $reason account', async ({ emailVerified, ageInDays, reason }) => {
    mocks.publishedExists.mockResolvedValue({ _id: 'a1' });
    mocks.userFindById.mockReturnValue({
      lean: () => Promise.resolve({ createdAt: new Date(Date.now() - ageInDays * 24 * 60 * 60 * 1000), emailVerified }),
    });

    const { res, promise } = claim({ key: 'published' });
    await promise;

    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData()).toEqual({ error: 'reward_pending', reason });
    expect(mocks.publishedExists).toHaveBeenCalledExactlyOnceWith({ ownerId: 'u1', deletedAt: null });
    expect(mocks.withTransaction).not.toHaveBeenCalled();
    expect(mocks.addCredits).not.toHaveBeenCalled();
  });

  it('answers alreadyClaimed without touching the ledger when the gear was paid before', async () => {
    unlockProjects();
    mocks.txFind.mockResolvedValue([{ transactionId: 'gear-unlock:u1:projects' }]);
    const { res, promise } = claim({ key: 'projects' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ key: 'projects', alreadyClaimed: true });
    expect(mocks.addCredits).not.toHaveBeenCalled();
  });

  it('pays the admin override amount, unscaled', async () => {
    unlockProjects();
    mocks.overridesByKey.mockResolvedValue(new Map([['projects', { key: 'projects', credits: 7 }]]));
    const { res, promise } = claim({ key: 'projects' });
    await promise;
    expect(res._getJSONData()).toEqual({ key: 'projects', creditsAwarded: 7 });
    expect(mocks.addCredits.mock.calls[0][0]).toMatchObject({ credits: 7 });
  });

  it('404s on a gear disabled in Manage Gears', async () => {
    unlockProjects();
    mocks.overridesByKey.mockResolvedValue(new Map([['projects', { key: 'projects', enabled: false }]]));
    const { res, promise } = claim({ key: 'projects' });
    await promise;
    expect(res._getStatusCode()).toBe(404);
    expect(mocks.addCredits).not.toHaveBeenCalled();
  });

  it('refuses a gear whose reward was set to zero', async () => {
    unlockProjects();
    mocks.overridesByKey.mockResolvedValue(new Map([['projects', { key: 'projects', credits: 0 }]]));
    const { res, promise } = claim({ key: 'projects' });
    await promise;
    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData()).toEqual({ error: 'no_reward' });
  });

  it('checks only the gear being claimed', async () => {
    unlockProjects();
    const { promise } = claim({ key: 'projects' });
    await promise;
    expect(mocks.agentCount).not.toHaveBeenCalled();
    expect(mocks.apiKeyExists).not.toHaveBeenCalled();
  });

  it('blocks payout when the account is not email-verified', async () => {
    unlockProjects();
    mocks.userFindById.mockReturnValue({
      lean: () => Promise.resolve({ createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000), emailVerified: false }),
    });
    const { res, promise } = claim({ key: 'projects' });
    await promise;
    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData()).toEqual({ error: 'reward_pending', reason: 'unverified' });
    expect(mocks.addCredits).not.toHaveBeenCalled();
  });

  it('blocks payout when the account is younger than 7 days', async () => {
    unlockProjects();
    mocks.userFindById.mockReturnValue({
      lean: () => Promise.resolve({ createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), emailVerified: true }),
    });
    const { res, promise } = claim({ key: 'projects' });
    await promise;
    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData()).toEqual({ error: 'reward_pending', reason: 'too_new' });
    expect(mocks.addCredits).not.toHaveBeenCalled();
  });

  it('pays a 3-day-old account once gearRewardMinAccountAgeDays is lowered to 0', async () => {
    unlockProjects();
    mocks.gearMinAgeSetting.mockResolvedValue(0);
    mocks.userFindById.mockReturnValue({
      lean: () => Promise.resolve({ createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), emailVerified: true }),
    });
    const { res, promise } = claim({ key: 'projects' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ key: 'projects', creditsAwarded: 1000 });
  });

  it('holds an 8-day-old account once gearRewardMinAccountAgeDays is raised to 10', async () => {
    unlockProjects();
    mocks.gearMinAgeSetting.mockResolvedValue(10);
    const { res, promise } = claim({ key: 'projects' });
    await promise;
    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData()).toEqual({ error: 'reward_pending', reason: 'too_new' });
    expect(mocks.addCredits).not.toHaveBeenCalled();
  });

  it('still requires a verified email when the age wait is 0', async () => {
    unlockProjects();
    mocks.gearMinAgeSetting.mockResolvedValue(0);
    mocks.userFindById.mockReturnValue({
      lean: () => Promise.resolve({ createdAt: new Date(), emailVerified: false }),
    });
    const { res, promise } = claim({ key: 'projects' });
    await promise;
    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData()).toEqual({ error: 'reward_pending', reason: 'unverified' });
  });

  it('blocks payout as unavailable when the user doc is missing', async () => {
    unlockProjects();
    mocks.userFindById.mockReturnValue({ lean: () => Promise.resolve(null) });
    const { res, promise } = claim({ key: 'projects' });
    await promise;
    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData()).toEqual({ error: 'reward_pending', reason: 'unavailable' });
    expect(mocks.addCredits).not.toHaveBeenCalled();
  });

  it('reports unverified ahead of too_new when both apply', async () => {
    unlockProjects();
    mocks.userFindById.mockReturnValue({
      lean: () => Promise.resolve({ createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000), emailVerified: false }),
    });
    const { res, promise } = claim({ key: 'projects' });
    await promise;
    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData()).toEqual({ error: 'reward_pending', reason: 'unverified' });
  });

  it('still answers alreadyClaimed for a gear paid before the account became untrusted', async () => {
    unlockProjects();
    mocks.txFind.mockResolvedValue([{ transactionId: 'gear-unlock:u1:projects' }]);
    mocks.userFindById.mockReturnValue({
      lean: () => Promise.resolve({ createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000), emailVerified: false }),
    });
    const { res, promise } = claim({ key: 'projects' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ key: 'projects', alreadyClaimed: true });
    expect(mocks.addCredits).not.toHaveBeenCalled();
  });

  it.each([
    { millisecondsUntilEligible: 1, statusCode: 409 },
    { millisecondsUntilEligible: 0, statusCode: 200 },
  ])(
    'enforces the age boundary with $millisecondsUntilEligible ms remaining',
    async ({ millisecondsUntilEligible, statusCode }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-27T00:00:00Z'));
      unlockProjects();
      mocks.userFindById.mockReturnValue({
        lean: () =>
          Promise.resolve({
            createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 + millisecondsUntilEligible),
            emailVerified: true,
          }),
      });
      const { res, promise } = claim({ key: 'projects' });
      await promise;
      expect(res._getStatusCode()).toBe(statusCode);
      if (millisecondsUntilEligible > 0) {
        expect(res._getJSONData()).toEqual({ error: 'reward_pending', reason: 'too_new' });
        expect(mocks.addCredits).not.toHaveBeenCalled();
      } else {
        expect(res._getJSONData()).toEqual({ key: 'projects', creditsAwarded: 1000 });
      }
    }
  );

  it('pays a verified legacy account that has no createdAt but an old ObjectId', async () => {
    unlockProjects();
    mocks.userFindById.mockReturnValue({ lean: () => Promise.resolve({ emailVerified: true }) });
    const { res, promise } = claim({ key: 'projects' }, { id: '507f1f77bcf86cd799439011' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ key: 'projects', creditsAwarded: 1000 });
  });

  it('holds the payout for an account with neither createdAt nor an ObjectId id', async () => {
    unlockProjects();
    mocks.userFindById.mockReturnValue({ lean: () => Promise.resolve({ emailVerified: true }) });
    const { res, promise } = claim({ key: 'projects' });
    await promise;
    expect(res._getStatusCode()).toBe(409);
    expect(mocks.addCredits).not.toHaveBeenCalled();
  });

  it('pays a trusted account (email-verified and older than 7 days)', async () => {
    unlockProjects();
    const { res, promise } = claim({ key: 'projects' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ key: 'projects', creditsAwarded: 1000 });
  });

  it('blocks apikey gear payout for an unverified account even with an active key', async () => {
    mocks.apiKeyExists.mockResolvedValue({ _id: 'k1' });
    mocks.userFindById.mockReturnValue({
      lean: () => Promise.resolve({ createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000), emailVerified: false }),
    });
    const { res, promise } = claim({ key: 'apikey' });
    await promise;
    // Gear unlocks (active key exists), but trust gate blocks the payout.
    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData()).toEqual({ error: 'reward_pending', reason: 'unverified' });
    expect(mocks.addCredits).not.toHaveBeenCalled();
  });

  it('blocks apicall gear payout for an unverified account even with API usage', async () => {
    mocks.usageDistinct.mockImplementation((field: string) =>
      Promise.resolve(field === 'feature' ? ['completion_api'] : [])
    );
    mocks.userFindById.mockReturnValue({
      lean: () => Promise.resolve({ createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000), emailVerified: false }),
    });
    const { res, promise } = claim({ key: 'apicall' });
    await promise;
    // Gear unlocks (usage event exists), but trust gate blocks the payout.
    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData()).toEqual({ error: 'reward_pending', reason: 'unverified' });
    expect(mocks.addCredits).not.toHaveBeenCalled();
  });
});
