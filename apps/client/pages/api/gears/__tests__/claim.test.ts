import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  User: { exists: (...a: unknown[]) => mocks.miscExists(...a) },
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
  hearthRepository: { hasAnyChannelForUser: (...a: unknown[]) => mocks.hearthHasAnyChannel(...a) },
  importHistoryJobRepository: { findOne: (...a: unknown[]) => mocks.importFindOne(...a) },
  rapidReplyAuditLogRepository: { findOne: (...a: unknown[]) => mocks.miscFindOne(...a) },
  researchDataRepository: { findOne: (...a: unknown[]) => mocks.miscFindOne(...a) },
  userRepository: {},
  withTransaction: (fn: () => Promise<unknown>) => mocks.withTransaction(fn),
}));
vi.mock('@bike4mind/services', () => ({
  creditService: { addCredits: (...a: unknown[]) => mocks.addCredits(...a) },
}));
vi.mock('@bike4mind/common', () => ({
  CreditHolderType: { User: 'User' },
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
};

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  lockEverything();
  mocks.addCredits.mockResolvedValue({ currentCredits: 100 });
  mocks.withTransaction.mockImplementation((fn: () => Promise<unknown>) => fn());
});

describe('POST /api/gears/claim', () => {
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
    expect(mocks.addCredits).toHaveBeenCalledTimes(1);
    expect(mocks.addCredits.mock.calls[0][0]).toMatchObject({
      ownerId: 'u1',
      credits: 1000,
      type: 'generic_add',
      transactionId: 'gear-unlock:u1:projects',
    });
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
    expect(res._getJSONData()).toEqual({ error: 'reward_pending' });
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
});
