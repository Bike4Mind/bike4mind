import { describe, it, expect, beforeEach } from 'vitest';
import { PendingOtcTokenModel, pendingOtcTokenRepository } from '../models/auth/PendingOtcTokenModel';
import { setupMongoTest } from '../__test__/utils';

/**
 * Guards the atomic per-recipient OTC send cooldown.
 *
 * tryReserveSlot replaces the previous non-atomic check-then-act pattern
 * (getLastSentAt then storeNonce) that allowed N concurrent requests to all read
 * "no record" and all send an OTC email. The new approach uses the unique-email
 * index to ensure exactly one request wins per cooldown window.
 */
describe('PendingOtcToken.tryReserveSlot — atomic cooldown enforcement', () => {
  setupMongoTest();

  const COOLDOWN_MS = 30_000;
  const EMAIL = 'rate-limit@example.com';

  beforeEach(async () => {
    // setupMongoTest's beforeEach drops the entire database (including indexes).
    // Re-sync PendingOtcTokenModel's unique-email index so E11000 is enforced.
    await PendingOtcTokenModel.ensureIndexes();
    await PendingOtcTokenModel.deleteMany({});
  });

  it('allows the first request (no existing record)', async () => {
    const result = await pendingOtcTokenRepository.tryReserveSlot(EMAIL, COOLDOWN_MS);
    expect(result.allowed).toBe(true);
    const doc = await PendingOtcTokenModel.findOne({ email: EMAIL });
    expect(doc).not.toBeNull();
  });

  it('blocks a second request within the cooldown window', async () => {
    await pendingOtcTokenRepository.tryReserveSlot(EMAIL, COOLDOWN_MS);
    const second = await pendingOtcTokenRepository.tryReserveSlot(EMAIL, COOLDOWN_MS);
    expect(second.allowed).toBe(false);
    expect(typeof second.retryAfterSeconds).toBe('number');
    expect(second.retryAfterSeconds).toBeGreaterThan(0);
    expect(second.retryAfterSeconds).toBeLessThanOrEqual(COOLDOWN_MS / 1000);
  });

  it('allows a request once the cooldown window has passed', async () => {
    const past = new Date(Date.now() - COOLDOWN_MS - 1000);
    await PendingOtcTokenModel.create({ email: EMAIL, nonce: 'old-nonce', createdAt: past });

    const result = await pendingOtcTokenRepository.tryReserveSlot(EMAIL, COOLDOWN_MS);
    expect(result.allowed).toBe(true);

    // Verify the old record was updated (not a second doc inserted)
    const count = await PendingOtcTokenModel.countDocuments({ email: EMAIL });
    expect(count).toBe(1);
  });

  it('concurrent reservations: exactly one wins (race simulation)', async () => {
    // Simulate the concurrent-request race by firing all reservations in parallel.
    // Exactly one should be allowed; the rest should be blocked.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => pendingOtcTokenRepository.tryReserveSlot(EMAIL, COOLDOWN_MS))
    );
    const allowed = results.filter(r => r.allowed);
    const blocked = results.filter(r => !r.allowed);
    expect(allowed).toHaveLength(1);
    expect(blocked).toHaveLength(4);
  });

  it('storeNonce after a successful reserve updates the placeholder nonce', async () => {
    await pendingOtcTokenRepository.tryReserveSlot(EMAIL, COOLDOWN_MS);
    await pendingOtcTokenRepository.storeNonce(EMAIL, 'real-nonce-abc', 'debug-code');

    const doc = await PendingOtcTokenModel.findOne({ email: EMAIL });
    expect(doc?.nonce).toBe('real-nonce-abc');
    expect(doc?.debugCode).toBe('debug-code');
  });
});
