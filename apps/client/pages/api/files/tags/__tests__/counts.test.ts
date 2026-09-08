import { describe, it, expect, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { getDataLakeTags } from '@bike4mind/common';

/**
 * Route-layer coverage for GET /api/files/tags/counts. This endpoint backs TWO surfaces that must
 * NOT share one scope: the Tags view (tag tree + its click-through file list, which counts
 * personal shares) needs `tagCounts` unnarrowed, while WORKSPACES (Home/Overview) needs
 * `workspaceTagCounts`/`namespaceCounts` narrowed - excluding a file merely shared with the caller
 * - or a tag they already cleared their own copy of stays orphaned by someone else's share. The
 * WORKSPACES pair must share the SAME scope with each other, or a row's existence and its size
 * disagree. Only a route-level test can catch either kind of drift.
 */

const UNNARROWED_RESULT = [{ tag: 'shared-and-owned', count: 3 }];
const NARROWED_RESULT = [{ tag: 'owned-only', count: 1 }];

// Collapse the baseApi().get() chain and capture the GET handler.
const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  tagCallArgs: [] as unknown[][],
  namespaceArgs: undefined as unknown[] | undefined,
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
  fabFileRepository: {
    // Returns a DIFFERENT, distinguishable result depending on the scope's excludePersonalShares,
    // so a test can assert which call landed in which response field without relying on call order.
    countFilesByTagForUser: (...args: unknown[]) => {
      mockRefs.tagCallArgs.push(args);
      const isNarrowed = (args[1] as { excludePersonalShares?: boolean } | undefined)?.excludePersonalShares === true;
      return Promise.resolve(isNarrowed ? NARROWED_RESULT : UNNARROWED_RESULT);
    },
    countUniqueFilesByNamespaceForUser: (...args: unknown[]) => {
      mockRefs.namespaceArgs = args;
      return Promise.resolve([]);
    },
  },
}));

// Import after mocks are registered so the chain capture runs.
import '@pages/api/files/tags/counts';

// `Opti` is the requiredUserTag of the only lake in the DATA_LAKES registry, so getDataLakeTags
// resolves to a non-empty set here. Without it every assertion below passes vacuously on [].
const USER_TAGS = ['Opti', 'some-arbitrary-tag'];

function invokeGet(user: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'GET', url: '/api/files/tags/counts' });
  (req as any).user = user;
  return { req, res };
}

// countFilesByTagForUser is called twice (unnarrowed for tagCounts, narrowed for
// workspaceTagCounts) - find each call by its scope, not by call order.
function splitTagCalls() {
  const narrowed = mockRefs.tagCallArgs.find(
    args => (args[1] as { excludePersonalShares?: boolean } | undefined)?.excludePersonalShares === true
  );
  const unnarrowed = mockRefs.tagCallArgs.find(args => args !== narrowed);
  return { narrowed, unnarrowed };
}

describe('GET /api/files/tags/counts', () => {
  beforeEach(() => {
    mockRefs.tagCallArgs = [];
    mockRefs.namespaceArgs = undefined;
  });

  it('calls countFilesByTagForUser exactly twice - once unnarrowed, once narrowed', async () => {
    expect(mockRefs.getHandler).toBeTypeOf('function');
    const { req, res } = invokeGet({ id: 'user-1', groups: ['group-a'], tags: USER_TAGS });

    await mockRefs.getHandler!(req, res);

    expect(mockRefs.tagCallArgs).toHaveLength(2);
    const baseScope = { userGroups: ['group-a'], dataLakeTags: getDataLakeTags(USER_TAGS) };
    const { narrowed, unnarrowed } = splitTagCalls();
    expect(unnarrowed).toEqual(['user-1', baseScope]);
    expect(narrowed).toEqual(['user-1', { ...baseScope, excludePersonalShares: true }]);
  });

  // The regression a human review caught: GET /api/files/tags (listFileTags) must NOT get the
  // exclusion, so it was moved out of a hardcoded default and into this route's own second call.
  // Asserting on the RESPONSE BODY (not just call args) pins that `tagCounts` - what the Tags view
  // reads - is the unnarrowed result, so it can never silently inherit the WORKSPACES narrowing.
  it('returns the unnarrowed call as tagCounts and the narrowed one as workspaceTagCounts', async () => {
    const { req, res } = invokeGet({ id: 'user-1', groups: [], tags: [] });

    await mockRefs.getHandler!(req, res);

    const body = res._getJSONData();
    expect(body.tagCounts).toEqual(UNNARROWED_RESULT);
    expect(body.workspaceTagCounts).toEqual(NARROWED_RESULT);
  });

  it('narrows the namespace count to the same scope as workspaceTagCounts', async () => {
    const { req, res } = invokeGet({ id: 'user-1', groups: ['group-a'], tags: USER_TAGS });

    await mockRefs.getHandler!(req, res);

    const { narrowed } = splitTagCalls();
    expect(mockRefs.namespaceArgs?.[1]).toEqual(narrowed?.[1]);
  });

  it('derives data-lake tags rather than forwarding the raw user tags', async () => {
    const { req, res } = invokeGet({ id: 'user-1', groups: [], tags: USER_TAGS });

    await mockRefs.getHandler!(req, res);

    for (const args of [...mockRefs.tagCallArgs, mockRefs.namespaceArgs]) {
      const { dataLakeTags } = args?.[1] as { dataLakeTags: string[] };
      expect(dataLakeTags).not.toContain('some-arbitrary-tag');
      expect(dataLakeTags).not.toContain('Opti');
    }
  });

  it('defaults missing groups and tags to empty rather than passing undefined', async () => {
    const { req, res } = invokeGet({ id: 'user-1' });

    await mockRefs.getHandler!(req, res);

    const baseScope = { userGroups: [], dataLakeTags: getDataLakeTags([]) };
    const { narrowed, unnarrowed } = splitTagCalls();
    expect(unnarrowed).toEqual(['user-1', baseScope]);
    expect(narrowed).toEqual(['user-1', { ...baseScope, excludePersonalShares: true }]);
  });

  it('rejects an unauthenticated caller before touching the repository', async () => {
    const { req, res } = invokeGet({});

    await expect(mockRefs.getHandler!(req, res)).rejects.toThrow();
    expect(mockRefs.tagCallArgs).toHaveLength(0);
    expect(mockRefs.namespaceArgs).toBeUndefined();
  });
});
