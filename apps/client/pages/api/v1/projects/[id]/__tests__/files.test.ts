// @vitest-environment node
/**
 * Route tests for /api/v1/projects/{id}/files and /files/{file_id}. `baseApi` is stubbed (no DB
 * connect, no auth chain) but `nextRouteForContract`, projectService and the shared write helpers are
 * not, so the status mapping, cursor handling and response drift check run for real against mocked
 * repositories.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { FileSummarySchema, ProjectResourceSchema, ProjectEvents, isZodError } from '@bike4mind/common';

const {
  mockFindAccessibleById,
  mockFindUpdateAccessById,
  mockUpdateWithUpdateAccess,
  mockProjectUpdate,
  mockFindUser,
  mockFindPageByIds,
  mockFindAllAccessibleFiles,
  mockFileUpdate,
  mockLogEvent,
  mockRateLimitOptions,
} = vi.hoisted(() => ({
  mockFindAccessibleById: vi.fn(),
  mockFindUpdateAccessById: vi.fn(),
  mockUpdateWithUpdateAccess: vi.fn(),
  mockProjectUpdate: vi.fn(),
  mockFindUser: vi.fn(),
  mockFindPageByIds: vi.fn(),
  mockFindAllAccessibleFiles: vi.fn(),
  mockFileUpdate: vi.fn(),
  mockLogEvent: vi.fn(),
  mockRateLimitOptions: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  methodNotAllowedHandler: () => (_req: unknown, res: { status: (n: number) => { end: () => void } }) =>
    res.status(405).end(),
  baseApi: () => {
    type Mw = (req: unknown, res: unknown, next: () => void) => unknown;
    const compose =
      (...handlers: Mw[]) =>
      async (req: unknown, res: unknown) => {
        for (const handler of handlers) {
          let advanced = false;
          await handler(req, res, () => {
            advanced = true;
          });
          if (!advanced) return;
        }
      };
    return { get: compose, post: compose, delete: compose };
  },
}));
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => {
    mockRateLimitOptions(options);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));
vi.mock('@server/utils/userRateTier', () => ({ resolveUserRateLimitPerMin: () => 60 }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: mockLogEvent }));
vi.mock('@bike4mind/database', () => ({
  projectRepository: {
    shareable: { findAccessibleById: mockFindAccessibleById, findUpdateAccessById: mockFindUpdateAccessById },
    updateWithUpdateAccess: mockUpdateWithUpdateAccess,
    update: mockProjectUpdate,
  },
  userRepository: { findById: mockFindUser, findByIds: vi.fn().mockResolvedValue([]) },
  fabFileRepository: {
    findPageByIds: mockFindPageByIds,
    shareable: { findAllAccessibleByIds: mockFindAllAccessibleFiles },
    update: mockFileUpdate,
  },
  inviteRepository: { findAllByDocumentId: vi.fn().mockResolvedValue([]) },
  withTransaction: (fn: () => unknown) => fn(),
}));

const { default: listAddHandler } = await import('@pages/api/v1/projects/[id]/files/index');
const { default: removeHandler } = await import('@pages/api/v1/projects/[id]/files/[file_id]');
const { encodeCursor, decodeCursor } = await import('@server/utils/cursorPagination');
const rateLimitBuckets = mockRateLimitOptions.mock.calls.map(([options]) => (options as { bucket: string }).bucket);

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const USER = { id: 'u1', groups: [] };
const PROJECT_ID = '65a000000000000000000001';
const FILE_A = '65b000000000000000000001';
const FILE_B = '65b000000000000000000002';

type Method = 'GET' | 'POST' | 'DELETE';

async function call(handler: unknown, method: Method, query: Record<string, string>, body?: object) {
  const { req, res } = createMocks({ method, query, body });
  Object.assign(req, { user: USER, logger, ability: {} });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the contract router's param type carries prelude-only fields
  await (handler as any)(req, res);
  return res;
}

async function statusOf(handler: unknown, method: Method, query: Record<string, string>, body?: object) {
  try {
    return (await call(handler, method, query, body))._getStatusCode();
  } catch (err) {
    // The real baseApi error handler maps a ZodError to 422; the stubbed chain here rethrows it.
    if (isZodError(err)) return 422;
    return (err as { statusCode?: number }).statusCode;
  }
}

const list = (query: Record<string, string> = {}) => call(listAddHandler, 'GET', { id: PROJECT_ID, ...query });
const add = (body: object, id = PROJECT_ID) => call(listAddHandler, 'POST', { id }, body);
const remove = (fileId: string, id = PROJECT_ID) => call(removeHandler, 'DELETE', { id, file_id: fileId });

let project: Record<string, unknown>;
const makeProject = (overrides: Record<string, unknown> = {}) => ({
  id: PROJECT_ID,
  name: 'Research',
  description: 'desc',
  userId: 'u1',
  sessionIds: [],
  fileIds: [FILE_A],
  users: [],
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});
const summaryRow = (id: string) => ({
  id,
  fileName: `${id}.txt`,
  mimeType: 'text/plain',
  fileSize: 5,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  filePath: 'private/key',
  userId: 'u1',
});

beforeEach(() => {
  vi.clearAllMocks();
  project = makeProject();
  mockFindUser.mockResolvedValue(USER);
  mockFindAccessibleById.mockImplementation(async () => project);
  mockFindUpdateAccessById.mockImplementation(async () => project);
  mockUpdateWithUpdateAccess.mockResolvedValue({ id: PROJECT_ID });
  mockProjectUpdate.mockResolvedValue(undefined);
  mockFindAllAccessibleFiles.mockResolvedValue([]);
  mockFindPageByIds.mockResolvedValue({ data: [], hasMore: false });
});

describe('rate limiting', () => {
  it('uses one named bucket per method for every project and file id', () => {
    expect(rateLimitBuckets).toEqual(
      expect.arrayContaining([
        'GET /api/v1/projects/[id]/files',
        'POST /api/v1/projects/[id]/files',
        'DELETE /api/v1/projects/[id]/files/[file_id]',
      ])
    );
  });
});

describe('GET /api/v1/projects/{id}/files', () => {
  it('returns file summaries only, never a download url or owner', async () => {
    mockFindPageByIds.mockResolvedValue({ data: [summaryRow(FILE_A)], hasMore: false });

    const res = await list();

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body.next_cursor).toBeNull();
    expect(body.data).toHaveLength(1);
    expect(FileSummarySchema.safeParse(body.data[0]).success).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/private\/key|userId|download_url/);
    expect(mockFindPageByIds).toHaveBeenCalledWith([FILE_A], { afterId: undefined, limit: 25 });
  });

  it('answers 404, never 403, for a project the caller cannot read', async () => {
    mockFindAccessibleById.mockResolvedValue(null);
    expect(await statusOf(listAddHandler, 'GET', { id: PROJECT_ID })).toBe(404);
    expect(mockFindPageByIds).not.toHaveBeenCalled();
  });

  it('answers 404 for a malformed project id', async () => {
    mockFindAccessibleById.mockResolvedValue(null);
    expect(await statusOf(listAddHandler, 'GET', { id: 'not-an-id' })).toBe(404);
  });

  it('pages with next_cursor and resumes after the last id served', async () => {
    mockFindPageByIds.mockResolvedValue({ data: [summaryRow(FILE_A)], hasMore: true });
    const first = (await list({ limit: '1' }))._getJSONData();

    expect(first.next_cursor).toEqual(expect.any(String));
    expect(decodeCursor(first.next_cursor, 'v1.projects.files')).toBe(FILE_A);

    mockFindPageByIds.mockResolvedValue({ data: [summaryRow(FILE_B)], hasMore: false });
    const second = (await list({ limit: '1', cursor: first.next_cursor }))._getJSONData();

    expect(mockFindPageByIds).toHaveBeenLastCalledWith([FILE_A], { afterId: FILE_A, limit: 1 });
    expect(second.data.map((f: { id: string }) => f.id)).toEqual([FILE_B]);
    expect(second.next_cursor).toBeNull();
  });

  it.each([
    ['a malformed cursor', 'garbage'],
    ['a cursor issued by another endpoint', encodeCursor('v1.projects', FILE_A)],
    ['a cursor whose id is not an ObjectId', encodeCursor('v1.projects.files', 'nope')],
  ])('answers 422 for %s', async (_name, cursor) => {
    expect(await statusOf(listAddHandler, 'GET', { id: PROJECT_ID, cursor })).toBe(422);
    expect(mockFindPageByIds).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/projects/{id}/files', () => {
  const FILE_B_DOC = { id: FILE_B, userId: 'u1', users: [] };

  it('adds readable files, returns the project allowlist and logs ADD_FILE', async () => {
    mockFindAllAccessibleFiles.mockResolvedValue([FILE_B_DOC]);

    const res = await add({ file_ids: [FILE_B] });

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(ProjectResourceSchema.safeParse(body).success).toBe(true);
    expect(body.file_ids).toEqual([FILE_A, FILE_B]);
    expect(JSON.stringify(body)).not.toMatch(/userId|users/);
    expect(mockUpdateWithUpdateAccess).toHaveBeenCalledTimes(1);
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: ProjectEvents.ADD_FILE,
        metadata: expect.objectContaining({ contentId: FILE_B }),
      }),
      expect.anything()
    );
  });

  it('answers 404 for a project the caller can only read (read-only sharee)', async () => {
    mockFindUpdateAccessById.mockResolvedValue(null);
    expect(await statusOf(listAddHandler, 'POST', { id: PROJECT_ID }, { file_ids: [FILE_B] })).toBe(404);
    expect(mockUpdateWithUpdateAccess).not.toHaveBeenCalled();
  });

  it('answers 404 for a malformed project id', async () => {
    mockFindUpdateAccessById.mockResolvedValue(null);
    expect(await statusOf(listAddHandler, 'POST', { id: 'not-an-id' }, { file_ids: [FILE_B] })).toBe(404);
  });

  it('answers 400 when a listed file is not readable, and attaches nothing', async () => {
    mockFindAllAccessibleFiles.mockResolvedValue([FILE_B_DOC]);
    expect(await statusOf(listAddHandler, 'POST', { id: PROJECT_ID }, { file_ids: [FILE_B, FILE_A] })).toBe(400);
    expect(mockUpdateWithUpdateAccess).not.toHaveBeenCalled();
  });

  it.each([
    ['the SPA camelCase spelling', { fileIds: [FILE_B] }],
    ['an empty list', { file_ids: [] }],
    ['an unknown field', { file_ids: [FILE_B], extra: 1 }],
    ['an empty id', { file_ids: [''] }],
  ])('answers 422 for %s', async (_name, body) => {
    expect(await statusOf(listAddHandler, 'POST', { id: PROJECT_ID }, body)).toBe(422);
    expect(mockFindUpdateAccessById).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/v1/projects/{id}/files/{file_id}', () => {
  const ownFile = { id: FILE_A, userId: 'u1', users: [] };

  it('removes the file, writes the project and logs REMOVE_FILE', async () => {
    mockFindAllAccessibleFiles.mockResolvedValue([ownFile]);

    const res = await remove(FILE_A);

    expect(res._getStatusCode()).toBe(204);
    expect(mockProjectUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: PROJECT_ID, fileIds: [] }));
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: ProjectEvents.REMOVE_FILE }),
      expect.anything()
    );
  });

  it('is a 204 no-op for a readable file that is not in the project', async () => {
    mockFindAllAccessibleFiles.mockResolvedValue([{ id: FILE_B, userId: 'u1', users: [] }]);

    const res = await remove(FILE_B);

    expect(res._getStatusCode()).toBe(204);
    expect(mockProjectUpdate).toHaveBeenCalledWith(expect.objectContaining({ fileIds: [FILE_A] }));
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it('answers 404 for a project the caller cannot read', async () => {
    mockFindAccessibleById.mockResolvedValue(null);
    expect(await statusOf(removeHandler, 'DELETE', { id: PROJECT_ID, file_id: FILE_A })).toBe(404);
  });

  it('answers 404 for an unreadable file id the project does not hold', async () => {
    mockFindAllAccessibleFiles.mockResolvedValue([]);
    expect(await statusOf(removeHandler, 'DELETE', { id: PROJECT_ID, file_id: FILE_B })).toBe(404);
    expect(mockProjectUpdate).not.toHaveBeenCalled();
  });

  it('lets the owner clear a held id whose file no longer resolves', async () => {
    mockFindAllAccessibleFiles.mockResolvedValue([]);

    expect((await remove(FILE_A))._getStatusCode()).toBe(204);
    expect(mockProjectUpdate).toHaveBeenCalledWith(expect.objectContaining({ fileIds: [] }));
  });

  it('answers 404 for a malformed file id without touching the project', async () => {
    expect(await statusOf(removeHandler, 'DELETE', { id: PROJECT_ID, file_id: 'not-an-id' })).toBe(404);
    expect(mockFindAccessibleById).not.toHaveBeenCalled();
  });

  it('answers 403 when the caller owns neither the project nor the file', async () => {
    project = makeProject({ userId: 'someone-else' });
    mockFindAllAccessibleFiles.mockResolvedValue([{ id: FILE_A, userId: 'someone-else', users: [] }]);

    expect(await statusOf(removeHandler, 'DELETE', { id: PROJECT_ID, file_id: FILE_A })).toBe(403);
    expect(mockProjectUpdate).not.toHaveBeenCalled();
  });

  it("lets a sharee remove a file they own from someone else's project", async () => {
    project = makeProject({ userId: 'someone-else' });
    mockFindAllAccessibleFiles.mockResolvedValue([ownFile]);

    expect((await remove(FILE_A))._getStatusCode()).toBe(204);
  });
});
