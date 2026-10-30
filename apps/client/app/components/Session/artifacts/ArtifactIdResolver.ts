import { useCallback } from 'react';
import { findExistingArtifactId } from '@client/app/utils/artifactPersistence';
import { generateCompleteArtifactId, getArtifactTimestamp } from '@client/app/utils/artifactParser';

// Module-level caches shared across all instances (client-side only). Persist
// across mount/unmount and avoid the infinite loop from state values in
// useCallback deps changing the callback reference.

const MAX_CACHE_SIZE = 500;

interface WindowWithCaches extends Window {
  /** Ids of rows the database returned. Authoritative for the rest of the page's life. */
  __artifactIdCache?: Map<string, string>;
  /** In-flight database lookups, so concurrent cards for one identifier share a request. */
  __artifactIdLookups?: Map<string, Promise<string | null>>;
  /** Ids minted while no row existed, per message and index. Never authoritative. */
  __provisionalArtifactIds?: Map<string, string>;
}

const getArtifactIdCache = (): Map<string, string> => {
  if (typeof window === 'undefined') return new Map();
  const win = window as WindowWithCaches;
  if (!win.__artifactIdCache) {
    win.__artifactIdCache = new Map<string, string>();
  }
  return win.__artifactIdCache;
};

const getPendingLookups = (): Map<string, Promise<string | null>> => {
  if (typeof window === 'undefined') return new Map();
  const win = window as WindowWithCaches;
  if (!win.__artifactIdLookups) {
    win.__artifactIdLookups = new Map<string, Promise<string | null>>();
  }
  return win.__artifactIdLookups;
};

const getProvisionalIds = (): Map<string, string> => {
  if (typeof window === 'undefined') return new Map();
  const win = window as WindowWithCaches;
  if (!win.__provisionalArtifactIds) {
    win.__provisionalArtifactIds = new Map<string, string>();
  }
  return win.__provisionalArtifactIds;
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

/** Cache key for a resolved artifact id. Session-scoped, so one session's ids never
 *  answer for another's. */
const artifactCacheKey = (type: string, identifier: string, sessionId?: string) =>
  `${sessionId ?? 'no-session'}_${type}_${identifier}`;

const provisionalKey = (
  type: string,
  identifier: string,
  sessionId: string | undefined,
  messageId: string,
  index: number
) => `${artifactCacheKey(type, identifier, sessionId)}_${messageId}_${index}`;

/**
 * Synchronous read of the module cache, for the first render rather than an effect.
 *
 * Resolution is async, so a component that always starts at `null` renders a placeholder
 * for one frame on EVERY mount - including the remounts a virtualized transcript performs
 * constantly as messages scroll in and out. The placeholder is shorter than the card that
 * replaces it, so react-virtuoso measures the short frame and then has to correct the
 * scroll position: the list jumps under the reader. Seeding state from here means an
 * artifact that has been resolved once renders at its real height immediately.
 */
export function getCachedArtifactId(type: string, identifier: string, sessionId?: string): string | null {
  return getArtifactIdCache().get(artifactCacheKey(type, identifier, sessionId)) ?? null;
}

/**
 * The id last minted for this card while its row did not exist yet, for seeding a remount the
 * same way getCachedArtifactId does. Keyed by message and index, never by identifier alone: a
 * streaming reply renumbers its artifacts as later ones arrive (the persisted index counts from
 * the END of the reply), so an id minted mid-stream must not answer for the finished card.
 */
export function getProvisionalArtifactId(
  type: string,
  identifier: string,
  sessionId: string | undefined,
  messageId: string,
  index: number
): string | null {
  return getProvisionalIds().get(provisionalKey(type, identifier, sessionId, messageId, index)) ?? null;
}

/** The session's row for this identifier, or null. Only a found row is cached. */
function lookupArtifactId(type: string, identifier: string, sessionId?: string): Promise<string | null> {
  const cacheKey = artifactCacheKey(type, identifier, sessionId);
  const pendingLookups = getPendingLookups();
  const pending = pendingLookups.get(cacheKey);
  if (pending) return pending;

  // Started from a resolved promise so the cleanup below can never run before the set.
  const lookup = Promise.resolve()
    .then(() => findExistingArtifactId(type, identifier, sessionId))
    .then(existingId => {
      if (existingId) {
        const artifactIdCache = getArtifactIdCache();
        artifactIdCache.set(cacheKey, existingId);
        evictOldestCacheEntries(artifactIdCache, MAX_CACHE_SIZE);
      }
      return existingId;
    })
    .catch(error => {
      console.warn(`[RESOLVE ARTIFACT ID] Error checking database:`, error);
      return null;
    })
    .finally(() => {
      pendingLookups.delete(cacheKey);
    });
  pendingLookups.set(cacheKey, lookup);
  return lookup;
}

/**
 * Resolve artifact IDs with caching and deduplication.
 *
 * Design decisions (fixes React error 185, Maximum update depth exceeded):
 * 1. Module-level cache - shared across components, survives remounts
 * 2. Promise deduplication - concurrent lookups share one API call
 * 3. No useState for maps - avoids infinite loop from state in useCallback deps
 * 4. Empty dependency array - stable callback reference
 * 5. Session-scoped cache keys - prevents cross-session contamination
 * 6. LRU eviction - prevents unbounded memory growth
 * 7. SSR guard - prevents hydration mismatches in Next.js
 * 8. Only database ids are cached by identifier - a minted fallback is provisional (see
 *    getProvisionalArtifactId) and each caller mints its own from its own index
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
      const cachedId = getArtifactIdCache().get(artifactCacheKey(type, identifier, sessionId));
      if (cachedId) {
        return cachedId;
      }

      const existingId = await lookupArtifactId(type, identifier, sessionId);
      if (existingId) {
        return existingId;
      }

      // Same inputs as useStreamingArtifactPersistence, so once the reply is complete this is the
      // id its row is written under.
      const newId = generateCompleteArtifactId(type, identifier, getArtifactTimestamp(messageId), index);
      const provisionalIds = getProvisionalIds();
      provisionalIds.set(provisionalKey(type, identifier, sessionId, messageId, index), newId);
      evictOldestCacheEntries(provisionalIds, MAX_CACHE_SIZE);
      return newId;
    },
    [] // Empty deps = stable callback reference (fixes infinite loop)
  );

  return { resolveArtifactId };
}
