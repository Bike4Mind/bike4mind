// @vitest-environment node
/**
 * Route tests for the public file endpoints: GET/POST /api/v1/files and GET/PATCH/DELETE
 * /api/v1/files/{id}. Scope enforcement through the real auth chain lives in
 * pages/api/v1/files/__tests__/scopes.integration.test.ts.
 *
 * `baseApi` is stubbed (no DB connect, no auth chain) but `nextRouteForContract` is NOT: the
 * contract's own prelude - path-param validation, body validation, and the non-prod response
 * drift check - runs for real, so a response that stops matching the published schema fails
 * here. The shared admission/authorization helpers are mocked; they have their own coverage
 * through the SPA-internal routes' tests.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import {
  ApiKeyScope,
  CreateFileUploadResponseSchema,
  FileEvents,
  FileResponseSchema,
  ListFilesResponseSchema,
  createFileUploadContract,
  deleteFileContract,
  getFileContract,
  listFilesContract,
  updateFileContract,
} from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import { decideScopeGate } from '@server/middlewares/apiKeyScopeGate';
import { encodeCursor } from '@server/utils/cursorPagination';

const {
  mockCreatePresignedUpload,
  mockLoadAccessibleFabFile,
  mockListOwnedAfterId,
  mockUpdateFabFile,
  mockDeleteFileForUser,
  mockLogEvent,
} = vi.hoisted(() => ({
  mockCreatePresignedUpload: vi.fn(),
  mockLoadAccessibleFabFile: vi.fn(),
  mockListOwnedAfterId: vi.fn(),
  mockUpdateFabFile: vi.fn(),
  mockDeleteFileForUser: vi.fn(),
  mockLogEvent: vi.fn(),
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
vi.mock('@server/files/createPresignedUpload', () => ({
  createPresignedUpload: mockCreatePresignedUpload,
  PRESIGNED_UPLOAD_EXPIRES_IN: 600,
}));
vi.mock('@server/files/loadAccessibleFabFile', () => ({ loadAccessibleFabFile: mockLoadAccessibleFabFile }));
vi.mock('@server/files/deleteFileForUser', () => ({ deleteFileForUser: mockDeleteFileForUser }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: mockLogEvent }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: vi.fn() }));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: async () => ({ administeredOrgIds: [] }) }));
vi.mock('@server/dataLakes/lakeConfigAuditDb', () => ({ lakeConfigAuditDb: {} }));
vi.mock('@server/dataLakes/lakeMembershipAuditDb', () => ({ lakeMembershipAuditDb: {} }));
vi.mock('@server/dataLakes/lakeConfigAuditPrincipal', () => ({ lakeConfigAuditPrincipal: () => undefined }));
vi.mock('@server/dataLakes/dataLakeScopes', () => ({ assertDataLakeWriteScope: vi.fn() }));
vi.mock('@bike4mind/services', () => ({ fabFilesService: { updateFabFile: mockUpdateFabFile } }));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  scopedSettingsRepository: {},
  fabFileRepository: { listOwnedAfterId: mockListOwnedAfterId },
  withTransaction: (fn: () => unknown) => fn(),
}));

const { default: uploadHandler } = await import('@pages/api/v1/files/index');
const { default: getHandler } = await import('@pages/api/v1/files/[id]/index');

const FILE_ID = '507f1f77bcf86cd799439011';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() };

function post(body: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, { user: { id: 'u1' }, logger });
  return { req, res };
}

function get(id: string) {
  const { req, res } = createMocks({ method: 'GET', query: { id } });
  Object.assign(req, { user: { id: 'u1' }, logger });
  return { req, res };
}

function list(query: Record<string, string> = {}) {
  const { req, res } = createMocks({ method: 'GET', query });
  Object.assign(req, { user: { id: 'u1' }, logger });
  return { req, res };
}

function patch(id: string, body: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'PATCH', query: { id }, body });
  Object.assign(req, { user: { id: 'u1' }, logger });
  return { req, res };
}

function del(id: string) {
  const { req, res } = createMocks({ method: 'DELETE', query: { id } });
  Object.assign(req, { user: { id: 'u1' }, logger });
  return { req, res };
}

/** node-mocks-http surfaces a thrown error only if the caller catches it. */
async function statusOf(run: Promise<unknown>): Promise<number> {
  try {
    await run;
  } catch (err) {
    return (err as { statusCode?: number }).statusCode ?? 500;
  }
  throw new Error('expected the handler to throw');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- next-connect handlers are untyped at this seam
const callHandler = (handler: unknown, req: unknown, res: unknown) => (handler as any)(req, res);

function fabFile(overrides: Record<string, unknown> = {}) {
  return {
    id: FILE_ID,
    fileName: 'reference.png',
    mimeType: 'image/png',
    fileSize: 482133,
    moderationStatus: 'clean',
    fileUrl: 'https://cdn.example/key.png?Signature=abc',
    fileUrlExpireAt: new Date('2026-09-30T12:00:00.000Z'),
    createdAt: new Date('2026-09-29T12:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreatePresignedUpload.mockResolvedValue({
    url: 'https://bucket.s3.example/key.png?X-Amz-Signature=abc',
    fileId: FILE_ID,
    fileKey: 'key.png',
  });
  mockLoadAccessibleFabFile.mockResolvedValue(fabFile());
  mockListOwnedAfterId.mockResolvedValue({ data: [], hasMore: false });
  mockUpdateFabFile.mockResolvedValue({ ...fabFile(), filePath: 'key.png' });
  mockDeleteFileForUser.mockResolvedValue('deleted');
  mockLogEvent.mockResolvedValue(undefined);
});

