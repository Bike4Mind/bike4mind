import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
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
  delete process.env.DELETE_UNADDRESSABLE_CHUNKS_DRY_RUN;
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

  it('writes nothing in dry-run mode', async () => {
    process.env.DELETE_UNADDRESSABLE_CHUNKS_DRY_RUN = '1';
    const orphan = await insertChunk(serializedDocument(String(new mongoose.Types.ObjectId())));

    await migration.up();

    expect(await chunkIds()).toEqual([String(orphan._id)]);
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

  it('is idempotent - a second run deletes nothing further', async () => {
    await insertChunk(serializedDocument(String(new mongoose.Types.ObjectId())));
    const healthy = await insertChunk(String(new mongoose.Types.ObjectId()));

    await migration.up();
    await migration.up();

    expect(await chunkIds()).toEqual([String(healthy._id)]);
  });
});
