/**
 * Real-Mongo cover for the resume's embedding-space guard (#2766).
 *
 * The unit suite in fabFileChunk.test.ts mocks `distinctEmbeddingModelsByFabFileId` and
 * `countUnlabeledVectorChunksByFabFileId` outright, so it proves what the handler does GIVEN a
 * classification and nothing about whether real chunk rows produce that classification. The whole
 * guard rests on those two queries meaning what their names say, and their filters are subtle in
 * exactly the way a mock hides: one selects `embeddingModel: { $nin: [null, ''] }` while the other
 * selects the complement through a three-arm `$or`, and both are scoped to `'vector.0': $exists`.
 * A chunk that is vector-bearing-but-unlabeled has to land in the second and not the first, and
 * only a real mongod can say whether it does.
 *
 * Mirrors vectorizeStrandRecovery.e2e.test.ts: real @bike4mind/database against a throwaway
 * replica set, everything that leaves the process mocked. Consumes the built dist, so
 * `pnpm turbo:core:build` must be current.
 *
 * Runs in the integration lane only - `CLIENT_TEST_LANE=integration` (apps/client/package.json's
 * `test:integration`, the `client-integration` CI job). Without it vitest EXCLUDES `*.e2e.test.ts`
 * and reports 0 tests with exit 0, which reads as a pass.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const h = vi.hoisted(() => ({ sendToQueue: vi.fn(async () => undefined) }));

vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...args: unknown[]) => unknown) => fn,
  MARK_PAUSED_MAX_ATTEMPTS: 3,
  MARK_PAUSED_RETRY_DELAY_MS: 0,
}));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: (...a: unknown[]) => h.sendToQueue(...a) }));
vi.mock('@server/websocket/utils', () => ({ sendToClient: vi.fn(async () => undefined) }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: vi.fn(() => ({ getContentAsBuffer: vi.fn() })) }));
vi.mock('sst', () => ({
  Resource: new Proxy({}, { get: () => ({ url: 'https://queue.test', managementEndpoint: 'wss://ws.test' }) }),
}));

import {
  AdminSettings,
  FabFile,
  User,
  dataLakeBatchRepository,
  fabFileChunkRepository,
  fabFileRepository,
} from '@bike4mind/database';
import { KnowledgeType } from '@bike4mind/common';
import { dispatch } from './fabFileChunk';
import { FAB_FILE_CHUNK_MAX_RECEIVE_COUNT } from './sqsDelivery';

const DEPLOYMENT_DEFAULT = 'text-embedding-3-small';
const COMMITTED_SPACE = 'voyage-3';
const RETIRED_SPACE = 'text-embedding-retired-001'; // deliberately absent from SupportedEmbeddingModelSchema

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), updateMetadata: vi.fn() } as never;

/**
 * Delivered as the FINAL attempt by default. deferFailureIfRetryable suppresses the whole failure
 * record on every earlier one, so a refusal delivered as attempt 1 leaves `error` unwritten and an
 * assertion against it would be checking a file the handler deliberately had not marked yet.
 */
const makeEvent = (body: Record<string, unknown>, receiveCount = FAB_FILE_CHUNK_MAX_RECEIVE_COUNT) =>
  ({
    Records: [{ body: JSON.stringify(body), attributes: { ApproximateReceiveCount: String(receiveCount) } }],
  }) as never;

let replSet: Awaited<ReturnType<typeof createMongoReplSet>> | undefined;

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

/** A chunk with a real vector in `space`, or a vectorless one when `space` is null. */
type SeedChunk = { space: string | null | undefined; vectorized: boolean };

async function seedFile(fileLabel: string | undefined, chunks: SeedChunk[]) {
  await AdminSettings.create({ settingName: 'defaultEmbeddingModel', settingValue: DEPLOYMENT_DEFAULT });
  const user = await User.create({ username: `u-space-${Date.now()}`, name: 'Space Tester' });
  const userId = user._id.toString();
  const fabFile = await FabFile.create({
    userId,
    fileName: 'x.pdf',
    type: KnowledgeType.FILE,
    mimeType: 'application/pdf',
    filePath: 'x.pdf',
    fileSize: 100,
    status: 'complete',
    chunked: true,
    chunkCount: chunks.length,
    ...(fileLabel ? { embeddingModel: fileLabel } : {}),
    vectorized: false,
    vectorizedChunkCount: 0,
  });
  const fabFileId = fabFile._id.toString();
  await fabFileChunkRepository.bulkInsert(
    chunks.map((c, i) => ({
      text: `chunk ${i}`,
      fabFileId,
      tokenCount: 5,
      // `vector.0` existing is what every one of the three queries keys on.
      ...(c.vectorized ? { vector: [0.1, 0.2, 0.3] } : {}),
      ...(c.space === undefined ? {} : { embeddingModel: c.space }),
    })) as never
  );
  return { fabFileId, userId };
}

