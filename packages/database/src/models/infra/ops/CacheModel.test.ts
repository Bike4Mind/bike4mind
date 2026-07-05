import { describe, it, expect, beforeEach } from 'vitest';
import { cacheRepository, Cache } from './CacheModel';
import { setupMongoTest } from '../../../__test__/utils';

// Single mongo lifecycle for both describe blocks - calling setupMongoTest()
// twice in one file creates two MongoMemoryServer lifecycles that disconnect
// each other mid-suite.
setupMongoTest();

// setupMongoTest's beforeEach calls dropDatabase(), which drops the unique
// index on `key` along with the data. Re-sync indexes before every test so
// the upsert-on-conflict path can rely on a 11000 duplicate-key error and
// the buggy non-atomic create path would actually trip the unique constraint.
beforeEach(async () => {
  await Cache.syncIndexes();
});

describe('CacheRepository.incrementCounterConditional', () => {
  const limit = 5;
  const ttlMs = 60_000;

  it('first request seeds the counter at 1', async () => {
    const key = `rl:${Date.now()}-1`;
    const result = await cacheRepository.incrementCounterConditional(key, limit, ttlMs);

    expect(result).toEqual({ success: true, count: 1 });
  });

  it('sequential requests increment until limit, then reject', async () => {
    const key = `rl:${Date.now()}-2`;

    for (let i = 1; i <= limit; i++) {
      const r = await cacheRepository.incrementCounterConditional(key, limit, ttlMs);
      expect(r).toEqual({ success: true, count: i });
    }

    const blocked = await cacheRepository.incrementCounterConditional(key, limit, ttlMs);
    expect(blocked).toEqual({ success: false, count: limit });
  });

  it('returns success=false when limit < 1', async () => {
    const key = `rl:${Date.now()}-3`;
    const result = await cacheRepository.incrementCounterConditional(key, 0, ttlMs);

    expect(result).toEqual({ success: false, count: 0 });
    // Should not create a document
    expect(await Cache.findOne({ key })).toBeNull();
  });

  // The original race: two concurrent requests both miss the doc and both
  // call create() against the unique-indexed key - the loser throws E11000.
  // The intermediate fix swapped the throw for a silent false-rejection of
  // the race-loser. This test guards against both.
  it('concurrent burst against a fresh key produces exactly limit successes (no throws, no false rejects)', async () => {
    const key = `rl:${Date.now()}-4`;
    const concurrentCount = 50;

    const results = await Promise.all(
      Array.from({ length: concurrentCount }, () => cacheRepository.incrementCounterConditional(key, limit, ttlMs))
    );

    const successes = results.filter(r => r.success);
    const failures = results.filter(r => !r.success);

    expect(successes.length).toBe(limit);
    expect(failures.length).toBe(concurrentCount - limit);

    // Every success must report a unique count in [1..limit]
    const successCounts = successes.map(r => r.count).sort((a, b) => a - b);
    expect(successCounts).toEqual([1, 2, 3, 4, 5]);

    // Failures all see the saturated counter
    failures.forEach(r => expect(r.count).toBe(limit));

    // Final stored count matches the limit - no double-counting, no lost increments
    const doc = await Cache.findOne({ key });
    expect((doc?.result as { count: number }).count).toBe(limit);
  });

  it('concurrent burst smaller than limit lets all requests through', async () => {
    const key = `rl:${Date.now()}-5`;
    const concurrentCount = 3;

    const results = await Promise.all(
      Array.from({ length: concurrentCount }, () => cacheRepository.incrementCounterConditional(key, limit, ttlMs))
    );

    expect(results.every(r => r.success)).toBe(true);
    const counts = results.map(r => r.count).sort((a, b) => a - b);
    expect(counts).toEqual([1, 2, 3]);
  });
});

describe('CacheRepository.tryIncrementWithinLimitFixedWindow', () => {
  const limit = 5;
  const windowMs = 60_000;

  it('first request seeds the window with count=1', async () => {
    const key = `rate-limit:test:${Date.now()}-1`;
    const result = await cacheRepository.tryIncrementWithinLimitFixedWindow(key, limit, windowMs);

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now() + windowMs - 1000);
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + windowMs + 100);
  });

  it('increments preserve the original expiresAt (fixed window)', async () => {
    const key = `rate-limit:test:${Date.now()}-2`;

    const first = await cacheRepository.tryIncrementWithinLimitFixedWindow(key, limit, windowMs);
    const firstExpiresAt = first.expiresAt.getTime();

    // Wait long enough that a sliding window would visibly drift forward.
    await new Promise(r => setTimeout(r, 50));

    const second = await cacheRepository.tryIncrementWithinLimitFixedWindow(key, limit, windowMs);

    expect(second.success).toBe(true);
    expect(second.count).toBe(2);
    expect(second.expiresAt.getTime()).toBe(firstExpiresAt);
  });

  it('rejects with success=false once limit is reached', async () => {
    const key = `rate-limit:test:${Date.now()}-3`;

    for (let i = 1; i <= limit; i++) {
      const r = await cacheRepository.tryIncrementWithinLimitFixedWindow(key, limit, windowMs);
      expect(r.success).toBe(true);
      expect(r.count).toBe(i);
    }

    const blocked = await cacheRepository.tryIncrementWithinLimitFixedWindow(key, limit, windowMs);
    expect(blocked.success).toBe(false);
    expect(blocked.count).toBe(limit);
    expect(blocked.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('resets when the window has expired (handles TTL lag)', async () => {
    const key = `rate-limit:test:${Date.now()}-4`;

    // Manually seed a doc that's "expired in time" but not yet TTL-deleted.
    await Cache.create({
      key,
      result: { count: limit },
      expiresAt: new Date(Date.now() - 1000),
    });

    const result = await cacheRepository.tryIncrementWithinLimitFixedWindow(key, limit, windowMs);

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('overwrites legacy numeric `result` shape on first contact', async () => {
    const key = `rate-limit:test:${Date.now()}-5`;

    // Old shape - what the pre-migration rateLimit middleware wrote.
    await Cache.create({
      key,
      result: 3,
      expiresAt: new Date(Date.now() + windowMs),
    });

    const result = await cacheRepository.tryIncrementWithinLimitFixedWindow(key, limit, windowMs);

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);

    const doc = await Cache.findOne({ key });
    expect(doc?.result).toEqual({ count: 1 });
  });

  it('concurrent burst never exceeds the limit', async () => {
    const key = `rate-limit:test:${Date.now()}-6`;
    const concurrentCount = 50;

    const results = await Promise.all(
      Array.from({ length: concurrentCount }, () =>
        cacheRepository.tryIncrementWithinLimitFixedWindow(key, limit, windowMs)
      )
    );

    const successes = results.filter(r => r.success);
    const failures = results.filter(r => !r.success);

    expect(successes.length).toBe(limit);
    expect(failures.length).toBe(concurrentCount - limit);

    const successCounts = successes.map(r => r.count).sort((a, b) => a - b);
    expect(successCounts).toEqual([1, 2, 3, 4, 5]);

    failures.forEach(r => expect(r.count).toBe(limit));
  });
});
