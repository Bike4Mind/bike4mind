import type {
  ResearchFeedCursor,
  ResearchFeedStatus,
  ResearchRunLevers,
} from '../types/entities/DataLakeResearchTypes';

export type ResearchFeedFingerprintLevers = Pick<
  ResearchRunLevers,
  'feedUrl' | 'query' | 'minRelevance' | 'trustedDomains' | 'reviewDomains' | 'unlistedSources' | 'allowedDomains'
> &
  Partial<Pick<ResearchRunLevers, 'model' | 'recencyDays' | 'blockedDomains'>>;

/** Pure-JS 53-bit hash (cyrb53), so the same value comes out of the node and browser builds. */
const cyrb53 = (input: string, seed: number): string => {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
};

const sortedUnique = (values: readonly string[] | undefined): string[] => [...new Set(values ?? [])].sort();

/**
 * A stable hash of the levers that decide which feed items a run judges and how. A cursor written
 * under a different fingerprint is not trusted as-is: if the feed address is unchanged the newest
 * items are re-checked and items still waiting are kept, otherwise the feed starts fresh.
 * Site lists are order-insensitive.
 */
export const researchFeedFingerprint = (levers: ResearchFeedFingerprintLevers): string => {
  const canonical = JSON.stringify([
    levers.feedUrl ?? null,
    levers.query,
    levers.model ?? null,
    levers.minRelevance,
    levers.recencyDays ?? 0,
    sortedUnique(levers.trustedDomains),
    sortedUnique(levers.reviewDomains),
    levers.unlistedSources,
    sortedUnique(levers.allowedDomains),
    sortedUnique(levers.blockedDomains),
  ]);
  return cyrb53(canonical, 0) + cyrb53(canonical, 1);
};

/** Hash of the feed address alone, so a cursor can tell "same feed, other levers changed" from "another feed". */
export const researchFeedUrlKey = (feedUrl: string | null | undefined): string => {
  const canonical = feedUrl ?? '';
  return cyrb53(canonical, 0) + cyrb53(canonical, 1);
};

/**
 * The config response's view of its cursor: when it last advanced and whether it still applies. Null with no cursor.
 * `levers` must be the normalized levers a run would snapshot, not the raw stored fields.
 */
export const researchFeedStatus = (
  config: { feedCursor?: ResearchFeedCursor | null },
  levers: ResearchFeedFingerprintLevers
): ResearchFeedStatus | null => {
  const cursor = config.feedCursor;
  if (!cursor) return null;
  return {
    newestPublishedAt: cursor.newestPublishedAt ?? null,
    current: cursor.fingerprint === researchFeedFingerprint(levers),
  };
};

/** A config as the API returns it: the cursor itself stays on the server, its status goes out in its place. */
export const withResearchFeedStatus = <T extends { feedCursor?: ResearchFeedCursor | null }>(
  config: T,
  levers: ResearchFeedFingerprintLevers
): Omit<T, 'feedCursor'> & { feedStatus: ResearchFeedStatus | null } => {
  const { feedCursor: _cursor, ...rest } = config;
  return { ...rest, feedStatus: researchFeedStatus(config, levers) };
};

/** `origin + path` of a feed address, never its query string or credentials. */
export function feedLabel(feedUrl: string): string {
  try {
    const { origin, pathname } = new URL(feedUrl);
    return `${origin}${pathname}`;
  } catch {
    return '(invalid address)';
  }
}
