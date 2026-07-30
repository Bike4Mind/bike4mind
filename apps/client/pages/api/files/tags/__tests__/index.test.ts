import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { getDataLakeTags } from '@bike4mind/common';

/**
 * Route-layer coverage for GET /api/files/tags. The service decides how to fold counts into tags;
 * the route decides what scope to hand it, and getting that wrong (owner-only counts, or raw user
 * tags forwarded as data-lake tags) makes the sidebar badge disagree with the tag tree. Only a
 * route-level test can catch that, so this asserts the wiring matches the sibling counts.ts.
 */

// Collapse the baseApi().post().get() chain and capture the GET handler.
const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  listArgs: undefined as unknown[] | undefined,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    post: () => chain,
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@bike4mind/database', () => ({
  fileTagRepository: { __repo: 'fileTags' },
  fabFileRepository: { __repo: 'fabFiles' },
}));

vi.mock('@bike4mind/services', () => ({
  tagService: {
    create: vi.fn(),
    listFileTags: (...args: unknown[]) => {
      mockRefs.listArgs = args;
      return Promise.resolve([]);
    },
  },
}));

// Import after mocks are registered so the chain capture runs.
import '@pages/api/files/tags/index';

// `Opti` is the requiredUserTag of the only lake in the DATA_LAKES registry, so getDataLakeTags
// resolves to a non-empty set here. Without it every assertion below passes vacuously on [].
const USER_TAGS = ['Opti', 'some-arbitrary-tag'];
const GRANTED_LAKE_TAG = 'datalake:opti-knowledge';

function invokeGet(user: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'GET', url: '/api/files/tags' });
  (req as any).user = user;
  return { req, res };
}

describe('GET /api/files/tags', () => {
  beforeEach(() => {
    mockRefs.listArgs = undefined;
  });

  it('scopes counts to the caller groups and their accessible data lakes', async () => {
    expect(mockRefs.getHandler).toBeTypeOf('function');
    const { req, res } = invokeGet({ id: 'user-1', groups: ['group-a'], tags: USER_TAGS });

    await mockRefs.getHandler!(req, res);

    expect(mockRefs.listArgs?.[0]).toBe('user-1');
    expect(mockRefs.listArgs?.[1]).toEqual({
      userGroups: ['group-a'],
      dataLakeTags: getDataLakeTags(USER_TAGS),
    });
  });

  it('derives data-lake tags rather than forwarding the raw user tags', async () => {
    const { req, res } = invokeGet({ id: 'user-1', groups: [], tags: USER_TAGS });

    await mockRefs.getHandler!(req, res);

    const { dataLakeTags } = mockRefs.listArgs?.[1] as { dataLakeTags: string[] };
    expect(dataLakeTags).toContain(GRANTED_LAKE_TAG);
    expect(dataLakeTags).not.toContain('some-arbitrary-tag');
    expect(dataLakeTags).not.toContain('Opti');
  });

  // dataLakeTags is an ownership-bypass arm in buildOwnershipConditions, so a caller who holds no
  // lake-granting tag must widen the count scope by nothing at all.
  it('grants no lake scope to a caller without the gating tag', async () => {
    const { req, res } = invokeGet({ id: 'user-1', groups: [], tags: ['some-arbitrary-tag'] });

    await mockRefs.getHandler!(req, res);

    expect((mockRefs.listArgs?.[1] as { dataLakeTags: string[] }).dataLakeTags).toEqual([]);
  });

  it('passes both repositories the service needs to recompute counts', async () => {
    const { req, res } = invokeGet({ id: 'user-1', groups: ['group-a'], tags: USER_TAGS });

    await mockRefs.getHandler!(req, res);

    expect(mockRefs.listArgs?.[2]).toEqual({
      db: { fileTags: { __repo: 'fileTags' }, fabFiles: { __repo: 'fabFiles' } },
    });
  });

  it('defaults missing groups and tags to empty rather than passing undefined', async () => {
    const { req, res } = invokeGet({ id: 'user-1' });

    await mockRefs.getHandler!(req, res);

    expect(mockRefs.listArgs?.[1]).toEqual({ userGroups: [], dataLakeTags: getDataLakeTags([]) });
  });

  it('rejects an unauthenticated caller before touching the service', async () => {
    const { req, res } = invokeGet({});

    await expect(mockRefs.getHandler!(req, res)).rejects.toThrow();
    expect(mockRefs.listArgs).toBeUndefined();
  });
});
