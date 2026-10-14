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
  storedObjectArgs: undefined as unknown[] | undefined,
  findFilters: [] as unknown[],
  selectProjections: [] as unknown[],
  unpublishArgs: undefined as unknown[] | undefined,
  updateManyArgs: undefined as unknown[] | undefined,
  updateManyOptions: undefined as unknown,
  baseApiOptions: undefined as unknown,
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
  return { baseApi: (options: unknown) => ((mockRefs.baseApiOptions = options), chain) };
});

const fabFileDocs = vi.hoisted(() => [
  { filePath: 'a/one.png' },
  { filePath: 'b/two.mp3', sourceMetadata: { generatedCopyKey: 'two.mp3' } },
]);

vi.mock('@bike4mind/database', () => {
  class FabFile {
    static find = (filter: unknown) => {
      mockRefs.findFilters.push(filter);
      return {
        select: (projection: unknown) => {
          mockRefs.selectProjections.push(projection);
          return {
            session: async () => fabFileDocs,
            lean: async () => fabFileDocs.map((doc, i) => ({ ...doc, _id: `file-${i}` })),
          };
        },
      };
    };
    // Mirrors the real soft-delete plugin static: it settles to a plain Promise, not a
    // chainable Query, so calling `.session()` on the return value throws in production
    // (see softDeletePlugin in b4m-core/db-core/src/utils/mongo.ts). Session must be
    // passed as an options argument instead.
    static deleteMany = (filter: any, ...rest: unknown[]) => {
      mockRefs.deleteManyArgs = [filter, ...rest];
      // Only the owner-scoped arm of the CASL filter should ever reach here - a wrong/widened
      // filter (e.g. {}, or the bare CASL scope, which also matches files shared IN) resolves 0,
      // which the test below can tell apart from the real filter.
      const isOwnedScope = Array.isArray(filter?.$and) && filter.$and[0] === accessibleFilter;
      return Promise.resolve({ deletedCount: isOwnedScope ? fabFileDocs.length : 0 });
    };
    static updateMany = (filter: unknown, update: unknown, ...rest: unknown[]) => {
      mockRefs.updateManyArgs = [filter, update, ...rest];
      return {
        setOptions: (options: unknown) => {
          mockRefs.updateManyOptions = options;
          return Promise.resolve({ modifiedCount: 1 });
        },
      };
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
    deleteStoredObjects: (...args: unknown[]) => {
      mockRefs.storedObjectArgs = args;
      return Promise.resolve();
    },
  },
}));

vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ bucket: 'files', getSignedUrl: vi.fn(), delete: vi.fn() }),
  getGeneratedImageStorage: () => ({ bucket: 'generated', delete: vi.fn() }),
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/services/publish/purgeUserPublishedArtifacts', () => ({
  unpublishUserArtifactsBySource: (...args: unknown[]) => {
    mockRefs.unpublishArgs = args;
    return Promise.resolve({ artifacts: [], annotations: 0, reports: 0, viewAudits: 0 });
  },
}));
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

