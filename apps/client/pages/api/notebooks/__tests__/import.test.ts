import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

type RouteHandler = (req: Request, res: Response) => Promise<unknown>;
const { upload, sign, captured } = vi.hoisted(() => ({
  upload: vi.fn(),
  sign: vi.fn(),
  captured: {} as { post?: RouteHandler },
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    post: (handler: RouteHandler) => {
      captured.post = handler;
    },
  }),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (handler: RouteHandler) => handler }));
vi.mock('@bike4mind/common', () => ({ Permission: { create: 'create' } }));
vi.mock('@bike4mind/database/auth', () => ({ Session: class Session {} }));
vi.mock('@bike4mind/fab-pipeline', () => ({
  S3Storage: class {
    upload = upload;
    getSignedUrl = sign;
  },
}));
vi.mock('sst', () => ({ Resource: { historyImportBucket: { name: 'import-bucket' } } }));
await import('../import');

describe('POST /api/notebooks/import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    upload.mockResolvedValue(undefined);
    sign.mockResolvedValue('https://storage.example/signed-upload');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([true, false])('uploads options and preserves the appropriate URL (self-host=%s)', async selfHost => {
    vi.stubEnv('B4M_SELF_HOST', String(selfHost));
    const req = {
      user: { id: 'user-1' },
      ability: { can: () => true },
      body: { conflictResolution: 'skip' },
      logger: { info: vi.fn() },
    } as unknown as Request;
    const res = { json: vi.fn() } as unknown as Response;
    await captured.post!(req, res);
    expect(upload).toHaveBeenCalledWith(expect.any(Buffer), 'notebooks/user-1/1700000000000.options.json', {
      ContentType: 'application/json',
    });
    expect(JSON.parse(upload.mock.calls[0][0].toString())).toMatchObject({ conflictResolution: 'skip' });
    if (selfHost) {
      expect(sign).not.toHaveBeenCalled();
    } else {
      expect(sign).toHaveBeenCalledExactlyOnceWith('notebooks/user-1/1700000000000.json', 'put', { expiresIn: 600 });
    }
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      importId: 1700000000000,
      uploadUrl: selfHost
        ? '/api/notebooks/import/upload?importId=1700000000000'
        : 'https://storage.example/signed-upload',
    });
  });
});
