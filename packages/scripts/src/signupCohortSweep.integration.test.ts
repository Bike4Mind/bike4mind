import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { User } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';

import { readSignupRecords } from './signupCohortSweep';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

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
  await User.collection.deleteMany({});
});

const OPTIONS = {
  localPartShapes: [],
  ignoredInfrastructureHosts: [],
  minHexLength: 6,
  registrationBucketDays: 14,
  signupBucketHours: 24,
};
const at = (iso: string) => new Date(`${iso}T10:00:00Z`);

// Raw inserts skip schema defaults and validation, so a missing signupMeta or a bad email can be seeded.
const insertUser = async (email: unknown, createdAt: Date, extra: Record<string, unknown> = {}) => {
  const _id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id, username: `u-${_id}`, email, createdAt, ...extra });
  return String(_id);
};

const ids = (records: { userId: string }[]) => records.map(record => record.userId).sort();

describe('readSignupRecords', () => {
  it('maps stored signup data, tolerating a missing signupMeta', async () => {
    const withMeta = await insertUser('sam@harbor.example', at('2026-03-10'), {
      signupMeta: { asn: 64500, isDatacenter: true },
    });
    const withoutMeta = await insertUser('kim@meadow.example', at('2026-03-11'));

    const records = await readSignupRecords(User, {}, OPTIONS);

    expect(records.find(record => record.userId === withMeta)).toMatchObject({
      domain: 'harbor.example',
      createdAt: at('2026-03-10'),
      asn: 64500,
      isDatacenter: true,
    });
    expect(records.find(record => record.userId === withoutMeta)).toMatchObject({
      domain: 'meadow.example',
      asn: null,
      isDatacenter: null,
    });
  });

  it('keeps users created at or after since and before until', async () => {
    const before = await insertUser('a@one.example', at('2026-02-28'));
    const atStart = await insertUser('b@two.example', at('2026-03-01'));
    const inside = await insertUser('c@three.example', at('2026-03-15'));
    const atEnd = await insertUser('d@four.example', at('2026-04-01'));

    const records = await readSignupRecords(User, { since: at('2026-03-01'), until: at('2026-04-01') }, OPTIONS);

    expect(ids(records)).toEqual([atStart, inside].sort());
    expect(ids(records)).not.toContain(before);
    expect(ids(records)).not.toContain(atEnd);
  });

  it('stops at maxUsers, taking the earliest signups and warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const latest = await insertUser('c@c.example', at('2026-03-12'));
    const earliest = await insertUser('a@a.example', at('2026-03-10'));
    const middle = await insertUser('b@b.example', at('2026-03-11'));
    const records = await readSignupRecords(User, { maxUsers: 2 }, OPTIONS);
    expect(ids(records)).toEqual([earliest, middle].sort());
    expect(ids(records)).not.toContain(latest);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('--max-users cap of 2'));
    warn.mockRestore();
  });

  it('skips a user whose email is not a string', async () => {
    await insertUser(null, at('2026-03-10'));
    const kept = await insertUser('sam@harbor.example', at('2026-03-10'));
    expect(ids(await readSignupRecords(User, {}, OPTIONS))).toEqual([kept]);
  });
});
