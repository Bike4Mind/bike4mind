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

import { main } from './preview-near-empty-fabfilechunks';

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

async function insertChunk(
  fabFileId: string,
  overrides: { text?: string; charLength?: number; vector?: number[] | null } = {}
) {
  const text = overrides.text ?? 'x';
  const charLength = overrides.charLength ?? text.length;
  const doc: Record<string, unknown> = {
    _id: new mongoose.Types.ObjectId(),
    fabFileId,
    text,
    tokenCount: 1,
    charLength,
  };
  if (overrides.vector !== null) doc.vector = overrides.vector ?? [0.1];
  await raw('fabfilechunks').insertOne(doc);
  return doc;
}

async function insertFabFile() {
  const doc = { _id: new mongoose.Types.ObjectId(), userId: 'user-1', fileName: 'contract.pdf', deletedAt: null };
  await raw('fabfiles').insertOne(doc);
  return doc;
}

/**
 * The exit code is the operator's go/no-go signal and 2 is deliberately NOT an error, so it has to
 * be pinned: `sst shell` and `pnpm --filter` both collapse a non-zero child code to 1, which is why
 * the script also prints PREVIEW RESULT and why both are asserted together. This is READ-ONLY -
 * every test also asserts the row count is unchanged.
 */
describe('preview-near-empty-fabfilechunks exit-code contract (real DB)', () => {
  it('exits 0 when nothing would be deleted', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const file = await insertFabFile();
    await insertChunk(String(file._id), { text: 'a'.repeat(60), charLength: 60 });

    expect(await main()).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain('PREVIEW RESULT: exit 0 - 0 deletable, 0 kept as sole chunk');
    expect(await raw('fabfilechunks').countDocuments()).toBe(1);
  });

  it('exits 2 when a degenerate vector-bearing chunk would be deleted, and deletes nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const file = await insertFabFile();
    const doomed = await insertChunk(String(file._id), { text: '.', charLength: 1 });
    await insertChunk(String(file._id), { text: 'a'.repeat(100), charLength: 100 });

    expect(await main()).toBe(2);
    expect(log.mock.calls.flat().join('\n')).toContain('PREVIEW RESULT: exit 2 - 1 deletable, 0 kept as sole chunk');
    expect(await raw('fabfilechunks').countDocuments({ _id: doomed._id as mongoose.Types.ObjectId })).toBe(1);
  });

  it('exits 0 and reports a kept-as-sole-chunk finding when every chunk in a file is degenerate', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const file = await insertFabFile();
    await insertChunk(String(file._id), { text: '.', charLength: 1 });

    expect(await main()).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain('PREVIEW RESULT: exit 0 - 0 deletable, 1 kept as sole chunk');
  });

  it("leaves a vectorless near-empty chunk alone (out of this sweep's scope) and a charLength-less one uncounted", async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const file = await insertFabFile();
    await insertChunk(String(file._id), { text: '.', charLength: 1, vector: null });
    const noCharLength = {
      _id: new mongoose.Types.ObjectId(),
      fabFileId: String(file._id),
      text: '.',
      tokenCount: 1,
      vector: [0.1],
    };
    await raw('fabfilechunks').insertOne(noCharLength);

    expect(await main()).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain('PREVIEW RESULT: exit 0 - 0 deletable, 0 kept as sole chunk');
    expect(await raw('fabfilechunks').countDocuments()).toBe(2);
  });
});