const requestedModel = () =>
  (h.sendToQueue.mock.calls[0]?.[1] as { embeddingModel: string } | undefined)?.embeddingModel;

describe('resume embedding-space guard against a real mongod (#2766)', () => {
  it('resumes in the space the existing vectors declare, not the deployment default', async () => {
    // The file label says one thing and the vectors say another - the vectors win.
    const { fabFileId, userId } = await seedFile('text-embedding-3-large', [
      { space: COMMITTED_SPACE, vectorized: true },
      { space: undefined, vectorized: false },
    ]);

    await dispatch(makeEvent({ fabFileId, userId }), {} as never, mockLogger);

    expect(requestedModel()).toBe(COMMITTED_SPACE);
  });

  it('refuses rather than finish a file whose vectors are in a retired space', async () => {
    const { fabFileId, userId } = await seedFile(DEPLOYMENT_DEFAULT, [
      { space: RETIRED_SPACE, vectorized: true },
      { space: undefined, vectorized: false },
    ]);

    await expect(dispatch(makeEvent({ fabFileId, userId }), {} as never, mockLogger)).rejects.toThrow(
      /no longer available/
    );

    expect(h.sendToQueue).not.toHaveBeenCalled();
    const stored = await FabFile.findById(fabFileId).lean();
    expect(stored?.error).toContain('Reprocess it');
    expect(stored?.error).not.toContain(RETIRED_SPACE); // user-safe: no model ids in the tooltip
  });

  it('refuses a file whose vectors genuinely span two spaces', async () => {
    const { fabFileId, userId } = await seedFile(undefined, [
      { space: COMMITTED_SPACE, vectorized: true },
      { space: DEPLOYMENT_DEFAULT, vectorized: true },
      { space: undefined, vectorized: false },
    ]);

    await expect(dispatch(makeEvent({ fabFileId, userId }), {} as never, mockLogger)).rejects.toThrow(
      /more than one search space/
    );

    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  // The classification that a mock most easily gets wrong: these chunks HAVE vectors, so they are
  // not in the resume set, but carry no label, so they contribute nothing to the distinct set. The
  // file must read as `unrecorded` (warn and proceed), never as `none` (proceed silently) and never
  // as a refusal - most of the real corpus looks exactly like this.
  it('treats vector-bearing but unlabeled chunks as an unrecorded space: warns, still resumes', async () => {
    const { fabFileId, userId } = await seedFile(undefined, [
      { space: undefined, vectorized: true },
      { space: '', vectorized: true }, // the empty-string arm of the unlabeled filter
      { space: undefined, vectorized: false },
    ]);

    await dispatch(makeEvent({ fabFileId, userId }), {} as never, mockLogger);

    expect(requestedModel()).toBe(DEPLOYMENT_DEFAULT);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('no recorded embedding space'));
  });

  // Both queries firing on the SAME file, which is the interaction a mock cannot stage wrong: the
  // labelled vector lands in the distinct set, the unlabelled one in the count, and only both
  // together read as `mixed`. The declared space still wins, and the uncertainty is reported.
  it('resumes in the declared space but warns when unlabelled vectors sit beside it', async () => {
    const { fabFileId, userId } = await seedFile(undefined, [
      { space: COMMITTED_SPACE, vectorized: true },
      { space: undefined, vectorized: true },
      { space: undefined, vectorized: false },
    ]);

    await dispatch(makeEvent({ fabFileId, userId }), {} as never, mockLogger);

    expect(requestedModel()).toBe(COMMITTED_SPACE);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('no recorded space'));
  });

  // Seeded WITH a label that differs from the default, because the arm's decision is "the file
  // label still wins where nothing contradicts it" - the chunks were sized against it. Seeding no
  // label instead would assert the default, which is what a mutant that ignores the label entirely
  // also returns, so the case could not fail.
  it('keeps the file label when the file holds no vectors at all', async () => {
    const { fabFileId, userId } = await seedFile(COMMITTED_SPACE, [
      { space: undefined, vectorized: false },
      { space: undefined, vectorized: false },
    ]);

    await dispatch(makeEvent({ fabFileId, userId }), {} as never, mockLogger);

    expect(requestedModel()).toBe(COMMITTED_SPACE);
  });

  // Silence is a SEPARATE case from the one above, and it needs the label gone to mean anything.
  // `'vector.0': $exists` is what keeps these never-embedded rows out of the unlabelled-vector
  // count; drop it and the file reads as `unrecorded` instead of `none`. With a label seeded that
  // arm returns the label and says nothing, so the assertion could not fail - it is only with no
  // label that `unrecorded` reaches its warn and the two arms become distinguishable. Both return
  // the default either way, which is why the model assertion is not the one doing the work here.
  it('stays silent when a file with no label holds no vectors either', async () => {
    const { fabFileId, userId } = await seedFile(undefined, [
      { space: undefined, vectorized: false },
      { space: undefined, vectorized: false },
    ]);

    await dispatch(makeEvent({ fabFileId, userId }), {} as never, mockLogger);

    expect(requestedModel()).toBe(DEPLOYMENT_DEFAULT);
    expect(mockLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining('embedding space'));
  });
});

