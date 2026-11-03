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
vi.mock('@server/admin/usersBulk/adapters', () => ({ usersBulkUndoDeps: () => ({ deps: true }) }));
const mockUndo = vi.fn();
vi.mock('@server/admin/usersBulk/undo', () => ({ undoAdminUsersBulk: (...a: unknown[]) => mockUndo(...a) }));

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
    });
    expect(rateLimitOptions).toContainEqual(expect.objectContaining({ limit: 10, windowMs: 60_000 }));
  });

  it('refuses a non-admin', async () => {
    await expect(call({ batchId: BATCH_ID }, { ...ADMIN, isAdmin: false })).rejects.toThrow('Admin access required');
    expect(mockUndo).not.toHaveBeenCalled();
  });

  it('rejects a malformed batch id', async () => {
    await expect(call({ batchId: 'nope' })).rejects.toThrow();
    expect(mockUndo).not.toHaveBeenCalled();
  });

  it('undoes as the calling admin', async () => {
    const res = await call({ batchId: BATCH_ID });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual(UNDO_RESULT);
    expect(mockUndo).toHaveBeenCalledWith(BATCH_ID, ADMIN.id, { deps: true });
  });
});
