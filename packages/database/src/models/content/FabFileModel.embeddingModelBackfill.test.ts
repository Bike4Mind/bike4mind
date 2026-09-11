import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import { FabFileChunk, fabFileChunkRepository } from './FabFileModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await FabFileChunk.deleteMany({});
});

const makeChunk = (
  overrides: Partial<{ fabFileId: string; text: string; tokenCount: number; vector: number[] }> = {}
) => ({
  fabFileId: 'f1',
  text: 'hello world',
  tokenCount: 3,
  vector: [0.1, 0.2, 0.3],
  ...overrides,
});

describe('FabFileChunkRepository.updateEmbeddingModel', () => {
  it('stamps every chunk of the given file and leaves other files untouched', async () => {
    await FabFileChunk.create(makeChunk({ fabFileId: 'f1' }));
    await FabFileChunk.create(makeChunk({ fabFileId: 'f1' }));
    await FabFileChunk.create(makeChunk({ fabFileId: 'f2' }));

    await fabFileChunkRepository.updateEmbeddingModel('f1', 'text-embedding-3-small');

    const f1Chunks = await FabFileChunk.find({ fabFileId: 'f1' }).lean();
    expect(f1Chunks.every(c => c.embeddingModel === 'text-embedding-3-small')).toBe(true);

    const f2Chunks = await FabFileChunk.find({ fabFileId: 'f2' }).lean();
    expect(f2Chunks[0].embeddingModel).toBeUndefined();
  });

  it('leaves an already-labeled chunk alone and fills only its unlabeled siblings', async () => {
    // This method used to be an unfiltered `updateMany({ fabFileId })`, and the overwrite it
    // performed is now a bug rather than a feature. A file's chunks are fanned across several
    // vectorize messages that each resolve their own credential, so a credential appearing or
    // lapsing mid-ingest leaves one half embedded at 1024 dims and the other at 1536. A blanket
    // `$set` from whichever message observed the file complete relabeled BOTH halves with its own
    // model - silently mislabeling half the vectors at the wrong dimensionality, with no repair
    // short of a full re-embed.
    //
    // Overwriting on a genuine re-embed did not move to a different filter here, it moved to a
    // different WRITER: fabFileVectorize now assigns `chunk.embeddingModel` in the same transaction
    // that stores `chunk.vector`, so every re-embedded chunk is relabeled beside the vector that
    // justifies the new label. What is left for this method is exactly what predates that writer -
    // legacy chunks, and the packages/scripts/datalake backfill's whole purpose.
    const labeled = await FabFileChunk.create(makeChunk({ fabFileId: 'f1', text: 'already-embedded' }));
    await FabFileChunk.updateOne({ _id: labeled._id }, { $set: { embeddingModel: 'text-embedding-ada-002' } });
    const unlabeled = await FabFileChunk.create(makeChunk({ fabFileId: 'f1', text: 'legacy' }));

    await fabFileChunkRepository.updateEmbeddingModel('f1', 'text-embedding-3-small');

    const byId = new Map(
      (await FabFileChunk.find({ fabFileId: 'f1' }).lean()).map(c => [String(c._id), c.embeddingModel])
    );
    expect(byId.get(String(labeled._id))).toBe('text-embedding-ada-002');
    expect(byId.get(String(unlabeled._id))).toBe('text-embedding-3-small');
  });

  it('treats null and empty-string labels as unlabeled, not as a model to preserve', async () => {
    // Both shapes are real: '' from an older write path, and null from stampChunkEmbeddingModel
    // clearing a FILE label. Neither names an embedding space, so neither may block the fill.
    const nulled = await FabFileChunk.create(makeChunk({ fabFileId: 'f1', text: 'nulled' }));
    await FabFileChunk.updateOne({ _id: nulled._id }, { $set: { embeddingModel: null } });
    const blank = await FabFileChunk.create(makeChunk({ fabFileId: 'f1', text: 'blank' }));
    await FabFileChunk.updateOne({ _id: blank._id }, { $set: { embeddingModel: '' } });

    await fabFileChunkRepository.updateEmbeddingModel('f1', 'text-embedding-3-small');

    const chunks = await FabFileChunk.find({ fabFileId: 'f1' }).lean();
    expect(chunks.every(c => c.embeddingModel === 'text-embedding-3-small')).toBe(true);
  });
});

describe('FabFileChunkRepository.findChunksMissingEmbeddingModel', () => {
  it('returns only vector-bearing chunks missing embeddingModel', async () => {
    const stamped = await FabFileChunk.create(makeChunk({ fabFileId: 'f1', text: 'stamped' }));
    await FabFileChunk.updateOne({ _id: stamped._id }, { $set: { embeddingModel: 'text-embedding-3-small' } });
    await FabFileChunk.create(makeChunk({ fabFileId: 'f1', text: 'missing-model', vector: [0.4, 0.5] }));
    await FabFileChunk.create(makeChunk({ fabFileId: 'f1', text: 'vectorless', vector: [] }));

    const missing = await fabFileChunkRepository.findChunksMissingEmbeddingModel();
    expect(missing.map(c => c.fabFileId === 'f1' && c.vectorLength)).toEqual([2]);
  });

  it('pages via afterChunkId in ascending _id order', async () => {
    const chunks = await Promise.all([
      FabFileChunk.create(makeChunk({ fabFileId: 'f1', text: 'a' })),
      FabFileChunk.create(makeChunk({ fabFileId: 'f1', text: 'b' })),
      FabFileChunk.create(makeChunk({ fabFileId: 'f1', text: 'c' })),
    ]);
    const sortedIds = chunks.map(c => String(c._id)).sort();

    const firstPage = await fabFileChunkRepository.findChunksMissingEmbeddingModel({ limit: 2 });
    expect(firstPage.map(c => c.id)).toEqual(sortedIds.slice(0, 2));

    const secondPage = await fabFileChunkRepository.findChunksMissingEmbeddingModel({
      limit: 2,
      afterChunkId: firstPage[firstPage.length - 1].id,
    });
    expect(secondPage.map(c => c.id)).toEqual(sortedIds.slice(2));
  });

  it('returns an empty array once every chunk is stamped', async () => {
    const chunk = await FabFileChunk.create(makeChunk({ fabFileId: 'f1' }));
    await FabFileChunk.updateOne({ _id: chunk._id }, { $set: { embeddingModel: 'text-embedding-3-small' } });

    expect(await fabFileChunkRepository.findChunksMissingEmbeddingModel()).toEqual([]);
  });
});
