import { describe, it, expect, beforeEach } from 'vitest';
import { PendingOtcTokenModel, pendingOtcTokenRepository } from '../models/auth/PendingOtcTokenModel';
import { setupMongoTest } from '../__test__/utils';

/**
 * Guards the atomic per-recipient OTC send cooldown.
 *
 * tryReserveSlot replaces the previous non-atomic check-then-act pattern
 * (getLastSentAt then storeNonce) that allowed N concurrent requests to all read
 * "no record" and all send an OTC email. The new approach uses the unique-email
 * index (brand-new email) or a compare-and-swap on the existing record's
 * createdAt (resend) to ensure exactly one request wins per cooldown window -
 * including when cooldownMs is 0 (the E2E case), where a naive "createdAt < now"
 * filter would otherwise let every racing request re-match a document a sibling
 * had just written.
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

  it('confirmReservation after a successful reserve persists the real nonce', async () => {
    const reservation = await pendingOtcTokenRepository.tryReserveSlot(EMAIL, COOLDOWN_MS);
    expect(reservation.allowed).toBe(true);
    if (!reservation.allowed) throw new Error('unreachable');

    const confirmed = await pendingOtcTokenRepository.confirmReservation(
      EMAIL,
      reservation.reservedAt,
      'real-nonce-abc',
      'debug-code'
    );

    expect(confirmed).toBe(true);
    const doc = await PendingOtcTokenModel.findOne({ email: EMAIL });
    expect(doc?.nonce).toBe('real-nonce-abc');
    expect(doc?.debugCode).toBe('debug-code');
  });

  describe('cooldownMs = 0 (E2E bypass)', () => {
    // Even at cooldownMs = 0, a resend in the SAME millisecond as the previous
    // reservation is blocked (`existing.createdAt >= threshold` compares at ms
    // resolution), so tests that reserve twice must let the clock tick first.
    const clockTickPast = async (previous: Date) => {
      while (Date.now() <= previous.getTime()) {
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    };

    it('allows repeated sequential resends to the same email, each overwriting the last nonce', async () => {
      const first = await pendingOtcTokenRepository.tryReserveSlot(EMAIL, 0);
      expect(first.allowed).toBe(true);
      if (!first.allowed) throw new Error('unreachable');
      expect(await pendingOtcTokenRepository.confirmReservation(EMAIL, first.reservedAt, 'nonce-1')).toBe(true);

      await clockTickPast(first.reservedAt);
      const second = await pendingOtcTokenRepository.tryReserveSlot(EMAIL, 0);
      expect(second.allowed).toBe(true);
      if (!second.allowed) throw new Error('unreachable');
      expect(await pendingOtcTokenRepository.confirmReservation(EMAIL, second.reservedAt, 'nonce-2')).toBe(true);

      const doc = await PendingOtcTokenModel.findOne({ email: EMAIL });
      expect(doc?.nonce).toBe('nonce-2');
      expect(await PendingOtcTokenModel.countDocuments({ email: EMAIL })).toBe(1);
    });

    it('concurrent reservations on an already-existing record: winners form a strict supersession chain (the createdAt < now bug this closes)', async () => {
      // Seed an existing record so every racer takes the "reclaim" branch, not the
      // brand-new-email "create" branch (that one was already protected by the
      // unique index, tested separately above).
      await PendingOtcTokenModel.create({ email: EMAIL, nonce: 'seed-nonce', createdAt: new Date(Date.now() - 1000) });

      const results = await Promise.all(
        Array.from({ length: 5 }, () => pendingOtcTokenRepository.tryReserveSlot(EMAIL, 0))
      );

      // The winner COUNT is scheduling-dependent, so don't assert it. At cooldownMs = 0
      // there is no cooldown window: a racer whose read lands after a sibling's claim is
      // a legitimate NEW winner, exactly like the sequential-resend case above. Promise.all
      // gives no barrier between one racer's write and another's read, so under CI load
      // more than one generation can occur (this flaked in CI expecting exactly 1).
      //
      // What the CAS does guarantee, under any scheduling:
      //   - at least one racer wins
      //   - winners supersede each other: strictly increasing, DISTINCT reservedAt values.
      //     The pre-fix bare `createdAt < now` filter let every racer win off the same
      //     stale snapshot (any prior write is always "in the past" relative to a later
      //     `now`), which shows up here as duplicate reservedAt values.
      //   - the record is updated in place, never duplicated
      //   - only the LAST winner holds a confirmable reservation; superseded winners fail
      const winners = results.filter((r): r is { allowed: true; reservedAt: Date } => r.allowed);
      expect(winners.length).toBeGreaterThanOrEqual(1);

      const times = winners.map(w => w.reservedAt.getTime()).sort((a, b) => a - b);
      for (let i = 1; i < times.length; i++) {
        expect(times[i]).toBeGreaterThan(times[i - 1]);
      }

      expect(await PendingOtcTokenModel.countDocuments({ email: EMAIL })).toBe(1);

      const latest = winners.reduce((a, b) => (a.reservedAt > b.reservedAt ? a : b));
      for (const w of winners) {
        const confirmed = await pendingOtcTokenRepository.confirmReservation(
          EMAIL,
          w.reservedAt,
          `nonce-${w.reservedAt.getTime()}`
        );
        expect(confirmed).toBe(w === latest);
      }
    });

    it('confirmReservation fails for a reservation a newer one has since superseded, instead of silently succeeding', async () => {
      const first = await pendingOtcTokenRepository.tryReserveSlot(EMAIL, 0);
      expect(first.allowed).toBe(true);
      if (!first.allowed) throw new Error('unreachable');

      // A second, later reservation for the same email lands before the first confirms
      // - e.g. a genuinely concurrent resend that arrived just after the first claimed
      // its slot but before it finished generating/sending its code.
      await clockTickPast(first.reservedAt);
      const second = await pendingOtcTokenRepository.tryReserveSlot(EMAIL, 0);
      expect(second.allowed).toBe(true);
      if (!second.allowed) throw new Error('unreachable');

      const firstConfirmed = await pendingOtcTokenRepository.confirmReservation(EMAIL, first.reservedAt, 'nonce-a');
      expect(firstConfirmed).toBe(false);

      const secondConfirmed = await pendingOtcTokenRepository.confirmReservation(EMAIL, second.reservedAt, 'nonce-b');
      expect(secondConfirmed).toBe(true);

      // Only the winner's nonce is ever persisted - never a value from a request
      // that was told (incorrectly) that it succeeded.
      const doc = await PendingOtcTokenModel.findOne({ email: EMAIL });
      expect(doc?.nonce).toBe('nonce-b');
    });
  });
});
