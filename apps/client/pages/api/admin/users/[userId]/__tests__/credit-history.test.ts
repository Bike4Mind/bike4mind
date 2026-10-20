import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({ findById: vi.fn(), getUserCreditHistory: vi.fn() }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
        _config: config,
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({ userRepository: { findById: (...a: unknown[]) => mocks.findById(...a) } }));
vi.mock('@server/utils/userActivity', () => ({
  getUserCreditHistory: (...a: unknown[]) => mocks.getUserCreditHistory(...a),
}));

import handler from '../credit-history';

const USER_ID = 'b'.repeat(24);

const call = (userId: string = USER_ID, user: unknown = { id: 'admin1', isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'GET', query: { userId } });
  if (user) (req as Record<string, unknown>).user = user;
  return { req, res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findById.mockResolvedValue({ id: USER_ID, currentCredits: 42 });
  mocks.getUserCreditHistory.mockResolvedValue({ windowDays: 90, points: [] });
});

describe('GET /api/admin/users/[userId]/credit-history', () => {
  it('declares requiredScopes [ApiKeyScope.ADMIN]', () => {
    expect((handler as unknown as { _config?: { requiredScopes?: string[] } })._config?.requiredScopes).toEqual([
      ApiKeyScope.ADMIN,
    ]);
  });

  it('rejects a non-admin with 403', async () => {
    await expect(call(USER_ID, { id: 'u2', isAdmin: false }).promise).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.findById).not.toHaveBeenCalled();
  });

  it('rejects a malformed id with 400 and a missing user with 404', async () => {
    await expect(call('nope').promise).rejects.toMatchObject({ statusCode: 400 });
    mocks.findById.mockResolvedValue(null);
    await expect(call().promise).rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns the history rebuilt from the current balance', async () => {
    const { res, promise } = call();
    await promise;

    expect(mocks.getUserCreditHistory).toHaveBeenCalledWith({ id: USER_ID, currentCredits: 42 });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ windowDays: 90, points: [] });
  });
});
