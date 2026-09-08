import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const {
  mockUserFindById,
  mockUserUpdateOne,
  mockAppFileFindOne,
  mockAppFileFindOneAndDelete,
  mockStorageDelete,
  mockStorageGetSignedUrl,
} = vi.hoisted(() => ({
  mockUserFindById: vi.fn(),
  mockUserUpdateOne: vi.fn(),
  mockAppFileFindOne: vi.fn(),
  mockAppFileFindOneAndDelete: vi.fn(),
  mockStorageDelete: vi.fn(),
  mockStorageGetSignedUrl: vi.fn(),
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

const withSession = (value: unknown) => ({ session: () => Promise.resolve(value) });

vi.mock('@bike4mind/database/content', () => {
  class AppFile {
    id = 'new-file-id';
    constructor(public doc: Record<string, unknown>) {}
    save = vi.fn().mockResolvedValue(undefined);
    static findOne = (...a: unknown[]) => withSession(mockAppFileFindOne(...a));
    static findOneAndDelete = (...a: unknown[]) => withSession(mockAppFileFindOneAndDelete(...a));
  }
  return { AppFile };
});

vi.mock('@bike4mind/database', () => ({
  User: {
    findById: (...a: unknown[]) => mockUserFindById(...a),
    updateOne: (...a: unknown[]) => withSession(mockUserUpdateOne(...a)),
  },
  withTransaction: (fn: (session: unknown) => unknown) => fn({}),
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
vi.mock('@server/utils/errors', () => ({
  BadRequestError: class extends Error {},
  NotFoundError: class extends Error {},
}));

import handler from '../upload-photo';

const OWN = 'u1';

const run = (photoUrl: string | undefined) => {
  const { req, res } = createMocks({ method: 'POST', query: { id: OWN }, body: {} });
  (req as Record<string, unknown>).user = { id: OWN, isAdmin: false };
  (req as Record<string, unknown>).ability = {};
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  mockUserFindById.mockReset();
  mockUserUpdateOne.mockReset().mockResolvedValue(undefined);
  mockAppFileFindOne.mockReset();
  mockAppFileFindOneAndDelete.mockReset().mockResolvedValue(undefined);
  mockStorageDelete.mockReset().mockResolvedValue(undefined);
  mockStorageGetSignedUrl.mockReset().mockResolvedValue('https://signed');
});

describe('POST /api/users/:id/upload-photo - stored photoUrl deref guard', () => {
  it('does NOT delete the S3 object or AppFile when the existing photo file is not owned by the caller', async () => {
    mockUserFindById.mockResolvedValue({ id: OWN, name: 'A', photoUrl: 'profile-photos/victim/secret.png' });
    mockAppFileFindOne.mockReturnValue({ userId: 'someone-else' });

    const { res, promise } = run('profile-photos/victim/secret.png');
    await promise;

    expect(res._getStatusCode()).toBe(200);
    // The destructive operations must be skipped for a foreign key.
    expect(mockStorageDelete).not.toHaveBeenCalled();
    expect(mockAppFileFindOneAndDelete).not.toHaveBeenCalled();
    // The stale/foreign key is still cleared off the profile.
    expect(mockUserUpdateOne).toHaveBeenCalledWith({ _id: OWN }, { $unset: { photoUrl: 1 } });
  });

  it('deletes the caller-owned previous photo file on re-upload', async () => {
    mockUserFindById.mockResolvedValue({ id: OWN, name: 'A', photoUrl: 'profile-photos/u1/own.png' });
    mockAppFileFindOne.mockReturnValue({ userId: OWN });

    const { res, promise } = run('profile-photos/u1/own.png');
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(mockStorageDelete).toHaveBeenCalledWith('profile-photos/u1/own.png');
    expect(mockAppFileFindOneAndDelete).toHaveBeenCalledWith({ path: 'profile-photos/u1/own.png' });
  });
});
