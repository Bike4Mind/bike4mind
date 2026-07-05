/**
 * Shared localStorage utilities for TTL-based cleanup and QuotaExceeded handling.
 * Pattern follows UserContext.tsx and tagCache.ts
 */

// TTL constants for different storage types
export const TTL = {
  IDEMPOTENCY: 1 * 60 * 60 * 1000, // 1 hour (matches server-side TTL)
  SESSION_ACTIVITY: 7 * 24 * 60 * 60 * 1000, // 7 days
  SESSION_VIEWED: 30 * 24 * 60 * 60 * 1000, // 30 days
  ARTIFACTS: 7 * 24 * 60 * 60 * 1000, // 7 days
} as const;

/**
 * Cross-browser QuotaExceededError detection
 * - Chrome/Safari/Edge: error.code === 22
 * - Firefox: error.code === 1014 && error.name === 'NS_ERROR_DOM_QUOTA_REACHED'
 * - Modern browsers: error.name === 'QuotaExceededError'
 */
export function isQuotaExceededError(error: unknown): boolean {
  if (!(error instanceof DOMException)) return false;
  return (
    error.name === 'QuotaExceededError' ||
    error.code === 22 ||
    (error.code === 1014 && error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
  );
}

/**
 * Safe localStorage setItem with QuotaExceeded handling.
 * Calls cleanup function on quota error and retries once.
 *
 * @param key localStorage key
 * @param value Value to store
 * @param onQuotaExceeded Optional cleanup function to call on quota error
 * @returns true if successful, false otherwise
 */
export function safeLocalStorageSet(key: string, value: string, onQuotaExceeded?: () => void): boolean {
  if (typeof window === 'undefined') return false;

  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    if (isQuotaExceededError(error)) {
      if (onQuotaExceeded) {
        try {
          onQuotaExceeded();
        } catch (cleanupError) {
          console.warn('[localStorage] Cleanup failed:', cleanupError);
        }
      }

      // Retry once after cleanup
      try {
        localStorage.setItem(key, value);
        return true;
      } catch {
        console.warn(`[localStorage] Cannot save ${key} even after cleanup`);
        return false;
      }
    }

    console.warn(`[localStorage] Failed to save ${key}:`, error);
    return false;
  }
}

/**
 * Get all localStorage keys matching a prefix
 */
export function getLocalStorageKeysByPrefix(prefix: string): string[] {
  if (typeof window === 'undefined') return [];

  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(prefix)) {
      keys.push(key);
    }
  }
  return keys;
}
