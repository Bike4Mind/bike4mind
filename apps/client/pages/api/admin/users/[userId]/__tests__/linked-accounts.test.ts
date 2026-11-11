import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope, MODERATION_PAGE_READ, missingAdminPermissionMessage } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({ findById: vi.fn(), findLinkedAccounts: vi.fn() }));

vi.mock('@server/middlewares/adminApi', async () =>
  (await import('@server/middlewares/__tests__/adminApiMock')).adminApiMock()
);
vi.mock('@bike4mind/database', () => ({ userRepository: { findById: (...a: unknown[]) => mocks.findById(...a) } }));
vi.mock('@server/billing/linkedAccounts', () => ({
  findLinkedAccounts: (...a: unknown[]) => mocks.findLinkedAccounts(...a),
}));

import handler from '../linked-accounts';

const USER_ID = 'b'.repeat(24);
const LINKED = {
  id: 'c'.repeat(24),
  name: 'Other',
  email: 'other@example.com',
  strength: 'strong',
  via: ['card'],
  blocked: false,
  internalOnly: 'must not leak',
};

const call = (query: Record<string, string> = {}, user: unknown = { id: 'admin1', isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'GET', query: { userId: USER_ID, ...query } });
  if (user) (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findById.mockResolvedValue({ id: USER_ID });
  mocks.findLinkedAccounts.mockResolvedValue([LINKED]);
});

describe('GET /api/admin/users/[userId]/linked-accounts', () => {
  it('declares requiredScopes [ApiKeyScope.ADMIN] and MODERATION_PAGE_READ for GET', () => {
    const config = (handler as unknown as { _config?: { requiredScopes?: string[]; adminPermissions?: unknown } })
      ._config;
    expect(config?.requiredScopes).toEqual([ApiKeyScope.ADMIN]);
    expect(config?.adminPermissions).toEqual({ GET: MODERATION_PAGE_READ });
  });

  it('refuses a delegate without a moderation read permission before reading anything', async () => {
    const delegate = { id: 'u2', isAdmin: false, adminPermissions: ['credits:adjust'] };
    await expect(call({}, delegate).promise).rejects.toMatchObject({
      statusCode: 403,
      message: missingAdminPermissionMessage(MODERATION_PAGE_READ),
    });
    expect(mocks.findById).not.toHaveBeenCalled();
    expect(mocks.findLinkedAccounts).not.toHaveBeenCalled();
  });

  it.each(['support:read', 'users:moderate'])('admits a delegate holding %s', async permission => {
    const { res, promise } = call({}, { id: 'u2', isAdmin: false, adminPermissions: [permission] });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.findLinkedAccounts).toHaveBeenCalledTimes(1);
  });

  it('returns only the public linked-account fields to a full admin', async () => {
    const { res, promise } = call();
    await promise;
    const { internalOnly: _omitted, ...expected } = LINKED;
    expect(res._getJSONData()).toEqual([expected]);
  });

  it('rejects a malformed user id with 400 and a missing user with 404', async () => {
    await expect(call({ userId: 'nope' }).promise).rejects.toMatchObject({ statusCode: 400 });
    mocks.findById.mockResolvedValue(null);
    await expect(call().promise).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.findLinkedAccounts).not.toHaveBeenCalled();
  });
});
