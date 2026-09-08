import { useQuery } from '@tanstack/react-query';
import type { HelpAccessLevel } from '@bike4mind/scripts/help/types';
import { isPublicAccessLevel } from '@bike4mind/scripts/help/utils';
import { useHelpIndex } from './useHelpIndex';
import { useAccessToken } from './useAccessToken';

/**
 * Strips frontmatter from markdown content
 */
const stripFrontmatter = (content: string): string => {
  // Match frontmatter block at the start of the file
  const frontmatterRegex = /^---[\s\S]*?---\n*/;
  return content.replace(frontmatterRegex, '');
};

/**
 * Simple non-reversible hash for cache key derivation. This is a local copy of
 * useHelpIndex's identical helper (that hook does not export it) - see its doc
 * comment for why a basic DJB2-style hash is sufficient here too.
 */
function hashForCacheKey(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Fetch markdown content for a public help article from the bundled static
 * assets (same in dev and prod, no auth needed).
 */
const fetchPublicHelpContent = async (filePath: string): Promise<string> => {
  const response = await fetch(`/help-content/${filePath}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch help content: ${response.statusText}`);
  }
  return response.text();
};

/**
 * Fetch markdown content for an admin-only help article via the authenticated
 * route, mirroring useHelpIndex's auth pattern (credentials + Bearer header).
 */
const fetchAdminHelpContent = async (filePath: string, accessToken: string | null): Promise<string> => {
  const response = await fetch(`/api/help/content?path=${encodeURIComponent(filePath)}`, {
    credentials: 'include',
    headers: {
      ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch help content: ${response.statusText}`);
  }
  return response.text();
};

/**
 * Fetch markdown content for a help article, routing to the public static
 * asset or the authenticated admin API based on the entry's access level.
 */
const fetchHelpContent = async (
  filePath: string,
  accessLevel: HelpAccessLevel | undefined,
  accessToken: string | null
): Promise<string> => {
  const content = isPublicAccessLevel(accessLevel)
    ? await fetchPublicHelpContent(filePath)
    : await fetchAdminHelpContent(filePath, accessToken);
  return stripFrontmatter(content);
};

/**
 * Hook to fetch help content for a given slug
 */
export const useHelpContent = (slug: string) => {
  const { data: index } = useHelpIndex();
  const accessToken = useAccessToken(state => state.accessToken);

  // Find the entry to get the file path and access level
  const entry = index?.entries.find(e => e.slug === slug);
  const filePath = entry?.filePath;
  const accessLevel = entry?.accessLevel;

  // Hash the token into the cache key so a fetched admin article can never be
  // served from cache to a different identity on login/logout/user switch
  // (mirrors useHelpIndex's sessionKey - the server does its own auth-based
  // filtering regardless, this just keeps the client cache from being stale-wrong).
  const sessionKey = accessToken ? hashForCacheKey(accessToken) : 'anonymous';

  const query = useQuery({
    queryKey: ['help-content', slug, sessionKey],
    queryFn: () => {
      if (!filePath) {
        throw new Error(`No help entry found for slug: ${slug}`);
      }
      return fetchHelpContent(filePath, accessLevel, accessToken);
    },
    enabled: !!filePath,
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 30 * 60 * 1000, // 30 minutes
  });

  // Expose the resolved file path and access level so callers can resolve relative
  // links/media against the article's file path (index pages drop "/index") and
  // pick the right media URL scheme.
  return { ...query, filePath, accessLevel };
};

export default useHelpContent;
