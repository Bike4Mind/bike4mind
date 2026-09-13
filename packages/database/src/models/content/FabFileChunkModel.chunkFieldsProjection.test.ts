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

// `fabFileId` is a hex ObjectId string, and the schema is being tightened to validate it. Built
// locally rather than imported so this file is correct whether or not that validator has landed.
const testFabFileId = (label: string) => Buffer.from(label).toString('hex').padEnd(24, '0').slice(0, 24);
const fileA = testFabFileId('file-a');
const fileB = testFabFileId('file-b');
const fileC = testFabFileId('file-c');

const makeChunk = (fabFileId: string, text: string, extra: Record<string, unknown> = {}) =>
  FabFileChunk.create({ fabFileId, text, tokenCount: 7, vector: [0.1, 0.2, 0.3], ...extra });

describe('FabFileChunkRepository.findChunkFieldsByFabFileIds', () => {
  it('returns the planning fields and no vector', async () => {
    const chunk = await makeChunk(fileA, 'a passage', { embeddingModel: 'text-embedding-3-small' });

    const [row] = await fabFileChunkRepository.findChunkFieldsByFabFileIds([fileA]);

    expect(row).toEqual({
      id: String(chunk._id),
      fabFileId: fileA,
      text: 'a passage',
      tokenCount: 7,
      embeddingModel: 'text-embedding-3-small',
    });
    expect(row).not.toHaveProperty('vector');
  });

  it('includes vectorless chunks, which the vector reader filters out', async () => {
    await makeChunk(fileA, 'embedded');
    await makeChunk(fileA, 'not embedded yet', { vector: [] });

    const rows = await fabFileChunkRepository.findChunkFieldsByFabFileIds([fileA]);
    const withVectors = await fabFileChunkRepository.findVectorsByFabFileIds([fileA]);

    expect(rows.map(r => r.text).sort()).toEqual(['embedded', 'not embedded yet']);
    expect(withVectors.map(r => r.text)).toEqual(['embedded']);
  });

  // An absent count means unknown, and a caller pricing a capture has to substitute its own
  // overestimate - defaulting it to 0 here would quote the chunk as free. `tokenCount` is a required
  // path, so only a row written before it was can look like this: inserted through the driver rather
  // than the model, which is the only way to reproduce one.
  it('leaves an absent tokenCount absent', async () => {
    await FabFileChunk.collection.insertOne({ fabFileId: fileA, text: 'no count', vector: [0.1] });

    const [row] = await fabFileChunkRepository.findChunkFieldsByFabFileIds([fileA]);

    expect(row.tokenCount).toBeUndefined();
  });

  it('spans the given files and pages on an exact cursor', async () => {
    for (const [file, text] of [
      [fileA, '1'],
      [fileA, '2'],
      [fileB, '3'],
      [fileC, '4'],
    ] as const) {
      await makeChunk(file, text);
    }

    const first = await fabFileChunkRepository.findChunkFieldsByFabFileIds([fileA, fileB], { limit: 2 });
    const second = await fabFileChunkRepository.findChunkFieldsByFabFileIds([fileA, fileB], {
      limit: 2,
      afterChunkId: first[first.length - 1].id,
    });

    expect(first.map(r => r.text)).toEqual(['1', '2']);
    expect(second.map(r => r.text)).toEqual(['3']);
    expect(await fabFileChunkRepository.findChunkFieldsByFabFileIds([])).toEqual([]);
  });

  // The one property this read exists for, and the only assertion here that can see it: the mapper
  // returns a fixed literal, so every other test passes unchanged if the projection is dropped and
  // a whole lake's embeddings start crossing the wire.
  //
  // Read off mongoose's debug hook rather than a spy on the model's `find`: mongoose re-binds that
  // static on first exec, so a spy silently records zero calls and the assertion never fires.
  it('asks Mongo for the planning fields only, never the vector', async () => {
    await makeChunk(fileA, 'a passage');

    const projections: (Record<string, unknown> | undefined)[] = [];
    mongoose.set('debug', (_collection: string, method: string, ...args: unknown[]) => {
      if (method !== 'find') return;
      const options = args[1] as { projection?: Record<string, unknown> } | undefined;
      projections.push(options?.projection);
    });

    try {
      await fabFileChunkRepository.findChunkFieldsByFabFileIds([fileA]);
    } finally {
      mongoose.set('debug', false);
    }

    expect(projections).toHaveLength(1);
    expect(Object.keys(projections[0] ?? {}).sort()).toEqual([
      '_id',
      'embeddingModel',
      'fabFileId',
      'text',
      'tokenCount',
    ]);
  });
});
