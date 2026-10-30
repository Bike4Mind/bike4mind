import { randomUUID } from 'node:crypto';
import { cacheRepository } from '@bike4mind/database';
import {
  PUBLISH_RATE_LIMITED,
  PUBLISH_RATE_LIMITS,
  TooManyRequestsError,
  publishRateLimitMessage,
} from '@bike4mind/common';

/**
 * Publish - the per-user daily publish allowance (`PUBLISH_RATE_LIMITS`).
 *
 * Every publish write route (upload-url, reply/fabfile via settlePublication, revise, restore)
 * calls `consumePublishAction` once, after its own validation, permission and storage-quota
 * checks and before it does the work, so a refused or invalid request does not use up the
 * allowance. A route that is counted and then fails before anything is published (a failed storage
 * or record write, say) hands the action back with the receipt's `refund`, except that a revise
 * attempt that reaches the model keeps its count whatever the outcome.
 * finalize does not call it: it only promotes a draft a counted upload-url issued.
 *
 * Storage is the shared Mongo cache's lease primitive (`cacheRepository.tryAcquireLease`), used
 * as a sliding log: each action is a lease that lapses `windowMs` after it was taken, and a new
 * one is admitted only while fewer than the limit are live. That gives a true rolling window
 * rather than the fixed window of the `rateLimit` middleware, and since the prune, count and
 * append are one atomic update on one document per user, concurrent requests cannot take more
 * than the limit. The log holds at most `limit` entries, and the cache TTL drops it a window
 * after the last action. Times come from the app clock, as in the lease primitive itself.
 *
 * A cache read or write error propagates as a 500 (fails closed), the same as the `rateLimit`
 * and `apiKeyRateLimit` middlewares; the log lives in the same database the publish writes do.
 */

export interface PublishActor {
  id: string;
  isAdmin?: boolean;
  /** The account's creation time (`User.createdAt`), which selects the new-account allowance. */
  createdAt?: Date | string | null;
}

/** One counted publish action. */
export interface PublishActionReceipt {
  /**
   * Take this action back off the log, for a publish that failed after it was counted. Removes
   * only this action's own entry, so it can never free more than it took; calling it again, or
   * after the entry lapsed, is a no-op. Never throws: a failed refund only leaves the action counted.
   */
  refund(): Promise<void>;
}

const NOTHING_TO_REFUND: PublishActionReceipt = { refund: () => Promise.resolve() };

/** Cache key for a user's publish allowance; one per user, shared by every route and credential. */
export const publishActionsKey = (userId: string) => `rate-limit:${userId}:publish-actions`;

/**
 * When the account was created: `createdAt`, else the creation second an ObjectId id carries in
 * its first four bytes (for a row written without timestamps). NaN when neither is readable.
 */
function accountCreatedMs(actor: PublishActor): number {
  const createdMs = actor.createdAt ? new Date(actor.createdAt).getTime() : Number.NaN;
  if (Number.isFinite(createdMs)) return createdMs;
  return /^[0-9a-f]{24}$/i.test(actor.id) ? parseInt(actor.id.slice(0, 8), 16) * 1000 : Number.NaN;
}

/**
 * The actor's allowance per window: `Infinity` for admins (exempt, as with the publish quota and
 * the skill-market submit limits), the new-account tier for an account younger than
 * `newAccount.maxAgeMs` or with no readable creation time, else the standard tier.
 */
export function publishActionLimit(actor: PublishActor, now: number = Date.now()): number {
  if (actor.isAdmin) return Infinity;
  const createdMs = accountCreatedMs(actor);
  const isNewAccount = !Number.isFinite(createdMs) || now - createdMs < PUBLISH_RATE_LIMITS.newAccount.maxAgeMs;
  return isNewAccount ? PUBLISH_RATE_LIMITS.newAccount.maxActions : PUBLISH_RATE_LIMITS.maxActions;
}

/**
 * Seconds until the allowance next has room: when enough of the live leases have lapsed to bring
 * the count below `limit`. Read after the refusal, so it is a hint for `Retry-After`, not a promise.
 */
async function secondsUntilRoom(key: string, limit: number, now: number): Promise<number> {
  const doc = await cacheRepository.findByKey(key);
  const holders = (doc?.result as { holders?: Array<{ expiresAt?: Date | string }> } | undefined)?.holders ?? [];
  const expiries = holders
    .map(holder => new Date(holder.expiresAt ?? Number.NaN).getTime())
    .filter(ms => Number.isFinite(ms) && ms > now)
    .sort((a, b) => a - b);
  const freeAt = expiries[expiries.length - limit];
  return freeAt === undefined ? 1 : Math.max(1, Math.ceil((freeAt - now) / 1000));
}

/**
 * Count one publish action against the actor's allowance. Resolves to the action's receipt when
 * it fits; otherwise throws a 429 TooManyRequestsError, which errorHandler answers with the
 * standard error envelope, a `Retry-After` header and `code: 'publish_rate_limited'`.
 */
export async function consumePublishAction(actor: PublishActor): Promise<PublishActionReceipt> {
  const now = Date.now();
  const limit = publishActionLimit(actor, now);
  if (!Number.isFinite(limit)) return NOTHING_TO_REFUND;

  const key = publishActionsKey(actor.id);
  const actionId = randomUUID();
  if (await cacheRepository.tryAcquireLease(key, actionId, limit, PUBLISH_RATE_LIMITS.windowMs)) {
    return { refund: () => cacheRepository.releaseLease(key, actionId).catch(() => undefined) };
  }

  const retryAfter = await secondsUntilRoom(key, limit, now);
  throw new TooManyRequestsError(publishRateLimitMessage(retryAfter), {
    code: PUBLISH_RATE_LIMITED,
    retryAfter,
    details: { limit, windowMs: PUBLISH_RATE_LIMITS.windowMs },
  });
}
