import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { z } from 'zod';
import { KnowledgeType } from '@bike4mind/common';
// See dataLakeBatchRetryGating.e2e.test.ts: a REAL replica set is required because
// fabFileVectorize's success path writes chunk vectors via withTransaction.
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import {
  User,
  FabFile,
  AdminSettings,
  fabFileRepository,
  fabFileChunkRepository,
  dataLakeBatchRepository,
  dataLakeRepository,
} from '@bike4mind/database';

/**
 * End-to-end guard for the batch-accounting half of the stranded-vectorize recovery, driving the
 * REAL fabFileChunk and fabFileVectorize dispatch handlers over a real Mongo.
 *
 * The file-level recovery (chunks get their vectors) was already covered; what only a real Mongo
 * run can prove is the accounting, because the mechanism is a from-set gate no mock reproduces:
 * dataLakeBatchRepository.claimFileStatus can only move a manifest entry BETWEEN the states it is
 * given, and 'failed' appears in no success path's from-set. So a strand that wrote 'failed' used
 * to make the file permanently unclaimable - the recovered file kept its stale error text on the
 * batch, never counted toward vectorizedFiles, and (when it was the last outstanding file) left
 * the batch finalized 'completed_with_errors' over a file that succeeded.
 *
 * Mocks are limited to what would otherwise reach out of process (queue-handler logging, SQS,
 * websocket push, S3, CloudWatch, SST resource resolution) plus the embedding call itself.
 * @bike4mind/database, @bike4mind/common and the batch-progress module are deliberately real.
 * Consumes the built dist, so `pnpm turbo:core:build` must be current.
 */

vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...args: unknown[]) => unknown) => fn,
  MARK_PAUSED_MAX_ATTEMPTS: 3,
  MARK_PAUSED_RETRY_DELAY_MS: 0,
}));

const h = vi.hoisted(() => ({
  sendToQueue: vi.fn(async () => undefined),
  getVector: vi.fn(),
  getEmbedding: vi.fn(),
}));

vi.mock('@server/utils/sqs', () => ({ sendToQueue: (...a: unknown[]) => h.sendToQueue(...(a as [])) }));
vi.mock('@server/managers/fabFileManager', () => ({ getVector: h.getVector }));
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return {
    ...actual,
    apiKeyService: { getEffectiveLLMApiKeys: vi.fn(async () => ({})) },
    embeddingCacheService: { getEmbedding: h.getEmbedding, setEmbedding: vi.fn(async () => undefined) },
  };
});
vi.mock('@bike4mind/fab-pipeline', () => ({
  ChunkSchema: z.object({}).passthrough(),
  EmbeddingFactory: class {
    createEmbeddingService() {
      return { getModelInfo: () => ({ contextWindow: 1000 }) };
    }
  },
  getProviderFromModel: vi.fn(() => 'openai'),
  resolveEmbeddingConfig: vi.fn(() => ({ config: {}, missing: null })),
  isEmbeddingAuthError: (e: unknown) => e instanceof Error && e.name === 'EmbeddingAuthError',
  // See the sibling e2e: this suite's mock vectors are 3-wide, so Atlas dimension validation is
  // bypassed here and covered on its own elsewhere.
  getAtlasIndexForModel: vi.fn(() => null),
  // Imported by fabFileChunk; never reached here (every file under test is already chunked).
  effectiveChunkTokenLimit: vi.fn(() => 512),
  FabFileChunkSearchIndex: { deleteByFabFileId: vi.fn() },
}));
vi.mock('@server/websocket/utils', () => ({ sendToClient: vi.fn(async () => undefined) }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: vi.fn(() => ({ getContentAsBuffer: vi.fn() })) }));
vi.mock('@server/utils/cloudwatch', () => ({
  recordBatchCompletion: vi.fn(async () => undefined),
  recordTaxonomyDailyCapExceeded: vi.fn(async () => undefined),
}));
// Spend levers read as absent -> coded defaults -> the gate grants, keeping this suite about
// accounting rather than cost governance. BadRequestError is re-declared because fabFileChunk
// imports it from the same barrel.
vi.mock('@bike4mind/utils', () => ({
  getSettingsByNames: vi.fn(async () => ({})),
  BadRequestError: class BadRequestError extends Error {},
}));
vi.mock('sst', () => ({ Resource: new Proxy({}, { get: () => new Proxy({}, { get: () => 'mock' }) }) }));

import { dispatch as chunkDispatch } from './fabFileChunk';
import { dispatch as vectorizeDispatch } from './fabFileVectorize';
import { FAB_FILE_CHUNK_MAX_RECEIVE_COUNT } from './sqsDelivery';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const EMBEDDING_MODEL = 'text-embedding-3-small';
const TERMINAL_STATUSES = ['completed', 'completed_with_errors', 'failed', 'cancelled'];
const ENQUEUE_ERR = 'SQS throttled';

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});
afterEach(async () => {
  vi.clearAllMocks();
  await mongoose.connection.dropDatabase();
});

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), updateMetadata: vi.fn() } as never;

