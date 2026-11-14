import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ConflictError } from '@bike4mind/common';

const { mockRecalculate, mockFindById, mockRecordAdminAction } = vi.hoisted(() => ({
  mockRecalculate: vi.fn(),
  mockFindById: vi.fn(),
  mockRecordAdminAction: vi.fn(),
}));

type Handler = (req: { method?: string }, res: unknown, next: () => void) => unknown;
type Invocable = (req: unknown, res: unknown) => unknown;

const mockRefs = vi.hoisted(() => ({ getHandler: null as null | Invocable, postHandler: null as null | Invocable }));

// The chain runs adminApi's real permission guard (and any other use() middleware) ahead of the handler.
vi.mock('@server/middlewares/baseApi', () => {
  const guards: Handler[] = [];
  const gated = (method: string, fn: Invocable) => async (req: { method?: string }, res: unknown) => {
    req.method = method;
    for (const guard of guards) guard(req, res, () => {});
    return fn(req, res);
  };
  const chain = {
    use: (fn: Handler) => {
      guards.push(fn);
      return chain;
    },
    get: (fn: Invocable) => {
      mockRefs.getHandler = gated('GET', fn);
      return chain;
    },
    post: (fn: Invocable) => {
      mockRefs.postHandler = gated('POST', fn);
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: Invocable) => fn }));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: (...a: unknown[]) => mockFindById(...a) },
  fabFileRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  userService: { recalculateUserStorage: (...a: unknown[]) => mockRecalculate(...a) },
}));

vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  recordAdminActionFromRequest: (...a: unknown[]) => mockRecordAdminAction(...a),
}));

import errorHandler from '@server/middlewares/errorHandler';
import '../recalculate-storage';

async function call(user: { id: string; isAdmin?: boolean; adminPermissions?: string[] }) {
  const { req, res } = createMocks({ method: 'POST', query: { id: 'target1' } });
  (req as unknown as { user: unknown }).user = user;
  await mockRefs.postHandler!(req, res);
  return res;
}

describe('POST /api/users/:id/recalculate-storage', () => {
  beforeEach(() => {
    mockRecalculate.mockReset().mockResolvedValue({ counter: 999, truth: 1000, drift: -1, repaired: true });
    mockFindById.mockReset().mockResolvedValue({ storageLimit: 5000, currentStorageSize: 42, email: 't@example.com' });
    mockRecordAdminAction.mockReset().mockResolvedValue(null);
  });

  it('records user.storage.recalculated against the target user with the corrected counter', async () => {
    await call({ id: 'admin1', isAdmin: true });

    expect(mockRecordAdminAction).toHaveBeenCalledTimes(1);
    expect(mockRecordAdminAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.storage.recalculated',
        target: { kind: 'user', id: 'target1', displayName: 't@example.com' },
        changes: [{ field: 'currentStorageSize', before: 999, after: 1000 }],
        details: { drift: -1, repaired: true },
      })
    );
    expect(mockRecordAdminAction.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockRecalculate.mock.invocationCallOrder[0]
    );
  });

  it('records nothing for a non-admin or a failed recalculation', async () => {
    await expect(call({ id: 'u1', isAdmin: false })).rejects.toThrow();
    mockRecalculate.mockRejectedValue(new ConflictError('storage counter kept changing'));
    await expect(call({ id: 'admin1', isAdmin: true })).rejects.toThrow();

    expect(mockRecordAdminAction).not.toHaveBeenCalled();
  });

  it('refuses a signed-in non-admin without touching the counter', async () => {
    await expect(call({ id: 'u1', isAdmin: false })).rejects.toThrow('Missing permission: settings:manage');
    expect(mockRecalculate).not.toHaveBeenCalled();
  });

  it('admits a delegate holding settings:manage', async () => {
    const res = await call({ id: 'u2', isAdmin: false, adminPermissions: ['settings:manage'] });

    expect(res._getStatusCode()).toBe(200);
    expect(mockRecalculate).toHaveBeenCalledTimes(1);
  });

  it('refuses a delegate holding an unrelated permission', async () => {
    await expect(call({ id: 'u3', isAdmin: false, adminPermissions: ['users:moderate'] })).rejects.toThrow(
      'Missing permission: settings:manage'
    );
    expect(mockRecalculate).not.toHaveBeenCalled();
  });

  it('returns the recomputed truth, not a re-read counter a concurrent charge may have moved', async () => {
    const res = await call({ id: 'admin1', isAdmin: true });

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ success: true, currentStorageSize: 1000, storageLimit: 5000 });
    expect(mockRecalculate).toHaveBeenCalledWith({ userId: 'target1' }, expect.anything());
  });

  it('maps a retried-out CAS conflict to a 409 through the error middleware', async () => {
    mockRecalculate.mockRejectedValue(new ConflictError('storage counter kept changing'));

    const { req, res } = createMocks({ method: 'POST', query: { id: 'target1' } });
    const request = req as unknown as { user: unknown; logger: unknown };
    request.user = { id: 'admin1', isAdmin: true };
    request.logger = { warn: vi.fn(), error: vi.fn() };

    await Promise.resolve(mockRefs.postHandler!(req, res)).catch((error: unknown) => errorHandler(error, req, res));

    expect(res._getStatusCode()).toBe(409);
  });
});
