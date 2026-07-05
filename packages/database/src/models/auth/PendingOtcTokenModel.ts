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
   * Returns `{ allowed: true }` when the slot was reserved (caller may proceed to
   * generate and send the OTC); returns `{ allowed: false, retryAfterSeconds }` when
   * the cooldown is still active.
   *
   * Implementation (three steps):
   * 1. Try to update an existing record whose createdAt is old enough (no upsert).
   *    Only one concurrent request can match and update the same document - the
   *    subsequent requests will find a recent createdAt and fall through to step 2.
   * 2. If no old-enough record was updated, check whether a recent one exists.
   *    If yes -> throttled.
   * 3. If no record exists at all, create one. A plain insert (not upsert) lets the
   *    unique-email index raise E11000 when two concurrent requests race, so exactly
   *    one wins and the rest are treated as throttled.
   *
   * Callers MUST call `storeNonce` after OTC generation to replace the placeholder
   * nonce written here with the real one.
   */
  async tryReserveSlot(email: string, cooldownMs: number): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
    const now = Date.now();
    const threshold = new Date(now - cooldownMs);

    // Step 1: update an existing record that is past the cooldown window.
    // No upsert - only matches documents that already exist and are old enough.
    const updated = await PendingOtcTokenModel.findOneAndUpdate(
      { email, createdAt: { $lt: threshold } },
      { $set: { nonce: randomUUID(), createdAt: new Date(now), debugCode: null } },
      { new: true }
    );
    if (updated) return { allowed: true };

    // Step 2: no old-enough record was updated. Check if a recent record exists.
    const existing = await PendingOtcTokenModel.findOne({ email }).select('createdAt');
    if (existing) {
      const elapsed = Date.now() - existing.createdAt.getTime();
      return { allowed: false, retryAfterSeconds: Math.ceil(Math.max(0, cooldownMs - elapsed) / 1000) };
    }

    // Step 3: no record for this email - try to create one.
    // If concurrent requests race here, exactly one create wins; the rest hit E11000.
    try {
      await PendingOtcTokenModel.create({ email, nonce: randomUUID(), createdAt: new Date(now) });
      return { allowed: true };
    } catch (err: unknown) {
      if ((err as { code?: number }).code === 11000) {
        const doc = await PendingOtcTokenModel.findOne({ email }).select('createdAt');
        const elapsed = doc ? Date.now() - doc.createdAt.getTime() : cooldownMs;
        return { allowed: false, retryAfterSeconds: Math.ceil(Math.max(0, cooldownMs - elapsed) / 1000) };
      }
      throw err;
    }
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
