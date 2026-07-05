/**
 * Session activity localStorage utilities with TTL-based cleanup.
 * Manages `session_activity_*` keys for session resumption feature.
 */

import { isQuotaExceededError, TTL } from './localStorageUtils';

const SESSION_ACTIVITY_PREFIX = 'session_activity_';

/**
 * Clean up session activity keys older than 7 days
 *
 * @returns Number of keys removed
 */
export function cleanupOldSessionActivityKeys(): number {
  if (typeof window === 'undefined') return 0;

  const keysToRemove: string[] = [];
  const now = Date.now();

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(SESSION_ACTIVITY_PREFIX)) {
      try {
        const timestamp = localStorage.getItem(key);
        if (timestamp) {
          const activityTime = new Date(timestamp).getTime();
          if (isNaN(activityTime) || now - activityTime > TTL.SESSION_ACTIVITY) {
            keysToRemove.push(key);
          }
        } else {
          // Empty value - remove
          keysToRemove.push(key);
        }
      } catch {
        // Invalid - remove
        keysToRemove.push(key);
      }
    }
  }

  keysToRemove.forEach(key => localStorage.removeItem(key));

  if (keysToRemove.length > 0) {
    console.log(`[SessionActivity] Cleaned up ${keysToRemove.length} expired keys`);
  }

  return keysToRemove.length;
}

/**
 * Record session activity with QuotaExceeded handling
 *
 * @param sessionId The session ID to record activity for
 */
export function recordSessionActivity(sessionId: string): void {
  if (typeof window === 'undefined') return;

  const key = `${SESSION_ACTIVITY_PREFIX}${sessionId}`;
  const value = new Date().toISOString();

  try {
    localStorage.setItem(key, value);
  } catch (error) {
    if (isQuotaExceededError(error)) {
      cleanupOldSessionActivityKeys();
      try {
        localStorage.setItem(key, value);
      } catch {
        console.warn('[SessionActivity] Cannot record activity even after cleanup');
      }
    }
  }
}

/**
 * Get last activity timestamp for a session
 *
 * @param sessionId The session ID to check
 * @returns The activity timestamp as ISO string, or null if not found
 */
export function getSessionActivity(sessionId: string): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(`${SESSION_ACTIVITY_PREFIX}${sessionId}`);
}
