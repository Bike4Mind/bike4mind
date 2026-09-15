import { cacheRepository } from '@bike4mind/database';

/**
 * Per-artifact passphrase lockout for the public gate (issue #383 Tier 2).
 *
 * Sits alongside the coarse per-IP rate limit on POST /api/publish/gate/passphrase:
 * the IP limit throttles a single client across ALL gated artifacts, while this
 * counts WRONG passphrases against ONE artifact and locks that artifact's gate for
 * the rest of a fixed window once the count reaches MAX_ATTEMPTS. Together they are
 * the acceptance's "rate-limit per token + IP; temporary lockout after N wrong attempts".
 *
 * The cache key is namespaced with `pp` so a future Tier 3 (domain) gate throttle
 * gets its own bucket and passphrase failures can never cross-lock a different mode.
 */

/** Wrong attempts against one artifact before its gate locks (inclusive). */
export const PASSPHRASE_LOCKOUT_MAX_ATTEMPTS = 5;
/** Fixed window the lock and the failure count live in. */
export const PASSPHRASE_LOCKOUT_WINDOW_MS = 15 * 60_000;

const keyFor = (publicId: string) => `publish-gate-pp-lock:${publicId}`;

export interface LockState {
  locked: boolean;
  /** ms until the window closes; 0 when not locked. */
  retryAfterMs: number;
}

const remainingMs = (expiresAt?: Date | null): number =>
  expiresAt ? Math.max(0, expiresAt.getTime() - Date.now()) : 0;

/**
 * Read-only check run BEFORE bcrypt so a locked gate rejects even a correct
 * passphrase for the remainder of the window. Never mutates the counter, so
 * hammering a locked gate cannot extend the lock.
 */
export async function checkLock(publicId: string): Promise<LockState> {
  const doc = await cacheRepository.findByKey(keyFor(publicId));
  if (!doc) return { locked: false, retryAfterMs: 0 };
  const count = (doc.result as { count?: number })?.count ?? 0;
  const expired = doc.expiresAt.getTime() <= Date.now();
  if (expired || count < PASSPHRASE_LOCKOUT_MAX_ATTEMPTS) return { locked: false, retryAfterMs: 0 };
  return { locked: true, retryAfterMs: remainingMs(doc.expiresAt) };
}

/**
 * Record one wrong attempt and report whether the gate is now locked. Uses the
 * fixed-window primitive so the window opens on the first failure and closes
 * deterministically WINDOW_MS later (a stream of failures cannot slide it forward).
 */
export async function recordFailure(publicId: string): Promise<LockState> {
  const { success, count, expiresAt } = await cacheRepository.tryIncrementWithinLimitFixedWindow(
    keyFor(publicId),
    PASSPHRASE_LOCKOUT_MAX_ATTEMPTS,
    PASSPHRASE_LOCKOUT_WINDOW_MS
  );
  // !success == already at the cap (a prior request tipped it over); count>=cap
  // == this failure was the one that reached it.
  const locked = !success || count >= PASSPHRASE_LOCKOUT_MAX_ATTEMPTS;
  return { locked, retryAfterMs: locked ? remainingMs(expiresAt) : 0 };
}

/** Clear the counter after a correct passphrase so a returning viewer starts fresh. */
export async function clear(publicId: string): Promise<void> {
  await cacheRepository.deleteByKey(keyFor(publicId));
}
