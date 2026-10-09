// @vitest-environment node
/**
 * Route tests for the public artifact endpoints under /api/v1/artifacts. Scope enforcement through
 * the real auth chain lives in pages/api/v1/artifacts/__tests__/scopes.integration.test.ts.
 *
 * `baseApi` is stubbed (no DB connect, no auth chain) but `nextRouteForContract` is NOT: the
 * contract's own prelude - param, query and body validation plus the non-prod response drift check -
 * runs for real, so a response that stops matching the published schema fails here. artifactService
 * is mocked; it has its own coverage in b4m-core/services.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import {
  ApiKeyScope,
  ArtifactResourceSchema,
  ArtifactVersionSchema,
  ListArtifactsResponseSchema,
  ListArtifactVersionsResponseSchema,
  createArtifactContract,
  deleteArtifactContract,
  getArtifactContract,
  getArtifactVersionContract,
  listArtifactVersionsContract,
  listArtifactsContract,
  updateArtifactContract,
} from '@bike4mind/common';
import { NotFoundError, UnauthorizedError } from '@server/utils/errors';
import { encodeCursor } from '@server/utils/cursorPagination';

const {
  mockGet,
  mockCreate,
  mockUpdate,
  mockDelete,
  mockProjectGet,
  mockListOwned,
  mockListVersions,
  mockFindByVersion,
  mockFindContent,
  mockCanUpdateSession,
} = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
  mockDelete: vi.fn(),
  mockProjectGet: vi.fn(),
  mockListOwned: vi.fn(),
  mockListVersions: vi.fn(),
  mockFindByVersion: vi.fn(),
  mockFindContent: vi.fn(),
  mockCanUpdateSession: vi.fn(),
}));

// Strip the middleware chain but keep next-connect's registrar shape, so
// nextRouteForContract's prelude (validation + drift check) still composes and runs.
vi.mock('@server/middlewares/baseApi', () => ({
  methodNotAllowedHandler: () => (_req: unknown, res: { status: (n: number) => { end: () => void } }) =>
    res.status(405).end(),
  baseApi: () => {
    const compose =
      (...handlers: ((req: unknown, res: unknown, next: () => void) => unknown)[]) =>
      async (req: unknown, res: unknown) => {
        for (const handler of handlers) {
          let advanced = false;
          await handler(req, res, () => {
            advanced = true;
          });
          if (!advanced) return;
        }
      };
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.get = compose;
    chain.post = compose;
    chain.patch = compose;
    chain.delete = compose;
    return chain;
  },
}));
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/utils/userRateTier', () => ({ resolveUserRateLimitPerMin: () => 60 }));
vi.mock('@bike4mind/services', () => ({
  artifactService: { get: mockGet, create: mockCreate, update: mockUpdate, delete: mockDelete },
  projectService: { get: mockProjectGet },
}));
vi.mock('@bike4mind/database', () => ({
  artifactRepository: { listOwnedAfterId: mockListOwned, findOne: vi.fn() },
  artifactContentRepository: { findById: mockFindContent },
  artifactVersionRepository: { listByArtifactAfterVersion: mockListVersions, findByVersion: mockFindByVersion },
  projectRepository: {},
  questRepository: {},
  userRepository: {},
  sessionRepository: { shareable: { findUpdateAccessById: mockCanUpdateSession } },
}));

const { default: listOrCreate } = await import('@pages/api/v1/artifacts/index');
const { default: byId } = await import('@pages/api/v1/artifacts/[id]/index');
const { default: listVersions } = await import('@pages/api/v1/artifacts/[id]/versions/index');
const { default: getVersion } = await import('@pages/api/v1/artifacts/[id]/versions/[version]');

const ARTIFACT_ID = 'mermaid-signup-flow-1';
const MONGO_ID = '65a000000000000000000001';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() };

function fire(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  { query = {}, body }: { query?: Record<string, string>; body?: Record<string, unknown> } = {}
) {
  const { req, res } = createMocks({ method, query, body });
  Object.assign(req, { user: { id: 'u1', groups: [] }, logger });
  return { req, res };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- next-connect handlers are untyped at this seam
const call = (handler: unknown, req: unknown, res: unknown) => (handler as any)(req, res);

/** node-mocks-http surfaces a thrown error only if the caller catches it. */
async function statusOf(run: Promise<unknown>): Promise<number> {
  try {
    await run;
  } catch (err) {
    return (err as { statusCode?: number }).statusCode ?? 500;
  }
  throw new Error('expected the handler to throw');
}

function artifactDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: MONGO_ID,
    id: ARTIFACT_ID,
    type: 'mermaid',
    title: 'Signup flow',
    version: 1,
    status: 'draft',
    tags: [],
    visibility: 'private',
    userId: 'u1',
    permissions: { canRead: [], canWrite: [], canDelete: [] },
    contentHash: 'h',
    createdAt: new Date('2026-10-01T12:00:00.000Z'),
    updatedAt: new Date('2026-10-01T12:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGet.mockResolvedValue({ artifact: artifactDoc(), content: { content: 'graph TD; A-->B' } });
  mockCreate.mockResolvedValue({ artifact: artifactDoc() });
  mockUpdate.mockResolvedValue({ artifact: artifactDoc() });
  mockDelete.mockResolvedValue({ success: true });
  mockListOwned.mockResolvedValue({ data: [], hasMore: false });
  mockListVersions.mockResolvedValue({ data: [], hasMore: false });
  mockFindByVersion.mockResolvedValue({ version: 1, contentId: 'c1', createdAt: new Date('2026-10-01T12:00:00Z') });
  mockFindContent.mockResolvedValue({ content: 'graph TD; A-->B' });
  mockCanUpdateSession.mockResolvedValue({ id: 's1' });
  mockProjectGet.mockResolvedValue({ id: 'p1' });
});

describe('artifact contracts', () => {
  it('gate writes on notebooks:write and reads on either notebooks scope', () => {
    for (const contract of [createArtifactContract, updateArtifactContract, deleteArtifactContract]) {
      expect(contract.scopes).toEqual([ApiKeyScope.WRITE_NOTEBOOKS]);
    }
    for (const contract of [
      listArtifactsContract,
      getArtifactContract,
      listArtifactVersionsContract,
      getArtifactVersionContract,
    ]) {
      expect(contract.scopes).toEqual([ApiKeyScope.READ_NOTEBOOKS, ApiKeyScope.WRITE_NOTEBOOKS]);
    }
  });
});

