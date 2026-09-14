import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260911120000_delete-unaddressable-fabfilechunks';

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
  await mongoose.connection.dropDatabase();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function raw(name: string) {
  const db = mongoose.connection.db;
  if (!db) throw new Error('no db connection');
  return db.collection(name);
}

// Raw driver, not the model: the schema now refuses these values, and a faithful pre-migration
// document is the only shape this migration is allowed to depend on.
async function insertChunks(fabFileIds: unknown[]) {
  const docs = fabFileIds.map(fabFileId => ({
    _id: new mongoose.Types.ObjectId(),
    fabFileId,
    text: 't',
    tokenCount: 1,
    vector: [0.1],
  }));
  await raw('fabfilechunks').insertMany(docs);
  return docs;
}

async function insertChunk(fabFileId: unknown) {
  const [doc] = await insertChunks([fabFileId]);
  return doc;
}

/** The field absent entirely, which `$type: 'string'` deliberately does not claim. */
async function insertChunkWithoutFabFileId() {
  const doc = { _id: new mongoose.Types.ObjectId(), text: 't', tokenCount: 1, vector: [0.1] };
  await raw('fabfilechunks').insertOne(doc);
  return doc;
}

async function insertFabFile(overrides: Record<string, unknown> = {}) {
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    userId: 'user-1',
    fileName: 'contract.pdf',
    deletedAt: null,
    ...overrides,
  };
  await raw('fabfiles').insertOne(doc);
  return doc;
}

/** The observed corruption: a whole serialized FabFile document, with the file's id inside it. */
const serializedDocument = (embeddedId: string) =>
  `{ _id: new ObjectId("${embeddedId}"), userId: 'user-1', fileName: 'contract.pdf', status: 'complete' }`;

/**
 * An unbroken hex run of `length`, built so every 24-character window is distinct - a repeating run
 * would collapse under the extractor's `Set` and never reach the cap. Windows number `length - 23`.
 */
const hexRun = (length: number) =>
  Array.from({ length: Math.ceil(length / 4) }, (_, i) => i.toString(16).padStart(4, '0'))
    .join('')
    .slice(0, length);

const chunkIds = async () =>
  (
    await raw('fabfilechunks')
      .find({}, { projection: { _id: 1 } })
      .toArray()
  ).map(d => String(d._id));

