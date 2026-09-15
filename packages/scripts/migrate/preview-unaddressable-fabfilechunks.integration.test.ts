import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
vi.mock('../utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://unused/%STAGE%' } }));
// Only connectDB is replaced: the scan reaches the real models, which are already bound to the
// connection this file opens, and a second connect would point them somewhere else.
vi.mock('@bike4mind/database', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/database')>('@bike4mind/database');
  return { ...actual, connectDB: vi.fn(async () => undefined) };
});

import { main } from './preview-unaddressable-fabfilechunks';

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

async function insertChunk(fabFileId: unknown) {
  const doc = { _id: new mongoose.Types.ObjectId(), fabFileId, text: 't', tokenCount: 1, vector: [0.1] };
  await raw('fabfilechunks').insertOne(doc);
  return doc;
}

async function insertFabFile() {
  const doc = { _id: new mongoose.Types.ObjectId(), userId: 'user-1', fileName: 'contract.pdf', deletedAt: null };
  await raw('fabfiles').insertOne(doc);
  return doc;
}

const serializedDocument = (embeddedId: string) =>
  `{ _id: new ObjectId("${embeddedId}"), userId: 'user-1', fileName: 'contract.pdf', status: 'complete' }`;

/**
 * The exit code is the operator's go/no-go signal and 2 is deliberately NOT an error, so it has to
 * be pinned: `sst shell` and `pnpm --filter` both collapse a non-zero child code to 1, which is why
 * the script also prints PREVIEW RESULT and why both are asserted together.
 */
describe('preview-unaddressable-fabfilechunks exit-code contract (real DB)', () => {
  it('exits 0 when nothing would be deleted', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await insertChunk(String(new mongoose.Types.ObjectId()));

    expect(await main()).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain('PREVIEW RESULT: exit 0 - 0 deletable');
  });

  it('exits 0 when every unaddressable row is one a human has to judge', async () => {
    // A finding, but not a deletable one - the operator is not being asked to sign off on a delete.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const live = await insertFabFile();
    await insertChunk(serializedDocument(String(live._id)));

    expect(await main()).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain('PREVIEW RESULT: exit 0 - 0 deletable, 1 kept for review');
  });

  it('exits 2 when rows would be deleted, and deletes none of them', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const doomed = await insertChunk(serializedDocument(String(new mongoose.Types.ObjectId())));

    expect(await main()).toBe(2);
    expect(log.mock.calls.flat().join('\n')).toContain('PREVIEW RESULT: exit 2 - 1 deletable');
    expect(await raw('fabfilechunks').countDocuments({ _id: doomed._id })).toBe(1);
  });
});
