/**
 * Centralized localStorage cleanup utilities.
 * Runs TTL-based cleanup for all localStorage caches on app mount.
 *
 * Prevents localStorage quota-exceeded errors caused by unbounded accumulation
 * of idempotency keys, session activity, viewed timestamps, and artifact caches.
 */

import { cleanupOldIdempotencyKeys } from '@client/lib/utils/idempotency';
import { cleanupOldSessionActivityKeys } from './sessionActivityCleanup';
import { cleanupOldViewedTimestamps } from '@client/app/hooks/useUnreadProactiveMessages';
import { clearOldCachedArtifacts } from './artifactPersistence';

/**
 * Master cleanup function called on app mount.
 * Cleans up all localStorage caches with TTL-based expiration.
 */
export function runLocalStorageCleanup(): void {
  if (typeof window === 'undefined') return;

  try {
    const results = {
      idempotency: cleanupOldIdempotencyKeys(),
      sessionActivity: cleanupOldSessionActivityKeys(),
      viewedTimestamps: cleanupOldViewedTimestamps(),
    };

    // clearOldCachedArtifacts doesn't return count
    clearOldCachedArtifacts();

    const total = Object.values(results).reduce((a, b) => a + b, 0);
    if (total > 0) {
      console.log('[LocalStorage Cleanup] Removed entries:', results);
    }
  } catch (error) {
    // Fail silently - don't block app initialization if cleanup fails
    console.warn('[LocalStorage Cleanup] Error during cleanup:', error);
  }
}
