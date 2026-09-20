import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType } from '@bike4mind/common';
import { createMongoServer } from './createMongoServer';
import { FabFile, FabFileChunk, fabFileRepository, fabFileChunkRepository } from '../models/content/FabFileModel';

/**
 * The reads behind the FILE-level label repair (packages/scripts/datalake/
 * label-blank-embedding-model-files.ts). Run against a real server because all three are defined by
 * their Mongo filters rather than by any branching in TypeScript: "blank" is three distinct
 * document shapes, and a structural assertion on a filter object cannot show which rows it matches.
 *
 * Its own server: these fixtures are written to be enumerated exhaustively, so seeding them
 * alongside a suite that asserts over the whole collection would change that suite's expected sets.
 */

const ADA = 'text-embedding-ada-002';
const SMALL = 'text-embedding-3-small';

let server: Awaited<ReturnType<typeof createMongoServer>>;
const id: Record<string, string> = {};

const vectorizedFile = (label: unknown, extra: Record<string, unknown> = {}) => ({
  userId: 'owner',
  fileName: 'f.txt',
  type: KnowledgeType.FILE,
  status: 'complete',
  filePath: 'f',
  vectorizedChunkCount: 3,
  ...(label === undefined ? {} : { embeddingModel: label }),
  ...extra,
});

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());

  // The three blank shapes, each written a different way in production: the field absent (legacy
  // rows predating it), explicit null (stampChunkEmbeddingModel clears it for a split file), and
  // empty string (an older write path).
  const [absent, nulled, empty, labeled, unvectorized, softDeleted] = await FabFile.create([
    vectorizedFile(undefined),
    vectorizedFile(null),
    vectorizedFile(''),
    vectorizedFile(ADA),
    vectorizedFile(undefined, { vectorizedChunkCount: 0 }),
    vectorizedFile(undefined, { deletedAt: new Date() }),
  ]);
  Object.assign(id, {
    absent: String(absent._id),
    nulled: String(nulled._id),
    empty: String(empty._id),
    labeled: String(labeled._id),
    unvectorized: String(unvectorized._id),
    softDeleted: String(softDeleted._id),
  });

  await FabFileChunk.create([
    // Unlabeled and vector-bearing, two widths: the distinct set must report both, not one.
    { fabFileId: id.absent, text: 'a', tokenCount: 1, vector: new Array(1536).fill(0.1) },
    { fabFileId: id.absent, text: 'b', tokenCount: 1, vector: new Array(1024).fill(0.1) },
    // A second chunk at a width already seen, to prove the aggregation groups rather than lists.
    { fabFileId: id.absent, text: 'c', tokenCount: 1, vector: new Array(1536).fill(0.1) },
    // LABELED and 3072 wide. Width evidence is only about unlabeled rows, so this must not appear.
    { fabFileId: id.absent, text: 'd', tokenCount: 1, vector: new Array(3072).fill(0.1), embeddingModel: SMALL },
    // Vectorless. Nothing to attribute a model to, so it is not an unlabeled VECTOR chunk.
    { fabFileId: id.absent, text: 'e', tokenCount: 1 },
    // Blank-as-empty-string at chunk level counts as unlabeled too, same three shapes one level down.
    { fabFileId: id.nulled, text: 'f', tokenCount: 1, vector: new Array(1536).fill(0.1), embeddingModel: '' },
  ]);

  // A malformed `vector` that is an object rather than an array. Mongoose casts this away, so it
  // goes in raw - which is how the real rows got there. It still satisfies `vector.0` exists, so
  // the aggregation sees it and an unguarded $size would raise instead of returning a width.
  await mongoose.connection.db!.collection('fabfilechunks').insertOne({
    fabFileId: id.empty,
    text: 'g',
    tokenCount: 1,
    vector: { 0: 0.1, 1: 0.2 },
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

describe('findVectorizedFilesMissingEmbeddingModel', () => {
  it('matches all three blank shapes and nothing that is already labeled', async () => {
    const found = await fabFileRepository.findVectorizedFilesMissingEmbeddingModel();
    const ids = found.map(f => f.id).sort();
    expect(ids).toEqual([id.absent, id.nulled, id.empty, id.softDeleted].sort());
    expect(ids).not.toContain(id.labeled);
  });

  it('excludes a file with no vectorized chunks, which has no label to be missing', async () => {
    const found = await fabFileRepository.findVectorizedFilesMissingEmbeddingModel();
    expect(found.map(f => f.id)).not.toContain(id.unvectorized);
  });

  it('returns a soft-deleted file and flags it, rather than filtering it out', async () => {
    // Deliberate: the population is defined by vector state alone, and excluding these would make
    // the count irreconcilable with the one the operator started from. The caller decides.
    const found = await fabFileRepository.findVectorizedFilesMissingEmbeddingModel();
    const row = found.find(f => f.id === id.softDeleted);
    expect(row?.deleted).toBe(true);
    expect(found.find(f => f.id === id.absent)?.deleted).toBe(false);
  });

  it('projects chunkEmbeddingModelStampedAt as null when absent, for the rollback record', async () => {
    const found = await fabFileRepository.findVectorizedFilesMissingEmbeddingModel();
    expect(found.every(f => f.chunkEmbeddingModelStampedAt === null)).toBe(true);
  });

  it('pages by ascending _id without repeating or skipping a row', async () => {
    const all = await fabFileRepository.findVectorizedFilesMissingEmbeddingModel();
    const walked: string[] = [];
    let afterFileId: string | undefined;
    for (;;) {
      const page = await fabFileRepository.findVectorizedFilesMissingEmbeddingModel({ limit: 2, afterFileId });
      if (page.length === 0) break;
      walked.push(...page.map(f => f.id));
      afterFileId = page[page.length - 1].id;
    }
    expect(walked).toEqual(all.map(f => f.id));
    expect(new Set(walked).size).toBe(walked.length);
  });
});

describe('countVectorizedFilesMissingEmbeddingModel', () => {
  it('agrees with the finder, so it can serve as the completion predicate', async () => {
    const found = await fabFileRepository.findVectorizedFilesMissingEmbeddingModel();
    await expect(fabFileRepository.countVectorizedFilesMissingEmbeddingModel()).resolves.toBe(found.length);
  });
});

describe('distinctUnlabeledVectorWidthsByFabFileId', () => {
  it('reports each distinct width once, ascending', async () => {
    await expect(fabFileChunkRepository.distinctUnlabeledVectorWidthsByFabFileId(id.absent)).resolves.toEqual([
      1024, 1536,
    ]);
  });

  it('ignores labeled chunks, whose model is read rather than inferred from width', async () => {
    // The 3072-wide chunk on this file is labeled, and its absence is what lets a file with
    // fully-labeled chunks be stamped without consulting width at all.
    const widths = await fabFileChunkRepository.distinctUnlabeledVectorWidthsByFabFileId(id.absent);
    expect(widths).not.toContain(3072);
  });

  it('counts a blank-string chunk label as unlabeled, matching the count it must agree with', async () => {
    await expect(fabFileChunkRepository.distinctUnlabeledVectorWidthsByFabFileId(id.nulled)).resolves.toEqual([1536]);
    await expect(fabFileChunkRepository.countUnlabeledVectorChunksByFabFileId(id.nulled)).resolves.toBe(1);
  });

  it('returns a sentinel width for a malformed vector instead of raising', async () => {
    // -1 is a width no model claims, so the allowlist in labelBlankFilesPlan.ts skips the file.
    await expect(fabFileChunkRepository.distinctUnlabeledVectorWidthsByFabFileId(id.empty)).resolves.toEqual([-1]);
  });

  it('is empty for a file whose vector-bearing chunks are all labeled', async () => {
    await expect(fabFileChunkRepository.distinctUnlabeledVectorWidthsByFabFileId(id.labeled)).resolves.toEqual([]);
  });
});
