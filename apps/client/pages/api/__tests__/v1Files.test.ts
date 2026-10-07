// @vitest-environment node
/**
 * Route tests for the public file endpoints (POST /api/v1/files, GET /api/v1/files/{id}).
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
  FileResponseSchema,
  createFileUploadContract,
  getFileContract,
} from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import { decideScopeGate } from '@server/middlewares/apiKeyScopeGate';

const { mockCreatePresignedUpload, mockLoadAccessibleFabFile } = vi.hoisted(() => ({
  mockCreatePresignedUpload: vi.fn(),
  mockLoadAccessibleFabFile: vi.fn(),
}));

// Strip the middleware chain but keep next-connect's registrar shape, so
// nextRouteForContract's prelude (validation + drift check) still composes and runs.
vi.mock('@server/middlewares/baseApi', () => ({
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
});

describe('file contracts', () => {
  it('gate upload on files:write and read-back on files:read', () => {
    expect(createFileUploadContract.scopes).toEqual([ApiKeyScope.WRITE_FILES]);
    expect(getFileContract.scopes).toEqual([ApiKeyScope.READ_FILES]);
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
