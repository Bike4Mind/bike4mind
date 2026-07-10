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
    addCredits: vi.fn(),
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
  agentRepository: { countByUserId: (...a: unknown[]) => mocks.agentCount(...a) },
  dataLakeRepository: { findOne: (...a: unknown[]) => mocks.dataLakeFindOne(...a) },
  creditTransactionRepository: { find: (...a: unknown[]) => mocks.txFind(...a) },
  userRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  creditService: { addCredits: (...a: unknown[]) => mocks.addCredits(...a) },
}));
vi.mock('@bike4mind/common', () => ({
  CreditHolderType: { User: 'User' },
}));

import handler from '../status';

const run = (user?: { id: string }) => {
  const { req, res } = createMocks({ method: 'GET' });
  if (user) (req as Record<string, unknown>).user = user;
  return {
    res,
    promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res),
  };
};

const lockEverything = () => {
  mocks.projectExists.mockResolvedValue(null);
  mocks.agentCount.mockResolvedValue(0);
  mocks.dataLakeFindOne.mockResolvedValue(null);
  mocks.fabFileExists.mockResolvedValue(null);
  mocks.publishedExists.mockResolvedValue(null);
  mocks.txFind.mockResolvedValue([]);
};

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  lockEverything();
  mocks.addCredits.mockResolvedValue({ currentCredits: 100 });
});

describe('GET /api/gears/status', () => {
  it('401s without a user', async () => {
    const { res, promise } = run();
    await promise;
    expect(res._getStatusCode()).toBe(401);
  });

  it('reports all gears locked for a brand-new user and grants nothing', async () => {
    const { res, promise } = run({ id: 'u1' });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData() as { gears: Array<{ unlocked: boolean }>; totalUnlocked: number };
    expect(body.gears).toHaveLength(5);
    expect(body.gears.every(g => !g.unlocked)).toBe(true);
    expect(body.totalUnlocked).toBe(0);
    expect(mocks.addCredits).not.toHaveBeenCalled();
  });

  it('derives unlocks from data existence and grants the one-time reward with a stable transactionId', async () => {
    mocks.projectExists.mockResolvedValue({ _id: 'p1' });
    const { res, promise } = run({ id: 'u1' });
    await promise;

    const body = res._getJSONData() as { gears: Array<{ key: string; unlocked: boolean; creditsAwarded?: number }> };
    const projects = body.gears.find(g => g.key === 'projects')!;
    expect(projects.unlocked).toBe(true);
    expect(projects.creditsAwarded).toBeGreaterThan(0);
    expect(mocks.addCredits).toHaveBeenCalledTimes(1);
    expect(mocks.addCredits.mock.calls[0][0]).toMatchObject({
      ownerId: 'u1',
      type: 'generic_add',
      transactionId: 'gear-unlock:u1:projects',
    });
  });

  it('never re-grants once the ledger has the gear transaction', async () => {
    mocks.projectExists.mockResolvedValue({ _id: 'p1' });
    mocks.txFind.mockResolvedValue([{ transactionId: 'gear-unlock:u1:projects' }]);

    const { res, promise } = run({ id: 'u1' });
    await promise;

    const body = res._getJSONData() as { gears: Array<{ key: string; creditsAwarded?: number }> };
    expect(body.gears.find(g => g.key === 'projects')!.creditsAwarded).toBeUndefined();
    expect(mocks.addCredits).not.toHaveBeenCalled();
  });

  it('a reward failure never breaks the status surface (nav still gets its answer)', async () => {
    mocks.projectExists.mockResolvedValue({ _id: 'p1' });
    mocks.addCredits.mockRejectedValue(new Error('ledger down'));

    const { res, promise } = run({ id: 'u1' });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData() as { gears: Array<{ key: string; unlocked: boolean; creditsAwarded?: number }> };
    const projects = body.gears.find(g => g.key === 'projects')!;
    expect(projects.unlocked).toBe(true);
    expect(projects.creditsAwarded).toBeUndefined();
  });

  it('unlock by receipt: project membership (not just ownership) is queried', async () => {
    const { promise } = run({ id: 'u1' });
    await promise;
    expect(mocks.projectExists).toHaveBeenCalledWith({
      $or: [{ userId: 'u1' }, { 'users.id': 'u1' }],
    });
  });
});
