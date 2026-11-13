import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope, type AdminPermissionId } from '@bike4mind/common';
import { ADMIN_USERS_BULK_ROUTE_PERMISSIONS } from '@bike4mind/server-utils/app/utils/adminUsersBulk';

vi.mock('@server/middlewares/adminApi', async () =>
  (await import('@server/admin/bulkAbuse/__tests__/bulkAbuseRouteMocks')).adminApiMock()
);
vi.mock('@server/middlewares/asyncHandler', async () =>
  (await import('@server/admin/bulkAbuse/__tests__/bulkAbuseRouteMocks')).asyncHandlerMock()
);
// Recorded at import, so a plain array that clearAllMocks does not reset.
const { rateLimitOptions } = vi.hoisted(() => ({ rateLimitOptions: [] as unknown[] }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => (rateLimitOptions.push(options), () => undefined),
}));
vi.mock('@bike4mind/server-utils/admin/usersBulk/adapters', () => ({ usersBulkUndoDeps: () => ({ deps: true }) }));
const mockUndo = vi.fn();
vi.mock('@bike4mind/server-utils/admin/usersBulk/undo', () => ({
  undoAdminUsersBulk: (...a: unknown[]) => mockUndo(...a),
}));

const UNDO_RESULT = {
  restored: 2,
  failed: [],
  partial: false,
  remaining: 0,
  unblockedDomains: [],
  stillBlockedDomains: [],
};

import handler from '../undo';

const ADMIN = { id: 'a'.repeat(24), isAdmin: true };
const delegate = (...adminPermissions: AdminPermissionId[]) => ({ ...ADMIN, isAdmin: false, adminPermissions });
const BATCH_ID = '7b1f3c52-9a3e-4b8e-8f43-2f4a1c9d0e11';

async function call(body: unknown, user: Record<string, unknown> = ADMIN) {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, { user });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return res;
}

describe('POST /api/admin/users/bulk/undo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUndo.mockResolvedValue(UNDO_RESULT);
  });

  it('requires JWT admin auth and a per-admin rate limit', () => {
    expect((handler as unknown as { _config: unknown })._config).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
      adminPermissions: { POST: ADMIN_USERS_BULK_ROUTE_PERMISSIONS },
    });
    expect(rateLimitOptions).toContainEqual(expect.objectContaining({ limit: 10, windowMs: 60_000 }));
  });

  it('refuses a delegate holding none of the bulk permissions', async () => {
    await expect(call({ batchId: BATCH_ID }, delegate('support:read'))).rejects.toThrow('Missing permission:');
    expect(mockUndo).not.toHaveBeenCalled();
  });

  it('admits a delegate holding one of the bulk permissions', async () => {
    const res = await call({ batchId: BATCH_ID }, delegate('keys:revoke'));

    expect(res._getStatusCode()).toBe(200);
  });

  it('rejects a malformed batch id', async () => {
    await expect(call({ batchId: 'nope' })).rejects.toThrow();
    expect(mockUndo).not.toHaveBeenCalled();
  });

  it('undoes as the calling admin', async () => {
    const res = await call({ batchId: BATCH_ID });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual(UNDO_RESULT);
    expect(mockUndo).toHaveBeenCalledWith(BATCH_ID, ADMIN.id, { deps: true }, expect.any(Function));
  });

  describe('re-checks the batch action at undo time', () => {
    const authorizeAs = async (user: Record<string, unknown>) => {
      await call({ batchId: BATCH_ID }, user);
      return mockUndo.mock.calls[0][3] as (record: { action: string; blockedDomains?: string[] }) => void;
    };

    it('refuses a delegate who no longer holds the permission the batch needed', async () => {
      const authorize = await authorizeAs(delegate('keys:revoke'));
      expect(() => authorize({ action: 'suspend' })).toThrow('Missing permission: users:moderate');
    });

    it('admits a delegate who still holds it', async () => {
      const authorize = await authorizeAs(delegate('users:moderate'));
      expect(() => authorize({ action: 'suspend' })).not.toThrow();
    });

    it('requires settings ability when undo would unblock a domain', async () => {
      const authorize = await authorizeAs(delegate('users:moderate', 'keys:revoke', 'credits:adjust'));
      expect(() => authorize({ action: 'contain', blockedDomains: ['abuse.example'] })).toThrow(
        'Unblocking email domains needs permission to edit admin settings.'
      );
    });

    it('refuses an unknown recorded action', async () => {
      const authorize = await authorizeAs(ADMIN);
      expect(() => authorize({ action: 'bogus' })).toThrow('This bulk action cannot be undone here.');
    });
  });
});
