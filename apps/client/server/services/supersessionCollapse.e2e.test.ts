/**
 * End-to-end guard for per-lake supersession collapse against REAL Mongo rather than the mocked
 * file sets in semanticDataLakeSearch.test.ts. The mocked suites hand `rankChunksForFiles` a file
 * shape built by hand; only a real search proves the identity key's inputs (`relativePath`,
 * `driveFileId`, `createdAt`) actually survive `fabfiles.search`'s excludeContent projection and
 * `toJSON()`, and that a real `tags` array - a schema-less [Object] array - reverses to a lake.
 * Lives in apps/client because it is the only package with both @bike4mind/services and
 * @bike4mind/database as dependencies. Consumes the built dist, so `pnpm turbo:core:build` must be
 * current.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

// The embedding PROVIDER is the only stub - it is the one input that needs a network credential.
// Real cosine, real repositories, real Mongo. Every vector is [1,0] so every chunk scores 1.0 and
// nothing is dropped by relevance: what survives is decided by the partitions under test alone.
vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...actual,
    getProviderFromModel: () => 'openai',
    EmbeddingFactory: class {
      createEmbeddingService() {
        return { generateEmbedding: async () => [1, 0] };
      }
    },
  };
});

import { FabFile, FabFileChunk, User, fabFileRepository, fabFileChunkRepository } from '@bike4mind/database';
import { KnowledgeType } from '@bike4mind/common';
import { dataLakeService } from '@bike4mind/services';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryServer;
let userId: string;

const MODEL = 'text-embedding-ada-002';

const LAKE_A = { id: 'lake-a', datalakeTag: 'datalake:alpha' };
const LAKE_B = { id: 'lake-b', datalakeTag: 'datalake:beta' };

async function makeFile(opts: {
  fileName: string;
  tags: { name: string }[];
  createdAt: string;
  relativePath?: string;
  driveFileId?: string;
  chunkCount?: number;
  vectorizedChunkCount?: number;
  embeddingModel?: string;
  text: string;
}) {
  const doc = await FabFile.create({
    userId,
    type: KnowledgeType.FILE,
    fileName: opts.fileName,
    tags: opts.tags,
    relativePath: opts.relativePath,
    driveFileId: opts.driveFileId,
    vectorized: true,
    embeddingModel: opts.embeddingModel ?? MODEL,
    chunkCount: opts.chunkCount ?? 1,
    vectorizedChunkCount: opts.vectorizedChunkCount ?? 1,
  });
  // timestamps:true overwrites createdAt on create, so stamp the generation age afterwards.
  await FabFile.collection.updateOne({ _id: doc._id }, { $set: { createdAt: new Date(opts.createdAt) } });
  await FabFileChunk.create({ fabFileId: String(doc._id), text: opts.text, tokenCount: 4, vector: [1, 0] });
  return String(doc._id);
}

const adapters = {
  db: { fabfiles: fabFileRepository, fabfilechunks: fabFileChunkRepository },
};

const baseParams = {
  userId: '',
  query: 'treatment protocol',
  embeddingModel: MODEL as never,
  apiKeyTable: { openai: 'stub' },
  dataLakeTags: [LAKE_A.datalakeTag, LAKE_B.datalakeTag],
  dataLakeTagPrefixes: [],
};

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  const user = await User.create({ username: 'verifier', name: 'Verifier' });
  userId = user.id as string;
  baseParams.userId = userId;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

const run = (overrides: Record<string, unknown> = {}) =>
  dataLakeService.semanticDataLakeSearch({ ...baseParams, ...overrides } as never, adapters as never);

describe('supersession collapse against real Mongo', () => {
  // In afterEach, not inline at the end of each case: these all search the same lakes unfiltered,
  // so one failed assertion would otherwise leave its rows behind and take every later case with it.
  afterEach(async () => {
    await FabFile.deleteMany({});
    await FabFileChunk.deleteMany({});
  });

  it('flag off ranks both generations; flag on ranks only the newest and names it', async () => {
    const older = await makeFile({
      fileName: 'Protocol.pdf',
      tags: [{ name: LAKE_A.datalakeTag }],
      createdAt: '2024-01-01T00:00:00Z',
      text: 'OLD protocol text',
    });
    const newer = await makeFile({
      fileName: 'Protocol.pdf',
      tags: [{ name: LAKE_A.datalakeTag }],
      createdAt: '2025-06-01T00:00:00Z',
      text: 'NEW protocol text',
    });

    const off = await run({ lakes: [LAKE_A, LAKE_B] });
    const offIds = off.results.map(r => r.fileId).sort();
    expect(offIds).toEqual([older, newer].sort());
    expect(off.supersession.count).toBe(0);

    const on = await run({ lakes: [LAKE_A, LAKE_B], supersessionCollapseEnabled: true });
    expect(on.results.map(r => r.fileId)).toEqual([newer]);
    expect(on.supersession.count).toBe(1);
    expect(on.supersession.sample).toEqual([
      { fileId: older, fileName: 'Protocol.pdf', tier: 'fileName', supersededBy: newer },
    ]);

    const note = dataLakeService.describeSearchLimitations(on);
    expect(note).toContain(older);
    expect(note).toContain('matched by fileName');
    // Reported to the model, but not a partial corpus: nothing is missing, it is deduplicated.
    expect(dataLakeService.isPartialSearch(on)).toBe(false);
  });

  it('does not collapse the same file name across two different lakes', async () => {
    const inA = await makeFile({
      fileName: 'Shared.pdf',
      tags: [{ name: LAKE_A.datalakeTag }],
      createdAt: '2024-01-01T00:00:00Z',
      text: 'lake A copy',
    });
    const inB = await makeFile({
      fileName: 'Shared.pdf',
      tags: [{ name: LAKE_B.datalakeTag }],
      createdAt: '2025-01-01T00:00:00Z',
      text: 'lake B copy',
    });

    const on = await run({ lakes: [LAKE_A, LAKE_B], supersessionCollapseEnabled: true });
    expect(on.results.map(r => r.fileId).sort()).toEqual([inA, inB].sort());
    expect(on.supersession.count).toBe(0);
  });

  it('driveFileId wins over a differing relativePath (fields survive the real search projection)', async () => {
    const older = await makeFile({
      fileName: 'Old name.docx',
      relativePath: 'archive/2024',
      driveFileId: 'drive-xyz',
      tags: [{ name: LAKE_A.datalakeTag }],
      createdAt: '2024-01-01T00:00:00Z',
      text: 'drive gen 1',
    });
    const newer = await makeFile({
      fileName: 'New name.docx',
      relativePath: 'current',
      driveFileId: 'drive-xyz',
      tags: [{ name: LAKE_A.datalakeTag }],
      createdAt: '2025-01-01T00:00:00Z',
      text: 'drive gen 2',
    });

    const on = await run({ lakes: [LAKE_A, LAKE_B], supersessionCollapseEnabled: true });
    expect(on.results.map(r => r.fileId)).toEqual([newer]);
    expect(on.supersession.sample[0]).toMatchObject({ fileId: older, tier: 'driveFileId', supersededBy: newer });
  });

  it('runs AFTER the availability partition: a mid-reindex newest generation does not erase the older one', async () => {
    const older = await makeFile({
      fileName: 'Reindexing.pdf',
      tags: [{ name: LAKE_A.datalakeTag }],
      createdAt: '2024-01-01T00:00:00Z',
      text: 'still servable older generation',
    });
    // Newest generation is mid-rebuild: chunks exist, none vectorized -> withheld upstream.
    await makeFile({
      fileName: 'Reindexing.pdf',
      tags: [{ name: LAKE_A.datalakeTag }],
      createdAt: '2025-01-01T00:00:00Z',
      chunkCount: 3,
      vectorizedChunkCount: 0,
      text: 'unvectorized newer generation',
    });

    const on = await run({ lakes: [LAKE_A, LAKE_B], supersessionCollapseEnabled: true });
    expect(on.results.map(r => r.fileId)).toEqual([older]);
    expect(on.supersession.count).toBe(0);
    expect(on.retrievalUnavailable.indexing.count).toBe(1);
  });

  it('leaves an unattributable member alone (tags reverse to no lake)', async () => {
    const a = await makeFile({
      fileName: 'Untagged.pdf',
      tags: [{ name: LAKE_A.datalakeTag }, { name: 'datalake:gamma' }],
      createdAt: '2024-01-01T00:00:00Z',
      text: 'multi-lake gen 1',
    });
    const b = await makeFile({
      fileName: 'Untagged.pdf',
      tags: [{ name: LAKE_A.datalakeTag }, { name: 'datalake:gamma' }],
      createdAt: '2025-01-01T00:00:00Z',
      text: 'multi-lake gen 2',
    });
    // Both attribute to TWO lakes once gamma is in scope -> never collapsed.
    const on = await run({
      dataLakeTags: [LAKE_A.datalakeTag, 'datalake:gamma'],
      lakes: [LAKE_A, { id: 'lake-g', datalakeTag: 'datalake:gamma' }],
      supersessionCollapseEnabled: true,
    });
    expect(on.results.map(r => r.fileId).sort()).toEqual([a, b].sort());
    expect(on.supersession.count).toBe(0);
  });

  it('survives a legacy row whose tag object carries no name', async () => {
    const older = await makeFile({
      fileName: 'Legacy.pdf',
      // FabFile.tags is a schema-less [Object] array; this row is what a legacy write left behind.
      tags: [{ label: 'no-name-here' }, { name: LAKE_A.datalakeTag }] as never,
      createdAt: '2024-01-01T00:00:00Z',
      text: 'legacy gen 1',
    });
    const newer = await makeFile({
      fileName: 'Legacy.pdf',
      tags: [{ name: LAKE_A.datalakeTag }],
      createdAt: '2025-01-01T00:00:00Z',
      text: 'legacy gen 2',
    });

    const on = await run({ lakes: [LAKE_A, LAKE_B], supersessionCollapseEnabled: true });
    expect(on.results.map(r => r.fileId)).toEqual([newer]);
    expect(on.supersession.sample[0]).toMatchObject({ fileId: older, tier: 'fileName' });
  });
});
