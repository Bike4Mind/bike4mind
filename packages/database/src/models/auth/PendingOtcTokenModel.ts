import mongoose, { Schema, Document, Model } from 'mongoose';
import { randomUUID } from 'crypto';

/**
 * Tracks the latest valid pending OTC token nonce per email.
 * Prevents JWT replay attacks on the new-user registration path where
 * the attempt counter lives in the JWT - without this, an attacker could
 * replay the original attempts:0 token and bypass the per-code brute-force cap.
 *
 * Documents auto-expire via MongoDB TTL (10 minutes, matching OTC expiry).
 */

interface IPendingOtcToken {
  email: string;
  nonce: string;
  createdAt: Date;
  /**
   * Plaintext OTC - written ONLY on non-production stages (gated by isE2EEnabled in
   * the route) so the test-only /api/test/otc-code endpoint can hand it to Playwright.
   * Never written on production; production only ever stores the bcrypt hash (in the JWT).
   */
  debugCode?: string;
}

interface IPendingOtcTokenDocument extends IPendingOtcToken, Document {}

const pendingOtcTokenSchema = new Schema<IPendingOtcTokenDocument>({
  email: { type: String, required: true, unique: true },
  nonce: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  debugCode: { type: String, default: null },
});

// Auto-expire after 10 minutes (matches OTC expiry)
pendingOtcTokenSchema.index({ createdAt: 1 }, { expireAfterSeconds: 600 });

const modelName = 'PendingOtcToken';

export const PendingOtcTokenModel: Model<IPendingOtcTokenDocument> =
  mongoose.models[modelName] || mongoose.model<IPendingOtcTokenDocument>(modelName, pendingOtcTokenSchema);

export class PendingOtcTokenRepository {
  /**
   * Returns when the last pending OTC token was issued for this email, or null
   * if none is on record. Used by /api/otc/send to enforce a per-recipient
   * send cooldown. A record is written for every /send regardless of whether the
   * account exists, so this check never reveals account existence.
   */
  async getLastSentAt(email: string): Promise<Date | null> {
    const doc = await PendingOtcTokenModel.findOne({ email });
    return doc?.createdAt ?? null;
  }

  /**
   * Store (or replace) the nonce for a given email.
   * Called when /api/otc/send issues a new pending token.
   *
   * `debugCode` is the plaintext OTC and MUST only be passed on non-production stages
   * (the caller gates this via isE2EEnabled). It powers the test-only otc-code endpoint.
   */
  async storeNonce(email: string, nonce: string, debugCode?: string): Promise<void> {
    await PendingOtcTokenModel.findOneAndUpdate(
      { email },
      { email, nonce, createdAt: new Date(), debugCode: debugCode ?? null },
      { upsert: true, new: true }
    );
  }

  /**
   * Test-only: returns the plaintext OTC stored for this email (non-production only).
   * Returns null if none is recorded (e.g., on production, where debugCode is never written).
   */
  async getDebugCode(email: string): Promise<string | null> {
    const doc = await PendingOtcTokenModel.findOne({ email });
    return doc?.debugCode ?? null;
  }

  /**
   * Atomically enforce a per-recipient send cooldown before the OTC email is sent.
   *
   * Returns `{ allowed: true, reservedAt }` when the slot was reserved (caller may
   * proceed to generate and send the OTC, then MUST call `confirmReservation` with
   * this same `reservedAt` to persist the real nonce - see that method for why the
   * reservation alone isn't enough). Returns `{ allowed: false, retryAfterSeconds }`
   * when the cooldown is still active or a concurrent request already claimed this
   * slot.
   *
   * Implementation:
   * 1. No existing record for this email - try to create one. A plain insert (not
   *    upsert) lets the unique-email index raise E11000 when concurrent first-time
   *    requests race, so exactly one wins and the rest are throttled.
   * 2. Existing record younger than the cooldown window - throttled.
   * 3. Existing record old enough - reclaim it via compare-and-swap on the
   *    `createdAt` just read. This CAS is what actually enforces "only one
   *    concurrent request wins" - a bare `createdAt < now` filter would let every
   *    racing request re-match a document a sibling had *just* written (this is
   *    what broke down when cooldownMs collapses to 0 for E2E: any prior write is
   *    always "in the past" relative to a `now` evaluated moments later, so nothing
   *    stopped every racer from re-claiming and silently clobbering the last
   *    winner's nonce). The CAS fails deterministically for a loser instead.
   */
  async tryReserveSlot(
    email: string,
    cooldownMs: number
  ): Promise<{ allowed: true; reservedAt: Date } | { allowed: false; retryAfterSeconds: number }> {
    const now = Date.now();
    const threshold = new Date(now - cooldownMs);
    const reservedAt = new Date(now);

    const existing = await PendingOtcTokenModel.findOne({ email }).select('createdAt');

    if (!existing) {
      // No record for this email - try to create one.
      // If concurrent requests race here, exactly one create wins; the rest hit E11000.
      try {
        await PendingOtcTokenModel.create({ email, nonce: randomUUID(), createdAt: reservedAt });
        return { allowed: true, reservedAt };
      } catch (err: unknown) {
        if ((err as { code?: number }).code === 11000) {
          const doc = await PendingOtcTokenModel.findOne({ email }).select('createdAt');
          const elapsed = doc ? now - doc.createdAt.getTime() : cooldownMs;
          return { allowed: false, retryAfterSeconds: Math.ceil(Math.max(0, cooldownMs - elapsed) / 1000) };
        }
        throw err;
      }
    }

    if (existing.createdAt >= threshold) {
      const elapsed = now - existing.createdAt.getTime();
      return { allowed: false, retryAfterSeconds: Math.ceil(Math.max(0, cooldownMs - elapsed) / 1000) };
    }

    const claimed = await PendingOtcTokenModel.findOneAndUpdate(
      { email, createdAt: existing.createdAt },
      { $set: { createdAt: reservedAt } },
      { new: true }
    );
    if (!claimed) {
      // A concurrent request claimed this same stale record between our read and write.
      return { allowed: false, retryAfterSeconds: 0 };
    }
    return { allowed: true, reservedAt };
  }

  /**
   * Persist the real nonce for a reservation made by `tryReserveSlot`, guarded by a
   * compare-and-swap on `reservedAt`. OTC generation runs between the reservation and
   * this call (and may await IO); if a *newer* reservation for the same email lands
   * in that window - e.g. a genuinely concurrent resend - this CAS fails and returns
   * `false`. The caller MUST treat that as a failure, not a success: the nonce it's
   * holding would never verify, since another request has already superseded this
   * record.
   */
  async confirmReservation(email: string, reservedAt: Date, nonce: string, debugCode?: string): Promise<boolean> {
    const result = await PendingOtcTokenModel.findOneAndUpdate(
      { email, createdAt: reservedAt },
      { $set: { nonce, debugCode: debugCode ?? null } },
      { new: true }
    );
    return result !== null;
  }

  /**
   * Validate that the provided nonce matches the stored one,
   * then atomically replace it with a new nonce (for the re-issued token).
   * Returns true if the nonce was valid and replaced, false if stale/missing.
   */
  async validateAndRotateNonce(email: string, currentNonce: string, newNonce: string): Promise<boolean> {
    const result = await PendingOtcTokenModel.findOneAndUpdate(
      { email, nonce: currentNonce },
      { nonce: newNonce },
      { new: true }
    );
    return result !== null;
  }
}

export const pendingOtcTokenRepository = new PendingOtcTokenRepository();
