// @vitest-environment node
/**
 * Route tests for GET/POST/DELETE /api/v1/data-lakes/{id}/files/{file_id}. `baseApi` is stubbed;
 * each method's contract prelude and response drift check run for real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import {
  DATA_LAKES,
  BadRequestError,
  DataLakeFileMembershipResponseSchema,
  DataLakeFileResponseSchema,
  NotFoundError,
} from '@bike4mind/common';

const {
  mockAssertLakeAccess,
  mockAssertLakeAccessWithGrants,
  mockCanManageLake,
  mockAddFile,
  mockRemoveFile,
  mockFindFile,
  mockFeatureEnabled,
  mockRateLimitOptions,
  mockMethodNotAllowed,
} = vi.hoisted(() => ({
  mockAssertLakeAccess: vi.fn(),
  mockAssertLakeAccessWithGrants: vi.fn(),
  mockCanManageLake: vi.fn(),
  mockAddFile: vi.fn(),
  mockRemoveFile: vi.fn(),
  mockFindFile: vi.fn(),
  mockFeatureEnabled: { value: true },
  mockRateLimitOptions: vi.fn(),
  mockMethodNotAllowed: vi.fn(),
}));

// Keeps next-connect's registrar shape and runs `.use()` middleware ahead of each handler, so the
// feature-flag gate is exercised alongside the contract prelude.
vi.mock('@server/middlewares/baseApi', () => ({
  methodNotAllowedHandler: (allowedMethods: readonly string[]) => (req: unknown, res: unknown) =>
    mockMethodNotAllowed(allowedMethods, req, res),
  baseApi: () => {
    type Mw = (req: unknown, res: unknown, next: () => void) => unknown;
    const used: Mw[] = [];
    const compose =
      (...handlers: Mw[]) =>
      async (req: unknown, res: unknown) => {
        for (const handler of [...used, ...handlers]) {
          let advanced = false;
          await handler(req, res, () => {
            advanced = true;
          });
          if (!advanced) return;
        }
      };
    const chain: Record<string, unknown> = {};
    chain.use = (mw: Mw) => {
      used.push(mw);
      return chain;
    };
    chain.get = compose;
    chain.post = compose;
    chain.delete = compose;
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({
  requireFeatureEnabled:
    () => (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
      mockFeatureEnabled.value
        ? next()
        : res.status(403).json({ error: 'Feature not available', code: 'FEATURE_DISABLED' }),
}));
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => {
    mockRateLimitOptions(options);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));
vi.mock('@server/utils/userRateTier', () => ({ resolveUserRateLimitPerMin: () => 60 }));
// Two DISTINCT contexts so a test can tell which builder the route actually called: the admin
// context bypasses lake access and must never reach the service on this member-scoped route.
vi.mock('@server/dataLakes/toAccessContext', () => ({
  toAccessContext: async () => ({ userId: 'u1', isAdmin: true, userTags: [], organizationIds: [] }),
  toMemberAccessContext: async () => ({ userId: 'u1', isAdmin: false, userTags: [], organizationIds: [] }),
}));
vi.mock('@server/dataLakes/lakeConfigAuditDb', () => ({ lakeConfigAuditDb: {} }));
vi.mock('@server/dataLakes/lakeMembershipAuditDb', () => ({ lakeMembershipAuditDb: {} }));
vi.mock('@server/dataLakes/lakeConfigAuditPrincipal', () => ({ lakeConfigAuditPrincipal: () => ({ kind: 'user' }) }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  dataLakeAccessGrantRepository: {},
  dataLakeRepository: {},
  fabFileRepository: { findById: mockFindFile },
  lakeMembershipRemovalRepository: {},
  scopedSettingsRepository: {},
}));
// Membership scope resolution, the membership predicate and the ingestion classifier stay real:
// they decide the 404-versus-200 and the status this route reports.
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return {
    ...actual,
    dataLakeService: {
      ...actual.dataLakeService,
      assertLakeAccess: mockAssertLakeAccess,
      assertLakeAccessWithGrants: mockAssertLakeAccessWithGrants,
      canManageLake: mockCanManageLake,
      addFileToDataLake: mockAddFile,
      removeFileFromDataLake: mockRemoveFile,
    },
  };
});

const { default: handler } = await import('@pages/api/v1/data-lakes/[id]/files/[file_id]');
// Captured before any beforeEach clears it: all three routers build their limiter once, at module load.
const rateLimitOptionsAtLoad: unknown[] = mockRateLimitOptions.mock.calls.map(call => call[0]);

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const LAKE = {
  id: '65a000000000000000000001',
  name: 'Handbook',
  slug: 'handbook',
  fileTagPrefix: 'hb:',
  datalakeTag: 'datalake:handbook',
  createdByUserId: 'u1',
  status: 'active',
};
const FILE_ID = '65b000000000000000000001';
const memberFile = (overrides: Record<string, unknown> = {}) => ({
  id: FILE_ID,
  fileName: 'guide.pdf',
  userId: 'u1',
  tags: [{ name: 'datalake:handbook', strength: 1 }],
  chunkCount: 8,
  vectorizedChunkCount: 8,
  error: null,
  ...overrides,
});

async function run(method: 'GET' | 'POST' | 'DELETE' | 'PATCH', fileId: string = FILE_ID, id = 'handbook') {
  const { req, res } = createMocks({ method, query: { id, file_id: fileId } });
  Object.assign(req, { user: { id: 'u1' }, logger });
  await handler(req as never, res as never);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFeatureEnabled.value = true;
  mockAssertLakeAccess.mockResolvedValue(LAKE);
  mockAssertLakeAccessWithGrants.mockResolvedValue({ lake: LAKE, grants: [] });
  mockCanManageLake.mockReturnValue(true);
  mockFindFile.mockResolvedValue(memberFile());
  mockAddFile.mockResolvedValue({ success: true, fileCount: 5, totalSizeBytes: 500 });
  mockRemoveFile.mockResolvedValue({ success: true, fileCount: 4, totalSizeBytes: 400, restoreTokenMinted: true });
});

describe('GET /api/v1/data-lakes/{id}/files/{file_id}', () => {
  it('reports a ready member with its counts', async () => {
    const res = await run('GET');
    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(DataLakeFileResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      lake_id: LAKE.id,
      file_id: FILE_ID,
      file_name: 'guide.pdf',
      ingestion_status: 'ready',
      chunk_count: 8,
      vectorized_chunk_count: 8,
      error: null,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['indexing', { vectorizedChunkCount: 3 }],
    ['paused', { vectorizedChunkCount: 0, chunkStallReason: 'rechunkPaused' }],
    ['failed', { chunkCount: 0, vectorizedChunkCount: 0, error: 'Unsupported file' }],
    ['not_ingested', { chunkCount: 0, vectorizedChunkCount: 0 }],
  ])('reports %s', async (status, overrides) => {
    mockFindFile.mockResolvedValue(memberFile(overrides));
    expect((await run('GET'))._getJSONData().ingestion_status).toBe(status);
  });

  it('matches the membership prefix arm, not just the meta-tag', async () => {
    mockFindFile.mockResolvedValue(memberFile({ tags: [{ name: 'hb:policies', strength: 1 }] }));
    expect((await run('GET'))._getStatusCode()).toBe(200);
  });

  it.each([
    ['a malformed file id', () => undefined, 'not-an-id'],
    ['a missing file', () => mockFindFile.mockResolvedValue(null), FILE_ID],
    ['a deleted file', () => mockFindFile.mockResolvedValue(memberFile({ deletedAt: new Date() })), FILE_ID],
    ['an archived file', () => mockFindFile.mockResolvedValue(memberFile({ archivedAt: new Date() })), FILE_ID],
    [
      'a non-member file',
      () => mockFindFile.mockResolvedValue(memberFile({ tags: [{ name: 'other', strength: 1 }] })),
      FILE_ID,
    ],
    [
      'a lake the caller cannot see',
      () => mockAssertLakeAccess.mockRejectedValue(new NotFoundError('Data lake not found')),
      FILE_ID,
    ],
  ])('answers one 404 for %s', async (_label, arrange, fileId) => {
    arrange();
    await expect(run('GET', fileId)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('never queries for a malformed file id', async () => {
    await expect(run('GET', 'not-an-id')).rejects.toMatchObject({ statusCode: 404 });
    expect(mockFindFile).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/data-lakes/{id}/files/{file_id}', () => {
  it('adds the file and returns the lake totals', async () => {
    const res = await run('POST');
    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(DataLakeFileMembershipResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({ lake_id: LAKE.id, file_id: FILE_ID, file_count: 5, total_size_bytes: 500 });
    expect(mockAddFile).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1' }),
      LAKE.id,
      FILE_ID,
      expect.anything()
    );
  });

  it('passes the canonical lowercase file id to the service', async () => {
    await run('POST', FILE_ID.toUpperCase());
    expect(mockAddFile).toHaveBeenCalledWith(expect.anything(), LAKE.id, FILE_ID, expect.anything());
  });

  it('answers 403 from the manage pre-check for a reader who cannot manage the lake', async () => {
    mockCanManageLake.mockReturnValue(false);
    await expect(run('POST')).rejects.toMatchObject({ statusCode: 403 });
    expect(mockAddFile).not.toHaveBeenCalled();
  });

  it('answers 403 for a built-in lake', async () => {
    mockAssertLakeAccessWithGrants.mockResolvedValue({ lake: { ...DATA_LAKES[0], createdByUserId: '' }, grants: [] });
    await expect(run('POST')).rejects.toMatchObject({ statusCode: 403 });
    expect(mockAddFile).not.toHaveBeenCalled();
  });

  it('answers 404 for an invisible lake, a malformed id, or a file the caller may not add', async () => {
    mockAssertLakeAccessWithGrants.mockRejectedValueOnce(new NotFoundError('Data lake not found'));
    await expect(run('POST')).rejects.toMatchObject({ statusCode: 404 });
    await expect(run('POST', 'nope')).rejects.toMatchObject({ statusCode: 404 });
    mockAddFile.mockRejectedValueOnce(new NotFoundError('File not found'));
    await expect(run('POST')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('surfaces an admission refusal as the service 400', async () => {
    mockAddFile.mockRejectedValue(new BadRequestError('Passage size not accepted'));
    await expect(run('POST')).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('DELETE /api/v1/data-lakes/{id}/files/{file_id}', () => {
  it('removes the membership and returns only the public totals', async () => {
    const res = await run('DELETE');
    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body).toEqual({ lake_id: LAKE.id, file_id: FILE_ID, file_count: 4, total_size_bytes: 400 });
    expect(DataLakeFileMembershipResponseSchema.safeParse(body).success).toBe(true);
  });

  it('answers 404 for a non-member and 403 for a non-manager', async () => {
    mockRemoveFile.mockRejectedValueOnce(new NotFoundError('File is not a member'));
    await expect(run('DELETE')).rejects.toMatchObject({ statusCode: 404 });
    mockCanManageLake.mockReturnValue(false);
    await expect(run('DELETE')).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('rate limit bucket', () => {
  // The raw pathname embeds `id`/`file_id`; without a stable bucket, every GET/POST/DELETE across
  // the three routers built here would each get its own per-id/per-file counter.
  it('shares one stable bucket across GET, POST and DELETE', () => {
    expect(rateLimitOptionsAtLoad.length).toBeGreaterThan(0);
    for (const options of rateLimitOptionsAtLoad) {
      expect(options).toEqual(
        expect.objectContaining({ bucket: '/api/v1/data-lakes/[id]/files/[file_id]', windowMs: 60_000 })
      );
    }
  });
});

describe('admin reach', () => {
  // Regression for the admin-bypass gap: GET/POST/DELETE must all resolve the member-scoped
  // context, never the admin-bypass one - fails if any of the three route used `toAccessContext`.
  it.each(['GET', 'POST', 'DELETE'] as const)('%s resolves a member-scoped context', async method => {
    await run(method);
    const spy = method === 'GET' ? mockAssertLakeAccess : mockAssertLakeAccessWithGrants;
    expect(spy).toHaveBeenCalledWith('handbook', expect.objectContaining({ isAdmin: false }), expect.anything());
  });
});

describe('feature flag', () => {
  it.each(['GET', 'POST', 'DELETE'] as const)(
    '%s answers 403 FEATURE_DISABLED when Data Lakes are off',
    async method => {
      mockFeatureEnabled.value = false;
      const res = await run(method);
      expect(res._getStatusCode()).toBe(403);
      expect(res._getJSONData()).toMatchObject({ code: 'FEATURE_DISABLED' });
      expect(mockAssertLakeAccess).not.toHaveBeenCalled();
      expect(mockAssertLakeAccessWithGrants).not.toHaveBeenCalled();
    }
  );
});

describe('method dispatch', () => {
  it('hands a method no contract serves to the path-level 405 handler, advertising every verb', async () => {
    await run('PATCH');
    expect(mockMethodNotAllowed).toHaveBeenCalledWith(['GET', 'POST', 'DELETE'], expect.anything(), expect.anything());
    expect(mockAssertLakeAccess).not.toHaveBeenCalled();
    expect(mockAssertLakeAccessWithGrants).not.toHaveBeenCalled();
  });

  it('serves GET without touching the 405 handler', async () => {
    await run('GET');
    expect(mockMethodNotAllowed).not.toHaveBeenCalled();
  });
});
