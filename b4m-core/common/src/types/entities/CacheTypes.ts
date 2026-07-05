import { IMongoDocument } from './common';
import { IBaseRepository } from './BaseTypes';

export interface ICacheDocument extends IMongoDocument {
  key: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any;
  expiresAt: Date;
}

export interface ICacheRepository extends IBaseRepository<ICacheDocument> {
  findByKey(key: string): Promise<ICacheDocument | null>;
  deleteByKey(key: string): Promise<void>;
  createOrUpdate(data: Omit<ICacheDocument, 'id' | 'updatedAt' | 'createdAt'>): Promise<ICacheDocument>;
  /**
   * Atomically increment a counter stored in cache
   * Uses MongoDB $inc for race-condition-free increments
   */
  incrementCounter(key: string, ttlMs: number): Promise<number>;
  /**
   * Atomically increment a counter ONLY if it's under the specified limit.
   * Uses SLIDING-WINDOW semantics - `expiresAt` is extended to now + ttlMs on
   * every successful increment. Suitable for dedup windows that should keep
   * extending as duplicates arrive.
   * @returns Object with success status and current count
   */
  incrementCounterConditional(key: string, limit: number, ttlMs: number): Promise<{ success: boolean; count: number }>;
  /**
   * Atomically increment a counter ONLY if it's under the specified limit.
   * Uses FIXED-WINDOW semantics - `expiresAt` is set when the window first
   * opens and preserved across increments until the window expires naturally.
   * The Mongo TTL background job may lag up to ~60s; this method handles the
   * expired-but-not-yet-deleted case via `expiresAt > now` in the query.
   *
   * Returns `expiresAt` so callers (e.g. the rate-limit middleware) can
   * compute `Retry-After` without a second round-trip.
   *
   * Suitable for request-rate limiting where a fixed window is required.
   */
  tryIncrementWithinLimitFixedWindow(
    key: string,
    limit: number,
    ttlMs: number
  ): Promise<{ success: boolean; count: number; expiresAt: Date }>;
  /**
   * Atomically decrement a counter (used for rollback)
   * @returns Current count after decrement
   */
  decrementCounter(key: string): Promise<number>;
  /**
   * Atomically claim a deduplication key.
   * Uses $setOnInsert to only set data if document is newly created.
   * Prevents race conditions where multiple workers could both claim the same key.
   *
   * @param key - Cache key to claim
   * @param data - Data to store if key is newly claimed
   * @param ttlMs - TTL in milliseconds
   * @returns Object with claimed flag (true if we created it, false if it existed)
   */
  claimDedup(
    key: string,
    data: Record<string, unknown>,
    ttlMs: number
  ): Promise<{ claimed: boolean; existingData?: Record<string, unknown> }>;
}
