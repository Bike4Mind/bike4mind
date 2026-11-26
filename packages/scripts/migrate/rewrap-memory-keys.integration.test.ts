import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import mongoose, { type mongo } from 'mongoose';
import { encryptFact, openWrappedDek, wrapDekUnder } from '@bike4mind/server-utils/memory/factCipher';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';
import { formatSweep, rewrapRow, sweepExitCode, sweepMemoryKeys } from './rewrap-memory-keys-sweep';
import { run } from './rewrap-memory-keys';

const mocks = vi.hoisted(() => ({ resources: {} as Record<string, string | undefined> }));
vi.mock('./encrypt-admin-settings-and-apikeys', () => ({
  getResource: (name: string) => mocks.resources[name],
  getStage: () => 'test',
}));

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const sha = (secret: string) => createHash('sha256').update(secret).digest();
const oldKey = sha('old-secret');
const newKey = sha('new-secret');
const keys = { current: newKey, previous: oldKey };

let server: Awaited<ReturnType<typeof createMongoServer>>;
let client: mongo.MongoClient;
let db: mongo.Db;
let keysColl: mongo.Collection;
let counter = 0;

beforeAll(async () => {
  server = await createMongoServer();
  client = await new mongoose.mongo.MongoClient(server.getUri()).connect();
  db = client.db('rewrap_main');
  keysColl = db.collection('memoryprincipalkeys');
});
afterAll(async () => {
  await client.close();
  await server.stop();
});
beforeEach(async () => {
  await db.dropDatabase();
  mocks.resources = {
    MEMORY_KEY_SECRET: 'new-secret',
    MEMORY_KEY_SECRET_PREVIOUS: 'old-secret',
    MONGODB_URI: server.getUri().replace(/\/?$/, '/rewrap_main'),
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Seeds one principal key wrapped under `wrapKey` plus one encrypted fact under its data key. */
async function seed(wrapKey: Buffer | null, extra: Record<string, unknown> = {}) {
  const dek = randomBytes(32);
  const principalId = `u${++counter}`;
  const dekValue = wrapKey ? wrapDekUnder(wrapKey, dek) : undefined;
  const { insertedId } = await keysColl.insertOne({
    principalKind: 'user',
    principalId,
    ownerUserId: principalId,
    ...(dekValue ? { dek: dekValue } : {}),
    ...extra,
  });
  const sealed = encryptFact(dek, 'fact-' + principalId);
  await db.collection('memoryledgerevents').insertOne({
    principalKind: 'user',
    principalId,
    factCipher: sealed.cipher,
    factIv: sealed.iv,
    factTag: sealed.tag,
  });
  return { _id: insertedId, dek, dekValue };
}

const snapshot = async () => JSON.stringify(await keysColl.find({}).sort({ _id: 1 }).toArray());

function captureOutput() {
  const lines: string[] = [];
  const grab = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  vi.spyOn(console, 'log').mockImplementation(grab);
  vi.spyOn(console, 'error').mockImplementation(grab);
  return lines;
}

describe('sweepMemoryKeys', () => {
  it('rewraps previous-key rows, keeps data keys, and a second run rewraps 0', async () => {
    const a = await seed(oldKey);
    const b = await seed(newKey);
    const first = await sweepMemoryKeys(db, keys, 'rewrite');
    expect(first).toMatchObject({ scanned: 2, rewrapped: 1, alreadyCurrent: 1 });
    const row = await keysColl.findOne({ _id: a._id });
    expect(openWrappedDek(row!.dek, [newKey])?.dek).toEqual(a.dek);
    expect(openWrappedDek(row!.dek, [oldKey])).toBeNull();
    expect((await keysColl.findOne({ _id: b._id }))!.dek).toBe(b.dekValue);
    const second = await sweepMemoryKeys(db, keys, 'rewrite');
    expect(second.rewrapped).toBe(0);
    expect(sweepExitCode(second)).toBe(0);
  });

  it('dry-run writes nothing and counts what a run would do', async () => {
    await seed(oldKey);
    await seed(oldKey);
    const before = await snapshot();
    const counts = await sweepMemoryKeys(db, keys, 'dry-run');
    expect(counts.wouldRewrap).toBe(2);
    expect(await snapshot()).toBe(before);
  });

  it('reports unfinished rewraps in the dry-run exit code', async () => {
    await seed(oldKey);
    expect(sweepExitCode(await sweepMemoryKeys(db, keys, 'dry-run'))).toBe(1);
  });

  it('reports a raw key inserted after the preflight count', async () => {
    await seed(newKey);
    const count = vi.spyOn(mongoose.mongo.Collection.prototype, 'countDocuments');
    count.mockImplementationOnce(async () => {
      await keysColl.insertOne({ principalKind: 'user', principalId: 'late-raw', dek: 'raw:late' });
      return 0;
    });
    const counts = await sweepMemoryKeys(db, keys, 'verify');
    expect(counts).toMatchObject({ scanned: 2, alreadyCurrent: 1, raw: 1 });
    expect(sweepExitCode(counts)).toBe(2);
  });

  it('reports partial progress if a raw key appears during a rewrite', async () => {
    const row = await seed(oldKey);
    vi.spyOn(mongoose.mongo.Collection.prototype, 'countDocuments').mockImplementationOnce(async () => {
      await keysColl.insertOne({ principalKind: 'user', principalId: 'late-rewrite-raw', dek: 'raw:late' });
      return 0;
    });
    const counts = await sweepMemoryKeys(db, keys, 'rewrite');
    expect(counts).toMatchObject({ scanned: 2, rewrapped: 1, raw: 1 });
    expect(sweepExitCode(counts)).toBe(2);
    expect(openWrappedDek((await keysColl.findOne({ _id: row._id }))!.dek, [newKey])?.dek).toEqual(row.dek);
    expect(formatSweep(counts, 'rewrite')).not.toContain('nothing was written');
  });

  it('does not treat facts from a destroyed key as evidence against a reminted key', async () => {
    const destroyedAt = new Date('2026-11-25T10:00:00Z');
    await seed(newKey, { destroyedAt });
    const principalId = `u${counter}`;
    const old = encryptFact(randomBytes(32), 'erased fact');
    await db.collection('memoryledgerevents').updateOne(
      { principalId },
      {
        $set: {
          factCipher: old.cipher,
          factIv: old.iv,
          factTag: old.tag,
          createdAt: new Date(destroyedAt.getTime() - 1),
        },
      }
    );
    const counts = await sweepMemoryKeys(db, keys, 'verify');
    expect(counts).toMatchObject({ factsChecked: 0, factsUnreadable: 0, principalsWithoutFacts: 1 });
    expect(sweepExitCode(counts)).toBe(0);
  });

  it('still verifies a fact created after the latest key destruction', async () => {
    const destroyedAt = new Date('2026-11-25T10:00:00Z');
    await seed(newKey, { destroyedAt });
    await db
      .collection('memoryledgerevents')
      .updateOne({ principalId: `u${counter}` }, { $set: { createdAt: new Date(destroyedAt.getTime() + 1) } });
    const counts = await sweepMemoryKeys(db, keys, 'verify');
    expect(counts).toMatchObject({ factsChecked: 1, factsUnreadable: 0, principalsWithoutFacts: 0 });
    expect(sweepExitCode(counts)).toBe(0);
  });

  it('leaves a tombstone byte-identical', async () => {
    await seed(null, { destroyedAt: new Date(0) });
    await seed(oldKey);
    const tomb = JSON.stringify(await keysColl.findOne({ dek: { $exists: false } }));
    const counts = await sweepMemoryKeys(db, keys, 'rewrite');
    expect(counts).toMatchObject({ tombstones: 1, rewrapped: 1 });
    expect(JSON.stringify(await keysColl.findOne({ dek: { $exists: false } }))).toBe(tomb);
  });

  it('stops on a raw row with exit 2 and writes nothing', async () => {
    await seed(oldKey);
    await keysColl.insertOne({
      principalKind: 'user',
      principalId: 'raw1',
      ownerUserId: 'x',
      dek: 'raw:' + randomBytes(32).toString('base64'),
    });
    const before = await snapshot();
    const counts = await sweepMemoryKeys(db, keys, 'rewrite');
    expect(sweepExitCode(counts)).toBe(2);
    expect(await snapshot()).toBe(before);
  });

  it('stops on an unprefixed legacy row with exit 2 and writes nothing', async () => {
    await seed(oldKey);
    await keysColl.insertOne({
      principalKind: 'user',
      principalId: 'legacy1',
      ownerUserId: 'x',
      dek: randomBytes(32).toString('base64'),
    });
    const before = await snapshot();
    expect(sweepExitCode(await sweepMemoryKeys(db, keys, 'rewrite'))).toBe(2);
    expect(await snapshot()).toBe(before);
  });

  it('verify exits 2 on a raw row', async () => {
    await seed(newKey);
    await keysColl.insertOne({
      principalKind: 'user',
      principalId: 'raw2',
      ownerUserId: 'x',
      dek: 'raw:' + randomBytes(32).toString('base64'),
    });
    const counts = await sweepMemoryKeys(db, keys, 'verify');
    expect(counts.raw).toBe(1);
    expect(sweepExitCode(counts)).toBe(2);
  });

  it('treats an empty-string dek as a tombstone, not a raw row', async () => {
    await keysColl.insertOne({ principalKind: 'user', principalId: 'empty1', ownerUserId: 'x', dek: '' });
    await seed(oldKey);
    const counts = await sweepMemoryKeys(db, keys, 'rewrite');
    expect(counts).toMatchObject({ raw: 0, tombstones: 1, rewrapped: 1 });
  });

  it('verify samples the newest fact, not one sealed under a destroyed key', async () => {
    const { dek } = await seed(newKey);
    const principalId = `u${counter}`;
    const stale = encryptFact(randomBytes(32), 'old fact');
    const fresh = encryptFact(dek, 'new fact');
    const events = db.collection('memoryledgerevents');
    await events.deleteMany({});
    await events.insertMany([
      { principalKind: 'user', principalId, seq: 1, factCipher: stale.cipher, factIv: stale.iv, factTag: stale.tag },
      { principalKind: 'user', principalId, seq: 2, factCipher: fresh.cipher, factIv: fresh.iv, factTag: fresh.tag },
    ]);
    const counts = await sweepMemoryKeys(db, keys, 'verify');
    expect(counts).toMatchObject({ factsChecked: 1, factsUnreadable: 0 });
    expect(sweepExitCode(counts)).toBe(0);
  });

  it('counts a row under an unrelated key, exits 1, and leaves it untouched', async () => {
    await seed(sha('third'));
    const before = await snapshot();
    const counts = await sweepMemoryKeys(db, keys, 'rewrite');
    expect(counts.openedByNeither).toBe(1);
    expect(sweepExitCode(counts)).toBe(1);
    expect(await snapshot()).toBe(before);
  });

  it('treats an empty collection as clean', async () => {
    expect(sweepExitCode(await sweepMemoryKeys(db, keys, 'rewrite'))).toBe(0);
  });

  it('verify exits 1 before a rewrap and 0 after, decrypting a fact with the rewrapped key', async () => {
    await seed(oldKey);
    expect(sweepExitCode(await sweepMemoryKeys(db, keys, 'verify'))).toBe(1);
    await sweepMemoryKeys(db, keys, 'rewrite');
    const after = await sweepMemoryKeys(db, keys, 'verify');
    expect(after).toMatchObject({ factsChecked: 1, factsUnreadable: 0 });
    expect(sweepExitCode(after)).toBe(0);
  });

  it('verify flags a fact the stored key cannot decrypt', async () => {
    const { _id } = await seed(newKey);
    await keysColl.updateOne({ _id }, { $set: { dek: wrapDekUnder(newKey, randomBytes(32)) } });
    expect(sweepExitCode(await sweepMemoryKeys(db, keys, 'verify'))).toBe(1);
  });
});

describe('rewrapRow race', () => {
  it('does not resurrect a key erased between read and write', async () => {
    const { _id } = await seed(oldKey);
    const stale = (await keysColl.findOne({ _id }))!;
    await keysColl.updateOne({ _id }, { $unset: { dek: '' }, $set: { destroyedAt: new Date() } });
    expect(await rewrapRow(keysColl as never, stale as never, keys, 'rewrite')).toBe('changed');
    expect((await keysColl.findOne({ _id }))!.dek).toBeUndefined();
  });

  it('does not overwrite a key re-minted between read and write', async () => {
    const { _id } = await seed(oldKey);
    const stale = (await keysColl.findOne({ _id }))!;
    const minted = wrapDekUnder(newKey, randomBytes(32));
    await keysColl.updateOne({ _id }, { $set: { dek: minted } });
    expect(await rewrapRow(keysColl as never, stale as never, keys, 'rewrite')).toBe('changed');
    expect((await keysColl.findOne({ _id }))!.dek).toBe(minted);
  });
});

describe('sweepExitCode', () => {
  it('exits 1 while a row may still be moving', async () => {
    const counts = await sweepMemoryKeys(db, keys, 'rewrite');
    expect(sweepExitCode({ ...counts, changedDuringWrite: 1 })).toBe(1);
  });
});

describe('run (CLI)', () => {
  it('rejects --dry-run with --verify', async () => {
    captureOutput();
    expect(await run(['--dry-run', '--verify'])).toBe(2);
  });

  it('needs a previous secret to rewrap, but not to verify', async () => {
    captureOutput();
    mocks.resources.MEMORY_KEY_SECRET_PREVIOUS = undefined;
    expect(await run([])).toBe(2);
    expect(await run(['--verify'])).toBe(0);
  });

  it('uses exported secrets when SST resources contain placeholders', async () => {
    captureOutput();
    await seed(oldKey);
    mocks.resources.MEMORY_KEY_SECRET = 'not-configured';
    mocks.resources.MEMORY_KEY_SECRET_PREVIOUS = 'not-configured';
    vi.stubEnv('MEMORY_KEY_SECRET', 'new-secret');
    vi.stubEnv('MEMORY_KEY_SECRET_PREVIOUS', 'old-secret');
    expect(await run([])).toBe(0);
    expect(await run(['--verify'])).toBe(0);
  });

  it('proceeds with exported secrets when no SST resource is linked', async () => {
    captureOutput();
    const row = await seed(sha('exported-old'));
    mocks.resources.MEMORY_KEY_SECRET = undefined;
    mocks.resources.MEMORY_KEY_SECRET_PREVIOUS = undefined;
    vi.stubEnv('MEMORY_KEY_SECRET', 'exported-new');
    vi.stubEnv('MEMORY_KEY_SECRET_PREVIOUS', 'exported-old');
    expect(await run([])).toBe(0);
    const stored = await keysColl.findOne({ _id: row._id });
    expect(openWrappedDek(stored!.dek, [sha('exported-new')])?.dek).toEqual(row.dek);
  });

  it('proceeds with SST resources alone', async () => {
    captureOutput();
    const row = await seed(oldKey);
    expect(await run([])).toBe(0);
    expect(openWrappedDek((await keysColl.findOne({ _id: row._id }))!.dek, [newKey])?.dek).toEqual(row.dek);
  });

  it('proceeds when the environment and the SST resource hold the same secrets', async () => {
    captureOutput();
    await seed(oldKey);
    vi.stubEnv('MEMORY_KEY_SECRET', 'new-secret');
    vi.stubEnv('MEMORY_KEY_SECRET_PREVIOUS', 'old-secret');
    expect(await run([])).toBe(0);
    expect(await run(['--verify'])).toBe(0);
  });

  it('refuses an environment secret that differs from the SST resource, before connecting', async () => {
    const lines = captureOutput();
    const row = await seed(oldKey);
    const connect = vi.spyOn(mongoose, 'connect');
    vi.stubEnv('MEMORY_KEY_SECRET', 'stray-secret');
    for (const argv of [[], ['--dry-run'], ['--verify']]) {
      expect(await run(argv)).toBe(2);
    }
    expect(connect).not.toHaveBeenCalled();
    expect((await keysColl.findOne({ _id: row._id }))!.dek).toBe(row.dekValue);
    const out = lines.join('\n');
    expect(out).toContain('MEMORY_KEY_SECRET in the environment differs from the linked SST resource');
    expect(out).not.toContain('stray-secret');
    expect(out).not.toContain('new-secret');
  });

  it('refuses a previous secret in the environment that differs from the SST resource', async () => {
    const lines = captureOutput();
    const connect = vi.spyOn(mongoose, 'connect');
    vi.stubEnv('MEMORY_KEY_SECRET_PREVIOUS', 'stray-previous');
    expect(await run([])).toBe(2);
    expect(connect).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('MEMORY_KEY_SECRET_PREVIOUS in the environment differs');
    expect(await run(['--verify'])).toBe(0);
  });

  it('rejects previous equal to current', async () => {
    captureOutput();
    mocks.resources.MEMORY_KEY_SECRET_PREVIOUS = 'new-secret';
    expect(await run([])).toBe(2);
  });

  it('rewraps end to end and prints no key material or ids', async () => {
    const lines = captureOutput();
    const row = await seed(oldKey);
    expect(await run(['--verify'])).toBe(1);
    expect(await run([])).toBe(0);
    expect(await run(['--verify'])).toBe(0);
    const out = lines.join('\n');
    expect(out).not.toContain(row.dekValue!);
    expect(out).not.toContain(String(row._id));
    expect(out).toContain('rewrapped=1');
  });
});
