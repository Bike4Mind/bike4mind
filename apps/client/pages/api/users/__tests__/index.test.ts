import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET /api/users publicView is the invite/member-picker directory search. It
 * bypasses CASL by design, so it must not become a mass-enumeration vector for
 * non-admins: downloadAll (unbounded export) is admin-only, and the publicView
 * page size is capped.
 */

// `any` below is deliberate test-mock plumbing: typing the full next-connect /
// node-mocks-http chain adds no coverage value (matches the repo's handler-test convention).
const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  facet: undefined as any,
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

vi.mock('@bike4mind/database', () => ({
  User: {
    find: () => ({ getQuery: () => ({}) }),
    populate: vi.fn().mockResolvedValue(undefined),
    hydrate: (u: any) => u,
    aggregate: vi.fn().mockResolvedValue([]),
  },
  Project: { findById: vi.fn() },
  executeFacetCompatible: (_m: any, _p: any, facet: any) => {
    mockRefs.facet = facet;
    return Promise.resolve([{ totalCount: [{ count: 0 }], paginatedResults: [] }]);
  },
  convertPipelineForDocumentDB: (p: any) => p,
  mongoose: { Types: { ObjectId: class {} } },
}));
vi.mock('@casl/mongoose', () => ({ accessibleBy: () => ({ ofType: () => ({}) }) }));
vi.mock('@bike4mind/utils/escapeRegex', () => ({ escapeRegex: (s: string) => s }));

import '@pages/api/users/index';

function mocks(user: unknown, query: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'GET', query });
  (req as any).user = user;
  return { req, res };
}

describe('GET /api/users - publicView enumeration guards', () => {
  beforeEach(() => {
    mockRefs.facet = undefined;
  });

  it('rejects downloadAll for a non-admin with 403', async () => {
    const { req, res } = mocks({ id: 'u1', isAdmin: false }, { publicView: 'true', downloadAll: 'true' });
    await mockRefs.getHandler!(req, res);
    expect(res._getStatusCode()).toBe(403);
    // Never reached the aggregation.
    expect(mockRefs.facet).toBeUndefined();
  });

  it('allows downloadAll for an admin', async () => {
    const { req, res } = mocks({ id: 'admin1', isAdmin: true }, { downloadAll: 'true' });
    await mockRefs.getHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
  });

  it('caps the publicView page size for a non-admin (limit 1000 -> 50)', async () => {
    const { req, res } = mocks({ id: 'u1', isAdmin: false }, { publicView: 'true', limit: '1000' });
    await mockRefs.getHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    const limitStage = mockRefs.facet.paginatedResults.find((s: any) => '$limit' in s);
    expect(limitStage.$limit).toBe(50);
  });

  it('does not cap the page size for an admin', async () => {
    const { req, res } = mocks({ id: 'admin1', isAdmin: true }, { publicView: 'true', limit: '1000' });
    await mockRefs.getHandler!(req, res);
    const limitStage = mockRefs.facet.paginatedResults.find((s: any) => '$limit' in s);
    expect(limitStage.$limit).toBe(1000);
  });
});
