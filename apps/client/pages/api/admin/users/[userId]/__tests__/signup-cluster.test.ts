import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope, MODERATION_PAGE_READ, missingAdminPermissionMessage } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({ findById: vi.fn(), findSignupCluster: vi.fn() }));

vi.mock('@server/middlewares/adminApi', async () =>
  (await import('@server/middlewares/__tests__/adminApiMock')).adminApiMock()
);
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
  it('declares requiredScopes [ApiKeyScope.ADMIN] and MODERATION_PAGE_READ for GET', () => {
    const config = (handler as unknown as { _config?: { requiredScopes?: string[]; adminPermissions?: unknown } })
      ._config;
    expect(config?.requiredScopes).toEqual([ApiKeyScope.ADMIN]);
    expect(config?.adminPermissions).toEqual({ GET: MODERATION_PAGE_READ });
  });

  it('refuses a delegate without a moderation read permission with 403 before reading anything', async () => {
    const delegate = { id: 'u2', isAdmin: false, adminPermissions: ['credits:adjust'] };
    await expect(call({}, delegate).promise).rejects.toMatchObject({
      statusCode: 403,
      message: missingAdminPermissionMessage(MODERATION_PAGE_READ),
    });
    expect(mocks.findById).not.toHaveBeenCalled();
  });

  it.each(['support:read', 'users:moderate'])('admits a delegate holding %s', async permission => {
    const { res, promise } = call({}, { id: 'u2', isAdmin: false, adminPermissions: [permission] });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.findById).toHaveBeenCalledTimes(1);
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
