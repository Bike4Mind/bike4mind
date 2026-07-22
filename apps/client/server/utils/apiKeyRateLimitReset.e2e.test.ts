import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer } from '../../../../packages/database/src/__test__/createMongoServer';
import { cacheRepository } from '@bike4mind/database';
import { buildRateLimitKeys, checkApiKeyRateLimit, resetApiKeyRateLimit } from './apiKeyRateLimitCheck';

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
}, 30000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
}, 30000);
afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

describe('resetApiKeyRateLimit (end-to-end, real cache repo + Mongo)', () => {
  it('unblocks a key that genuinely hit its ceiling, opening a fresh window', async () => {
    // Drive the enforcer to the minute ceiling: 2 allowed, 3rd rejected.
    expect((await checkApiKeyRateLimit(keyId, rateLimit)).allowed).toBe(true);
    expect((await checkApiKeyRateLimit(keyId, rateLimit)).allowed).toBe(true);
    const blocked = await checkApiKeyRateLimit(keyId, rateLimit);
    expect(blocked.allowed).toBe(false);
    expect(blocked.limitType).toBe('minute');

    await resetApiKeyRateLimit(keyId);

    // Fresh window: allowed again, counter restarted at 1.
    const afterReset = await checkApiKeyRateLimit(keyId, rateLimit);
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.headers['X-RateLimit-Remaining-Minute']).toBe(rateLimit.requestsPerMinute - 1);
    expect(afterReset.headers['X-RateLimit-Remaining-Day']).toBe(rateLimit.requestsPerDay - 1);
  });

  it('clears both window docs for the target key only; unrelated cache keys survive', async () => {
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
  });

  it('is idempotent: resetting a never-used or already-reset key is a no-op', async () => {
    await expect(resetApiKeyRateLimit('never-used-key')).resolves.toBeUndefined();
    await checkApiKeyRateLimit(keyId, rateLimit);
    await resetApiKeyRateLimit(keyId);
    await expect(resetApiKeyRateLimit(keyId)).resolves.toBeUndefined();
  });
});
