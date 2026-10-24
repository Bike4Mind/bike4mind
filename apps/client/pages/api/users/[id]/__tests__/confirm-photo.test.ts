import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const {
  mockUserFindOneAndUpdate,
  mockAppFileFindById,
  mockAppFileFindOne,
  mockAppFileFindOneAndDelete,
  mockStorageDelete,
  mockStorageGetMetadata,
  mockWithTransaction,
  mockCommitted,
  transactionSession,
} = vi.hoisted(() => ({
  mockUserFindOneAndUpdate: vi.fn(),
  mockAppFileFindById: vi.fn(),
  mockAppFileFindOne: vi.fn(),
  mockAppFileFindOneAndDelete: vi.fn(),
  mockStorageDelete: vi.fn(),
  mockStorageGetMetadata: vi.fn(),
  mockWithTransaction: vi.fn(),
  mockCommitted: vi.fn(),
  transactionSession: { id: 'photo-transaction' },
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

vi.mock('@bike4mind/database/content', () => ({
  AppFile: {
    findById: (...a: unknown[]) => mockAppFileFindById(...a),
    findOne: (...a: unknown[]) => mockAppFileFindOne(...a),
    findOneAndDelete: (...a: unknown[]) => mockAppFileFindOneAndDelete(...a),
  },
}));

vi.mock('@bike4mind/database', () => ({
  withTransaction: (callback: (session: unknown) => Promise<unknown>) => mockWithTransaction(callback),
  User: {
    findOneAndUpdate: (...a: unknown[]) => mockUserFindOneAndUpdate(...a),
  },
}));

vi.mock('@bike4mind/fab-pipeline', () => ({
  S3Storage: class {
    delete = (...a: unknown[]) => mockStorageDelete(...a);
    getMetadata = (...a: unknown[]) => mockStorageGetMetadata(...a);
  },
}));

vi.mock('sst', () => ({ Resource: { appFilesBucket: { name: 'bucket' } } }));
vi.mock('@bike4mind/server-utils/utils/objectId', () => ({ isValidObjectId: (id: unknown) => id !== 'not-an-id' }));
vi.mock('@bike4mind/server-utils/utils/errors', () => ({
  BadRequestError: class extends Error {},
  NotFoundError: class extends Error {},
}));

import { AppFileReservedTags } from '@bike4mind/common';
import handler from '../confirm-photo';

const OWN = 'u1';
const NEW_KEY = 'profile-photos/u1/new.png';
const OLD_KEY = 'profile-photos/u1/old.png';

const newFile = (over: Record<string, unknown> = {}) => ({
  id: 'f-new',
  userId: OWN,
  path: NEW_KEY,
  mimeType: 'image/png',
  tags: [AppFileReservedTags.ProfilePhoto],
  ...over,
});

const run = (
  caller: { id: string; isAdmin: boolean } = { id: OWN, isAdmin: false },
  body: unknown = { fileId: 'f-new' }
) => {
  const { req, res } = createMocks({ method: 'POST', query: { id: OWN }, body: body as object });
  (req as Record<string, unknown>).user = caller;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  mockUserFindOneAndUpdate.mockReset().mockResolvedValue({ id: OWN, name: 'A', photoUrl: OLD_KEY });
  mockAppFileFindById.mockReset().mockResolvedValue(newFile());
  mockAppFileFindOne.mockReset().mockResolvedValue(newFile());
  mockAppFileFindOneAndDelete.mockReset().mockResolvedValue({ path: OLD_KEY });
  mockStorageDelete.mockReset().mockResolvedValue(undefined);
  mockStorageGetMetadata.mockReset().mockResolvedValue({ size: 123, contentType: 'image/png' });
  mockCommitted.mockReset();
  mockWithTransaction.mockReset().mockImplementation(async (callback: (session: unknown) => Promise<unknown>) => {
    const result = await callback(transactionSession);
    mockCommitted();
    return result;
  });
});

describe('POST /api/users/:id/confirm-photo', () => {
  it('points photoUrl at the new file only after the object exists, then deletes the previous photo', async () => {
    const { res, promise } = run();
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(mockStorageGetMetadata).toHaveBeenCalledWith(NEW_KEY);
    expect(mockUserFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: OWN },
      { photoUrl: NEW_KEY },
      { new: false, session: transactionSession }
    );
    expect(mockStorageDelete).toHaveBeenCalledWith(OLD_KEY);
    expect(mockAppFileFindOne).toHaveBeenCalledWith(
      { _id: 'f-new', userId: OWN, path: NEW_KEY, mimeType: 'image/png', tags: AppFileReservedTags.ProfilePhoto },
      null,
      { session: transactionSession }
    );
    expect(mockAppFileFindOneAndDelete).toHaveBeenCalledWith(
      { path: OLD_KEY, userId: OWN, tags: AppFileReservedTags.ProfilePhoto },
      { session: transactionSession }
    );
    expect(mockStorageGetMetadata.mock.invocationCallOrder[0]).toBeLessThan(
      mockUserFindOneAndUpdate.mock.invocationCallOrder[0]
    );
    expect(mockCommitted.mock.invocationCallOrder[0]).toBeLessThan(mockStorageDelete.mock.invocationCallOrder[0]);
  });

  it('leaves photoUrl untouched and rejects when the object is not in storage yet', async () => {
    mockStorageGetMetadata.mockRejectedValue(Object.assign(new Error('head failed'), { name: 'NotFound' }));

    const { promise } = run();
    await expect(promise).rejects.toThrow('has not finished uploading');

    expect(mockUserFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockStorageDelete).not.toHaveBeenCalled();
  });

  it('surfaces a storage failure that is not a missing object instead of reporting an unfinished upload', async () => {
    mockStorageGetMetadata.mockRejectedValue(Object.assign(new Error('throttled'), { name: 'SlowDown' }));

    const { promise } = run();
    await expect(promise).rejects.toThrow('throttled');

    expect(mockUserFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects a candidate retired between HEAD and the transaction without changing the profile', async () => {
    mockAppFileFindOne.mockResolvedValue(null);

    const { promise } = run();
    await expect(promise).rejects.toThrow('Profile photo upload not found');

    expect(mockStorageGetMetadata).toHaveBeenCalledWith(NEW_KEY);
    expect(mockUserFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockStorageDelete).not.toHaveBeenCalled();
    expect(mockAppFileFindOneAndDelete).not.toHaveBeenCalled();
  });

  it('does not delete storage when retiring the previous record aborts the transaction', async () => {
    mockAppFileFindOneAndDelete.mockRejectedValue(new Error('retirement failed'));

    const { promise } = run();
    await expect(promise).rejects.toThrow('retirement failed');

    expect(mockCommitted).not.toHaveBeenCalled();
    expect(mockStorageDelete).not.toHaveBeenCalled();
  });

  it('rechecks the candidate when a write conflict retries the transaction', async () => {
    mockAppFileFindOne.mockResolvedValueOnce(newFile()).mockResolvedValueOnce(null);
    mockUserFindOneAndUpdate.mockRejectedValueOnce(new Error('write conflict'));
    mockWithTransaction.mockImplementation(async (callback: (session: unknown) => Promise<unknown>) => {
      try {
        await callback(transactionSession);
      } catch {
        return callback(transactionSession);
      }
    });

    const { promise } = run();
    await expect(promise).rejects.toThrow('Profile photo upload not found');

    expect(mockAppFileFindOne).toHaveBeenCalledTimes(2);
    expect(mockUserFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(mockStorageDelete).not.toHaveBeenCalled();
  });

  it('does not delete storage when no owned profile-photo record was retired', async () => {
    mockAppFileFindOneAndDelete.mockResolvedValue(null);

    const { res, promise } = run();
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(mockAppFileFindOneAndDelete).toHaveBeenCalledWith(
      { path: OLD_KEY, userId: OWN, tags: AppFileReservedTags.ProfilePhoto },
      { session: transactionSession }
    );
    expect(mockStorageDelete).not.toHaveBeenCalled();
  });

  it.each([null, undefined])('preserves an unstructured storage rejection (%s)', async rejection => {
    mockStorageGetMetadata.mockRejectedValue(rejection);

    const { promise } = run();
    await expect(promise).rejects.toBe(rejection);

    expect(mockWithTransaction).not.toHaveBeenCalled();
  });

  it('skips the cleanup when the profile has no previous photo', async () => {
    mockUserFindOneAndUpdate.mockResolvedValue({ id: OWN, name: 'A' });

    const { promise } = run();
    await promise;

    expect(mockUserFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: OWN },
      { photoUrl: NEW_KEY },
      { new: false, session: transactionSession }
    );
    expect(mockAppFileFindOneAndDelete).not.toHaveBeenCalled();
    expect(mockStorageDelete).not.toHaveBeenCalled();
  });

  it.each([NEW_KEY, 'profile-photos/someone-else/old.png', 'documents/u1/old.png'])(
    'skips retirement when the previous path is current or outside the owner profile prefix (%s)',
    async previousPath => {
      mockUserFindOneAndUpdate.mockResolvedValue({ id: OWN, photoUrl: previousPath });

      const { promise } = run();
      await promise;

      expect(mockAppFileFindOneAndDelete).not.toHaveBeenCalled();
      expect(mockStorageDelete).not.toHaveBeenCalled();
    }
  );

  it('still succeeds when deleting the previous photo fails', async () => {
    mockStorageDelete.mockRejectedValue(new Error('boom'));

    const { res, promise } = run();
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(mockUserFindOneAndUpdate).toHaveBeenCalled();
  });

  it.each([
    ['belongs to another user', { userId: 'someone-else' }],
    ['is not tagged as a profile photo', { tags: [] }],
    ['has a key outside the profile owner prefix', { path: 'profile-photos/victim/secret.png' }],
  ])('rejects a file that %s', async (_label, over) => {
    mockAppFileFindById.mockResolvedValue(newFile(over));

    const { promise } = run();
    await expect(promise).rejects.toThrow('Profile photo upload not found');

    expect(mockUserFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects a malformed fileId without querying the database', async () => {
    const { promise } = run(undefined, { fileId: 'not-an-id' });
    await expect(promise).rejects.toThrow('Profile photo upload not found');

    expect(mockAppFileFindById).not.toHaveBeenCalled();
    expect(mockUserFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('cleans up the photo that was live at swap time, not an earlier read', async () => {
    mockUserFindOneAndUpdate.mockResolvedValue({ id: OWN, photoUrl: 'profile-photos/u1/raced.png' });
    mockAppFileFindOneAndDelete.mockResolvedValue({ path: 'profile-photos/u1/raced.png' });

    const { promise } = run();
    await promise;

    expect(mockAppFileFindOneAndDelete).toHaveBeenCalledWith(
      { path: 'profile-photos/u1/raced.png', userId: OWN, tags: AppFileReservedTags.ProfilePhoto },
      { session: transactionSession }
    );
    expect(mockStorageDelete).toHaveBeenCalledWith('profile-photos/u1/raced.png');
    expect(mockStorageDelete).not.toHaveBeenCalledWith(OLD_KEY);
  });

  it('rejects an object whose stored content type is not the declared image type', async () => {
    mockStorageGetMetadata.mockResolvedValue({ size: 123, contentType: 'text/html' });

    const { promise } = run();
    await expect(promise).rejects.toThrow('unexpected content type');

    expect(mockUserFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockStorageDelete).not.toHaveBeenCalled();
  });

  it('accepts a stored content type that carries parameters', async () => {
    mockStorageGetMetadata.mockResolvedValue({ size: 123, contentType: 'Image/PNG; charset=binary' });

    const { res, promise } = run();
    await promise;

    expect(res._getStatusCode()).toBe(200);
  });

  it('rejects when the profile owner does not exist and leaves storage untouched', async () => {
    mockUserFindOneAndUpdate.mockResolvedValue(null);

    const { promise } = run();
    await expect(promise).rejects.toThrow('User not found');

    expect(mockStorageDelete).not.toHaveBeenCalled();
    expect(mockAppFileFindOneAndDelete).not.toHaveBeenCalled();
  });

  it('rejects a caller who is neither the owner nor an admin', async () => {
    const { promise } = run({ id: 'intruder', isAdmin: false });
    await expect(promise).rejects.toThrow('only update your own');

    expect(mockAppFileFindById).not.toHaveBeenCalled();
    expect(mockStorageGetMetadata).not.toHaveBeenCalled();
    expect(mockUserFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('lets an admin confirm on behalf of the profile owner', async () => {
    const { res, promise } = run({ id: 'admin-1', isAdmin: true });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(mockUserFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: OWN },
      { photoUrl: NEW_KEY },
      { new: false, session: transactionSession }
    );
  });
});
