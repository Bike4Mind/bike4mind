import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Route-layer coverage for GET /api/files. Unlike its sibling ./search.ts this route hands the
 * service the parsed query with no server scope at all, so its default view is owner-only. That is
 * only true as long as no scope reaches the service from here - the value of the test is pinning
 * that a query string cannot acquire one.
 */

// Collapse the baseApi().get().delete() chain and capture the GET handler.
const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  searchArgs: undefined as unknown[] | undefined,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    delete: () => chain,
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@bike4mind/database', () => ({
  FabFile: class FabFile {},
  User: class User {},
  fabFileRepository: { __repo: 'fabFiles' },
  userRepository: { __repo: 'users' },
  projectRepository: { __repo: 'projects' },
  adminSettingsRepository: { __repo: 'adminSettings' },
  withTransaction: vi.fn(),
}));

vi.mock('@bike4mind/services', () => ({
  fabFilesService: {
    search: (...args: unknown[]) => {
      mockRefs.searchArgs = args;
      return Promise.resolve({ data: [], total: 0, hasMore: false });
    },
  },
}));

vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ getSignedUrl: vi.fn(), delete: vi.fn() }) }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@casl/mongoose', () => ({ accessibleBy: () => ({ ofType: () => ({}) }) }));

// Import after mocks are registered so the chain capture runs.
import '@pages/api/files';

function invokeGet(query: Record<string, unknown> = {}) {
  const { req, res } = createMocks({ method: 'GET', url: '/api/files', query: query as any });
  (req as any).user = { id: 'user-1', groups: ['group-a'], tags: ['Opti'] };
  (req as any).ability = { can: () => true };
  (req as any).logger = { error: vi.fn() };
  return { req, res };
}

describe('GET /api/files', () => {
  beforeEach(() => {
    mockRefs.searchArgs = undefined;
  });

  it('passes no server scope, leaving the default view owner-only', async () => {
    expect(mockRefs.getHandler).toBeTypeOf('function');
    const { req, res } = invokeGet();

    await mockRefs.getHandler!(req, res);

    expect(mockRefs.searchArgs?.[0]).toBe('user-1');
    expect(mockRefs.searchArgs?.[3]).toBeUndefined();
  });

  // `datalake:` is the namespace holding every lake's membership meta-tag; honored as a prefix it
  // would match every data-lake file in the database. search() drops these at the zod parse (see
  // fabFileService/search.test.ts); what this route owes is never handing them over as a scope.
  it('does not turn a query-string scope into a server scope', async () => {
    const { req, res } = invokeGet({
      options: {
        includeShared: 'true',
        dataLakeTagPrefixes: ['datalake:'],
        scopedTagPrefixes: ['acme:'],
        userGroups: ['a-group-the-caller-is-not-in'],
      },
    });

    await mockRefs.getHandler!(req, res);

    expect(mockRefs.searchArgs?.[3]).toBeUndefined();
  });

  it('forwards the caller filters and pagination untouched', async () => {
    const { req, res } = invokeGet({ search: 'invoice', filters: { type: 'pdf' }, pagination: { page: '2' } });

    await mockRefs.getHandler!(req, res);

    const params = mockRefs.searchArgs?.[1] as Record<string, any>;
    expect(params.search).toBe('invoice');
    expect(params.filters).toEqual({ type: 'pdf' });
    expect(params.pagination).toEqual({ page: '2' });
  });
});
