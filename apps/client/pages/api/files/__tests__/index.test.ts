import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Route-layer coverage for GET /api/files. Unlike its sibling ./search.ts this route hands the
 * service the parsed query with no server scope at all, so its default view is owner-only. That is
 * only true as long as no scope reaches the service from here - the value of the test is pinning
 * that a query string cannot acquire one.
 */

// Collapse the baseApi().get().delete() chain and capture both handlers.
const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  deleteHandler: null as null | ((req: any, res: any) => unknown),
  searchArgs: undefined as unknown[] | undefined,
  deleteManyArgs: undefined as unknown[] | undefined,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
    delete: (fn: any) => {
      mockRefs.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const fabFileDocs = vi.hoisted(() => [{ filePath: 'a/one.png' }, { filePath: 'b/two.png' }]);

vi.mock('@bike4mind/database', () => {
  class FabFile {
    static find = () => ({ select: () => ({ session: async () => fabFileDocs }) });
    // Mirrors the real soft-delete plugin static: it settles to a plain Promise, not a
    // chainable Query, so calling `.session()` on the return value throws in production
    // (see softDeletePlugin in b4m-core/db-core/src/utils/mongo.ts). Session must be
    // passed as an options argument instead.
    static deleteMany = (filter: unknown, ...rest: unknown[]) => {
      mockRefs.deleteManyArgs = [filter, ...rest];
      // Only the CASL-scoped accessible filter should ever reach here - a wrong/widened filter
      // (e.g. {}) resolves 0, which the test below can tell apart from the real filter.
      const deletedCount = filter === accessibleFilter ? fabFileDocs.length : 0;
      return Promise.resolve({ deletedCount });
    };
  }
  class User {
    static findById = () => ({
      session: async () => ({ save: vi.fn().mockResolvedValue(undefined), currentStorageSize: 0 }),
    });
  }
  return {
    FabFile,
    User,
    fabFileRepository: { __repo: 'fabFiles' },
    userRepository: { __repo: 'users' },
    projectRepository: { __repo: 'projects' },
    adminSettingsRepository: { __repo: 'adminSettings' },
    withTransaction: vi.fn((fn: (session: unknown) => unknown) => fn({ __fakeSession: true })),
  };
});

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
const accessibleFilter = vi.hoisted(() => ({ __accessibleFilter: true }));
vi.mock('@casl/mongoose', () => ({ accessibleBy: () => ({ ofType: () => accessibleFilter }) }));

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

function invokeDelete() {
  const { req, res } = createMocks({ method: 'DELETE', url: '/api/files' });
  (req as any).user = { id: 'user-1' };
  (req as any).ability = { can: () => true };
  (req as any).logger = { error: vi.fn() };
  return { req, res };
}

describe('DELETE /api/files', () => {
  beforeEach(() => {
    mockRefs.deleteManyArgs = undefined;
  });

  // Regression for the TypeError that fired in production: FabFile.deleteMany() comes from the
  // soft-delete plugin, which resolves to a plain Promise rather than a Query, so chaining
  // `.session(session)` onto it throws `.session is not a function`. Passing session as an
  // options object is the only shape that both works and keeps the delete inside the transaction.
  it('passes the session as an option to deleteMany instead of chaining it', async () => {
    expect(mockRefs.deleteHandler).toBeTypeOf('function');
    const { req, res } = invokeDelete();

    await mockRefs.deleteHandler!(req, res);

    // Both the CASL-scoped filter and the session must reach deleteMany unchanged - checking only
    // the session option would let a widened/wrong filter (e.g. {}, matching every user's files)
    // pass unnoticed.
    expect(mockRefs.deleteManyArgs?.[0]).toBe(accessibleFilter);
    expect(mockRefs.deleteManyArgs?.[1]).toEqual({ session: { __fakeSession: true } });
  });

  it('completes the request without throwing', async () => {
    const { req, res } = invokeDelete();

    await mockRefs.deleteHandler!(req, res);

    expect(res._getStatusCode()).toBe(204);
  });
});
