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
  pipeline: undefined as any,
  findAccessibleById: null as any,
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
  projectRepository: { shareable: { findAccessibleById: (...args: any[]) => mockRefs.findAccessibleById(...args) } },
  executeFacetCompatible: (_m: any, pipeline: any, facet: any) => {
    mockRefs.facet = facet;
    mockRefs.pipeline = pipeline;
    return Promise.resolve([{ totalCount: [{ count: 0 }], paginatedResults: [] }]);
  },
  convertPipelineForDocumentDB: (p: any) => p,
  mongoose: { Types: { ObjectId: class {} } },
}));
vi.mock('@casl/mongoose', () => ({ accessibleBy: () => ({ ofType: () => ({}) }) }));
vi.mock('@bike4mind/utils/escapeRegex', () => ({ escapeRegex: (s: string) => s }));

import '@pages/api/users/index';

// Any 24-hex string: the route now validates projectId shape before using it.
const PROJECT_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

function mocks(user: unknown, query: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'GET', query });
  (req as any).user = user;
  return { req, res };
}

describe('GET /api/users - publicView enumeration guards', () => {
  beforeEach(() => {
    mockRefs.facet = undefined;
    mockRefs.pipeline = undefined;
    mockRefs.findAccessibleById = vi.fn().mockResolvedValue(null);
  });

  it('rejects downloadAll for a non-admin with 403', async () => {
    const { req, res } = mocks(
      { id: 'u1', isAdmin: false },
      { publicView: 'true', downloadAll: 'true', search: 'abc' }
    );
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
    const { req, res } = mocks({ id: 'u1', isAdmin: false }, { publicView: 'true', limit: '1000', search: 'abc' });
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

  it('returns 400 when non-admin publicView has no search term', async () => {
    const { req, res } = mocks({ id: 'u1', isAdmin: false }, { publicView: 'true' });
    await mockRefs.getHandler!(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(mockRefs.facet).toBeUndefined();
  });

  it('returns 400 when non-admin publicView has a 2-char search term', async () => {
    const { req, res } = mocks({ id: 'u1', isAdmin: false }, { publicView: 'true', search: 'ab' });
    await mockRefs.getHandler!(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(mockRefs.facet).toBeUndefined();
  });

  it('returns 200 when non-admin publicView has a 3-char search term', async () => {
    const { req, res } = mocks({ id: 'u1', isAdmin: false }, { publicView: 'true', search: 'abc' });
    await mockRefs.getHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
  });

  it('allows non-admin publicView with no search when projectId is provided and accessible', async () => {
    // projectId-scoped requests (e.g. project member list) are not a full-directory
    // enumeration path, so they are exempt from the 3-char search minimum -- but only
    // once the caller is shown to hold access to that project.
    mockRefs.findAccessibleById = vi.fn().mockResolvedValue({ users: [] });
    const { req, res } = mocks({ id: 'u1', isAdmin: false }, { publicView: 'true', projectId: PROJECT_ID });
    await mockRefs.getHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockRefs.findAccessibleById).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), PROJECT_ID);
  });

  it('404s a projectId the caller has no access to, without running the query', async () => {
    // The search-minimum exemption made this the cheapest directory walk on the route:
    // any authenticated caller could name an arbitrary project and read back its roster.
    mockRefs.findAccessibleById = vi.fn().mockResolvedValue(null);
    const { req, res } = mocks({ id: 'u1', isAdmin: false }, { publicView: 'true', projectId: PROJECT_ID });
    await mockRefs.getHandler!(req, res);
    expect(res._getStatusCode()).toBe(404);
    expect(mockRefs.facet).toBeUndefined();
  });

  it('rejects a malformed projectId as a 400 rather than a 500', async () => {
    const { req, res } = mocks({ id: 'u1', isAdmin: false }, { publicView: 'true', projectId: 'not-an-objectid' });
    await mockRefs.getHandler!(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(mockRefs.facet).toBeUndefined();
  });
});

describe('GET /api/users - publicView projection coupling', () => {
  beforeEach(() => {
    mockRefs.facet = undefined;
    mockRefs.pipeline = undefined;
    mockRefs.findAccessibleById = vi.fn().mockResolvedValue(null);
  });

  const sortStage = () => mockRefs.pipeline?.find((st: any) => '$sort' in st)?.$sort;
  const matchStage = () => mockRefs.pipeline?.find((st: any) => '$match' in st)?.$match;

  it('ignores a sortField the public projection does not return', async () => {
    // $sort runs before $project, so ranking on isAdmin ordered the directory by
    // admin-ness even though the field never appears in the response.
    const { req, res } = mocks(
      { id: 'u1', isAdmin: false },
      { publicView: 'true', search: 'abc', sortField: 'isAdmin' }
    );
    await mockRefs.getHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(sortStage()).not.toHaveProperty('isAdmin');
    // Falls back to the public default field, username - ascending by default so a bare
    // fallback reads A-Z rather than reverse-alphabetical.
    expect(sortStage()).toEqual({ username: 1 });
  });

  it('honours an explicit sortOrder even on the fallback field', async () => {
    const { req, res } = mocks(
      { id: 'u1', isAdmin: false },
      { publicView: 'true', search: 'abc', sortField: 'isAdmin', sortOrder: 'desc' }
    );
    await mockRefs.getHandler!(req, res);
    expect(sortStage()).toEqual({ username: -1 });
  });

  it('honours a sortField the public projection does return', async () => {
    const { req, res } = mocks({ id: 'u1', isAdmin: false }, { publicView: 'true', search: 'abc', sortField: 'name' });
    await mockRefs.getHandler!(req, res);
    expect(sortStage()).toEqual({ name: -1 });
  });

  it('honours an admin sortField the admin projection returns', async () => {
    const { req, res } = mocks({ id: 'a1', isAdmin: true }, { sortField: 'currentCredits' });
    await mockRefs.getHandler!(req, res);
    expect(sortStage()).toEqual({ currentCredits: -1 });
  });

  it('drops the tags/Admin filter for a non-admin publicView caller', async () => {
    // tags selects on isAdmin, which publicView does not project: for a non-admin it
    // answered "who are the admins" through the result set.
    const { req, res } = mocks({ id: 'u1', isAdmin: false }, { publicView: 'true', search: 'abc', tags: ['Admin'] });
    await mockRefs.getHandler!(req, res);
    expect(JSON.stringify(matchStage())).not.toContain('isAdmin');
  });

  it('keeps the tags/Admin filter for an admin', async () => {
    const { req, res } = mocks({ id: 'a1', isAdmin: true }, { tags: ['Admin'] });
    await mockRefs.getHandler!(req, res);
    expect(JSON.stringify(matchStage())).toContain('isAdmin');
  });

  it('anchors the publicView search so it cannot walk the directory by domain', async () => {
    // `search=com` used to match every address on the instance through an unanchored
    // substring regex over email.
    const { req, res } = mocks({ id: 'u1', isAdmin: false }, { publicView: 'true', search: 'com' });
    await mockRefs.getHandler!(req, res);
    const emailClause = JSON.stringify(matchStage());
    expect(emailClause).toContain('^com');
  });

  it('leaves the admin search unanchored', async () => {
    const { req, res } = mocks({ id: 'a1', isAdmin: true }, { search: 'com' });
    await mockRefs.getHandler!(req, res);
    const clause = JSON.stringify(matchStage());
    expect(clause).not.toContain('^com');
  });
});
