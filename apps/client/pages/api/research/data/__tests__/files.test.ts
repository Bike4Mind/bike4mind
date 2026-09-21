import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET /api/research/data/files listed EVERY tenant's research files with working signed
 * download URLs: the route ran `researchDataRepository.find({})` behind an authentication-only
 * `baseApi({ auth: true })`. Both queries must now carry the caller's ownership filter.
 */

// Real 24-hex ids, not placeholders: the route casts them through `usableObjectIds` and folds hex
// case before comparing, so a fixture like 'f1' would exercise neither path.
const FILE_ONE = '651f1c0a9b4e2d1f00a10001';
const FILE_TWO = '651f1c0a9b4e2d1f00a10002';

const OMITTED_WARNING = '[research-files] Owner-scoped listing omitted referenced files';
const UNUSABLE_WARNING = '[research-files] skipping ids that cannot address a row by _id';

// `any` below is deliberate test-mock plumbing for the next-connect / node-mocks-http chain,
// matching the repo's handler-test convention.
const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  researchDataFilter: undefined as any,
  fabFileFilter: undefined as any,
  researchDataRows: [] as any[],
  fabFileRows: [] as any[],
  loggerWarn: vi.fn(),
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
      return Promise.resolve(mockRefs.fabFileRows);
    },
  },
}));

import '@pages/api/research/data/files';

function mocks(userId: string) {
  const { req, res } = createMocks({ method: 'GET' });
  (req as any).user = { id: userId };
  (req as any).logger = { warn: mockRefs.loggerWarn };
  return { req, res };
}

describe('GET /api/research/data/files - caller scoping', () => {
  beforeEach(() => {
    mockRefs.researchDataFilter = undefined;
    mockRefs.fabFileFilter = undefined;
    mockRefs.researchDataRows = [{ fabFileId: FILE_ONE }, { fabFileId: FILE_TWO }];
    mockRefs.fabFileRows = [];
    mockRefs.loggerWarn.mockReset();
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
    expect(mockRefs.fabFileFilter).toEqual({ _id: { $in: [FILE_ONE, FILE_TWO] }, userId: 'user-1' });
  });

  it('returns an empty list without touching FabFile when the caller owns nothing', async () => {
    mockRefs.researchDataRows = [];
    const { req, res } = mocks('user-2');
    await mockRefs.getHandler!(req, res);
    expect(mockRefs.fabFileFilter).toBeUndefined();
    expect(res._getJSONData()).toEqual([]);
    expect(mockRefs.loggerWarn).not.toHaveBeenCalled();
  });

  it('does not warn when every referenced file is accessible', async () => {
    mockRefs.fabFileRows = [{ id: FILE_ONE }, { id: FILE_TWO }];
    const { req, res } = mocks('user-1');

    await mockRefs.getHandler!(req, res);

    expect(res._getJSONData()).toEqual([{ id: FILE_ONE }, { id: FILE_TWO }]);
    expect(mockRefs.loggerWarn).not.toHaveBeenCalled();
  });

  it('warns with the count of unique referenced files omitted by owner scoping', async () => {
    mockRefs.researchDataRows = [{ fabFileId: FILE_ONE }, { fabFileId: FILE_TWO }, { fabFileId: FILE_TWO }];
    mockRefs.fabFileRows = [{ id: FILE_ONE }];
    const { req, res } = mocks('user-1');

    await mockRefs.getHandler!(req, res);

    expect(mockRefs.fabFileFilter).toEqual({ _id: { $in: [FILE_ONE, FILE_TWO] }, userId: 'user-1' });
    expect(res._getJSONData()).toEqual([{ id: FILE_ONE }]);
    expect(res._getJSONData()).not.toContainEqual({ id: FILE_TWO });
    expect(mockRefs.loggerWarn).toHaveBeenCalledWith(OMITTED_WARNING, {
      droppedFileCount: 1,
      referencedFileCount: 2,
    });
  });

  it('treats a reference differing only in hex case as resolved', async () => {
    // Mongo casts hex in either case to the same _id, so the file IS returned. Matching the raw
    // stored string against the always-lowercase `id` virtual would report it as omitted.
    mockRefs.researchDataRows = [{ fabFileId: FILE_ONE.toUpperCase() }];
    mockRefs.fabFileRows = [{ id: FILE_ONE }];
    const { req, res } = mocks('user-1');

    await mockRefs.getHandler!(req, res);

    expect(mockRefs.fabFileFilter).toEqual({ _id: { $in: [FILE_ONE] }, userId: 'user-1' });
    expect(mockRefs.loggerWarn).not.toHaveBeenCalledWith(OMITTED_WARNING, expect.anything());
  });

  it('counts a case-variant duplicate as one referenced file', async () => {
    mockRefs.researchDataRows = [
      { fabFileId: FILE_ONE },
      { fabFileId: FILE_ONE.toUpperCase() },
      { fabFileId: FILE_TWO },
    ];
    mockRefs.fabFileRows = [{ id: FILE_ONE }];
    const { req, res } = mocks('user-1');

    await mockRefs.getHandler!(req, res);

    // Two ids address two documents, not three - the duplicate must not inflate the denominator.
    expect(mockRefs.loggerWarn).toHaveBeenCalledWith(OMITTED_WARNING, {
      droppedFileCount: 1,
      referencedFileCount: 2,
    });
  });

  it('drops a legacy non-ObjectId reference instead of rejecting the whole cast', async () => {
    mockRefs.researchDataRows = [{ fabFileId: FILE_ONE }, { fabFileId: 'legacy-uuid-2019' }];
    mockRefs.fabFileRows = [{ id: FILE_ONE }];
    const { req, res } = mocks('user-1');

    await mockRefs.getHandler!(req, res);

    // Passed through, the unusable id would CastError the `$in` and lose FILE_ONE with it.
    expect(mockRefs.fabFileFilter).toEqual({ _id: { $in: [FILE_ONE] }, userId: 'user-1' });
    expect(mockRefs.loggerWarn).toHaveBeenCalledWith(UNUSABLE_WARNING, {
      received: 2,
      usable: 1,
      skipped: ['legacy-uuid-2019'],
    });
    // Reported on its own line: owner scoping dropped nothing here.
    expect(mockRefs.loggerWarn).not.toHaveBeenCalledWith(OMITTED_WARNING, expect.anything());
  });
});
