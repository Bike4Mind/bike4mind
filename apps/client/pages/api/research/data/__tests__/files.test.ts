import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET /api/research/data/files listed EVERY tenant's research files with working signed
 * download URLs: the route ran `researchDataRepository.find({})` behind an authentication-only
 * `baseApi({ auth: true })`. Both queries must now carry the caller's ownership filter.
 */

// `any` below is deliberate test-mock plumbing for the next-connect / node-mocks-http chain,
// matching the repo's handler-test convention.
const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  researchDataFilter: undefined as any,
  fabFileFilter: undefined as any,
  researchDataRows: [] as any[],
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
  researchDataRepository: {
    find: (filter: any) => {
      mockRefs.researchDataFilter = filter;
      return Promise.resolve(mockRefs.researchDataRows);
    },
  },
  FabFile: {
    find: (filter: any) => {
      mockRefs.fabFileFilter = filter;
      return Promise.resolve([]);
    },
  },
}));

import '@pages/api/research/data/files';

function mocks(userId: string) {
  const { req, res } = createMocks({ method: 'GET' });
  (req as any).user = { id: userId };
  return { req, res };
}

describe('GET /api/research/data/files - caller scoping', () => {
  beforeEach(() => {
    mockRefs.researchDataFilter = undefined;
    mockRefs.fabFileFilter = undefined;
    mockRefs.researchDataRows = [{ fabFileId: 'f1' }, { fabFileId: 'f2' }];
  });

  it('scopes the ResearchData query to the caller', async () => {
    const { req, res } = mocks('user-1');
    await mockRefs.getHandler!(req, res);
    expect(mockRefs.researchDataFilter).toEqual({ userId: 'user-1' });
  });

  it('scopes the FabFile query to the caller as well as the id list', async () => {
    // ResearchData.userId is optional, so a legacy row without one must not widen the
    // FabFile lookup into another tenant's files. The id list alone is not the guard.
    const { req, res } = mocks('user-1');
    await mockRefs.getHandler!(req, res);
    expect(mockRefs.fabFileFilter).toEqual({ _id: { $in: ['f1', 'f2'] }, userId: 'user-1' });
  });

  it('returns an empty list without touching FabFile when the caller owns nothing', async () => {
    mockRefs.researchDataRows = [];
    const { req, res } = mocks('user-2');
    await mockRefs.getHandler!(req, res);
    expect(mockRefs.fabFileFilter).toBeUndefined();
    expect(res._getJSONData()).toEqual([]);
  });
});
