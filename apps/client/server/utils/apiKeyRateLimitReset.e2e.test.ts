import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { cacheRepository } from '@bike4mind/database';
import { buildRateLimitKeys, checkApiKeyRateLimit, resetApiKeyRateLimit } from './apiKeyRateLimitCheck';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND
// hooks in one place (see MONGO_TEST_TIMEOUT_MS for why 30s is not enough).
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * Agreement test for the rate-limit reset, driving the REAL enforcer and the
 * REAL reset through the REAL cache repository against createMongoServer. The
 * unit tests mock the cache layer, so only this test proves the enforcer's
 * counter keys and the reset's deletions actually line up at runtime: a key
 * driven to its ceiling is unblocked by the reset, and unrelated cache docs
 * survive. Consumes the built dist, so `pnpm turbo:core:build` must be current.
 */

let mongoServer: MongoMemoryServer;

const keyId = 'e2e-rate-limit-key';
const rateLimit = { requestsPerMinute: 2, requestsPerDay: 1000 };

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

describe('resetApiKeyRateLimit (end-to-end, real cache repo + Mongo)', () => {
  it('unblocks a key that genuinely hit its ceiling, opening a fresh window', async () => {
    // Freeze the clock (Date only - Mongo's real timers/IO are untouched) so the enforcer's
    // fixed wall-clock window can't roll over mid-test. On a starved CI runner the three
    // sequential awaits below could otherwise span >60s, expiring the window and letting the
    // "blocked" call through - a false red in the runner, not the code. All calls must see one
    // window. The frozen instant must be in the real-clock FUTURE: the cache collection has a
    // TTL index on expiresAt, and mongod's sweeper runs on its own real clock (not the faked
    // Date), so a past instant would make the window doc immediately TTL-eligible and delete it
    // mid-test - the same starved-runner flake, reintroduced via TTL.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    try {
      // Drive the enforcer to the minute ceiling: 2 allowed, 3rd rejected.
      expect((await checkApiKeyRateLimit(keyId, rateLimit)).allowed).toBe(true);
      expect((await checkApiKeyRateLimit(keyId, rateLimit)).allowed).toBe(true);
      const blocked = await checkApiKeyRateLimit(keyId, rateLimit);
      expect(blocked.allowed).toBe(false);
      expect(blocked.limitType).toBe('minute');

      // Against a real cache repo (not mocked), the usage this reports is
      // read from the exact document the atomic findOneAndDelete removed -
      // proves the reported count matches what was actually cleared, not a
      // stale pre-read.
      const result = await resetApiKeyRateLimit(keyId);
      expect(result.request).toMatchObject({ minute: 2, day: 2 });

      // Fresh window: allowed again, counter restarted at 1.
      const afterReset = await checkApiKeyRateLimit(keyId, rateLimit);
      expect(afterReset.allowed).toBe(true);
      expect(afterReset.headers['X-RateLimit-Remaining-Minute']).toBe(rateLimit.requestsPerMinute - 1);
      expect(afterReset.headers['X-RateLimit-Remaining-Day']).toBe(rateLimit.requestsPerDay - 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears both window docs for the target key only; unrelated cache keys survive', async () => {
    // Same freeze rationale as the test above: without it these are live 60s-TTL windows, and a
    // starved CI runner spanning the sequential awaits below across a real minute rollover is a
    // false red, not a bug.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    try {
      const otherKeyId = 'e2e-other-key';
      await checkApiKeyRateLimit(keyId, rateLimit);
      await checkApiKeyRateLimit(otherKeyId, rateLimit);
      // A non-rate-limit cache doc that shares nothing but the collection.
      await cacheRepository.createOrUpdate({ key: 'unrelated:cache-doc', result: { value: 42 } });

      await resetApiKeyRateLimit(keyId);

      // findByKey yields undefined (not null) for a missing doc, so assert falsy/truthy.
      const target = buildRateLimitKeys(keyId);
      expect(await cacheRepository.findByKey(target.minuteKey)).toBeFalsy();
      expect(await cacheRepository.findByKey(target.dayKey)).toBeFalsy();

      const other = buildRateLimitKeys(otherKeyId);
      expect(await cacheRepository.findByKey(other.minuteKey)).toBeTruthy();
      expect(await cacheRepository.findByKey(other.dayKey)).toBeTruthy();
      expect(await cacheRepository.findByKey('unrelated:cache-doc')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is idempotent: resetting a never-used or already-reset key is a no-op', async () => {
    await expect(resetApiKeyRateLimit('never-used-key')).resolves.toMatchObject({
      request: { minute: 0, day: 0 },
    });
    await checkApiKeyRateLimit(keyId, rateLimit);
    await resetApiKeyRateLimit(keyId);
    await expect(resetApiKeyRateLimit(keyId)).resolves.toMatchObject({ request: { minute: 0, day: 0 } });
  });

  it('alsoResetManagement additionally clears the management counter (#2883)', async () => {
    // Same freeze rationale as the two tests above.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    try {
      await checkApiKeyRateLimit(keyId, rateLimit, undefined, { counter: 'management' });

      await resetApiKeyRateLimit(keyId); // routine reset: request counter only

      const management = buildRateLimitKeys(keyId, 'management');
      expect(await cacheRepository.findByKey(management.minuteKey)).toBeTruthy();
      expect(await cacheRepository.findByKey(management.dayKey)).toBeTruthy();

      const result = await resetApiKeyRateLimit(keyId, { alsoResetManagement: true });

      expect(await cacheRepository.findByKey(management.minuteKey)).toBeFalsy();
      expect(await cacheRepository.findByKey(management.dayKey)).toBeFalsy();
      // The management usage reported back reflects what was actually cleared -
      // one call was made above, so the minute counter was at 1 when deleted.
      expect(result.management).toMatchObject({ minute: 1, day: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});
