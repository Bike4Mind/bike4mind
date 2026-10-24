import { cacheRepository } from '@bike4mind/database';

/** Fixed-window failures per artifact and viewer, independent of other viewers. */

/** Wrong attempts against one artifact before its gate locks (inclusive). */
export const PASSPHRASE_LOCKOUT_MAX_ATTEMPTS = 5;
/** Fixed window the lock and the failure count live in. */
export const PASSPHRASE_LOCKOUT_WINDOW_MS = 15 * 60_000;

const keyFor = (publicId: string, viewerId: string) => `publish-gate-pp-lock:${publicId}:${viewerId}`;

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
export async function checkLock(publicId: string, viewerId: string): Promise<LockState> {
  const doc = await cacheRepository.findByKey(keyFor(publicId, viewerId));
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
export async function recordFailure(publicId: string, viewerId: string): Promise<LockState> {
  const { success, count, expiresAt } = await cacheRepository.tryIncrementWithinLimitFixedWindow(
    keyFor(publicId, viewerId),
    PASSPHRASE_LOCKOUT_MAX_ATTEMPTS,
    PASSPHRASE_LOCKOUT_WINDOW_MS
  );
  // !success == already at the cap (a prior request tipped it over); count>=cap
  // == this failure was the one that reached it.
  const locked = !success || count >= PASSPHRASE_LOCKOUT_MAX_ATTEMPTS;
  return { locked, retryAfterMs: locked ? remainingMs(expiresAt) : 0 };
}

/** Clear the counter after a correct passphrase so a returning viewer starts fresh. */
export async function clear(publicId: string, viewerId: string): Promise<void> {
  await cacheRepository.deleteByKey(keyFor(publicId, viewerId));
}