/**
 * The superseding write pair against a real replica set.
 *
 * The unit suite mocks `withTransaction` as a passthrough, so it can show the two writes running
 * at transaction depth 1 and nothing about whether a transaction actually holds them: a passthrough
 * never rolls anything back, and a real one can fail outright (a standalone mongod rejects the
 * session with code 20 rather than degrading quietly). Both claims below need a real server, and
 * the second is the one the pair exists for - a half-written pair is PERMANENT here, because
 * nothing redelivers a refused file to retry the write that lost.
 */
const FOREIGN_ERROR = 'Chunking failed: corrupt PDF';

/** A refusable file (vectors in a retired space) already carrying someone else's error, in a batch. */
async function seedRefusableFileInBatch() {
  const { fabFileId, userId } = await seedFile(undefined, [
    { space: RETIRED_SPACE, vectorized: true },
    { space: undefined, vectorized: false },
  ]);
  const batch = await dataLakeBatchRepository.create({ dataLakeId: 'lake1', userId, totalFiles: 1 } as never);
  await dataLakeBatchRepository.appendFiles(batch.id, [
    { fabFileId, fileName: 'x.pdf', status: 'failed', error: FOREIGN_ERROR },
  ]);
  // The foreign error is what makes this the superseding path: markFailedIfNotAlready declines, and
  // clearStrandedMarkers will not clear an error this handler does not own. The stamp is what the
  // rescue sweep found the file by, and is dropped by the undo before the refusal is accounted.
  await FabFile.updateOne(
    { _id: fabFileId },
    { $set: { error: FOREIGN_ERROR, batchId: batch.id, vectorizeEnqueueFailedAt: new Date() } }
  );
  return { fabFileId, userId, batchId: batch.id };
}

const entryError = async (batchId: string) => (await dataLakeBatchRepository.findById(batchId))?.files[0].error;
const fileError = async (fabFileId: string) => (await FabFile.findById(fabFileId).lean())?.error;

describe('a refusal supersedes the file record and its manifest entry together (#2766)', () => {
  it('commits both halves of the pair', async () => {
    const { fabFileId, userId, batchId } = await seedRefusableFileInBatch();

    await expect(dispatch(makeEvent({ fabFileId, userId }), {} as never, mockLogger)).rejects.toThrow(
      /no longer available/
    );

    // Both records now name the refusal. They are read by different guards - `ownsError` on the
    // file, revertFileFailure's anchored prefix match on the entry - so agreement between them is
    // the whole point of writing them together.
    expect(await fileError(fabFileId)).toContain('Reprocess');
    expect(await entryError(batchId)).toContain('Reprocess');
  });

  it('rolls the manifest entry back when the file write fails', async () => {
    const { fabFileId, userId, batchId } = await seedRefusableFileInBatch();
    const spy = vi
      .spyOn(fabFileRepository, 'supersedeFailureError')
      .mockRejectedValueOnce(new Error('file write lost'));

    try {
      await expect(dispatch(makeEvent({ fabFileId, userId }), {} as never, mockLogger)).rejects.toThrow(
        /no longer available/
      );
    } finally {
      spy.mockRestore();
    }

    // Without the transaction the entry write has already landed by the time the file write throws,
    // leaving the entry carrying this handler's prefix while the file keeps the foreign error. That
    // state is unreachable-by-repair: a later strand's undo reverts the batch charge off the ENTRY
    // and markFailedIfNotAlready declines to restore it off the FILE, so the batch is left short a
    // failure it still has and can never reach its completion threshold.
    expect(await entryError(batchId)).toBe(FOREIGN_ERROR);
    expect(await fileError(fabFileId)).toBe(FOREIGN_ERROR);
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('file write lost'));
  });
});