const makeEvent = (body: Record<string, unknown>, receiveCount = 1) =>
  ({
    Records: [{ body: JSON.stringify(body), attributes: { ApproximateReceiveCount: String(receiveCount) } }],
  }) as never;

/**
 * `otherUnfinishedFile` adds a second manifest entry still in flight, so the strand is NOT the
 * last outstanding file: the batch stays 'processing' and the resume's revert has to land without
 * a reopen preceding it, which every other case in this file has in front of it.
 */
async function seed(opts: { otherUnfinishedFile?: boolean } = {}) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await AdminSettings.create({ settingName: 'defaultEmbeddingModel', settingValue: EMBEDDING_MODEL });

  const user = await User.create({ username: `u-strand-${stamp}`, name: 'Strand Tester' });
  const userId = user.id;

  const lake = await dataLakeRepository.create({
    name: 'strand-e2e',
    slug: `strand-e2e-${stamp}`,
    fileTagPrefix: `se2e-${stamp}:`,
    datalakeTag: `datalake:se2e-${stamp}`,
    createdByUserId: userId,
    status: 'active',
  } as never);

  const batch = await dataLakeBatchRepository.create({
    dataLakeId: lake.id,
    userId,
    totalFiles: opts.otherUnfinishedFile ? 2 : 1,
  } as never);

  // Already chunked with a vectorless chunk: the exact committed-chunks-but-no-vectors state a
  // failed fan-out leaves behind, and the one the chunk handler resumes rather than re-chunks.
  const fabFile = await FabFile.create({
    userId,
    fileName: 'x.pdf',
    type: KnowledgeType.FILE,
    mimeType: 'application/pdf',
    filePath: 'x.pdf',
    fileSize: 100,
    status: 'complete',
    batchId: batch.id,
    chunked: true,
    chunkCount: 1,
    embeddingModel: EMBEDDING_MODEL,
    vectorized: false,
    vectorizedChunkCount: 0,
  });
  const fabFileId = fabFile._id.toString();

  await dataLakeBatchRepository.appendFiles(batch.id, [{ fabFileId, fileName: 'x.pdf', status: 'chunking' }]);
  await dataLakeBatchRepository.incrementCounter(batch.id, 'chunkedFiles');
  if (opts.otherUnfinishedFile) {
    await dataLakeBatchRepository.appendFiles(batch.id, [
      { fabFileId: new mongoose.Types.ObjectId().toString(), fileName: 'y.pdf', status: 'uploaded' },
    ]);
  }

  const [chunk] = await fabFileChunkRepository.bulkInsert([
    { text: 'hello world', fabFileId, tokenCount: 5, createdAt: new Date(), updatedAt: new Date() },
  ]);

  return { userId, batchId: batch.id, fabFileId, chunkId: chunk.id };
}

/** Strand the file: a final-attempt fan-out failure, which is what writes the failure accounting. */
async function strand(userId: string, fabFileId: string) {
  h.sendToQueue.mockRejectedValue(new Error(ENQUEUE_ERR));
  await expect(
    chunkDispatch(makeEvent({ fabFileId, userId }, FAB_FILE_CHUNK_MAX_RECEIVE_COUNT), {} as never, mockLogger)
  ).rejects.toThrow(ENQUEUE_ERR);
  h.sendToQueue.mockReset();
  h.sendToQueue.mockResolvedValue(undefined);
}

