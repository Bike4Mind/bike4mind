import { createMocks } from 'node-mocks-http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { contracts, rateLimitKeys, countPendingDecisions } = vi.hoisted(() => ({
  contracts: [] as { operationId: string; auth: string; scopes?: readonly string[] }[],
  rateLimitKeys: [] as string[],
  countPendingDecisions: vi.fn(),
}));

vi.mock('@server/middlewares/defineNextRoute', () => ({
  nextRouteForContract: (contract: (typeof contracts)[number]) => {
    contracts.push(contract);
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain: Record<string, unknown> = Object.assign(
      async (req: { method: string }, res: unknown) => handlers[req.method]?.(req, res),
      { get: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.GET = fn), chain) }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/perUserRateLimit', () => ({
  perUserRateLimit: (key: string) => (rateLimitKeys.push(key), vi.fn()),
}));
vi.mock('@server/briefs/countPendingDecisions', () => ({ countPendingDecisions }));

import handler from '../pending-decisions';

const call = async (userId: string) => {
  const { req, res } = createMocks({ method: 'GET' });
  Object.assign(req, { user: { id: userId } });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
};

describe('/api/v1/pending-decisions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is JWT-only with no scopes and a per-user rate limit (an API key is refused before it runs)', () => {
    expect(contracts.map(c => [c.operationId, c.auth, c.scopes])).toEqual([
      ['getPendingDecisionCount', 'jwtOnly', undefined],
    ]);
    expect(rateLimitKeys).toEqual(['GET /api/v1/pending-decisions']);
  });

  it("returns the JWT user's own count", async () => {
    const count = { count: 3, approvals: 1, briefDecisions: 2, briefId: 'brief-1' };
    countPendingDecisions.mockResolvedValue(count);

    const res = await call('user-1');

    expect(countPendingDecisions).toHaveBeenCalledExactlyOnceWith('user-1');
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual(count);
  });

  it('propagates a failed count to the error handler instead of answering zero', async () => {
    countPendingDecisions.mockRejectedValue(new Error('db down'));

    await expect(call('user-1')).rejects.toThrow('db down');
  });
});
