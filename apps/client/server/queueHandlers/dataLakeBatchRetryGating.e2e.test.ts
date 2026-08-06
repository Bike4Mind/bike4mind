import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { z } from 'zod';
import { KnowledgeType } from '@bike4mind/common';
// createMongoReplSet is not exported from the package barrel / dist; deep-import the source.
// A REAL replica set is required here (not createMongoServer, used by the sibling e2e suites):
// fabFileVectorize's success path writes chunk vectors via withTransaction, and a standalone
// mongod rejects the first write inside a session with MongoServerError code 20.
import { createMongoReplSet } from '../../../../packages/database/src/__test__/createMongoServer';
import { User, FabFile, fabFileRepository, fabFileChunkRepository, dataLakeBatchRepository } from '@bike4mind/database';

/**
 * End-to-end guard for the #1412 retry-gating fix, driving the REAL fabFileVectorize dispatch
 * handler through two real SQS delivery attempts for the same file against a real
 * dataLakeBatchRepository/fabFileRepository/fabFileChunkRepository over createMongoReplSet.
 *
 * The unit tests in fabFileVectorize.test.ts already pin this behavior against MOCKED repos.
 * What only a real Mongo run can prove is the mechanical bug itself:
 * dataLakeBatchRepository.claimFileStatus only transitions a manifest file out of one of `from` -
 * once a file's entry is 'failed', no success path can ever claim it back to 'complete' (see
 * DataLakeModel.test.ts's "is a no-op once the entry is failed" case). So a premature 'failed'
 * write on a transient attempt 1 would silently strand attempt 2's real success forever; a mock
 * of claimFileStatus cannot fail that way; only the real from-set gate can.
 *
 * Mocks (mirroring fabFileVectorize.test.ts) are limited to the embedding call itself and the
 * modules that would otherwise reach out of process (queue-handler logging, websocket push, SST
 * resource resolution). @bike4mind/database and @bike4mind/common are deliberately real.
 * Consumes the built dist, so `pnpm turbo:core:build` must be current.
 */

vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...args: unknown[]) => unknown) => fn,
}));

const h = vi.hoisted(() => ({
  getVector: vi.fn(),
  getEmbedding: vi.fn(),
}));

vi.mock('@server/managers/fabFileManager', () => ({ getVector: h.getVector }));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: vi.fn(async () => ({})) },
  embeddingCacheService: { getEmbedding: h.getEmbedding, setEmbedding: vi.fn(async () => undefined) },
}));
vi.mock('@bike4mind/fab-pipeline', () => ({
  ChunkSchema: z.object({}).passthrough(),
  EmbeddingFactory: class {
    createEmbeddingService() {
      return { getModelInfo: () => ({ contextWindow: 1000 }) };
    }
  },
  getProviderFromModel: vi.fn(() => 'openai'),
  resolveEmbeddingConfig: vi.fn(() => ({ config: {}, missing: null })),
  // Mirror the real name-based guard so the failure branch classifies a plain Error correctly.
  isEmbeddingAuthError: (e: unknown) => e instanceof Error && e.name === 'EmbeddingAuthError',
}));
vi.mock('@server/websocket/utils', () => ({ sendToClient: vi.fn() }));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: vi.fn() }));
vi.mock('sst', () => ({ Resource: new Proxy({}, { get: () => new Proxy({}, { get: () => 'mock' }) }) }));

import { dispatch } from './fabFileVectorize';

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri());
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
}, 60000);
afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), updateMetadata: vi.fn() } as never;

const makeEvent = (body: Record<string, unknown>, receiveCount: number) =>
  ({
    Records: [
      {
        body: JSON.stringify(body),
        attributes: { ApproximateReceiveCount: String(receiveCount) },
      },
    ],
  }) as never;