describe('stranded vectorize recovery - batch accounting (real repos + real Mongo)', () => {
  it('strands the batch first: the manifest entry is failed and both failure counters are spent', async () => {
    const { userId, batchId, fabFileId } = await seed();
    await strand(userId, fabFileId);

    const batch = await dataLakeBatchRepository.findById(batchId);
    expect(batch?.failedFiles).toBe(1);
    expect(batch?.processingFailedFiles).toBe(1);
    expect(batch?.vectorizedFiles).toBe(0);
    expect(batch?.files[0].status).toBe('failed');
    expect(batch?.files[0].error).toContain('Could not hand off for vector indexing');
    // The strand was the last outstanding file, so it also finalized the batch over a file that
    // is about to recover - the second half of the same root cause.
    expect(batch?.status).toBe('completed_with_errors');
  });

  it('resume gives the failure counters back, clears the manifest error, and reopens the batch', async () => {
    const { userId, batchId, fabFileId } = await seed();
    await strand(userId, fabFileId);

    await chunkDispatch(makeEvent({ fabFileId, userId }), {} as never, mockLogger);

    const batch = await dataLakeBatchRepository.findById(batchId);
    expect(batch?.failedFiles).toBe(0);
    expect(batch?.processingFailedFiles).toBe(0);
    // Back to where the strand found it, so the vectorize handler's own claim can win.
    expect(batch?.files[0].status).toBe('chunking');
    expect(batch?.files[0].error).toBeFalsy();
    expect(batch?.status).toBe('processing');
    expect(batch?.completedAt).toBeFalsy();

    // The two surfaces agree: the file no longer reports the error the batch just dropped.
    const file = await fabFileRepository.findById(fabFileId);
    expect(file?.error).toBeFalsy();
    expect(file?.vectorizeEnqueueFailedAt).toBeFalsy();

    // The fan-out actually went back out - the recovery is real work, not just bookkeeping.
    expect(h.sendToQueue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ fabFileId }));
  });

  it('the recovered file then claims all the way to complete and settles the batch as completed', async () => {
    const { userId, batchId, fabFileId, chunkId } = await seed();
    await strand(userId, fabFileId);
    await chunkDispatch(makeEvent({ fabFileId, userId }), {} as never, mockLogger);

    h.getEmbedding.mockResolvedValue(null);
    h.getVector.mockResolvedValue([0.1, 0.2, 0.3]);
    await vectorizeDispatch(
      makeEvent({ userId, fabFileId, embeddingModel: EMBEDDING_MODEL, chunkIds: [chunkId] }),
      {} as never,
      mockLogger
    );

    const batch = await dataLakeBatchRepository.findById(batchId);
    expect(batch?.files[0].status).toBe('complete');
    expect(batch?.vectorizedFiles).toBe(1);
    expect(batch?.failedFiles).toBe(0);
    expect(batch?.processingFailedFiles).toBe(0);
    // Re-evaluated, not left at the verdict the strand wrote.
    expect(batch?.status).toBe('completed');
  });

  it('counts a file whose chunks already hold every vector, since nothing else will claim it', async () => {
    const { userId, batchId, fabFileId, chunkId } = await seed();
    await strand(userId, fabFileId);

    // The vectors landed while the manifest entry read 'failed' - no fan-out is left to resume,
    // so the resume itself owes the batch the vectorizedFiles.
    await fabFileChunkRepository.update({ id: chunkId, vector: [0.1, 0.2, 0.3] } as never);

    await chunkDispatch(makeEvent({ fabFileId, userId }), {} as never, mockLogger);

    const batch = await dataLakeBatchRepository.findById(batchId);
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(batch?.files[0].status).toBe('complete');
    expect(batch?.files[0].error).toBeFalsy();
    expect(batch?.vectorizedFiles).toBe(1);
    expect(batch?.failedFiles).toBe(0);
    expect(batch?.status).toBe('completed');
  });

  // Every case above strands the LAST outstanding file, so the batch is always terminal by the
  // time the resume runs and reopenFinalizedWithErrors always matches. This is the other branch:
  // a batch still 'processing', where the revert must land with no reopen in front of it.
  it('reverts on a batch that is still processing, with a second file yet to finish', async () => {
    const { userId, batchId, fabFileId, chunkId } = await seed({ otherUnfinishedFile: true });
    await strand(userId, fabFileId);

    const stranded = await dataLakeBatchRepository.findById(batchId);
    // Not the last outstanding file, so nothing finalized the batch - it is still where the seed
    // left it, which is what makes reopenFinalizedWithErrors a no-op below.
    expect(TERMINAL_STATUSES).not.toContain(stranded?.status);
    expect(stranded?.completedAt).toBeFalsy();
    expect(stranded?.failedFiles).toBe(1);

    await chunkDispatch(makeEvent({ fabFileId, userId }), {} as never, mockLogger);

    h.getEmbedding.mockResolvedValue(null);
    h.getVector.mockResolvedValue([0.1, 0.2, 0.3]);
    await vectorizeDispatch(
      makeEvent({ userId, fabFileId, embeddingModel: EMBEDDING_MODEL, chunkIds: [chunkId] }),
      {} as never,
      mockLogger
    );

    const batch = await dataLakeBatchRepository.findById(batchId);
    expect(batch?.failedFiles).toBe(0);
    expect(batch?.processingFailedFiles).toBe(0);
    expect(batch?.vectorizedFiles).toBe(1);
    expect(batch?.files[0].status).toBe('complete');
    expect(batch?.files[0].error).toBeFalsy();
    // Still one file outstanding, so the batch must NOT have been settled by the recovery.
    expect(TERMINAL_STATUSES).not.toContain(batch?.status);
    expect(batch?.completedAt).toBeFalsy();
    expect(batch?.files[1].status).toBe('uploaded');
  });

  it('a resume that fails again re-records the failure on both the file and the batch', async () => {
    const { userId, batchId, fabFileId } = await seed();
    await strand(userId, fabFileId);

    h.sendToQueue.mockRejectedValue(new Error(ENQUEUE_ERR));
    await expect(
      chunkDispatch(makeEvent({ fabFileId, userId }, FAB_FILE_CHUNK_MAX_RECEIVE_COUNT), {} as never, mockLogger)
    ).rejects.toThrow(ENQUEUE_ERR);

    const batch = await dataLakeBatchRepository.findById(batchId);
    expect(batch?.failedFiles).toBe(1);
    expect(batch?.processingFailedFiles).toBe(1);
    expect(batch?.files[0].status).toBe('failed');
    const file = await fabFileRepository.findById(fabFileId);
    expect(file?.error).toContain('Could not hand off for vector indexing');
    expect(file?.vectorizeEnqueueFailedAt).toBeTruthy();
  });
});
