import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import { FabFileChunk, fabFileChunkRepository } from './FabFileModel';

/**
 * The vector-free batched chunk read. Its whole reason to exist is what it does NOT return, and a
 * unit test against a mocked repository cannot see a projection - so this runs against a real Mongo.
 */
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

const makeChunk = (fabFileId: string, text: string, extra: Record<string, unknown> = {}) =>
  FabFileChunk.create({ fabFileId, text, tokenCount: 7, vector: [0.1, 0.2, 0.3], ...extra });

describe('FabFileChunkRepository.findChunkFieldsByFabFileIds', () => {
  it('returns the planning fields and no vector', async () => {
    const chunk = await makeChunk('file-a', 'a passage', { embeddingModel: 'text-embedding-3-small' });

    const [row] = await fabFileChunkRepository.findChunkFieldsByFabFileIds(['file-a']);

    expect(row).toEqual({
      id: String(chunk._id),
      fabFileId: 'file-a',
      text: 'a passage',
      tokenCount: 7,
      embeddingModel: 'text-embedding-3-small',
    });
    expect(row).not.toHaveProperty('vector');
  });

  it('includes vectorless chunks, which the vector reader filters out', async () => {
    await makeChunk('file-a', 'embedded');
    await makeChunk('file-a', 'not embedded yet', { vector: [] });

    const rows = await fabFileChunkRepository.findChunkFieldsByFabFileIds(['file-a']);
    const withVectors = await fabFileChunkRepository.findVectorsByFabFileIds(['file-a']);

    expect(rows.map(r => r.text).sort()).toEqual(['embedded', 'not embedded yet']);
    expect(withVectors.map(r => r.text)).toEqual(['embedded']);
  });

  // An absent count means unknown, and a caller pricing a capture has to substitute its own
  // overestimate - defaulting it to 0 here would quote the chunk as free. `tokenCount` is a required
  // path, so only a row written before it was can look like this: inserted through the driver rather
  // than the model, which is the only way to reproduce one.
  it('leaves an absent tokenCount absent', async () => {
    await FabFileChunk.collection.insertOne({ fabFileId: 'file-a', text: 'no count', vector: [0.1] });

    const [row] = await fabFileChunkRepository.findChunkFieldsByFabFileIds(['file-a']);

    expect(row.tokenCount).toBeUndefined();
  });

  it('spans the given files and pages on an exact cursor', async () => {
    const ids: string[] = [];
    for (const [file, text] of [
      ['file-a', '1'],
      ['file-a', '2'],
      ['file-b', '3'],
      ['file-c', '4'],
    ] as const) {
      ids.push(String((await makeChunk(file, text))._id));
    }

    const first = await fabFileChunkRepository.findChunkFieldsByFabFileIds(['file-a', 'file-b'], { limit: 2 });
    const second = await fabFileChunkRepository.findChunkFieldsByFabFileIds(['file-a', 'file-b'], {
      limit: 2,
      afterChunkId: first[first.length - 1].id,
    });

    expect(first.map(r => r.text)).toEqual(['1', '2']);
    expect(second.map(r => r.text)).toEqual(['3']);
    expect(await fabFileChunkRepository.findChunkFieldsByFabFileIds([])).toEqual([]);
  });
});
