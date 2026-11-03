import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

vi.mock('@server/middlewares/baseApi', async () =>
  (await import('@server/admin/bulkAbuse/__tests__/bulkAbuseRouteMocks')).baseApiMock()
);
vi.mock('@server/middlewares/asyncHandler', async () =>
  (await import('@server/admin/bulkAbuse/__tests__/bulkAbuseRouteMocks')).asyncHandlerMock()
);
// Recorded at import, so a plain array that clearAllMocks does not reset.
const { rateLimitOptions } = vi.hoisted(() => ({ rateLimitOptions: [] as unknown[] }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => (rateLimitOptions.push(options), () => undefined),
}));
vi.mock('@server/admin/usersBulk/adapters', () => ({ usersBulkResolveDeps: {}, usersBulkPreviewDeps: {} }));

const mockResolve = vi.fn();
const mockPreview = vi.fn();
vi.mock('@server/admin/usersBulk/resolve', () => ({
  resolveAdminUsersBulk: (...a: unknown[]) => mockResolve(...a),
  previewAdminUsersBulk: (...a: unknown[]) => mockPreview(...a),
}));

import handler from '../preview';

const ADMIN = { id: 'a'.repeat(24), isAdmin: true };
const BODY = { target: { kind: 'filter', filter: { status: 'active' } }, action: { type: 'suspend' } };

async function call(body: unknown, user: Record<string, unknown> = ADMIN) {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, { user });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return res;
}

describe('POST /api/admin/users/bulk/preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolve.mockResolvedValue({ matched: 0, eligible: [], excluded: { self: 0, admins: 0 }, overCap: false });
    mockPreview.mockResolvedValue({ eligible: 0 });
  });

  it('requires JWT admin auth and a per-admin rate limit', () => {
    expect((handler as unknown as { _config: unknown })._config).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
    });
    expect(rateLimitOptions).toContainEqual(expect.objectContaining({ limit: 60, windowMs: 60_000 }));
  });

  it('refuses a non-admin', async () => {
    await expect(call(BODY, { ...ADMIN, isAdmin: false })).rejects.toThrow('Admin access required');
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('rejects an invalid action', async () => {
    await expect(call({ ...BODY, action: { type: 'delete' } })).rejects.toThrow();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('resolves without the caller (and an impersonating admin) and returns the preview', async () => {
    const res = await call(BODY, { ...ADMIN, impersonatedBy: 'c'.repeat(24) });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ eligible: 0 });
    expect(mockResolve).toHaveBeenCalledWith(BODY.target, [ADMIN.id, 'c'.repeat(24)], {}, expect.any(Date));
    expect(mockPreview).toHaveBeenCalledWith(expect.anything(), BODY.action, {});
  });
});
