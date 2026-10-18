import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ConflictError } from '@bike4mind/common';

const { mockRecalculate, mockFindById } = vi.hoisted(() => ({
  mockRecalculate: vi.fn(),
  mockFindById: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = { use: () => chain, post: (fn: any) => fn };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: any) => fn }));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: (...a: unknown[]) => mockFindById(...a) },
  fabFileRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  userService: { recalculateUserStorage: (...a: unknown[]) => mockRecalculate(...a) },
}));

import errorHandler from '@server/middlewares/errorHandler';
import handler from '../recalculate-storage';

async function call(user: { id: string; isAdmin?: boolean }) {
  const { req, res } = createMocks({ method: 'POST', query: { id: 'target1' } });
  (req as any).user = user;
  await (handler as any)(req, res);
  return res;
}

describe('POST /api/users/:id/recalculate-storage', () => {
  beforeEach(() => {
    mockRecalculate.mockReset().mockResolvedValue({ counter: 999, truth: 1000, drift: -1, repaired: true });
    mockFindById.mockReset().mockResolvedValue({ storageLimit: 5000, currentStorageSize: 42 });
  });

  it('rejects a non-admin without touching the counter', async () => {
    const res = await call({ id: 'u1', isAdmin: false });

    expect(res._getStatusCode()).toBe(403);
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
    (req as any).user = { id: 'admin1', isAdmin: true };
    (req as any).logger = { warn: vi.fn(), error: vi.fn() };

    await (handler as any)(req, res).catch((error: unknown) => errorHandler(error, req, res));

    expect(res._getStatusCode()).toBe(409);
  });
});
