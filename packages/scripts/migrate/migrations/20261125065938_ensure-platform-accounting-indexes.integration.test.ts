import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { PlatformAttempt, UsageEvent } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';
import migration, { ensurePlatformAccountingIndexes } from './20261125065938_ensure-platform-accounting-indexes';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>>;
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await Promise.all([UsageEvent.createCollection(), PlatformAttempt.createCollection()]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

describe('platform accounting index migration', () => {
  it('builds only additive accounting indexes and is idempotent with automatic indexes disabled', async () => {
    expect(await UsageEvent.collection.indexes()).toHaveLength(1);
    await UsageEvent.collection.createIndex({ preservedLegacyField: 1 }, { name: 'preserved_legacy' });
    await migration.up();
    await migration.up();
    const usage = await UsageEvent.collection.indexes();
    expect(usage.find(index => index.key.providerCallId === 1)).toMatchObject({
      unique: true,
      partialFilterExpression: { 'attribution.kind': 'platform_operation' },
    });
    expect(usage.find(index => index.name === 'preserved_legacy')).toBeDefined();
    expect(usage.some(index => index.key.ownerId === 1)).toBe(false);
    expect((await PlatformAttempt.collection.indexes()).find(index => index.key.providerCallId === 1)).toMatchObject({
      unique: true,
    });
    await migration.down();
    expect(await UsageEvent.collection.indexes()).toEqual(usage);
  });

  it('fails closed when required schema indexes disappear', async () => {
    const get = vi.spyOn(UsageEvent.schema, 'indexes').mockReturnValue([]);
    await expect(ensurePlatformAccountingIndexes(UsageEvent, PlatformAttempt)).rejects.toThrow('not declared');
    get.mockRestore();
  });

  it('propagates an index creation failure without applying a migration receipt', async () => {
    const create = vi.spyOn(UsageEvent.collection, 'createIndex').mockRejectedValueOnce(new Error('index unavailable'));
    await expect(migration.up()).rejects.toThrow('index unavailable');
    create.mockRestore();
  });
});
