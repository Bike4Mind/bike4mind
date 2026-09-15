import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { getDataLakeTags } from '@bike4mind/common';

/**
 * Route-layer coverage for GET /api/files/search. This route decides the scope the file list is
 * taken over, and it hands the service an untyped qs.parse result - so TypeScript cannot catch a
 * mis-plumb here in either direction. Getting it wrong one way silently narrows the list to owned
 * files with no error; getting it wrong the other way lets a query string widen the scope, which
 * is a cross-tenant read. Both directions are pinned below.
 */

// Collapse the baseApi().get() chain and capture the GET handler.
const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  searchArgs: undefined as unknown[] | undefined,
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
  FabFile: class FabFile {},
  fabFileRepository: { __repo: 'fabFiles' },
  userRepository: { __repo: 'users' },
  projectRepository: { __repo: 'projects' },
  adminSettingsRepository: { __repo: 'adminSettings' },
}));

vi.mock('@bike4mind/services', () => ({
  fabFilesService: {
    search: (...args: unknown[]) => {
      mockRefs.searchArgs = args;
      return Promise.resolve({ data: [], total: 0, hasMore: false });
    },
  },
}));

vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ getSignedUrl: vi.fn() }) }));

// Import after mocks are registered so the chain capture runs.
import '@pages/api/files/search';

// `Opti` is the requiredUserTag of the only lake in the DATA_LAKES registry, so getDataLakeTags
// resolves to a non-empty set here. Without it every assertion below passes vacuously on [].
const USER_TAGS = ['Opti', 'some-arbitrary-tag'];
const GRANTED_LAKE_TAG = 'datalake:opti-knowledge';

const USER = { id: 'user-1', groups: ['group-a'], tags: USER_TAGS };

function invokeGet(query: Record<string, unknown> = {}, user: Record<string, unknown> = USER) {
  const { req, res } = createMocks({ method: 'GET', url: '/api/files/search', query: query as any });
  (req as any).user = user;
  (req as any).ability = { can: () => true };
  (req as any).logger = { error: vi.fn() };
  return { req, res };
}

const scopeArg = () => mockRefs.searchArgs?.[3] as Record<string, unknown> | undefined;

describe('GET /api/files/search', () => {
  beforeEach(() => {
    mockRefs.searchArgs = undefined;
  });

  it('scopes the default view to the caller groups and their accessible data lakes', async () => {
    expect(mockRefs.getHandler).toBeTypeOf('function');
    const { req, res } = invokeGet();

    await mockRefs.getHandler!(req, res);

    expect(mockRefs.searchArgs?.[0]).toBe('user-1');
    expect(scopeArg()).toEqual({
      includeShared: true,
      userGroups: ['group-a'],
      dataLakeTags: getDataLakeTags(USER_TAGS),
    });
  });

  // The scope has to arrive, not merely be absent from the params: passing nothing fails closed
  // into an owner-only list, which looks like a working route and shows a wrong number.
  it('actually delivers the scope rather than silently searching owner-only', async () => {
    const { req, res } = invokeGet();

    await mockRefs.getHandler!(req, res);

    expect(scopeArg()?.includeShared).toBe(true);
    expect(scopeArg()?.dataLakeTags).toContain(GRANTED_LAKE_TAG);
  });

  // `datalake:` is the namespace holding every lake's membership meta-tag, so honoring it as a
  // prefix would match every data-lake file in the database regardless of owner.
  //
  // The route still forwards the raw query as `params` - search() zod-parses those and drops any
  // scope key, which is asserted in fabFileService/search.test.ts. What this layer owes is that
  // nothing from the query string is copied into the scope argument, which is NOT parsed.
  it('never lifts a query-string scope into the server scope argument', async () => {
    const { req, res } = invokeGet({
      options: {
        dataLakeTagPrefixes: ['datalake:'],
        scopedTagPrefixes: ['acme:'],
        dataLakeTags: ['datalake:someone-else:private'],
        userGroups: ['a-group-the-caller-is-not-in'],
        restrictToDataLake: 'true',
      },
    });

    await mockRefs.getHandler!(req, res);

    const scope = JSON.stringify(scopeArg());
    expect(scope).not.toContain('datalake:someone-else:private');
    expect(scope).not.toContain('acme:');
    expect(scope).not.toContain('a-group-the-caller-is-not-in');
    expect(scopeArg()?.dataLakeTagPrefixes).toBeUndefined();
    expect(scopeArg()?.scopedTagPrefixes).toBeUndefined();
    expect(scopeArg()?.restrictToDataLake).toBeUndefined();
    // The server-derived scope still stands.
    expect(scopeArg()?.dataLakeTags).toEqual(getDataLakeTags(USER_TAGS));
    expect(scopeArg()?.userGroups).toEqual(['group-a']);
  });

  it('derives data-lake tags rather than forwarding the raw user tags', async () => {
    const { req, res } = invokeGet();

    await mockRefs.getHandler!(req, res);

    const dataLakeTags = scopeArg()?.dataLakeTags as string[];
    expect(dataLakeTags).toContain(GRANTED_LAKE_TAG);
    expect(dataLakeTags).not.toContain('some-arbitrary-tag');
    expect(dataLakeTags).not.toContain('Opti');
  });

  // dataLakeTags is an ownership-bypass arm, so a caller holding no lake-granting tag must widen
  // the scope by nothing at all.
  it('grants no lake scope to a caller without the gating tag', async () => {
    const { req, res } = invokeGet({}, { id: 'user-1', groups: [], tags: ['some-arbitrary-tag'] });

    await mockRefs.getHandler!(req, res);

    expect(scopeArg()?.dataLakeTags).toEqual([]);
  });

  it('defaults missing groups and tags to empty rather than passing undefined', async () => {
    const { req, res } = invokeGet({}, { id: 'user-1' });

    await mockRefs.getHandler!(req, res);

    expect(scopeArg()).toEqual({ includeShared: true, userGroups: [], dataLakeTags: getDataLakeTags([]) });
  });

  // The shared and curated views carry their own ownership predicate in buildFabFileSearchQuery,
  // and it is checked before the includeShared arm - widening them would be wrong and pointless.
  //
  // The 'false' and '0' cases are not hypothetical pedantry: the service coerces these fields with
  // z.coerce.boolean(), i.e. Boolean(input), so every one of these strings selects the shared-only
  // branch downstream. The route has to read them the same way or it emits a default-view scope
  // for a request answered from a different branch.
  it.each([
    ['shared', { filters: { shared: 'true' } }],
    ['curated', { filters: { curated: 'true' } }],
    ['shared, spelled false', { filters: { shared: 'false' } }],
    ['curated, spelled 0', { filters: { curated: '0' } }],
    ['shared, sent as an array', { filters: { shared: ['true'] } }],
  ])('injects no scope for the %s view', async (_name, query) => {
    const { req, res } = invokeGet(query);

    await mockRefs.getHandler!(req, res);

    expect(scopeArg()).toBeUndefined();
  });

  it('still scopes the default view when neither flag is present at all', async () => {
    const { req, res } = invokeGet({ filters: { type: 'pdf' } });

    await mockRefs.getHandler!(req, res);

    expect(scopeArg()?.includeShared).toBe(true);
  });

  it('rejects a caller without read permission before touching the service', async () => {
    const { req, res } = invokeGet();
    (req as any).ability = { can: () => false };

    await expect(mockRefs.getHandler!(req, res)).rejects.toThrow();
    expect(mockRefs.searchArgs).toBeUndefined();
  });
});
