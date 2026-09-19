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
  // Read off mongoose's debug hook rather than a spy on the model's `find`: a spy sees only what
  // this repository passed, so it goes blind the moment the projection moves to a chained
  // `.select()`. The hook sees what mongoose actually sent to the driver, which is the claim here.
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

describe('FabFileChunkRepository.findTextsByChunkIds', () => {
  it('returns text for exactly the ids asked for, and nothing around them', async () => {
    const [one, two, other] = await Promise.all([
      makeChunk(fileA, 'first passage'),
      makeChunk(fileA, 'second passage'),
      makeChunk(fileB, 'someone else'),
    ]);

    const rows = await fabFileChunkRepository.findTextsByChunkIds([String(one._id), String(other._id)]);

    // `two` shares a file with `one` and is absent: the read is keyed on chunk id, not on the file
    // the chunk belongs to, which is what keeps a served-set read from pulling whole files.
    expect(rows.map(r => r.text).sort()).toEqual(['first passage', 'someone else']);
    expect(rows.every(r => r.id && r.fabFileId)).toBe(true);
    expect(rows.find(r => r.text === 'someone else')?.fabFileId).toBe(fileB);
    expect(String(two._id)).not.toBe('');
  });

  it('omits an id that no longer exists rather than failing the batch', async () => {
    const live = await makeChunk(fileC, 'still here');
    const gone = await makeChunk(fileC, 'deleted since the capture');
    await FabFileChunk.deleteOne({ _id: gone._id });

    const rows = await fabFileChunkRepository.findTextsByChunkIds([String(live._id), String(gone._id)]);

    // A chunk can be replaced by re-vectorization between a capture and this read, so a short
    // result is data the caller reports, not an error here.
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('still here');
  });

  it('short-circuits an empty id list instead of querying for everything', async () => {
    await makeChunk(fileA, 'must not come back');

    // `{ _id: { $in: [] } }` would be harmless, but the guard is what makes that true by
    // construction rather than by Mongo's behavior on an empty $in.
    expect(await fabFileChunkRepository.findTextsByChunkIds([])).toEqual([]);
  });
});
