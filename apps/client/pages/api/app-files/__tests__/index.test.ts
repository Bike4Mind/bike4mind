import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET /api/app-files is a cross-user file inventory with owner PII (populated
 * name/email) and no per-user scoping; its only consumer is the admin Files tab,
 * so it must be admin-only. Prove a non-admin is rejected before any query.
 */

// `any` below is deliberate test-mock plumbing: typing the full next-connect /
// node-mocks-http chain adds no coverage value (matches the repo's handler-test convention).
const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const find = vi.hoisted(() =>
  vi.fn(() => ({ populate: () => ({ sort: () => ({ exec: () => Promise.resolve([]) }) }) }))
);
vi.mock('@bike4mind/database/content', () => ({ AppFile: { find } }));

import '@pages/api/app-files/index';

function mocks(user: unknown) {
  const { req, res } = createMocks({ method: 'GET', query: {} });
  (req as any).user = user;
  return { req, res };
}

describe('GET /api/app-files - admin gate', () => {
  beforeEach(() => find.mockClear());

  it('rejects a non-admin before querying', async () => {
    const { req, res } = mocks({ id: 'u1', isAdmin: false });
    await expect(mockRefs.getHandler!(req, res)).rejects.toThrow(/admin/i);
    expect(find).not.toHaveBeenCalled();
  });

  it('lists files for an admin', async () => {
    const { req, res } = mocks({ id: 'admin1', isAdmin: true });
    await mockRefs.getHandler!(req, res);
    expect(find).toHaveBeenCalledTimes(1);
    expect(res._getStatusCode()).toBe(200);
  });
});
