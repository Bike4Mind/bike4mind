import { randomUUID } from 'node:crypto';
import { cacheRepository } from '@bike4mind/database';
import { PUBLISH_RATE_LIMITED, PUBLISH_RATE_LIMITS, TooManyRequestsError } from '@bike4mind/common';

/**
 * Publish - the per-user daily publish allowance (`PUBLISH_RATE_LIMITS`).
 *
 * Every publish write route (upload-url, reply/fabfile via settlePublication, revise, restore)
 * calls `consumePublishAction` once, after its own validation, permission and storage-quota
 * checks and before it does the work, so a refused or invalid request does not use up the
 * allowance. finalize does not call it: it only promotes a draft a counted upload-url issued.
 *
 * Storage is the shared Mongo cache's lease primitive (`cacheRepository.tryAcquireLease`), used
 * as a sliding log: each action is a lease that lapses `windowMs` after it was taken, and a new
 * one is admitted only while fewer than the limit are live. That gives a true rolling window
 * rather than the fixed window of the `rateLimit` middleware, and since the prune, count and
 * append are one atomic update on one document per user, concurrent requests cannot take more
 * than the limit.
 */

export interface PublishActor {
  id: string;
  isAdmin?: boolean;
  /** The account's creation time (`User.createdAt`), which selects the new-account allowance. */
  createdAt?: Date | string | null;
}

/** Cache key for a user's publish allowance; one per user, shared by every route and credential. */
export const publishActionsKey = (userId: string) => `rate-limit:${userId}:publish-actions`;

/**
 * The actor's allowance per window: `Infinity` for admins (exempt, as with the publish quota and
 * the skill-market submit limits), the new-account tier for an account younger than
 * `newAccount.maxAgeMs` or with no readable creation time, else the standard tier.
 */
export function publishActionLimit(actor: PublishActor, now: number = Date.now()): number {
  if (actor.isAdmin) return Infinity;
  const createdMs = actor.createdAt ? new Date(actor.createdAt).getTime() : Number.NaN;
  const isNewAccount = !Number.isFinite(createdMs) || now - createdMs < PUBLISH_RATE_LIMITS.newAccount.maxAgeMs;
  return isNewAccount ? PUBLISH_RATE_LIMITS.newAccount.maxActions : PUBLISH_RATE_LIMITS.maxActions;
}

/** The user-facing refusal, with the wait rounded up to whole minutes. */
export function publishRateLimitMessage(retryAfterSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `You've published a lot today. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
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
 * Count one publish action against the actor's allowance. Resolves when it fits; otherwise throws
 * a 429 TooManyRequestsError, which errorHandler answers with the standard error envelope, a
 * `Retry-After` header and `code: 'publish_rate_limited'`.
 */
export async function consumePublishAction(actor: PublishActor): Promise<void> {
  const now = Date.now();
  const limit = publishActionLimit(actor, now);
  if (!Number.isFinite(limit)) return;

  const key = publishActionsKey(actor.id);
  if (await cacheRepository.tryAcquireLease(key, randomUUID(), limit, PUBLISH_RATE_LIMITS.windowMs)) return;

  const retryAfter = await secondsUntilRoom(key, limit, now);
  throw new TooManyRequestsError(publishRateLimitMessage(retryAfter), {
    code: PUBLISH_RATE_LIMITED,
    retryAfter,
    details: { limit, windowMs: PUBLISH_RATE_LIMITS.windowMs },
  });
}