describe('GET /api/files - scope gate', () => {
  it('requires files:read or files:write at the baseApi route gate', () => {
    expect(mockRefs.baseApiOptions).toEqual({ requiredScopes: ['files:read', 'files:write'] });
  });

  it('rejects a files:write-only key with a 403 before touching search', async () => {
    mockRefs.searchArgs = undefined;
    const { req, res } = invokeGet();
    (req as any).apiKeyInfo = { keyId: 'k', scopes: ['files:write'] };

    await expect(mockRefs.getHandler!(req, res)).rejects.toThrow(/files:read is required/);

    expect(mockRefs.searchArgs).toBeUndefined();
  });

  it('allows a files:read key through the gate on the happy path', async () => {
    const { req, res } = invokeGet();
    (req as any).apiKeyInfo = { keyId: 'k', scopes: ['files:read'] };

    await mockRefs.getHandler!(req, res);

    expect(mockRefs.searchArgs?.[0]).toBe('user-1');
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
    mockRefs.storedObjectArgs = undefined;
    mockRefs.findFilters = [];
    mockRefs.selectProjections = [];
    mockRefs.unpublishArgs = undefined;
    mockRefs.updateManyArgs = undefined;
    mockRefs.updateManyOptions = undefined;
  });

  // Regression for the TypeError that fired in production: FabFile.deleteMany() comes from the
  // soft-delete plugin, which resolves to a plain Promise rather than a Query, so chaining
  // `.session(session)` onto it throws `.session is not a function`. Passing session as an
  // options object is the only shape that both works and keeps the delete inside the transaction.
  it('passes the session as an option to deleteMany instead of chaining it', async () => {
    expect(mockRefs.deleteHandler).toBeTypeOf('function');
    const { req, res } = invokeDelete();

    await mockRefs.deleteHandler!(req, res);

    // Both the scoped filter and the session must reach deleteMany unchanged - checking only the
    // session option would let a widened/wrong filter (e.g. {}, matching every user's files) pass
    // unnoticed. The CASL scope is now one arm of an $and whose other arm pins ownership, so a
    // delete grant on a file shared IN can no longer destroy the owner's document.
    const deleteFilter = mockRefs.deleteManyArgs?.[0] as { $and: unknown[] };
    expect(deleteFilter.$and[0]).toBe(accessibleFilter);
    expect(deleteFilter.$and[1]).toEqual({ userId: 'user-1' });
    expect(mockRefs.deleteManyArgs?.[1]).toEqual({ session: { __fakeSession: true } });
  });

  it("takes down the caller's pages published from the files it owns", async () => {
    const { req, res } = invokeDelete();

    await mockRefs.deleteHandler!(req, res);

    // Only the owner-scoped arm feeds the takedown: a file shared IN keeps its owner's pages.
    const firstFind = mockRefs.findFilters[0] as { $and: unknown[] };
    expect(firstFind.$and[0]).toBe(accessibleFilter);
    expect(firstFind.$and[1]).toEqual({ userId: 'user-1' });
    expect(mockRefs.unpublishArgs?.[0]).toBe('user-1');
    expect(mockRefs.unpublishArgs?.[1]).toEqual({ kind: 'fabfile', fabFileIds: ['file-0', 'file-1'] });
  });

  it('unshares files owned by others rather than deleting them', async () => {
    const { req, res } = invokeDelete();

    await mockRefs.deleteHandler!(req, res);

    const [updateFilter, update] = (mockRefs.updateManyArgs ?? []) as [{ $and: unknown[] }, unknown];
    expect(updateFilter.$and[0]).toBe(accessibleFilter);
    expect(updateFilter.$and[1]).toEqual({ userId: { $ne: 'user-1' } });
    expect(update).toEqual({ $pull: { users: { userId: 'user-1' } } });
    // A soft-deleted share must lose the grant too, or restoring it hands the access back.
    expect(mockRefs.updateManyOptions).toEqual({ includeDeleted: true });
  });

  it("removes every owned file's stored objects, generated-bucket copies included", async () => {
    const { req, res } = invokeDelete();

    await mockRefs.deleteHandler!(req, res);

    const [files, buckets] = mockRefs.storedObjectArgs as [unknown, { files: unknown; generated: unknown }];
    expect(files).toBe(fabFileDocs);
    expect(buckets.files).toMatchObject({ bucket: 'files' });
    expect(buckets.generated).toMatchObject({ storage: { bucket: 'generated' } });
  });

  // The fork guard compares a reply's notebook with the file's own; a projection without sessionId makes the
  // file's own notebook look like another's, so every notebook-linked chat copy would be kept.
  it('selects the notebook link the generated-copy fork guard needs', async () => {
    const { req, res } = invokeDelete();

    await mockRefs.deleteHandler!(req, res);

    const storedObjectProjection = String(mockRefs.selectProjections.at(-1)).split(' ');
    expect(storedObjectProjection).toEqual(
      expect.arrayContaining([
        'filePath',
        'moderationStatus',
        'sourceMetadata.generatedCopyKey',
        'sourceMetadata.sessionId',
      ])
    );
  });

  it('completes the request without throwing', async () => {
    const { req, res } = invokeDelete();

    await mockRefs.deleteHandler!(req, res);

    expect(res._getStatusCode()).toBe(204);
  });

  it('rejects a files:read-only key with a 403 before touching deleteMany', async () => {
    const { req, res } = invokeDelete();
    (req as any).apiKeyInfo = { keyId: 'k', scopes: ['files:read'] };

    await expect(mockRefs.deleteHandler!(req, res)).rejects.toThrow(/files:write is required/);

    expect(mockRefs.deleteManyArgs).toBeUndefined();
  });
});
