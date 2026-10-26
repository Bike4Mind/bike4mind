import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const {
  mockUserFindById,
  mockUserUpdateOne,
  mockStorageDelete,
  mockStorageGetSignedUrl,
  mockAppFileCtor,
  mockFileSave,
} = vi.hoisted(() => ({
  mockUserFindById: vi.fn(),
  mockUserUpdateOne: vi.fn(),
  mockStorageDelete: vi.fn(),
  mockStorageGetSignedUrl: vi.fn(),
  mockAppFileCtor: vi.fn(),
  mockFileSave: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'POST']?.(req, res),
      {
        use: () => chain,
        post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.POST = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));

vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  FileGeneratePresignedUrlRequestInput: { parse: () => ({ mimeType: 'image/png', fileSize: 123 }) },
}));

vi.mock('@bike4mind/database/content', () => {
  class AppFile {
    id = 'new-file-id';
    constructor(public doc: Record<string, unknown>) {
      mockAppFileCtor(doc);
    }
    save = mockFileSave;
  }
  return { AppFile };
});

vi.mock('@bike4mind/database', () => ({
  User: {
    findById: (...a: unknown[]) => mockUserFindById(...a),
    updateOne: (...a: unknown[]) => mockUserUpdateOne(...a),
  },
}));

vi.mock('@bike4mind/fab-pipeline', () => ({
  S3Storage: class {
    getSignedUrl = (...a: unknown[]) => mockStorageGetSignedUrl(...a);
    delete = (...a: unknown[]) => mockStorageDelete(...a);
  },
}));

vi.mock('sst', () => ({ Resource: { appFilesBucket: { name: 'bucket' } } }));
vi.mock('@server/utils/browserUploadUrl', () => ({
  resolveBrowserAppFileUploadUrl: (_id: string, url: string) => url,
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@bike4mind/server-utils/utils/errors', () => ({
  BadRequestError: class extends Error {},
  NotFoundError: class extends Error {},
}));

import handler from '../upload-photo';

const OWN = 'u1';

const run = (caller: { id: string; isAdmin: boolean } = { id: OWN, isAdmin: false }) => {
  const { req, res } = createMocks({ method: 'POST', query: { id: OWN }, body: {} });
  (req as Record<string, unknown>).user = caller;
  (req as Record<string, unknown>).ability = {};
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  mockUserFindById.mockReset().mockResolvedValue({ id: OWN, name: 'A', photoUrl: 'profile-photos/u1/old.png' });
  mockUserUpdateOne.mockReset().mockResolvedValue(undefined);
  mockStorageDelete.mockReset().mockResolvedValue(undefined);
  mockStorageGetSignedUrl.mockReset().mockResolvedValue('https://signed');
  mockAppFileCtor.mockReset();
  mockFileSave.mockReset().mockResolvedValue(undefined);
});

describe('POST /api/users/:id/upload-photo - presign only', () => {
  it('creates a pending AppFile and returns the presigned URL without touching the profile or the old photo', async () => {
    const { res, promise } = run();
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(mockAppFileCtor).toHaveBeenCalledWith(
      expect.objectContaining({ userId: OWN, status: 'pending', path: expect.stringMatching(/^profile-photos\/u1\//) })
    );
    expect(mockFileSave).toHaveBeenCalled();
    // photoUrl stays on the old (existing) photo until confirm-photo runs, so no render can hit a missing key.
    expect(mockUserUpdateOne).not.toHaveBeenCalled();
    expect(mockStorageDelete).not.toHaveBeenCalled();
    // The PUT is bound to the declared fileSize and content type, so S3 refuses a larger photo or another type.
    expect(mockStorageGetSignedUrl).toHaveBeenCalledWith(expect.any(String), 'put', {
      expiresIn: 600,
      ContentType: 'image/png',
      ContentLength: 123,
    });
    expect(res._getJSONData()).toEqual(
      expect.objectContaining({ url: 'https://signed', fileId: 'new-file-id', fileKey: expect.any(String) })
    );
  });

  it('attributes the AppFile to the profile owner when an admin uploads on their behalf', async () => {
    const { res, promise } = run({ id: 'admin-1', isAdmin: true });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(mockAppFileCtor).toHaveBeenCalledWith(expect.objectContaining({ userId: OWN }));
  });

  it('rejects a caller who is neither the owner nor an admin before looking the user up', async () => {
    const { promise } = run({ id: 'intruder', isAdmin: false });
    await expect(promise).rejects.toThrow();

    expect(mockUserFindById).not.toHaveBeenCalled();
    expect(mockFileSave).not.toHaveBeenCalled();
  });
});
