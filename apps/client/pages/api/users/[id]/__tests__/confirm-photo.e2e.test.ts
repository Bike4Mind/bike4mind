import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMocks } from 'node-mocks-http';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';

const { storageDelete, storageMetadata } = vi.hoisted(() => ({
  storageDelete: vi.fn(),
  storageMetadata: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({ baseApi: () => ({ post: (handler: unknown) => handler }) }));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (handler: unknown) => handler }));
vi.mock('@bike4mind/fab-pipeline', () => ({
  S3Storage: class {
    delete = storageDelete;
    getMetadata = storageMetadata;
  },
}));
vi.mock('sst', () => ({ Resource: { appFilesBucket: { name: 'test-bucket' } } }));

import { User } from '@bike4mind/database';
import { AppFile } from '@bike4mind/database/content';
import { AppFileReservedTags } from '@bike4mind/common';
import handler from '../confirm-photo';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoReplSet>>;
const ownerId = new mongoose.Types.ObjectId().toString();
const photoPath = (name: string) => `profile-photos/${ownerId}/${name}.png`;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
};

const confirm = async (fileId: string) => {
  const { req, res } = createMocks({ method: 'POST', query: { id: ownerId }, body: { fileId } });
  Object.assign(req, { user: { id: ownerId, isAdmin: false } });
  await (handler as unknown as (request: unknown, response: unknown) => Promise<unknown>)(req, res);
  return res._getStatusCode();
};

beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await User.collection.deleteMany({});
  await AppFile.collection.deleteMany({});
  // The handler only needs an existing user and photoUrl; avoid unrelated account defaults/hooks.
  await User.collection.insertOne({ _id: new mongoose.Types.ObjectId(ownerId), photoUrl: photoPath('a') });
  await AppFile.create(
    ['a', 'b', 'c'].map(name => ({
      userId: ownerId,
      name,
      size: 123,
      path: photoPath(name),
      mimeType: 'image/png',
      tags: [AppFileReservedTags.ProfilePhoto],
    }))
  );
  storageDelete.mockReset().mockResolvedValue(undefined);
  storageMetadata.mockReset().mockResolvedValue({ size: 123, contentType: 'image/png' });
});

const fileIdFor = async (name: string) => {
  const file = await AppFile.findOne({ path: photoPath(name) }).orFail();
  return file.id as string;
};

describe('profile photo confirmation transactions', () => {
  it('rejects a stale re-confirm after a competing transaction retires its candidate', async () => {
    const candidateRead = deferred();
    const continueSwap = deferred();
    const originalSwap = User.findOneAndUpdate.bind(User);
    let paused = false;
    vi.spyOn(User, 'findOneAndUpdate').mockImplementation((...args: Parameters<typeof User.findOneAndUpdate>) => {
      if (!paused) {
        paused = true;
        candidateRead.resolve();
        return continueSwap.promise.then(() => originalSwap(...args)) as ReturnType<typeof User.findOneAndUpdate>;
      }
      return originalSwap(...args);
    });

    const staleResult = confirm(await fileIdFor('a')).then(
      () => null,
      (error: unknown) => error
    );
    try {
      await candidateRead.promise;
      expect(await confirm(await fileIdFor('b'))).toBe(200);
    } finally {
      continueSwap.resolve();
    }
    expect(await staleResult).toMatchObject({ message: 'Profile photo upload not found' });
    expect((await User.findById(ownerId).orFail()).photoUrl).toBe(photoPath('b'));
    expect(await AppFile.exists({ path: photoPath('b') })).toBeTruthy();
    expect(storageDelete).toHaveBeenCalledExactlyOnceWith(photoPath('a'));
  });

  it('keeps a valid final pointer when two fresh photos confirm concurrently', async () => {
    const results = await Promise.all([confirm(await fileIdFor('b')), confirm(await fileIdFor('c'))]);
    expect(results).toEqual([200, 200]);
    const user = await User.findById(ownerId).orFail();
    expect(await AppFile.exists({ path: user.photoUrl })).toBeTruthy();
    expect(storageDelete.mock.calls.flat()).not.toContain(user.photoUrl);
    expect(await AppFile.countDocuments({ userId: ownerId })).toBe(1);
  });

  it('rolls back the pointer when retiring the old record fails', async () => {
    vi.spyOn(AppFile, 'findOneAndDelete').mockImplementationOnce(() => {
      throw new Error('retirement failed');
    });
    await expect(confirm(await fileIdFor('b'))).rejects.toThrow('retirement failed');
    expect((await User.findById(ownerId).orFail()).photoUrl).toBe(photoPath('a'));
    expect(await AppFile.exists({ path: photoPath('a') })).toBeTruthy();
    expect(storageDelete).not.toHaveBeenCalled();
  });
});
