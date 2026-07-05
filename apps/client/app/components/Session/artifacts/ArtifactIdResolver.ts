import { useCallback } from 'react';
import { findExistingArtifactId } from '@client/app/utils/artifactPersistence';
import { generateCompleteArtifactId, getArtifactTimestamp } from '@client/app/utils/artifactParser';

// Module-level cache shared across all instances (client-side only). Persists
// across mount/unmount and avoids the infinite loop from state values in
// useCallback deps changing the callback reference.

const MAX_CACHE_SIZE = 500;

interface WindowWithCaches extends Window {
  __artifactIdCache?: Map<string, string>;
  __pendingResolutions?: Map<string, Promise<string>>;
}

const getArtifactIdCache = (): Map<string, string> => {
  if (typeof window === 'undefined') return new Map();
  const win = window as WindowWithCaches;
  if (!win.__artifactIdCache) {
    win.__artifactIdCache = new Map<string, string>();
  }
  return win.__artifactIdCache;
};

const getPendingResolutions = (): Map<string, Promise<string>> => {
  if (typeof window === 'undefined') return new Map();
  const win = window as WindowWithCaches;
  if (!win.__pendingResolutions) {
    win.__pendingResolutions = new Map<string, Promise<string>>();
  }
  return win.__pendingResolutions;
};

/**
 * Evict oldest entries when cache exceeds max size (simple LRU-like eviction)
 */
function evictOldestCacheEntries(cache: Map<string, string>, maxSize: number): void {
  if (cache.size <= maxSize) return;

  const entriesToRemove = cache.size - maxSize;
  const keys = cache.keys();
  for (let i = 0; i < entriesToRemove; i++) {
    const key = keys.next().value;
    if (key) cache.delete(key);
  }
}

/**
 * Resolve artifact IDs with caching and deduplication.
 *
 * Design decisions (fixes React error 185, Maximum update depth exceeded):
 * 1. Module-level cache - shared across components, survives remounts
 * 2. Promise deduplication - concurrent requests share one API call
 * 3. No useState for maps - avoids infinite loop from state in useCallback deps
 * 4. Empty dependency array - stable callback reference
 * 5. Session-scoped cache keys - prevents cross-session contamination
 * 6. LRU eviction - prevents unbounded memory growth
 * 7. SSR guard - prevents hydration mismatches in Next.js
 */
export function useArtifactIdResolver() {
  const resolveArtifactId = useCallback(
    async (
      type: string,
      identifier: string,
      content: string,
      messageId: string,
      index: number,
      sessionId?: string
    ): Promise<string> => {
      // Include sessionId in cache key to prevent cross-session contamination
      const cacheKey = `${sessionId ?? 'no-session'}_${type}_${identifier}`;

      const artifactIdCache = getArtifactIdCache();
      const pendingResolutions = getPendingResolutions();

      // Step 1: Return cached result immediately
      const cachedId = artifactIdCache.get(cacheKey);
      if (cachedId) {
        return cachedId;
      }

      // Step 2: Join existing pending resolution (Promise deduplication)
      // This replaces the buggy polling loop that used stale closures
      const existingPromise = pendingResolutions.get(cacheKey);
      if (existingPromise) {
        return existingPromise;
      }

      // Step 3: Create resolution promise with proper timing
      // Set pending BEFORE starting async work to close race condition window
      const promiseExecutor = async (): Promise<string> => {
        try {
          try {
            const existingId = await findExistingArtifactId(type, identifier, sessionId);
            if (existingId) {
              artifactIdCache.set(cacheKey, existingId);
              evictOldestCacheEntries(artifactIdCache, MAX_CACHE_SIZE);
              return existingId;
            }
            console.log(`[RESOLVE ARTIFACT ID] No existing artifact found, will generate new ID`);
          } catch (error) {
            console.warn(`[RESOLVE ARTIFACT ID] Error checking database:`, error);
          }

          // Generate new ID as fallback
          const timestamp = getArtifactTimestamp(messageId);
          const newId = generateCompleteArtifactId(type, identifier, timestamp, index);
          artifactIdCache.set(cacheKey, newId);
          evictOldestCacheEntries(artifactIdCache, MAX_CACHE_SIZE);
          return newId;
        } finally {
          // Clean up pending promise after resolution completes
          pendingResolutions.delete(cacheKey);
        }
      };

      // Track pending resolution BEFORE starting async work to prevent race conditions
      const resolutionPromise = promiseExecutor();
      pendingResolutions.set(cacheKey, resolutionPromise);

      return resolutionPromise;
    },
    [] // Empty deps = stable callback reference (fixes infinite loop)
  );

  return { resolveArtifactId };
}
