import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({ findById: vi.fn(), findSignupCluster: vi.fn() }));

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
vi.mock('@server/utils/userSignIns', () => ({
  findSignupCluster: (...a: unknown[]) => mocks.findSignupCluster(...a),
}));

import handler from '../signup-cluster';

const USER_ID = 'b'.repeat(24);
const CREATED = new Date('2026-10-01T00:00:00.000Z');

const call = (query: Record<string, string> = {}, user: unknown = { id: 'admin1', isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'GET', query: { userId: USER_ID, ...query } });
  if (user) (req as Record<string, unknown>).user = user;
  return { req, res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findById.mockResolvedValue({ id: USER_ID, createdAt: CREATED, signupMeta: { ja4: 't13d1516h2_abc' } });
  mocks.findSignupCluster.mockResolvedValue({
    fingerprintAvailable: true,
    windowDays: 7,
    matches: [],
    truncated: false,
  });
});

describe('GET /api/admin/users/[userId]/signup-cluster', () => {
  it('declares requiredScopes [ApiKeyScope.ADMIN]', () => {
    expect((handler as unknown as { _config?: { requiredScopes?: string[] } })._config?.requiredScopes).toEqual([
      ApiKeyScope.ADMIN,
    ]);
  });

  it('rejects a non-admin with 403 before reading anything', async () => {
    await expect(call({}, { id: 'u2', isAdmin: false }).promise).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.findById).not.toHaveBeenCalled();
  });

  it('rejects a malformed id with 400 and a missing user with 404', async () => {
    await expect(call({ userId: 'nope' }).promise).rejects.toMatchObject({ statusCode: 400 });
    mocks.findById.mockResolvedValue(null);
    await expect(call().promise).rejects.toMatchObject({ statusCode: 404 });
  });

  it('looks up the cluster from the stored signup fingerprint', async () => {
    const { res, promise } = call();
    await promise;

    expect(mocks.findSignupCluster).toHaveBeenCalledWith({
      id: USER_ID,
      createdAt: CREATED,
      signupMeta: { ja4: 't13d1516h2_abc' },
    });
    expect(res._getJSONData()).toMatchObject({ fingerprintAvailable: true, matches: [] });
  });
});
