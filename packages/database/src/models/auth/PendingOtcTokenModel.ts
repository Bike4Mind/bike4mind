import mongoose, { Schema, Document, Model } from 'mongoose';
import { randomUUID } from 'crypto';

/**
 * Tracks the live pending OTC token nonces per email.
 * Prevents JWT replay attacks on the new-user registration path where
 * the attempt counter lives in the JWT - without this, an attacker could
 * replay the original attempts:0 token and bypass the per-code brute-force cap.
 *
 * Up to MAX_LIVE_OTC_CODES codes stay live per email, so a stranger requesting a code for an
 * address cannot void the owner's in-flight one; a successful verify consumes them all.
 *
 * Documents auto-expire via MongoDB TTL (10 minutes, matching OTC expiry).
 */

/** Live codes kept per email; the oldest is evicted by a newer send. */
export const MAX_LIVE_OTC_CODES = 3;
/** Matches OTC_EXPIRY_MS in sendOTC and the TTL index below. */
const OTC_CODE_TTL_MS = 10 * 60 * 1000;

interface IPendingOtcCode {
  nonce: string;
  expiresAt: Date;
}

interface IPendingOtcToken {
  email: string;
  /** Newest issued nonce; kept for pre-`codes` documents, `codes` is authoritative. */
  nonce: string;
  /** Live codes, newest first, at most MAX_LIVE_OTC_CODES. */
  codes: IPendingOtcCode[];
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
  codes: {
    type: [new Schema<IPendingOtcCode>({ nonce: String, expiresAt: Date }, { _id: false })],
    default: [],
  },
  createdAt: { type: Date, default: Date.now },
  debugCode: { type: String, default: null },
});

// Auto-expire after 10 minutes (matches OTC expiry)
pendingOtcTokenSchema.index({ createdAt: 1 }, { expireAfterSeconds: 600 });

const modelName = 'PendingOtcToken';

/**
 * Update pipeline that makes `nonce` the newest live code: expired codes are dropped and the list is
 * capped at MAX_LIVE_OTC_CODES, evicting the oldest.
 */
function pushLiveCodePipeline(nonce: string, debugCode: string | undefined, now: Date) {
  const code = { nonce: { $literal: nonce }, expiresAt: new Date(now.getTime() + OTC_CODE_TTL_MS) };
  const stillLive = {
    $filter: { input: { $ifNull: ['$codes', []] }, cond: { $gt: ['$$this.expiresAt', now] } },
  };
  return [
    {
      $set: {
        nonce: { $literal: nonce },
        debugCode: { $literal: debugCode ?? null },
        codes: { $slice: [{ $concatArrays: [[code], stillLive] }, MAX_LIVE_OTC_CODES] },
      },
    },
  ];
}

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
    const now = new Date();
    await PendingOtcTokenModel.updateOne(
      { email },
      [...pushLiveCodePipeline(nonce, debugCode, now), { $set: { createdAt: now } }],
      { upsert: true }
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
  ): Promise<
    { allowed: true; reservedAt: Date; previousCreatedAt: Date | null } | { allowed: false; retryAfterSeconds: number }
  > {
    const now = Date.now();
    const threshold = new Date(now - cooldownMs);
    const reservedAt = new Date(now);

    const existing = await PendingOtcTokenModel.findOne({ email }).select('createdAt');

    if (!existing) {
      // No record for this email - try to create one.
      // If concurrent requests race here, exactly one create wins; the rest hit E11000.
      try {
        await PendingOtcTokenModel.create({ email, nonce: randomUUID(), createdAt: reservedAt });
        return { allowed: true, reservedAt, previousCreatedAt: null };
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
    return { allowed: true, reservedAt, previousCreatedAt: existing.createdAt };
  }

  /**
   * Undo a `tryReserveSlot` that will not send a code, so the refused request does not start a
   * cooldown for the address: restores the previous `createdAt`, or removes a record the
   * reservation created. A no-op once a newer reservation has superseded this one.
   */
  async releaseReservation(email: string, reservedAt: Date, previousCreatedAt: Date | null): Promise<void> {
    if (previousCreatedAt) {
      await PendingOtcTokenModel.updateOne(
        { email, createdAt: reservedAt },
        { $set: { createdAt: previousCreatedAt } }
      );
    } else {
      await PendingOtcTokenModel.deleteOne({ email, createdAt: reservedAt, codes: { $size: 0 } });
    }
  }

  /**
   * Persist the real nonce for a reservation made by `tryReserveSlot`, guarded by a
   * compare-and-swap on `reservedAt`. OTC generation runs between the reservation and
   * this call (and may await IO); if a *newer* reservation for the same email lands
   * in that window - e.g. a genuinely concurrent resend - this CAS fails and returns
   * `false`. The caller MUST treat that as a failure, not a success: the nonce it's
   * holding would never verify, since another request has already superseded this
   * record. On success the nonce joins the live codes (see pushLiveCodePipeline).
   */
  async confirmReservation(email: string, reservedAt: Date, nonce: string, debugCode?: string): Promise<boolean> {
    const result = await PendingOtcTokenModel.findOneAndUpdate(
      { email, createdAt: reservedAt },
      pushLiveCodePipeline(nonce, debugCode, new Date()),
      { new: true }
    );
    return result !== null;
  }

  /**
   * Validate that the provided nonce is one of the live codes for this email, then atomically
   * replace it with a new nonce (for the re-issued token), keeping that code's expiry.
   * Returns true if the nonce was valid and replaced, false if stale/missing/expired.
   */
  async validateAndRotateNonce(email: string, currentNonce: string, newNonce: string): Promise<boolean> {
    const rotated = await PendingOtcTokenModel.findOneAndUpdate(
      { email, codes: { $elemMatch: { nonce: currentNonce, expiresAt: { $gt: new Date() } } } },
      { $set: { 'codes.$.nonce': newNonce } },
      { new: true }
    );
    if (rotated) return true;
    // A record written before `codes` existed keeps its single nonce (its TTL is 10 minutes).
    const legacy = await PendingOtcTokenModel.findOneAndUpdate(
      { email, nonce: currentNonce, codes: { $exists: false } },
      { $set: { nonce: newNonce } },
      { new: true }
    );
    return legacy !== null;
  }

  /**
   * After a correct code: every other live code for the email stops verifying, leaving only
   * `keepNonce` (the rotated nonce the route may re-issue to finish this same sign-in).
   */
  async consumeOtherCodes(email: string, keepNonce: string): Promise<void> {
    await PendingOtcTokenModel.updateOne(
      { email },
      { $pull: { codes: { nonce: { $ne: keepNonce } } }, $set: { nonce: keepNonce } }
    );
  }
}

export const pendingOtcTokenRepository = new PendingOtcTokenRepository();