describe('delete-unaddressable-fabfilechunks migration (real DB)', () => {
  it('deletes a chunk whose fabFileId is a serialized document naming no surviving file', async () => {
    await insertChunk(serializedDocument(String(new mongoose.Types.ObjectId())));
    const healthy = await insertChunk(String(new mongoose.Types.ObjectId()));

    await migration.up();

    expect(await chunkIds()).toEqual([String(healthy._id)]);
  });

  it('keeps a chunk whose unaddressable value embeds an id that still resolves', async () => {
    const live = await insertFabFile();
    const salvageable = await insertChunk(serializedDocument(String(live._id)));

    await migration.up();

    expect(await chunkIds()).toEqual([String(salvageable._id)]);
  });

  it('keeps one whose embedded id resolves to a soft-deleted file - still re-associable', async () => {
    const softDeleted = await insertFabFile({ deletedAt: new Date('2026-01-01T00:00:00Z') });
    const salvageable = await insertChunk(serializedDocument(String(softDeleted._id)));

    await migration.up();

    expect(await chunkIds()).toEqual([String(salvageable._id)]);
  });

  it('keeps one whose embedded id is UPPERCASE and resolves', async () => {
    // The $in lookup normalizes case and finds the file either way, so a gate that compared raw-case
    // candidates against BSON-rendered ids would confirm the file exists and delete the chunk anyway.
    const live = await insertFabFile();
    const salvageable = await insertChunk(serializedDocument(String(live._id).toUpperCase()));

    await migration.up();

    expect(await chunkIds()).toEqual([String(salvageable._id)]);
  });

  it('keeps one whose embedded id is glued to a misaligned hex run', async () => {
    // A non-overlapping match is left-greedy: it would yield 'abc' plus the first 21 characters and
    // never the id itself, clearing gate 2 for a row whose file is right there.
    const live = await insertFabFile();
    const salvageable = await insertChunk(`abc${String(live._id)}`);

    await migration.up();

    expect(await chunkIds()).toEqual([String(salvageable._id)]);
  });

  it('leaves well-formed rows alone, including one pointing at a file that no longer exists', async () => {
    const live = await insertFabFile();
    const attached = await insertChunk(String(live._id));
    // A well-formed id whose file is gone is a different problem with a different owner - ordinary
    // deletion reaps those, and this migration must not widen into them.
    const danglingButAddressable = await insertChunk(String(new mongoose.Types.ObjectId()));

    await migration.up();

    expect((await chunkIds()).sort()).toEqual([String(attached._id), String(danglingButAddressable._id)].sort());
  });

  it('ignores rows whose fabFileId is not a string at all', async () => {
    const nonString = await insertChunk(42);

    await migration.up();

    expect(await chunkIds()).toEqual([String(nonString._id)]);
  });

  it('ignores a row whose fabFileId is an ARRAY of strings', async () => {
    // `$type: 'string'` matches an array if ANY element is a string, so without the array exclusion
    // this clears gate 1 and is then judged on a comma-joined stringification of the whole array -
    // which embeds no id, so it would be deleted.
    const arrayValued = await insertChunk(['not-an-id', 'also-not']);

    await migration.up();

    expect(await chunkIds()).toEqual([String(arrayValued._id)]);
  });

  it('ignores a row with no fabFileId field at all - a different corruption', async () => {
    const absent = await insertChunkWithoutFabFileId();

    await migration.up();

    expect(await chunkIds()).toEqual([String(absent._id)]);
  });

  it('leaves a 24-hex value with a trailing newline in place', async () => {
    // Server-side `$` is PCRE and also matches before a trailing newline, so the sweep reads this as
    // addressable even though the schema validator rejects it. Over-keeping, but not exhaustive.
    const trailingNewline = await insertChunk(`${String(new mongoose.Types.ObjectId())}\n`);

    await migration.up();

    expect(await chunkIds()).toEqual([String(trailingNewline._id)]);
  });

  it('pages past the page size and terminates on a set that is entirely kept', async () => {
    const live = await insertFabFile();
    await insertChunks(Array.from({ length: 250 }, () => serializedDocument(String(live._id))));

    await migration.up();

    expect(await raw('fabfilechunks').countDocuments()).toBe(250);
  });

  it('pages past the page size when deleting', async () => {
    await insertChunks(Array.from({ length: 250 }, () => serializedDocument(String(new mongoose.Types.ObjectId()))));

    await migration.up();

    expect(await raw('fabfilechunks').countDocuments()).toBe(0);
  });

  it('keeps a row whose value yields more candidates than the per-row cap', async () => {
    // The cap is fail-SAFE: over it, the row is kept UNCHECKED rather than checked on a truncated
    // candidate list. No fabfile exists here, so gate 2 resolves nothing and a missing cap would
    // delete this row.
    const overCap = await insertChunk(hexRun(280)); // 257 windows, cap is 256

    await migration.up();

    expect(await chunkIds()).toEqual([String(overCap._id)]);
  });

  it('still evaluates a row one candidate under the cap', async () => {
    // The other side of the boundary, so the cap cannot be satisfied by keeping everything.
    await insertChunk(hexRun(279)); // 256 windows

    await migration.up();

    expect(await chunkIds()).toEqual([]);
  });

  it('is idempotent - a second run deletes nothing further', async () => {
    await insertChunk(serializedDocument(String(new mongoose.Types.ObjectId())));
    const healthy = await insertChunk(String(new mongoose.Types.ObjectId()));

    await migration.up();
    await migration.up();

    expect(await chunkIds()).toEqual([String(healthy._id)]);
  });

  it('reports the deleted and scanned counts', async () => {
    // The operator's only go/no-go signal, and the thing the linked issue verifies on.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await insertChunks(Array.from({ length: 3 }, () => serializedDocument(String(new mongoose.Types.ObjectId()))));
    await insertChunk(String(new mongoose.Types.ObjectId()));

    await migration.up();

    expect(log.mock.calls.flat().join('\n')).toContain('Deleted 3 unaddressable fabfilechunk row(s) from 3 scanned');
  });

  it('caps the kept-id list and says how many it withheld', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const live = await insertFabFile();
    await insertChunks(Array.from({ length: 60 }, () => serializedDocument(String(live._id))));

    await migration.up();

    const warned = warn.mock.calls.flat().join('\n');
    expect(warned).toContain('60 row(s) have an unaddressable fabFileId');
    expect(warned).toContain('... and 10 more (capped at 50)');
  });
});
