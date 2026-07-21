import { useQuery } from '@tanstack/react-query';
import type { HelpIndex, HelpIndexEntry, HelpCategory } from '@bike4mind/scripts/help/types';
import { useAccessToken } from './useAccessToken';
import { useLanguage } from '@client/app/contexts/TranslationProvider';

/**
 * Simple non-reversible hash for cache key derivation.
 * Produces a short hash suitable for React Query keys without exposing the raw token.
 *
 * Uses a basic bitwise DJB2-style hash. Collisions are acceptable here - a collision
 * only causes an unnecessary cache miss (re-fetch), never incorrect data, since the
 * server performs its own auth-based filtering regardless of the client cache key.
 */
function hashForCacheKey(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Load help index from API with proper cache handling.
 * Sends auth headers so the server can return admin-only entries for admin users.
 */
const loadHelpIndex = async (accessToken: string | null, locale: string): Promise<HelpIndex> => {
  try {
    const query = locale && locale !== 'en' ? `?locale=${encodeURIComponent(locale)}` : '';
    const response = await fetch(`/api/help${query}`, {
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to load help index: ${response.status}`);
    }

    return response.json();
  } catch (error) {
    console.warn('[HelpIndex] Failed to load help index:', error);
    return {
      entries: [],
      categories: [],
      version: 'not-built',
    };
  }
};

/**
 * Hook to load and access the help documentation index
 *
 * Cache strategy:
 * - staleTime: 5 minutes - matches server Cache-Control max-age
 * - gcTime: 30 minutes - keep in memory for quick access
 * - Server uses ETag for efficient revalidation
 * - Query key includes a token hash so cache busts instantly on login/logout/user switch
 *   (the server does role-based filtering; the client key just needs to be session-unique)
 */
export const useHelpIndex = () => {
  const accessToken = useAccessToken(state => state.accessToken);
  const language = useLanguage(state => state.language);
  // Hash the token for a session-unique cache key that busts immediately on login/logout
  // without exposing the JWT in React Query DevTools or telemetry
  const sessionKey = accessToken ? hashForCacheKey(accessToken) : 'anonymous';

  return useQuery({
    // Language is part of the key so switching UI language refetches the localized index.
    queryKey: ['help-index', sessionKey, language],
    queryFn: () => loadHelpIndex(accessToken, language),
    staleTime: 5 * 60 * 1000, // 5 minutes - matches server cache
    gcTime: 30 * 60 * 1000, // 30 minutes
    refetchOnMount: 'always',
  });
};

/**
 * Get an entry by its slug
 */
export const getEntryBySlug = (entries: HelpIndexEntry[], slug: string): HelpIndexEntry | undefined => {
  return entries.find(entry => entry.slug === slug);
};

/**
 * Get all entries in a category
 */
export const getEntriesByCategory = (entries: HelpIndexEntry[], category: string): HelpIndexEntry[] => {
  return entries.filter(entry => entry.category === category);
};

/**
 * Get the category path for breadcrumbs
 * Returns an array of category names from root to the entry's category
 */
export const getCategoryPath = (category: string): string[] => {
  return category.split('/').filter(Boolean);
};

/**
 * Find a category by name in the category tree
 */
export const findCategory = (categories: HelpCategory[], name: string): HelpCategory | undefined => {
  for (const cat of categories) {
    if (cat.name === name) {
      return cat;
    }
    const found = findCategory(cat.subcategories, name);
    if (found) {
      return found;
    }
  }
  return undefined;
};

/** Strip punctuation and collapse whitespace so "github?" matches "github" */
function sanitizeQuery(raw: string): string {
  return raw
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Get entries matching a search query.
 * Checks the exact (lowercased) query first, then falls back to a
 * punctuation-stripped version so queries like "github?" still match "github".
 */
export const searchEntries = (entries: HelpIndexEntry[], query: string): HelpIndexEntry[] => {
  const normalizedQuery = query.toLowerCase().trim();
  if (!normalizedQuery) {
    return [];
  }

  const cleanedQuery = sanitizeQuery(normalizedQuery);

  const matchesField = (field: string): boolean => {
    const lower = field.toLowerCase();
    return lower.includes(normalizedQuery) || (cleanedQuery !== normalizedQuery && lower.includes(cleanedQuery));
  };

  return entries.filter(entry => {
    if (matchesField(entry.title)) return true;
    if (matchesField(entry.description)) return true;
    if (entry.headings.some(h => matchesField(h.text))) return true;
    if (entry.tags.some(t => matchesField(t))) return true;
    return false;
  });
};

/**
 * Hook to get a specific help entry by slug
 */
export const useHelpEntry = (slug: string) => {
  const { data: index } = useHelpIndex();
  return index ? getEntryBySlug(index.entries, slug) : undefined;
};

export default useHelpIndex;