describe('file contracts', () => {
  it('gate writes on files:write and reads on either files scope', () => {
    for (const contract of [createFileUploadContract, updateFileContract, deleteFileContract]) {
      expect(contract.scopes).toEqual([ApiKeyScope.WRITE_FILES]);
    }
    for (const contract of [getFileContract, listFilesContract]) {
      expect(contract.scopes).toEqual([ApiKeyScope.READ_FILES, ApiKeyScope.WRITE_FILES]);
    }
  });

  it('deny a key holding neither files scope, with nothing staged', () => {
    const held = [ApiKeyScope.AI_CHAT];
    expect(decideScopeGate([...createFileUploadContract.scopes!], held, new Set()).outcome).toBe('deny');
    expect(decideScopeGate([...getFileContract.scopes!], held, new Set()).outcome).toBe('deny');
  });
});

describe('POST /api/v1/files', () => {
  it('returns a 201 pending upload matching the published schema', async () => {
    const before = Date.now();
    const { req, res } = post({ file_name: 'reference.png', mime_type: 'image/png', file_size: 482133 });

    await callHandler(uploadHandler, req, res);

    expect(res._getStatusCode()).toBe(201);
    const body = res._getJSONData();
    expect(CreateFileUploadResponseSchema.safeParse(body).success).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(body).toMatchObject({ id: FILE_ID, upload_url: expect.stringContaining('X-Amz') });
    const expiresAt = Date.parse(body.upload_url_expires_at);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 600_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 600_000);
  });

  it('maps the snake_case body onto the shared admission helper, and nothing else', async () => {
    const { req, res } = post({ file_name: 'reference.png', mime_type: 'image/png', file_size: 482133 });

    await callHandler(uploadHandler, req, res);

    expect(mockCreatePresignedUpload).toHaveBeenCalledWith(req, {
      fileName: 'reference.png',
      mimeType: 'image/png',
      fileSize: 482133,
    });
  });

  // The 422 mapping itself belongs to errorHandler (stubbed out here) - see defineNextRoute.test.ts.
  it('rejects a non-integer size before admitting anything', async () => {
    const { req, res } = post({ file_name: 'reference.png', mime_type: 'image/png', file_size: 1.5 });

    await expect(callHandler(uploadHandler, req, res)).rejects.toThrow();
    expect(mockCreatePresignedUpload).not.toHaveBeenCalled();
  });

  it('surfaces an admission rejection as its own status', async () => {
    mockCreatePresignedUpload.mockRejectedValue(new BadRequestError('File size exceeds storage limit'));
    const { req, res } = post({ file_name: 'reference.png', mime_type: 'image/png', file_size: 482133 });

    expect(await statusOf(callHandler(uploadHandler, req, res))).toBe(400);
  });
});

