import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { Migration, MigrationLock } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';
import type { MigrationFile } from '@bike4mind/database';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let available: MigrationFile[] = [];
vi.mock('./migrations', () => ({
  get AvailableMigrations() {
    return available;
  },
}));
vi.mock('../seeders', () => ({ seeders: [] }));
vi.mock('../utils/config', () => ({ Config: {} }));

const { MigrationManager } = await import('./migrationManager');
const { acquireMigrationLease, MIGRATION_LOCK_ID } = await import('./migrationLock');
const { default: ensureIdIndex } = await import('./migrations/20261127043214_ensure-migration-id-unique-index');

const logger = new Logger();
let server: Awaited<ReturnType<typeof createMongoServer>>;

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function countingMigration(id: number, calls: Map<number, number>): MigrationFile {
  return {
    id,
    name: `migration-${id}`,
    up: async () => {
      calls.set(id, (calls.get(id) ?? 0) + 1);
      // Long enough that a second run starts while this one still holds the lease.
      await delay(50);
    },
    down: async () => {},
  };
}

const uniqueIdIndex = async () =>
  (await Migration.collection.indexes()).find(index => index.key.id === 1 && index.unique === true);

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri(), { dbName: 'migration_manager' });
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  available = [];
});

describe('MigrationManager single-runner lease', () => {
  it('applies each migration exactly once when two runs start together', async () => {
    const calls = new Map<number, number>();
    available = [countingMigration(1, calls), countingMigration(2, calls), countingMigration(3, calls)];

    await Promise.all([new MigrationManager(logger).up(null), new MigrationManager(logger).up(null)]);

    expect([...calls.entries()].sort()).toEqual([
      [1, 1],
      [2, 1],
      [3, 1],
    ]);
    expect((await Migration.find().sort({ id: 1 })).map(m => m.id)).toEqual([1, 2, 3]);
    expect(await MigrationLock.countDocuments()).toBe(0);
  });

  it('exits without applying anything while another run holds a live lease', async () => {
    const calls = new Map<number, number>();
    available = [countingMigration(1, calls)];
    const expiresAt = new Date(Date.now() + 60_000);
    await MigrationLock.create({ _id: MIGRATION_LOCK_ID, owner: 'other-run', acquiredAt: new Date(), expiresAt });

    await new MigrationManager(logger).up(null);
    await new MigrationManager(logger).down(null);

    expect(calls.size).toBe(0);
    expect(await Migration.countDocuments()).toBe(0);
    expect(await MigrationLock.findById(MIGRATION_LOCK_ID).lean()).toMatchObject({ owner: 'other-run', expiresAt });
  });

  it('takes over the lease a crashed run left behind once it has expired', async () => {
    const calls = new Map<number, number>();
    available = [countingMigration(1, calls)];
    await MigrationLock.create({
      _id: MIGRATION_LOCK_ID,
      owner: 'crashed-run',
      acquiredAt: new Date(Date.now() - 600_000),
      expiresAt: new Date(Date.now() - 1_000),
    });

    await new MigrationManager(logger).up(null);

    expect(calls.get(1)).toBe(1);
    expect(await Migration.countDocuments({ id: 1 })).toBe(1);
    expect(await MigrationLock.countDocuments()).toBe(0);
  });

  it('renews a held lease and notices when another run takes it', async () => {
    const lease = await acquireMigrationLease(logger, { leaseDurationMs: 300, renewIntervalMs: 50 });
    if (!lease) throw new Error('expected to acquire the lease');

    await delay(400);
    expect(lease.isLost()).toBe(false);
    expect(await acquireMigrationLease(logger)).toBeNull();

    await MigrationLock.updateOne({ _id: MIGRATION_LOCK_ID }, { $set: { owner: 'thief' } }, { runValidators: true });
    await delay(150);
    expect(lease.isLost()).toBe(true);

    await lease.release();
    expect(await MigrationLock.findById(MIGRATION_LOCK_ID).lean()).toMatchObject({ owner: 'thief' });
  });

  it('stops before the next migration once the lease is lost', async () => {
    const calls = new Map<number, number>();
    const stealLease: MigrationFile = {
      id: 1,
      name: 'steal-lease',
      up: async () => {
        await MigrationLock.updateOne(
          { _id: MIGRATION_LOCK_ID },
          { $set: { owner: 'thief' } },
          { runValidators: true }
        );
        await delay(150);
      },
      down: async () => {},
    };
    available = [stealLease, countingMigration(2, calls)];

    await expect(
      new MigrationManager(logger, { leaseDurationMs: 1_000, renewIntervalMs: 50 }).up(null)
    ).rejects.toThrow(/lease .* was lost/);
    expect(calls.size).toBe(0);
  });
});

describe('unique migration id', () => {
  it('rejects a duplicate Migration record at the database', async () => {
    await Migration.init();
    await Migration.create({ id: 1, name: 'first' });

    await expect(Migration.create({ id: 1, name: 'first' })).rejects.toMatchObject({ code: 11000 });
    expect(await Migration.countDocuments({ id: 1 })).toBe(1);
  });

  it('ensure-index migration builds the unique index when there are no duplicates', async () => {
    await Migration.collection.insertMany([
      { id: 1, name: 'a', migratedAt: new Date() },
      { id: 2, name: 'b', migratedAt: new Date() },
    ]);

    await ensureIdIndex.up();
    await ensureIdIndex.up();

    expect(await uniqueIdIndex()).toBeDefined();
  });

  it('ensure-index migration fails clearly, building nothing, when duplicates exist', async () => {
    await Migration.collection.insertMany([
      { id: 1, name: 'a', migratedAt: new Date() },
      { id: 2, name: 'b', migratedAt: new Date() },
      { id: 2, name: 'b', migratedAt: new Date() },
    ]);

    await expect(ensureIdIndex.up()).rejects.toThrow(
      /1 migration id\(s\) are recorded more than once: 2 x2 \(b\)\. Nothing was changed/
    );
    expect(await uniqueIdIndex()).toBeUndefined();
    expect(await Migration.countDocuments()).toBe(3);
  });
});
