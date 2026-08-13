import { ICacheDocument, ICacheRepository } from '@bike4mind/common';
import mongoose from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

function extractCount(result: unknown, key: string): number {
  if (!result || typeof result !== 'object') {
    throw new Error(`Invalid counter result from MongoDB for key: ${key}`);
  }
  const count = (result as { count?: unknown }).count;
  if (typeof count !== 'number') {
    throw new Error(`Counter value is not a number for key: ${key}`);
  }
  return count;
}

class CacheRepository extends BaseRepository<ICacheDocument> implements ICacheRepository {
  constructor(model: mongoose.Model<ICacheDocument>) {
    super(model);
  }

  /**
   * Returns the entry only while it is still live. The `expiresAt` TTL index is what eventually
   * deletes the row, but Mongo's TTL monitor runs about once a minute, so without this guard an
   * entry stayed readable for up to ~60s past its own expiry - a stale report served as fresh, a
   * closed rate-limit window read as open. Callers that need the expired document itself (to
   * report a window's reset time, say) must query the model directly.
   *
   * A row with no `expiresAt` at all never expires - the TTL index ignores it too - so it stays
   * readable.
   */
  async findByKey(key: string) {
    return this.findOne({ key, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] });
  }

  async deleteByKey(key: string) {
    await this.model.deleteOne({ key });
  }

  async createOrUpdate(data: Omit<ICacheDocument, 'id' | 'updatedAt' | 'createdAt'>): Promise<ICacheDocument> {
    return this.model.findOneAndUpdate({ key: data.key }, data, { upsert: true, new: true });
  }

  /**
   * Atomically increment a counter stored in cache using MongoDB $inc
   * This is safe under concurrent load - no race conditions
   *
   * @param key - Cache key for the counter
   * @param ttlMs - TTL in milliseconds
   * @returns Current count after increment
   */
  async incrementCounter(key: string, ttlMs: number): Promise<number> {
    const expiresAt = new Date(Date.now() + ttlMs);

    const result = await this.model.findOneAndUpdate(
      { key },
      {
        $inc: { 'result.count': 1 },
        $setOnInsert: { key, expiresAt },
        // Update expiry on each request to maintain sliding window
        $set: { expiresAt },
      },
      {
        upsert: true,
        new: true, // Return updated document
      }
    );

    // Validate the result has the expected structure
    if (!result?.result || typeof result.result !== 'object') {
      throw new Error(`Invalid counter result from MongoDB for key: ${key}`);
    }

    const count = (result.result as { count?: number }).count;
    if (typeof count !== 'number') {
      throw new Error(`Counter value is not a number for key: ${key}`);
    }

    return count;
  }

  /**
   * Atomically increment a counter ONLY if it's under the specified limit
   * This prevents race conditions in rate limiting - check and increment happen atomically
   *
   * @param key - Cache key for the counter
   * @param limit - Maximum allowed count (inclusive)
   * @param ttlMs - TTL in milliseconds
   * @returns Object with success status and current count
   */
  async incrementCounterConditional(
    key: string,
    limit: number,
    ttlMs: number
  ): Promise<{ success: boolean; count: number }> {
    if (limit < 1) {
      return { success: false, count: 0 };
    }

    const expiresAt = new Date(Date.now() + ttlMs);

    // Fast path: increment if under limit (handles existing documents)
    const result = await this.model.findOneAndUpdate(
      {
        key,
        'result.count': { $lt: limit },
      },
      {
        $inc: { 'result.count': 1 },
        $set: { expiresAt }, // Sliding window - extend on each successful increment
      },
      { new: true }
    );

    if (result) {
      return { success: true, count: extractCount(result.result, key) };
    }

    // Cold path: no doc matched - either it doesn't exist, or count >= limit.
    // Ensure the document exists atomically (no E11000 because $setOnInsert
    // is a no-op when the doc already exists), then re-run the conditional $inc.
    // Seed count=0 so the retry's $inc lands at 1 if we're the creator.
    await this.model.updateOne({ key }, { $setOnInsert: { key, result: { count: 0 }, expiresAt } }, { upsert: true });

    const retried = await this.model.findOneAndUpdate(
      {
        key,
        'result.count': { $lt: limit },
      },
      {
        $inc: { 'result.count': 1 },
        $set: { expiresAt },
      },
      { new: true }
    );

    if (retried) {
      return { success: true, count: extractCount(retried.result, key) };
    }

    // Retry didn't match - doc exists and count >= limit.
    const existing = await this.model.findOne({ key });
    const currentCount = (existing?.result as { count?: number })?.count ?? 0;
    return { success: false, count: currentCount };
  }

  /**
   * Atomically increment a counter only if it's under the specified limit,
   * using FIXED-WINDOW semantics. Unlike `incrementCounterConditional`, this
   * method preserves the original `expiresAt` across increments - the window
   * opens on the first request and closes deterministically `ttlMs` later.
   *
   * Algorithm:
   *   1. Try to atomically `$inc` if the doc exists, is not expired, and is
   *      under the limit. No `expiresAt` modification -> fixed window.
   *   2. If (1) didn't match, try to upsert a fresh window - matches docs
   *      that are absent, expired, or have a legacy non-object `result` shape
   *      (this handles in-flight cache rows from before this migration).
   *   3. If the upsert hits a duplicate-key error, the doc exists and is
   *      not expired, so it's either at the limit OR another caller just
   *      seeded a fresh window. Retry (1) once to disambiguate. If still
   *      no match, fall through to a lookup and report "at limit".
   *
   * @param key - Cache key for the counter
   * @param limit - Maximum allowed count (inclusive)
   * @param ttlMs - Window duration in milliseconds
   * @returns success/count/expiresAt - expiresAt lets callers compute Retry-After
   */
  async tryIncrementWithinLimitFixedWindow(
    key: string,
    limit: number,
    ttlMs: number
  ): Promise<{ success: boolean; count: number; expiresAt: Date }> {
    return this.tryAddWithinLimitFixedWindow(key, 1, limit, ttlMs);
  }

  /**
   * `tryIncrementWithinLimitFixedWindow` generalized to add `amount` per call (spend
   * metering, where each event's weight differs). All-or-nothing: if count + amount
   * would exceed `limit`, nothing is applied. `amount <= 0` is a no-op success (nothing
   * to meter); a window that cannot fit `amount` at all (`limit < amount`) is a deny.
   */
  async tryAddWithinLimitFixedWindow(
    key: string,
    amount: number,
    limit: number,
    ttlMs: number
  ): Promise<{ success: boolean; count: number; expiresAt: Date }> {
    const now = new Date();
    const freshExpiresAt = new Date(now.getTime() + ttlMs);

    const readSuccess = (doc: ICacheDocument): { success: true; count: number; expiresAt: Date } => {
      const count = (doc.result as { count?: number })?.count;
      if (typeof count !== 'number') {
        throw new Error(`Counter value is not a number for key: ${key}`);
      }
      return { success: true, count, expiresAt: doc.expiresAt };
    };

    if (amount <= 0) {
      // Nothing to meter. Report current window state without consuming from it.
      const existing = await this.model.findOne({ key, expiresAt: { $gt: now } });
      const count = (existing?.result as { count?: number })?.count ?? 0;
      return { success: true, count, expiresAt: existing?.expiresAt ?? freshExpiresAt };
    }

    // `count + amount <= limit`, expressed as a query bound. With amount = 1 this is the
    // original `$lt: limit`. Also the `limit < amount` deny: the bound goes negative and
    // matches nothing (counts are never negative).
    const roomBound = { $lte: limit - amount };

    // (1) Add if doc exists, in-window, and the amount still fits.
    const incremented = await this.model.findOneAndUpdate(
      {
        key,
        expiresAt: { $gt: now },
        'result.count': roomBound,
      },
      { $inc: { 'result.count': amount } },
      { new: true }
    );
    if (incremented) return readSuccess(incremented);

    // (2) Claim a fresh window - absent doc, expired doc, or legacy shape. Skipped when the
    // amount cannot fit even in an empty window, which must deny rather than seed count > limit.
    if (amount <= limit) {
      try {
        const claimed = await this.model.findOneAndUpdate(
          {
            key,
            $or: [{ expiresAt: { $lte: now } }, { 'result.count': { $exists: false } }],
          },
          { $set: { result: { count: amount }, expiresAt: freshExpiresAt } },
          { upsert: true, new: true }
        );
        if (claimed) return readSuccess(claimed);
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err;
        // (3) Duplicate-key: doc exists, not expired. Either at limit or another
        // caller just claimed it. Retry the add once.
        const retried = await this.model.findOneAndUpdate(
          {
            key,
            expiresAt: { $gt: now },
            'result.count': roomBound,
          },
          { $inc: { 'result.count': amount } },
          { new: true }
        );
        if (retried) return readSuccess(retried);
      }
    }

    // No room. Look up current state for Retry-After.
    const existing = await this.model.findOne({ key });
    const count = (existing?.result as { count?: number })?.count ?? limit;
    return {
      success: false,
      count,
      expiresAt: existing?.expiresAt ?? freshExpiresAt,
    };
  }

  /**
   * Atomically decrement a counter (used for rollback)
   *
   * @param key - Cache key for the counter
   * @returns Current count after decrement
   */
  async decrementCounter(key: string): Promise<number> {
    const result = await this.model.findOneAndUpdate({ key }, { $inc: { 'result.count': -1 } }, { new: true });

    if (!result?.result || typeof result.result !== 'object') {
      return 0;
    }

    const count = (result.result as { count?: number }).count;
    return typeof count === 'number' ? count : 0;
  }

  /**
   * Atomically claim a deduplication key.
   * Uses atomic operations to prevent race conditions where multiple workers
   * could both claim the same key.
   *
   * @param key - Cache key to claim
   * @param data - Data to store if key is newly claimed
   * @param ttlMs - TTL in milliseconds
   * @returns Object with claimed flag (true if we created it, false if it existed)
   */
  async claimDedup(
    key: string,
    data: Record<string, unknown>,
    ttlMs: number
  ): Promise<{ claimed: boolean; existingData?: Record<string, unknown> }> {
    // Use a single timestamp for all operations to prevent race conditions
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    // Phase 1: Try to claim an expired document atomically
    // This handles the case where a document exists but has expired
    const claimedExpired = await this.model.findOneAndUpdate(
      { key, expiresAt: { $lt: now } },
      { $set: { result: data, expiresAt } },
      { new: true }
    );

    if (claimedExpired) {
      return { claimed: true };
    }

    // Phase 2: Try to insert a new document
    // Use $setOnInsert with upsert - only sets fields if document is newly created
    const existingDoc = await this.model.findOneAndUpdate(
      { key },
      {
        $setOnInsert: {
          key,
          result: data,
          expiresAt,
        },
      },
      {
        upsert: true,
        new: false, // Return the document BEFORE update (null if newly created)
      }
    );

    // If existingDoc is null, we just created the document - we claimed it
    if (!existingDoc) {
      return { claimed: true };
    }

    // Document exists and is not expired (we checked in Phase 1) - someone else owns it
    return {
      claimed: false,
      existingData: existingDoc.result as Record<string, unknown> | undefined,
    };
  }

  /**
   * Read a dedupe entry's value without claiming or mutating it.
   *
   * Treats an expired-but-not-yet-swept document as absent: Mongo's TTL monitor
   * runs about once a minute, so `expiresAt <= now` rows are still readable and
   * would otherwise look like live reservations.
   */
  async readDedup(key: string): Promise<Record<string, unknown> | null> {
    const doc = await this.model.findOne({ key, expiresAt: { $gt: new Date() } });
    return (doc?.result as Record<string, unknown> | undefined) ?? null;
  }

  /**
   * Compare-and-set on a dedupe entry: replace `result` only while
   * `result[ownerField]` still equals `ownerValue`.
   *
   * The owner guard is what stops a submit that stalled past its TTL from
   * overwriting a newer submit's reservation. Passing `ttlMs` extends the
   * expiry; omitting it leaves the original expiry in place, which is what a
   * state flip wants - the window should not slide just because the state moved.
   */
  async casUpdateDedup(
    key: string,
    ownerField: string,
    ownerValue: string,
    data: Record<string, unknown>,
    ttlMs?: number
  ): Promise<boolean> {
    const set: Record<string, unknown> = { result: data };
    if (ttlMs !== undefined) {
      set.expiresAt = new Date(Date.now() + ttlMs);
    }

    const updated = await this.model.findOneAndUpdate(
      { key, [`result.${ownerField}`]: ownerValue },
      { $set: set },
      { new: true }
    );

    return !!updated;
  }

  /**
   * Compare-and-delete on a dedupe entry: remove it only while
   * `result[ownerField]` still equals `ownerValue`.
   */
  async casDeleteDedup(key: string, ownerField: string, ownerValue: string): Promise<boolean> {
    const result = await this.model.deleteOne({ key, [`result.${ownerField}`]: ownerValue });
    return (result.deletedCount ?? 0) > 0;
  }
}

const CacheSchema = new mongoose.Schema<ICacheDocument>({
  key: { type: String, required: true, unique: true },
  result: { type: mongoose.Schema.Types.Mixed, required: true },
  expiresAt: { type: Date, required: true },
});

// Create the TTL index on expiresAt
CacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Cache: mongoose.Model<ICacheDocument> =
  mongoose.models.Cache || mongoose.model<ICacheDocument>('Cache', CacheSchema);

export const cacheRepository = new CacheRepository(Cache);