async function seed() {
  const user = await User.create({
    username: `u-vectorize-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: 'Vectorize Tester',
  });
  const userId = user.id;

  const batch = await dataLakeBatchRepository.create({ dataLakeId: 'lake1', userId, totalFiles: 1 } as never);

  const fabFile = await FabFile.create({
    userId,
    fileName: 'x.pdf',
    type: KnowledgeType.FILE,
    mimeType: 'application/pdf',
    filePath: 'x.pdf',
    fileSize: 100,
    status: 'complete',
    batchId: batch.id,
    chunkCount: 1,
    vectorized: false,
    vectorizedChunkCount: 0,
  });
  const fabFileId = fabFile._id.toString();

  await dataLakeBatchRepository.appendFiles(batch.id, [{ fabFileId, fileName: 'x.pdf', status: 'uploaded' }]);

  const [chunk] = await fabFileChunkRepository.bulkInsert([
    {
      text: 'hello world',
      fabFileId,
      tokenCount: 5,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);

  return { userId, batchId: batch.id, fabFileId, chunkId: chunk.id };
}

describe('fabFileVectorize retry gating (#1412) - real repos + real Mongo transaction', () => {
  it('a non-final transient failure leaves the batch/file untouched and heartbeats it; the following successful retry claims the manifest all the way to complete', async () => {
    const { userId, batchId, fabFileId, chunkId } = await seed();
    const payload = { userId, fabFileId, embeddingModel: 'text-embedding-3-small', chunkIds: [chunkId] };

    const beforeAttempt1 = (await dataLakeBatchRepository.findById(batchId))!.updatedAt.getTime();

    // Attempt 1 of 3 (FAB_FILE_VECTORIZE_MAX_RECEIVE_COUNT): transient failure, not final.
    h.getEmbedding.mockResolvedValue(null); // always a cache miss, so the run reaches getVector.
    h.getVector.mockRejectedValueOnce(new Error('rate limit exceeded'));

    await expect(dispatch(makeEvent(payload, 1), {} as never, mockLogger)).rejects.toThrow('rate limit exceeded');

    const afterAttempt1 = await dataLakeBatchRepository.findById(batchId);
    expect(afterAttempt1?.failedFiles).toBe(0);
    expect(afterAttempt1?.processingFailedFiles).toBe(0);
    expect(afterAttempt1?.vectorizedFiles).toBe(0);
    // Untouched: the exact manifest entry a premature write would have poisoned unrecoverably.
    expect(afterAttempt1?.files[0].status).toBe('uploaded');
    expect(afterAttempt1?.status).not.toBe('completed');
    expect(afterAttempt1?.status).not.toBe('completed_with_errors');
    expect(afterAttempt1?.completedAt).toBeFalsy();
    // touchIfActive fired even though nothing else changed - the heartbeat that keeps the
    // read-time stuck-batch reconciler from forcing this batch terminal mid-retry.
    expect(afterAttempt1!.updatedAt.getTime()).toBeGreaterThan(beforeAttempt1);

    const fileAfterAttempt1 = await fabFileRepository.findById(fabFileId);
    expect(fileAfterAttempt1?.error).toBeFalsy();

    // Attempt 2 of 3: the retry succeeds. Still non-final by count, but the gate never triggers
    // here since nothing throws - this exercises the success path, not isFinalDeliveryAttempt.
    h.getVector.mockResolvedValue([0.1, 0.2, 0.3]);

    await dispatch(makeEvent(payload, 2), {} as never, mockLogger);

    const afterAttempt2 = await dataLakeBatchRepository.findById(batchId);
    // THE key assertion: claimFileStatus can only transition a manifest entry out of one of its
    // `from` states, so if attempt 1 had wrongly written 'failed' this claim would silently
    // no-op and the file would stay stuck at 'failed' forever (see DataLakeModel.test.ts's
    // "is a no-op once the entry is failed" case) - it reaching 'complete' proves attempt 1
    // really left the manifest at 'uploaded'.
    expect(afterAttempt2?.files[0].status).toBe('complete');
    expect(afterAttempt2?.vectorizedFiles).toBe(1);
    expect(afterAttempt2?.failedFiles).toBe(0);
    expect(afterAttempt2?.processingFailedFiles).toBe(0);
    // Not 'completed_with_errors': the earlier transient failure left no trace on the counters.
    expect(afterAttempt2?.status).toBe('completed');

    const fileAfterAttempt2 = await fabFileRepository.findById(fabFileId);
    expect(fileAfterAttempt2?.error).toBeFalsy();
    expect(fileAfterAttempt2?.vectorized).toBe(true);
  });

  it('a genuine final failure lands in processingFailedFiles, distinct from a browser upload failure (#1412 AC2)', async () => {
    const { batchId, fabFileId, chunkId, userId } = await seed();
    const payload = { userId, fabFileId, embeddingModel: 'text-embedding-3-small', chunkIds: [chunkId] };

    h.getVector.mockRejectedValue(new Error('rate limit exceeded'));

    // Final attempt (3 of FAB_FILE_VECTORIZE_MAX_RECEIVE_COUNT) - retries genuinely exhausted.
    await expect(dispatch(makeEvent(payload, 3), {} as never, mockLogger)).rejects.toThrow('rate limit exceeded');

    const afterFinal = await dataLakeBatchRepository.findById(batchId);
    // The real signal the client's Upload Complete dialog now reads to say "failed to
    // process" instead of a bare "failed" (which would misread as an upload failure).
    expect(afterFinal?.processingFailedFiles).toBe(1);
    expect(afterFinal?.failedFiles).toBe(1);
    expect(afterFinal?.files[0].status).toBe('failed');
    expect(afterFinal?.status).toBe('completed_with_errors');

    const fileAfterFinal = await fabFileRepository.findById(fabFileId);
    expect(fileAfterFinal?.error).toBeTruthy();
  });
});