describe('GET /api/v1/artifacts', () => {
  it('returns a content-free page matching the published schema', async () => {
    mockListOwned.mockResolvedValue({ data: [artifactDoc()], hasMore: true });
    const { req, res } = fire('GET', { query: { limit: '1' } });

    await call(listOrCreate, req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(ListArtifactsResponseSchema.safeParse(body).success).toBe(true);
    expect(body.data[0]).toMatchObject({ id: ARTIFACT_ID, content: null });
    expect(body.data[0]).not.toHaveProperty('permissions');
    expect(body.next_cursor).toBe(encodeCursor('v1.artifacts', MONGO_ID));
    expect(mockListOwned).toHaveBeenCalledWith('u1', { afterId: undefined, limit: 1 });
  });

  it('resumes after the id a cursor carries', async () => {
    const { req, res } = fire('GET', { query: { cursor: encodeCursor('v1.artifacts', MONGO_ID) } });

    await call(listOrCreate, req, res);

    expect(mockListOwned).toHaveBeenCalledWith('u1', { afterId: MONGO_ID, limit: 25 });
    expect(res._getJSONData().next_cursor).toBeNull();
  });

  it.each([
    ['garbage', 'not-a-cursor'],
    ['another endpoint', encodeCursor('v1.files', MONGO_ID)],
    ['a non-ObjectId payload', encodeCursor('v1.artifacts', 'nope')],
  ])('rejects a cursor from %s with 422', async (_label, cursor) => {
    const { req, res } = fire('GET', { query: { cursor } });

    expect(await statusOf(call(listOrCreate, req, res))).toBe(422);
    expect(mockListOwned).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/artifacts', () => {
  const BODY = { type: 'mermaid', title: 'Signup flow', content: 'graph TD; A-->B' };

  it('creates a private artifact and returns 201 with its content', async () => {
    const { req, res } = fire('POST', { body: { ...BODY, session_id: 's1', tags: ['x'] } });

    await call(listOrCreate, req, res);

    expect(res._getStatusCode()).toBe(201);
    const body = res._getJSONData();
    expect(ArtifactResourceSchema.safeParse(body).success).toBe(true);
    expect(body.content).toBe('graph TD; A-->B');
    expect(mockCreate).toHaveBeenCalledWith(
      'u1',
      {
        type: 'mermaid',
        title: 'Signup flow',
        content: 'graph TD; A-->B',
        description: undefined,
        sessionId: 's1',
        projectId: undefined,
        tags: ['x'],
        visibility: 'private',
        metadata: {},
      },
      expect.anything()
    );
  });

  it('rejects an unknown or camelCase body field before creating anything', async () => {
    for (const extra of [{ sessionId: 's1' }, { visibility: 'public' }, { metadata: { aiGenerated: true } }]) {
      const { req, res } = fire('POST', { body: { ...BODY, ...extra } });
      await expect(call(listOrCreate, req, res)).rejects.toThrow();
    }
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('answers 404 for a session the caller cannot edit', async () => {
    mockCanUpdateSession.mockResolvedValue(null);
    const { req, res } = fire('POST', { body: { ...BODY, session_id: 'someone-elses' } });

    expect(await statusOf(call(listOrCreate, req, res))).toBe(404);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('answers 404 for a project the caller cannot read', async () => {
    mockProjectGet.mockRejectedValue(new NotFoundError('Project not found'));
    const { req, res } = fire('POST', { body: { ...BODY, project_id: 'someone-elses' } });

    expect(await statusOf(call(listOrCreate, req, res))).toBe(404);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/artifacts/{id}', () => {
  it('returns the artifact with its current content', async () => {
    const { req, res } = fire('GET', { query: { id: ARTIFACT_ID } });

    await call(byId, req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(ArtifactResourceSchema.safeParse(body).success).toBe(true);
    expect(body.content).toBe('graph TD; A-->B');
    expect(mockGet).toHaveBeenCalledWith(
      'u1',
      { id: ARTIFACT_ID, includeContent: true, includeVersions: false },
      expect.anything()
    );
  });

  it.each([
    ['missing', new NotFoundError('Artifact not found')],
    ['unreadable', new UnauthorizedError('Access denied')],
  ])('answers 404 for a %s artifact', async (_label, err) => {
    mockGet.mockRejectedValue(err);
    const { req, res } = fire('GET', { query: { id: 'whatever' } });

    expect(await statusOf(call(byId, req, res))).toBe(404);
  });
});

describe('PATCH /api/v1/artifacts/{id}', () => {
  it('passes only the present fields and re-reads the result', async () => {
    const { req, res } = fire('PATCH', { query: { id: ARTIFACT_ID }, body: { content: 'new' } });

    await call(byId, req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(ArtifactResourceSchema.safeParse(res._getJSONData()).success).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith('u1', { id: ARTIFACT_ID, content: 'new' }, expect.anything());
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('answers 404 for a read-only sharee', async () => {
    mockUpdate.mockRejectedValue(new UnauthorizedError('Write access denied'));
    const { req, res } = fire('PATCH', { query: { id: ARTIFACT_ID }, body: { title: 'x' } });

    expect(await statusOf(call(byId, req, res))).toBe(404);
  });

  it('rejects an unknown body field before updating', async () => {
    const { req, res } = fire('PATCH', { query: { id: ARTIFACT_ID }, body: { visibility: 'public' } });

    await expect(call(byId, req, res)).rejects.toThrow();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/v1/artifacts/{id}', () => {
  it('returns 204 with no body', async () => {
    const { req, res } = fire('DELETE', { query: { id: ARTIFACT_ID } });

    await call(byId, req, res);

    expect(res._getStatusCode()).toBe(204);
    expect(res._getData()).toBe('');
    expect(mockDelete).toHaveBeenCalledWith('u1', { id: ARTIFACT_ID, hardDelete: false }, expect.anything());
  });

  it.each([
    ['missing', new NotFoundError('Artifact not found')],
    ['undeletable', new UnauthorizedError('Delete access denied')],
  ])('answers 404 for a %s artifact', async (_label, err) => {
    mockDelete.mockRejectedValue(err);
    const { req, res } = fire('DELETE', { query: { id: ARTIFACT_ID } });

    expect(await statusOf(call(byId, req, res))).toBe(404);
  });
});

describe('GET /api/v1/artifacts/{id}/versions', () => {
  const VERSION = { _id: 'v1', version: 1, changeDescription: 'Created artifact', createdAt: new Date() };

  it('checks read access, then pages versions with a version cursor', async () => {
    mockListVersions.mockResolvedValue({ data: [VERSION], hasMore: true });
    const { req, res } = fire('GET', { query: { id: ARTIFACT_ID, limit: '1' } });

    await call(listVersions, req, res);

    const body = res._getJSONData();
    expect(ListArtifactVersionsResponseSchema.safeParse(body).success).toBe(true);
    expect(body.data[0]).toMatchObject({ version: 1, content: null });
    expect(body.next_cursor).toBe(encodeCursor('v1.artifacts.versions', '1'));
    expect(mockListVersions).toHaveBeenCalledWith(ARTIFACT_ID, { afterVersion: undefined, limit: 1 });
  });

  it('resumes after the version a cursor carries', async () => {
    const { req, res } = fire('GET', {
      query: { id: ARTIFACT_ID, cursor: encodeCursor('v1.artifacts.versions', '3') },
    });

    await call(listVersions, req, res);

    expect(mockListVersions).toHaveBeenCalledWith(ARTIFACT_ID, { afterVersion: 3, limit: 25 });
  });

  it.each(['0', '1.5', 'abc'])('rejects a cursor carrying %s with 422', async payload => {
    const { req, res } = fire('GET', {
      query: { id: ARTIFACT_ID, cursor: encodeCursor('v1.artifacts.versions', payload) },
    });

    expect(await statusOf(call(listVersions, req, res))).toBe(422);
    expect(mockListVersions).not.toHaveBeenCalled();
  });

  it('answers 404 for an artifact the caller cannot read', async () => {
    mockGet.mockRejectedValue(new UnauthorizedError('Access denied'));
    const { req, res } = fire('GET', { query: { id: ARTIFACT_ID } });

    expect(await statusOf(call(listVersions, req, res))).toBe(404);
    expect(mockListVersions).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/artifacts/{id}/versions/{version}', () => {
  it('returns the version with its content', async () => {
    const { req, res } = fire('GET', { query: { id: ARTIFACT_ID, version: '1' } });

    await call(getVersion, req, res);

    const body = res._getJSONData();
    expect(ArtifactVersionSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ version: 1, content: 'graph TD; A-->B' });
    expect(mockFindByVersion).toHaveBeenCalledWith(ARTIFACT_ID, 1);
  });

  it.each(['0', '-1', '1.5', 'latest'])('answers 404 for version %s without a lookup', async version => {
    const { req, res } = fire('GET', { query: { id: ARTIFACT_ID, version } });

    expect(await statusOf(call(getVersion, req, res))).toBe(404);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('answers 404 for a version that does not exist', async () => {
    mockFindByVersion.mockResolvedValue(null);
    const { req, res } = fire('GET', { query: { id: ARTIFACT_ID, version: '9' } });

    expect(await statusOf(call(getVersion, req, res))).toBe(404);
  });

  it('answers 404 for an artifact the caller cannot read', async () => {
    mockGet.mockRejectedValue(new UnauthorizedError('Access denied'));
    const { req, res } = fire('GET', { query: { id: ARTIFACT_ID, version: '1' } });

    expect(await statusOf(call(getVersion, req, res))).toBe(404);
    expect(mockFindByVersion).not.toHaveBeenCalled();
  });
});
