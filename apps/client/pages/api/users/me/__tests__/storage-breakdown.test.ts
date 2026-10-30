import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => unknown;

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | Handler,
  baseApiOptions: undefined as unknown,
  rateLimitOptions: undefined as unknown,
  getUserStorageBreakdown: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: { use: () => unknown; get: (fn: Handler) => unknown } = {
    use: () => chain,
    get: (fn: Handler) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return {
    baseApi: (options: unknown) => {
      mockRefs.baseApiOptions = options;
      return chain;
    },
  };
});
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => {
    mockRefs.rateLimitOptions = options;
    return vi.fn();
  },
}));
vi.mock('@bike4mind/database', () => ({
  userRepository: { name: 'users' },
  fabFileRepository: { name: 'fabFiles' },
  dataLakeRepository: { name: 'dataLakes' },
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({
  toAccessContext: async (req: { user: { id: string } }) => ({ userId: req.user.id, isAdmin: false }),
}));
vi.mock('@bike4mind/services', () => ({
  userService: { getUserStorageBreakdown: mockRefs.getUserStorageBreakdown },
}));

import { STORAGE_BREAKDOWN_MAX_TIME_MS } from '@pages/api/users/me/storage-breakdown';

describe('GET /api/users/me/storage-breakdown', () => {
  beforeEach(() => {
    mockRefs.getUserStorageBreakdown.mockReset();
  });

  it('is first-party only and rate limited', () => {
    expect(mockRefs.baseApiOptions).toEqual({ auth: 'jwtOnly' });
    expect(mockRefs.rateLimitOptions).toMatchObject({ bucket: 'storage-breakdown' });
  });

  it("returns the caller's own breakdown with a bounded aggregate, ignoring a userId query", async () => {
    const breakdown = { totalBytes: 10, accountedBytes: 10, unaccountedBytes: 0, buckets: [] };
    mockRefs.getUserStorageBreakdown.mockResolvedValue(breakdown);
    const { req, res } = createMocks({ method: 'GET', query: { userId: 'someone-else' } });
    Object.assign(req, { user: { id: 'user-1' } });

    await mockRefs.getHandler!(req, res);

    expect(mockRefs.getUserStorageBreakdown).toHaveBeenCalledWith(
      { userId: 'user-1', isAdmin: false },
      { db: { users: { name: 'users' }, fabFiles: { name: 'fabFiles' }, dataLakes: { name: 'dataLakes' } } },
      { maxTimeMS: STORAGE_BREAKDOWN_MAX_TIME_MS }
    );
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual(breakdown);
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });
});
