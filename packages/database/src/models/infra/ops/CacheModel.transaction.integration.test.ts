import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { withTransaction } from '@bike4mind/db-core';
import { createMongoReplSet, settleAutoIndexBuilds } from '../../../__test__/createMongoServer';
import { Cache, cacheRepository } from './CacheModel';

/**
 * A refused fixed-window claim ends in a duplicate-key error on the upsert. Joined to a caller's
 * transaction that error aborts it (NoSuchTransaction on the next query, retried for minutes), so
 * callers inside `withTransaction` pass `outsideTransaction`. Needs a real replica set.
 */
let server: Awaited<ReturnType<typeof createMongoReplSet>>;

beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await Cache.syncIndexes();
  await settleAutoIndexBuilds(mongoose);
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 60000);

describe('fixed-window claim inside a caller transaction', () => {
  it('a refused claim leaves the transaction usable when it runs outside it', async () => {
    const key = `txn-claim:${Date.now()}`;
    const first = await cacheRepository.tryAddWithinLimitFixedWindow(key, 1, 1, 60_000, { outsideTransaction: true });
    expect(first.success).toBe(true);

    const result = await withTransaction(async () => {
      const refused = await cacheRepository.tryAddWithinLimitFixedWindow(key, 1, 1, 60_000, {
        outsideTransaction: true,
      });
      const later = await Cache.findOne({ key });
      return { refused, count: (later?.result as { count: number }).count };
    });

    expect(result.refused.success).toBe(false);
    expect(result.count).toBe(1);
  }, 30000);

  it('releases a claim outside the transaction that failed', async () => {
    const key = `txn-release:${Date.now()}`;
    const { expiresAt } = await cacheRepository.tryAddWithinLimitFixedWindow(key, 1, 1, 60_000, {
      outsideTransaction: true,
    });

    await expect(
      withTransaction(async () => {
        await cacheRepository.releaseFromFixedWindow(key, 1, expiresAt, { outsideTransaction: true });
        throw new Error('force abort');
      })
    ).rejects.toThrow('force abort');

    const doc = await Cache.findOne({ key });
    expect((doc?.result as { count: number }).count).toBe(0);
  }, 30000);
});