describe('GET /api/v1/files/{id}', () => {
  it('projects a downloadable file onto the published schema', async () => {
    const { req, res } = get(FILE_ID);

    await callHandler(getHandler, req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(FileResponseSchema.safeParse(body).success).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(body).toEqual({
      id: FILE_ID,
      file_name: 'reference.png',
      mime_type: 'image/png',
      file_size: 482133,
      moderation_status: 'clean',
      download_url: 'https://cdn.example/key.png?Signature=abc',
      download_url_expires_at: '2026-09-30T12:00:00.000Z',
      created_at: '2026-09-29T12:00:00.000Z',
    });
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });

  it('withholds the URL until the scan clears the file, even when one was signed', async () => {
    mockLoadAccessibleFabFile.mockResolvedValue(fabFile({ status: 'pending', moderationStatus: 'pending' }));
    const { req, res } = get(FILE_ID);

    await callHandler(getHandler, req, res);

    expect(res._getJSONData()).toMatchObject({
      moderation_status: 'pending',
      download_url: null,
      download_url_expires_at: null,
    });
  });

  // Imported-knowledge rows keep the default `status: 'pending'` with their bytes present, so
  // gating on `status` would make them permanently undownloadable.
  it('serves a clean file whose upload status never flipped', async () => {
    mockLoadAccessibleFabFile.mockResolvedValue(fabFile({ status: 'pending', moderationStatus: 'clean' }));
    const { req, res } = get(FILE_ID);

    await callHandler(getHandler, req, res);

    expect(res._getJSONData().download_url).toBe('https://cdn.example/key.png?Signature=abc');
  });

  it('withholds the URL for a complete file that moderation blocked', async () => {
    mockLoadAccessibleFabFile.mockResolvedValue(fabFile({ moderationStatus: 'blocked' }));
    const { req, res } = get(FILE_ID);

    await callHandler(getHandler, req, res);

    expect(res._getJSONData()).toMatchObject({ moderation_status: 'blocked', download_url: null });
  });

  it('404s a malformed id without touching the loader', async () => {
    const { req, res } = get('not-an-object-id');

    expect(await statusOf(callHandler(getHandler, req, res))).toBe(404);
    expect(mockLoadAccessibleFabFile).not.toHaveBeenCalled();
  });

  it('404s a file the caller cannot see', async () => {
    mockLoadAccessibleFabFile.mockRejectedValue(new NotFoundError('Fabfile not found'));
    const { req, res } = get(FILE_ID);

    expect(await statusOf(callHandler(getHandler, req, res))).toBe(404);
  });
});

describe('upload -> poll -> download', () => {
  it('hands back an id the read endpoint resolves, downloadable once processing lands', async () => {
    const upload = post({ file_name: 'reference.png', mime_type: 'image/png', file_size: 482133 });
    await callHandler(uploadHandler, upload.req, upload.res);
    const { id } = upload.res._getJSONData();

    mockLoadAccessibleFabFile.mockResolvedValueOnce(fabFile({ status: 'pending', moderationStatus: 'pending' }));
    const firstPoll = get(id);
    await callHandler(getHandler, firstPoll.req, firstPoll.res);
    expect(firstPoll.res._getJSONData().download_url).toBeNull();

    const secondPoll = get(id);
    await callHandler(getHandler, secondPoll.req, secondPoll.res);
    expect(secondPoll.res._getJSONData().download_url).toBe('https://cdn.example/key.png?Signature=abc');
    expect(mockLoadAccessibleFabFile).toHaveBeenLastCalledWith(secondPoll.req, FILE_ID);
  });
});

/** A full document as the repository returns it, including fields the public shape must drop. */
const ownedDoc = (id: string) => ({
  ...fabFile({ id }),
  _id: id,
  userId: 'u1',
  filePath: 'secret/path.png',
  notes: 'private notes',
  tags: [{ name: 'datalake:secret', strength: 1 }],
  users: [{ userId: 'someone-else', permissions: ['read'] }],
  chunkCount: 3,
});

const SUMMARY_KEYS = ['created_at', 'file_name', 'file_size', 'id', 'mime_type', 'moderation_status'];
const ID_2 = '507f1f77bcf86cd799439012';

describe('GET /api/v1/files', () => {
  it('returns a schema-valid page of allowlisted summaries with no download URL', async () => {
    mockListOwnedAfterId.mockResolvedValue({ data: [ownedDoc(FILE_ID)], hasMore: false });
    const { req, res } = list();

    await callHandler(uploadHandler, req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(ListFilesResponseSchema.safeParse(body).success).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(Object.keys(body.data[0]).sort()).toEqual(SUMMARY_KEYS);
    expect(body.next_cursor).toBeNull();
    expect(JSON.stringify(body)).not.toMatch(/secret|private|someone-else|userId|chunkCount/);
    expect(mockListOwnedAfterId).toHaveBeenCalledWith('u1', { afterId: undefined, limit: 25, search: undefined });
  });

  it('issues a cursor when there is another page, and passes it and search back to the repository', async () => {
    mockListOwnedAfterId.mockResolvedValue({ data: [ownedDoc(FILE_ID)], hasMore: true });
    const first = list({ limit: '1', search: 'Report' });
    await callHandler(uploadHandler, first.req, first.res);
    const { next_cursor } = first.res._getJSONData();
    expect(next_cursor).toEqual(expect.any(String));

    mockListOwnedAfterId.mockResolvedValue({ data: [ownedDoc(ID_2)], hasMore: false });
    const second = list({ limit: '1', search: 'Report', cursor: next_cursor });
    await callHandler(uploadHandler, second.req, second.res);

    expect(mockListOwnedAfterId).toHaveBeenLastCalledWith('u1', { afterId: FILE_ID, limit: 1, search: 'Report' });
    expect(second.res._getJSONData()).toMatchObject({ data: [{ id: ID_2 }], next_cursor: null });
  });

  it.each([
    ['a malformed cursor', { cursor: 'not-a-cursor' }],
    ['a cursor minted by another endpoint', { cursor: encodeCursor('v1.projects', FILE_ID) }],
    ['a cursor whose id is not an ObjectId', { cursor: encodeCursor('v1.files', 'nope') }],
  ])('rejects %s with 422 before querying', async (_label, query) => {
    const { req, res } = list(query);

    expect(await statusOf(callHandler(uploadHandler, req, res))).toBe(422);
    expect(mockListOwnedAfterId).not.toHaveBeenCalled();
  });

  // The 422 mapping itself belongs to errorHandler (stubbed out here) - see scopes.integration.test.ts.
  it.each([
    ['an empty search', { search: '' }],
    ['an out-of-range limit', { limit: '101' }],
  ])('rejects %s before querying', async (_label, query) => {
    const { req, res } = list(query);

    await expect(callHandler(uploadHandler, req, res)).rejects.toThrow();
    expect(mockListOwnedAfterId).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/v1/files/{id}', () => {
  it('passes only the provided fields to the shared update, logs it, and returns the re-read file', async () => {
    const { req, res } = patch(FILE_ID, { file_name: 'renamed.png' });

    await callHandler(getHandler, req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockUpdateFabFile).toHaveBeenCalledWith(
      req.user,
      { id: FILE_ID, fileName: 'renamed.png' },
      expect.anything()
    );
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: FileEvents.UPDATE_FILE, metadata: { fileId: FILE_ID, fileContent: 'key.png' } }),
      expect.anything()
    );
    expect(mockLoadAccessibleFabFile).toHaveBeenCalledWith(req, FILE_ID);
    const body = res._getJSONData();
    expect(FileResponseSchema.safeParse(body).success).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('treats an empty body as a no-op update that returns the file', async () => {
    const { req, res } = patch(FILE_ID, {});

    await callHandler(getHandler, req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockUpdateFabFile).toHaveBeenCalledWith(req.user, { id: FILE_ID }, expect.anything());
  });

  it.each([
    ['an unknown field', { tags: [] }],
    ['an empty file name', { file_name: '' }],
  ])('rejects %s before updating', async (_label, body) => {
    const { req, res } = patch(FILE_ID, body);

    await expect(callHandler(getHandler, req, res)).rejects.toThrow();
    expect(mockUpdateFabFile).not.toHaveBeenCalled();
  });

  it('404s a malformed id without updating', async () => {
    const { req, res } = patch('not-an-object-id', { notes: 'x' });

    expect(await statusOf(callHandler(getHandler, req, res))).toBe(404);
    expect(mockUpdateFabFile).not.toHaveBeenCalled();
  });

  it('404s a file the caller cannot edit', async () => {
    mockUpdateFabFile.mockRejectedValue(new NotFoundError('Invalid ID'));
    const { req, res } = patch(FILE_ID, { notes: 'x' });

    expect(await statusOf(callHandler(getHandler, req, res))).toBe(404);
    expect(mockLogEvent).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/v1/files/{id}', () => {
  it.each(['deleted', 'unshared'])('answers 204 with no body when the file is %s', async action => {
    mockDeleteFileForUser.mockResolvedValue(action);
    const { req, res } = del(FILE_ID);

    await callHandler(getHandler, req, res);

    expect(res._getStatusCode()).toBe(204);
    expect(res._getData()).toBe('');
    expect(mockDeleteFileForUser).toHaveBeenCalledWith(req, FILE_ID);
  });

  it.each(['not_found', 'denied'])('404s when the shared delete reports %s', async action => {
    mockDeleteFileForUser.mockResolvedValue(action);
    const { req, res } = del(FILE_ID);

    expect(await statusOf(callHandler(getHandler, req, res))).toBe(404);
  });

  it('404s a malformed id without deleting', async () => {
    const { req, res } = del('not-an-object-id');

    expect(await statusOf(callHandler(getHandler, req, res))).toBe(404);
    expect(mockDeleteFileForUser).not.toHaveBeenCalled();
  });
});
