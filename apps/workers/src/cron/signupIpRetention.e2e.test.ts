import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { User } from '@bike4mind/database';
import { runSignupIpRetention } from './signupIpRetention';

/**
 * Retention sweep against a real mongod: the capturedAt/`$type` query and the conditional bulk
 * writes are what decide which rows change, and a mocked collection cannot evaluate either.
 */

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://test/%STAGE%' } }));

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-26T00:00:00Z');
const OLD = new Date(NOW.getTime() - 91 * DAY_MS);
const FRESH = new Date(NOW.getTime() - 89 * DAY_MS);

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await User.collection.deleteMany({});
});

async function seed(rows: Array<Record<string, unknown>>) {
  const { insertedIds } = await User.collection.insertMany(
    rows.map((extra, i) => ({ username: `user${i}`, email: `user${i}@example.com`, ...extra }))
  );
  return Object.values(insertedIds);
}

async function ipsOf(ids: mongoose.Types.ObjectId[]) {
  const docs = await Promise.all(ids.map(_id => User.collection.findOne({ _id })));
  return docs.map(doc => doc?.signupMeta?.ip);
}

describe('signupIpRetention (real DB)', () => {
  it('truncates IPs past the window and keeps the full IP inside it', async () => {
    const ids = await seed([
      { signupMeta: { ip: '203.0.113.42', country: 'US', capturedAt: OLD }, updatedAt: OLD },
      { signupMeta: { ip: '2001:db8:abcd:12:34:56:78:9a', capturedAt: OLD } },
      { signupMeta: { ip: '2001:db8:abcd::1', capturedAt: OLD } },
      { signupMeta: { ip: '::ffff:198.51.100.9', capturedAt: OLD } },
      { signupMeta: { ip: '203.0.113.42', capturedAt: FRESH } },
      { signupMeta: { ip: null, capturedAt: OLD } },
      {},
    ]);

    const before = await User.collection.findOne({ _id: ids[0] });
    const result = await runSignupIpRetention({ now: NOW });

    expect(await ipsOf(ids)).toEqual([
      '203.0.113.0',
      '2001:db8:abcd:0:0:0:0:0',
      '2001:db8:abcd:0:0:0:0:0',
      '::ffff:198.51.100.0',
      '203.0.113.42',
      null,
      undefined,
    ]);
    expect(result.truncatedCount).toBe(4);
    const untouched = await User.collection.findOne({ _id: ids[0] });
    expect(untouched?.signupMeta).toMatchObject({ country: 'US', capturedAt: OLD });
    expect(untouched?.updatedAt).toEqual(before?.updatedAt);
  });

  it('is a no-op on re-run', async () => {
    const ids = await seed([
      { signupMeta: { ip: '198.51.100.7', capturedAt: OLD } },
      { signupMeta: { ip: '2001:db8:1:2::3', capturedAt: OLD } },
      { signupMeta: { ip: 'not-an-ip', capturedAt: OLD } },
    ]);

    await runSignupIpRetention({ now: NOW, batchSize: 1 });
    const afterFirst = await ipsOf(ids);
    const second = await runSignupIpRetention({ now: NOW, batchSize: 1 });

    expect(second).toMatchObject({ truncatedCount: 0, batches: 0 });
    expect(await ipsOf(ids)).toEqual(afterFirst);
  });
});
