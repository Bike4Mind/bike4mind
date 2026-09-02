import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { FabFileChunk, fabFileChunkRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * End-to-end guard for the seam the purge actually runs on: the REAL openSearchRetrievalIndex port
 * wired to the REAL fabFileChunkRepository over a real mongod, exactly as dataLakeCleanup.ts wires
 * them. Both halves are covered on their own - the port against a mocked resolver
 * (openSearchRetrievalIndex.test.ts), the resolver against real Mongo
 * (fabFileChunkVectorScope.test.ts) - and neither can catch this defect, because the port's
 * "absent from the map means nothing to remove" shortcut is only sound if the resolver reads index
 * RESIDENCY and not just the file-complete readiness stamp. Only running them together pins that.
 *
 * Consumes the built dist, so `pnpm turbo:core:build` must be current.
 */

let mongoServer: MongoMemoryServer;

const SCOPE = { datalakeTag: 'datalake:purged-lake', fileTagPrefix: null };

const MODEL = 'text-embedding-3-small';
const OTHER_MODEL = 'text-embedding-3-large';

const makePort = () => {
  const deleteByFabFileIdOrThrow = vi.fn(async () => undefined);
  return {
    deleteByFabFileIdOrThrow,
    port: dataLakeService.openSearchRetrievalIndex({
      db: { fabFileChunks: fabFileChunkRepository },
      searchIndex: { deleteByFabFileIdOrThrow },
    }),
  };
};

const removals = (fn: ReturnType<typeof makePort>['deleteByFabFileIdOrThrow']) =>
  fn.mock.calls.map(call => (call as unknown as [string, string]).join(' ')).sort();

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
afterEach(async () => {
  await FabFileChunk.deleteMany({});
});

describe('data lake purge -> OpenSearch removal, over the real chunk repository', () => {
  // The defect: fabFileVectorize writes a message's chunk docs to OpenSearch as soon as that
  // message's vectors land, but stamps embeddingModel only once the WHOLE file is vectorized. A
  // file that never gets there (terminal spend-gate denial, exhausted SQS retries, a purge landing
  // mid-flight) is in the purge's fabFileIds with live documents and no stamp, and resolving from
  // the stamp alone reported nothing to remove.
  it('removes documents for a file whose vectorize never finished', async () => {
    await FabFileChunk.create([
      { fabFileId: 'in-flight', text: 'message 1 chunk', tokenCount: 3, retrievalIndexModel: MODEL },
      { fabFileId: 'in-flight', text: 'message 1 chunk 2', tokenCount: 3, retrievalIndexModel: MODEL },
    ]);

    const { deleteByFabFileIdOrThrow, port } = makePort();
    await port.removeForDataLake({ scope: SCOPE, fabFileIds: ['in-flight'] });

    expect(removals(deleteByFabFileIdOrThrow)).toEqual([`in-flight ${MODEL}`]);
  });

  it('still removes documents for a file that did finish, from its stamped model index', async () => {
    await FabFileChunk.create([
      { fabFileId: 'complete', text: 'a', tokenCount: 3, retrievalIndexModel: MODEL, embeddingModel: MODEL },
    ]);

    const { deleteByFabFileIdOrThrow, port } = makePort();
    await port.removeForDataLake({ scope: SCOPE, fabFileIds: ['complete'] });

    expect(removals(deleteByFabFileIdOrThrow)).toEqual([`complete ${MODEL}`]);
  });

  // A chunk written before retrievalIndexModel existed carries only the stamp, so dropping the
  // stamp from the union would orphan every document a pre-upgrade install already indexed.
  it('covers a chunk that predates the residency field and carries only the stamp', async () => {
    await FabFileChunk.create([{ fabFileId: 'legacy', text: 'a', tokenCount: 3, embeddingModel: MODEL }]);

    const { deleteByFabFileIdOrThrow, port } = makePort();
    await port.removeForDataLake({ scope: SCOPE, fabFileIds: ['legacy'] });

    expect(removals(deleteByFabFileIdOrThrow)).toEqual([`legacy ${MODEL}`]);
  });

  it('reaches every index a re-embedded file spans, once each', async () => {
    await FabFileChunk.create([
      { fabFileId: 'reembedded', text: 'old embed', tokenCount: 3, retrievalIndexModel: OTHER_MODEL },
      { fabFileId: 'reembedded', text: 'new embed', tokenCount: 3, retrievalIndexModel: MODEL, embeddingModel: MODEL },
    ]);

    const { deleteByFabFileIdOrThrow, port } = makePort();
    await port.removeForDataLake({ scope: SCOPE, fabFileIds: ['reembedded'] });

    expect(removals(deleteByFabFileIdOrThrow)).toEqual([`reembedded ${MODEL}`, `reembedded ${OTHER_MODEL}`].sort());
  });

  // The #2105 shortcut this fix has to keep: a file with no chunk recording any index issues no
  // request at all, and no file is ever paired with a model it never used.
  it('issues nothing for a file whose chunks record no index, and never crosses files with models', async () => {
    await FabFileChunk.create([
      { fabFileId: 'chunked-only', text: 'never vectorized', tokenCount: 3 },
      { fabFileId: 'on-model-a', text: 'a', tokenCount: 3, retrievalIndexModel: MODEL },
      { fabFileId: 'on-model-b', text: 'b', tokenCount: 3, retrievalIndexModel: OTHER_MODEL },
    ]);

    const { deleteByFabFileIdOrThrow, port } = makePort();
    await port.removeForDataLake({
      scope: SCOPE,
      fabFileIds: ['chunked-only', 'on-model-a', 'on-model-b', 'never-seen'],
    });

    expect(removals(deleteByFabFileIdOrThrow)).toEqual([`on-model-a ${MODEL}`, `on-model-b ${OTHER_MODEL}`].sort());
  });
});
