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
  /**
   * Read a dedupe entry's stored value without claiming or mutating it.
   *
   * Returns `null` when nobody holds the key - either it never existed, it was
   * released, or its TTL lapsed (Mongo's TTL sweeper can lag ~60s, so an
   * `expiresAt <= now` document is reported as absent rather than live).
   *
   * Absent is a THIRD answer, distinct from "held and in flight" and "held and
   * delivered". A caller that collapses it into either one asserts something it
   * did not observe: see prReportService/sendReport.ts, where an absent read
   * means the key is free and the send must be re-attempted, never reported as
   * a duplicate of a post that never happened.
   */
  readDedup(key: string): Promise<Record<string, unknown> | null>;
  /**
   * Conditionally replace a dedupe entry's value, but only while `ownerField`
   * still equals `ownerValue` - a compare-and-set.
   *
   * The TTL is set once at claim time, so a submit that stalls past it can
   * settle after the entry expired and a DIFFERENT submit claimed the same key.
   * An unconditional write would then overwrite the new owner's value. Guarding
   * on the owner token makes that impossible.
   *
   * @returns true when this caller still owned the entry and the write landed;
   *   false when the condition was not met (someone else owns it now).
   */
  casUpdateDedup(
    key: string,
    ownerField: string,
    ownerValue: string,
    data: Record<string, unknown>,
    ttlMs?: number
  ): Promise<boolean>;
  /**
   * Conditionally delete a dedupe entry, but only while `ownerField` still
   * equals `ownerValue` - a compare-and-delete, the release counterpart to
   * `casUpdateDedup`.
   *
   * An unconditional delete here would destroy a different submit's delivered
   * reservation and re-open the duplicate-post window this mechanism exists to
   * close.
   *
   * @returns true when this caller still owned the entry and it was deleted;
   *   false when the condition was not met.
   */
  casDeleteDedup(key: string, ownerField: string, ownerValue: string): Promise<boolean>;
}
