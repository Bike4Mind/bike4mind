import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// The storage charge against a real replica set: the claim stamp and the counter write commit in one
// transaction, so a redelivery cannot charge twice. Only the non-database collaborators are mocked -
// @bike4mind/database stays real, which is the whole point of this suite.

type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const refs = vi.hoisted(() => ({ postHandler: null as null | Handler }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    post: (fn: Handler) => {
      refs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/utils/sqs', () => ({ sendToQueue: vi.fn() }));
vi.mock('@server/dataLakes/recomputeStatsForUploadedFile', () => ({ recomputeStatsForUploadedFile: vi.fn() }));
vi.mock('@server/s3/historyUploadComplete', () => ({ dispatch: vi.fn() }));
vi.mock('@server/s3/notebookImportComplete', () => ({ dispatch: vi.fn() }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ getMetadata: vi.fn() }) }));
// The handler reaches server/utils/config.ts for real here, which reads a long list of
// Resource.<secret>.value at import time; a permissive proxy serves the few the handler actually
// needs and a placeholder for the rest.
vi.mock('sst', () => {
  const known: Record<string, unknown> = {
    App: { stage: 'test' },
    fabFileBucket: { name: 'b4m-fab-file' },
    historyImportBucket: { name: 'b4m-history-import' },
    fabFileChunkQueue: { url: 'http://sqs/fabFileChunkQueue' },
  };
  return {
    Resource: new Proxy(known, {
      get: (target, prop: string) => (prop in target ? target[prop] : { value: 'test' }),
    }),
  };
});

import { KnowledgeType } from '@bike4mind/common';
import { FabFile, User, fabFileRepository, userRepository } from '@bike4mind/database';

let replSet: MongoMemoryReplSet;
let post: Handler;

beforeAll(async () => {
  replSet = await createMongoReplSet();
  // autoIndex off: this suite asserts nothing about indexes, and skipping the background builds
  // avoids the pool-deadlock a transaction can hit while they are in flight.
  await mongoose.connect(replSet.getUri(), { autoIndex: false });
  await import('../object-created');
  post = refs.postHandler!;
  process.env.B4M_SELF_HOST = 'true';
  process.env.INTERNAL_S3_WEBHOOK_SECRET = 'secret-token';
});

afterAll(async () => {
  delete process.env.B4M_SELF_HOST;
  delete process.env.INTERNAL_S3_WEBHOOK_SECRET;
  await mongoose.disconnect();
  await replSet?.stop();
});

beforeEach(() => {
  process.env.B4M_SELF_HOST = 'true';
  process.env.INTERNAL_S3_WEBHOOK_SECRET = 'secret-token';
});

afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

/** A user with a completed upload, exactly the state the PUT proxy leaves before MinIO notifies. */
const seedUploadedFile = async (bytes: number) => {
  const user = await User.create({
    name: 'Uploader',
    username: `uploader-${Math.random().toString(36).slice(2, 10)}`,
    password: null,
    hasUsablePassword: false,
    currentStorageSize: 0,
  });
  const file = await FabFile.create({
    userId: user.id,
    fileName: 'a.pdf',
    filePath: `uploads/${Math.random().toString(36).slice(2, 10)}.pdf`,
    type: KnowledgeType.FILE,
    fileSize: bytes,
    status: 'complete',
  });
  return { user, file };
};

const deliver = async (key: string, size: number) => {
  const { req, res } = createMocks({
    method: 'POST',
    headers: { authorization: 'secret-token' },
    body: { Records: [{ s3: { bucket: { name: 'b4m-fab-file' }, object: { key, size } } }] },
  });
  (req as unknown as { logger: unknown }).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  await post(req, res);
  return res._getStatusCode();
};

const counterOf = async (userId: string) => (await User.findById(userId).lean())?.currentStorageSize;
const recalcTruth = (userId: string) => fabFileRepository.sumFileSizeByUserId(userId);

describe('self-host MinIO webhook storage accounting (real replica set)', () => {
  it('charges N bytes once and a redelivery changes nothing', async () => {
    const { user, file } = await seedUploadedFile(4096);

    expect(await deliver(file.filePath!, 4096)).toBe(200);
    expect(await counterOf(user.id)).toBe(4096);
    // The counter agrees with what a recalculate pass would compute from the rows.
    expect(await counterOf(user.id)).toBe(await recalcTruth(user.id));

    // MinIO delivery is at-least-once: the same notification again must not charge a second time.
    expect(await deliver(file.filePath!, 4096)).toBe(200);
    expect(await counterOf(user.id)).toBe(4096);
    expect(await recalcTruth(user.id)).toBe(4096);
  });

  it('returns the counter to its start value once the file is deleted', async () => {
    const { user, file } = await seedUploadedFile(4096);
    await deliver(file.filePath!, 4096);
    expect(await counterOf(user.id)).toBe(4096);

    // Mirror the two writes the DELETE route makes (pages/api/files/[id]/index.ts): soft-delete the
    // row, then refund its fileSize. Assert only the invariant - counter == recalc truth - not the
    // route, which this suite does not drive.
    await FabFile.updateOne({ _id: file._id }, { $set: { deletedAt: new Date() } });
    await userRepository.incrementCurrentStorage(user.id, -(file.fileSize ?? 0));

    expect(await counterOf(user.id)).toBe(0);
    expect(await counterOf(user.id)).toBe(await recalcTruth(user.id));
  });
});
