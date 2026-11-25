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
vi.mock('@bike4mind/server-utils/admin/usersBulk/adapters', () => ({
  usersBulkResolveDeps: {},
  usersBulkPreviewDeps: {},
}));

const mockResolve = vi.fn();
const mockPreview = vi.fn();
vi.mock('@bike4mind/server-utils/admin/usersBulk/resolve', () => ({
  resolveAdminUsersBulk: (...a: unknown[]) => mockResolve(...a),
  previewAdminUsersBulk: (...a: unknown[]) => mockPreview(...a),
}));

const mockAudit = vi.fn();
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  recordAdminActionFromRequest: (...args: unknown[]) => mockAudit(...args),
}));

import handler from '../preview';

const ADMIN = { id: 'a'.repeat(24), isAdmin: true };
const delegate = (...adminPermissions: AdminPermissionId[]) => ({ ...ADMIN, isAdmin: false, adminPermissions });
const BODY = { target: { kind: 'filter', filter: { status: 'active' } }, action: { type: 'suspend' } };

async function call(body: unknown, user: Record<string, unknown> = ADMIN) {
  const { req, res } = createMocks({ method: 'POST' });
  Object.assign(req, { user, body });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return res;
}

describe('POST /api/admin/users/bulk/preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolve.mockResolvedValue({ matched: 0, eligible: [], excluded: { self: 0, admins: 0 }, overCap: false });
    mockPreview.mockResolvedValue({ eligible: 0 });
    mockAudit.mockResolvedValue({});
  });

  describe('provider end-user identifier search', () => {
    const DIGEST = 'cd'.repeat(32);
    const body = (search: string) => ({ ...BODY, target: { kind: 'filter', filter: { search } } });

    it('does not audit a name search or an id-list target', async () => {
      await call(body('ada'));
      await call({ ...BODY, target: { kind: 'ids', userIds: ['a'.repeat(24)] } });
      expect(mockAudit).not.toHaveBeenCalled();
    });

    it('audits a 64-hex filter search against the single matched account', async () => {
      mockResolve.mockResolvedValue({ matched: 1, eligible: [], excluded: { self: 0, admins: 0 }, overCap: false });
      mockPreview.mockResolvedValue({ eligible: 1, sample: [{ id: 'u1', name: 'Ada', email: 'ada@example.com' }] });

      const res = await call(body(DIGEST));

      expect(res._getStatusCode()).toBe(200);
      expect(mockAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'user.provider_id.resolved',
          target: { kind: 'user', id: 'u1', displayName: 'ada@example.com' },
          details: { providerEndUserId: DIGEST, source: 'users_bulk_preview', matched: true, matchedCount: 1 },
        })
      );
    });

    it('fails the request when the audit write fails', async () => {
      mockAudit.mockRejectedValue(new Error('audit down'));
      await expect(call(body(DIGEST))).rejects.toThrow('audit down');
    });
  });

  it('requires JWT admin auth and a per-admin rate limit', () => {
    expect((handler as unknown as { _config: unknown })._config).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
      adminPermissions: { POST: ADMIN_USERS_BULK_ROUTE_PERMISSIONS },
    });
    expect(rateLimitOptions).toContainEqual(expect.objectContaining({ limit: 60, windowMs: 60_000 }));
  });

  it('refuses a delegate holding none of the bulk permissions', async () => {
    await expect(call(BODY, delegate('support:read'))).rejects.toThrow('Missing permission: users:moderate');
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('refuses an action whose own permission the delegate lacks', async () => {
    const body = { ...BODY, action: { type: 'revokeApiKeys' } };

    await expect(call(body, delegate('users:moderate'))).rejects.toThrow('Missing permission: keys:revoke');
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('resolves as a non-full admin for a delegate holding the action permission', async () => {
    const res = await call(BODY, delegate('users:moderate'));

    expect(res._getStatusCode()).toBe(200);
    expect(mockResolve).toHaveBeenCalledWith(BODY.target, [ADMIN.id], {}, expect.any(Date), {
      actorIsFullAdmin: false,
    });
  });

  it('rejects an invalid action', async () => {
    await expect(call({ ...BODY, action: { type: 'delete' } })).rejects.toThrow();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('resolves without the caller (and an impersonating admin) and returns the preview', async () => {
    const res = await call(BODY, { ...ADMIN, impersonatedBy: 'c'.repeat(24) });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ eligible: 0 });
    expect(mockResolve).toHaveBeenCalledWith(BODY.target, [ADMIN.id, 'c'.repeat(24)], {}, expect.any(Date), {
      actorIsFullAdmin: true,
    });
    expect(mockPreview).toHaveBeenCalledWith(expect.anything(), BODY.action, {});
  });
});
