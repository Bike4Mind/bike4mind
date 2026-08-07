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

  it('overwrites a chunk already stamped with a different model (re-embed)', async () => {
    await FabFileChunk.create(makeChunk({ fabFileId: 'f1', text: 'existing' }));
    await fabFileChunkRepository.updateEmbeddingModel('f1', 'text-embedding-ada-002');

    await fabFileChunkRepository.updateEmbeddingModel('f1', 'text-embedding-3-small');

    const chunks = await FabFileChunk.find({ fabFileId: 'f1' }).lean();
    expect(chunks[0].embeddingModel).toBe('text-embedding-3-small');
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
