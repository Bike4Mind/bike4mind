import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { Subscriber } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921236500_normalize-subscriber-emails';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

const row = (email: string, extra: Record<string, unknown> = {}) => ({
  firstName: 'Ada',
  lastName: 'Lovelace',
  email,
  deletedAt: null,
  inviteGenerated: false,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...extra,
});

const insert = async (...rows: ReturnType<typeof row>[]) => {
  const { insertedIds } = await Subscriber.collection.insertMany(rows);
  return Object.values(insertedIds);
};

const all = () => Subscriber.collection.find({}).sort({ _id: 1 }).toArray();
const live = async () => (await all()).filter(doc => doc.deletedAt == null);

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await Subscriber.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await Subscriber.collection.deleteMany({});
});

describe('normalize-subscriber-emails migration (real DB)', () => {
  it('trims and lowercases a lone mixed-case email in place', async () => {
    const [id] = await insert(row('  Ada@Example.COM '));

    await migration.up();

    const [doc] = await all();
    expect(doc._id).toEqual(id);
    expect(doc.email).toBe('ada@example.com');
    expect(doc.deletedAt).toBeNull();
  });

  it('keeps one live row per address and soft-deletes the case variants', async () => {
    await insert(
      row('Ada@Example.com', { createdAt: new Date('2026-02-01T00:00:00Z') }),
      row('ADA@example.com', { createdAt: new Date('2026-01-01T00:00:00Z') }),
      row('grace@example.com')
    );

    await migration.up();

    const rows = await live();
    expect(rows.map(doc => doc.email).sort()).toEqual(['ada@example.com', 'grace@example.com']);
    const ada = rows.find(doc => doc.email === 'ada@example.com');
    expect(ada?.createdAt).toEqual(new Date('2026-01-01T00:00:00Z'));
    expect(await Subscriber.collection.countDocuments({})).toBe(3);
  });

  it('keeps the row that already holds the normalized address and carries over live and invite state', async () => {
    const [exactId] = await insert(
      row('ada@example.com', { deletedAt: new Date('2026-03-01T00:00:00Z') }),
      row('Ada@Example.com', {
        inviteGenerated: true,
        inviteCode: 'CODE123',
        inviteGeneratedBy: 'admin-1',
        startingCredits: 500,
        startingStorage: 100,
      })
    );

    await migration.up();

    const rows = await live();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      _id: exactId,
      email: 'ada@example.com',
      inviteGenerated: true,
      inviteCode: 'CODE123',
      inviteGeneratedBy: 'admin-1',
      startingCredits: 500,
      startingStorage: 100,
    });
  });

  it('prefers a live row over an older soft-deleted one when none is normalized yet', async () => {
    const [, liveId] = await insert(
      row('ADA@example.com', { deletedAt: new Date('2026-03-01T00:00:00Z') }),
      row('Ada@Example.com', { createdAt: new Date('2026-04-01T00:00:00Z') })
    );

    await migration.up();

    const rows = await live();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ _id: liveId, email: 'ada@example.com' });
  });

  it('leaves the stored set accepted by the model so a later variant signup is a duplicate', async () => {
    await insert(row('Ada@Example.com'), row('ADA@EXAMPLE.COM'));

    await migration.up();

    await expect(
      Subscriber.create({ firstName: 'Ada', lastName: 'Lovelace', email: 'aDa@example.com' })
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('is idempotent on re-run', async () => {
    await insert(row('Ada@Example.com'), row('ADA@example.com'), row('ada@example.com'));
    await migration.up();
    const first = await all();

    await migration.up();

    expect(await all()).toEqual(first);
  });

  it('is a no-op on an empty collection', async () => {
    await expect(migration.up()).resolves.toBeUndefined();
  });
});
