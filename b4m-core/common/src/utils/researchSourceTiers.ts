import type {
  LegacyResearchRunLevers,
  ResearchRunLevers,
  ResearchSource,
  ResearchUnlistedSources,
} from '../types/entities/DataLakeResearchTypes';
import {
  RESEARCH_DOMAIN_LIST_MAX,
  RESEARCH_MAX_AUTO_ADMITS_DEFAULT,
  RESEARCH_UNLISTED_SOURCES,
} from '../types/entities/DataLakeResearchTypes';

/**
 * Shared by the research-config repository (read path), the service normalizer and the run
 * executor. Pure functions only: this package is the one both the repository and the service can import.
 */

/** Trim, dedupe, drop empties and cap the length of a user-supplied string list. */
export const boundedStringList = (values: readonly unknown[] | undefined, max: number): string[] =>
  Array.from(
    new Set(
      (values ?? [])
        .filter((value): value is string => typeof value === 'string')
        .map(value => value.trim())
        .filter(value => value.length > 0)
    )
  ).slice(0, max);

/**
 * Drop a leading `www.`, but only when a registrable name remains, so `www.com` never widens to all
 * of `com`. `hostMatchesDomain` already covers subdomains, so the bare domain is what a manager
 * means by `www.example.com`.
 */
export const stripWww = (hostname: string): string => {
  const rest = hostname.replace(/^www\./, '');
  return rest.includes('.') ? rest : hostname;
};

/**
 * Reduce one free-text list entry to the hostname the source filter compares against, or '' when it
 * cannot be one. The field arrives as a mix of `example.net`, `*.example.net`, `https://example.net/blog`
 * and pasted URLs with a port or trailing dot. One `new URL` drops scheme, credentials, port, path and
 * query, lowercases the host and punycodes an IDN; the trailing root dot is stripped to meet
 * `sourceHostname` on the other side.
 */
export const normalizeDomainEntry = (value: string): string => {
  const bare = value
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^[*.]+/, '');
  if (!bare) return '';
  try {
    return stripWww(new URL(`https://${bare}`).hostname.replace(/\.$/, ''));
  } catch {
    return '';
  }
};

export const normalizeDomainList = (values: readonly unknown[] | undefined): string[] =>
  boundedStringList(
    boundedStringList(values, RESEARCH_DOMAIN_LIST_MAX).map(normalizeDomainEntry),
    RESEARCH_DOMAIN_LIST_MAX
  );

export const isResearchUnlistedSources = (value: unknown): value is ResearchUnlistedSources =>
  typeof value === 'string' && (RESEARCH_UNLISTED_SOURCES as readonly string[]).includes(value);

/** Set equality: a reordered or duplicated list is the same list. */
export const isSameDomainSet = (a: readonly string[], b: readonly string[]): boolean => {
  const setA = new Set(a);
  const setB = new Set(b);
  return setA.size === setB.size && [...setA].every(value => setB.has(value));
};

type TierFields = Pick<ResearchRunLevers, 'trustedDomains' | 'reviewDomains' | 'unlistedSources'>;

/**
 * The `allowedDomains` an old reader needs to keep today's behavior: the listed sites when other
 * sites are ignored, nothing (unrestricted) when they go to review.
 */
export const deriveLegacyAllowedDomains = (levers: TierFields): string[] =>
  levers.unlistedSources === 'drop' ? Array.from(new Set([...levers.trustedDomains, ...levers.reviewDomains])) : [];

type Upgraded<T extends LegacyResearchRunLevers> = Omit<
  T,
  keyof TierFields | 'allowedDomains' | 'autoAdmitTrusted' | 'maxAutoAdmits' | 'source' | 'feedUrl'
> &
  TierFields & {
    allowedDomains: string[];
    autoAdmitTrusted: boolean;
    maxAutoAdmits: number;
    source: ResearchSource;
    feedUrl: string | null;
  };

/**
 * Brings any stored lever shape to the tiered one. A pure field remap: it never normalizes, and it
 * judges emptiness on the raw list (every stored list has already been through the normalizer).
 *
 * - Legacy (no valid `unlistedSources`): a non-empty `allowedDomains` becomes the review list with
 *   other sites dropped; an empty one means other sites go to review.
 * - Auto-admit levers absent (a config or run snapshot saved before they existed) read as off, with
 *   the default cap.
 * - Mismatch (valid `unlistedSources`, but `allowedDomains` differs from what the tiers derive): code
 *   that predates the tiers wrote it, so its value wins.
 */
export function upgradeLegacyResearchLevers<T extends LegacyResearchRunLevers>(levers: T): Upgraded<T> {
  const autoAdmit = {
    autoAdmitTrusted: levers.autoAdmitTrusted ?? false,
    maxAutoAdmits: levers.maxAutoAdmits ?? RESEARCH_MAX_AUTO_ADMITS_DEFAULT,
    source: levers.source === 'feed' ? ('feed' as const) : ('search' as const),
    feedUrl: levers.feedUrl ?? null,
  };
  const trusted = levers.trustedDomains ?? [];
  const allowed = levers.allowedDomains ?? [];

  if (!isResearchUnlistedSources(levers.unlistedSources)) {
    const drop = allowed.length > 0;
    return {
      ...levers,
      ...autoAdmit,
      trustedDomains: trusted,
      reviewDomains: drop ? allowed : [],
      unlistedSources: drop ? 'drop' : 'review',
      allowedDomains: drop ? Array.from(new Set([...trusted, ...allowed])) : [],
    };
  }

  const tiers: TierFields = {
    trustedDomains: trusted,
    reviewDomains: levers.reviewDomains ?? [],
    unlistedSources: levers.unlistedSources,
  };
  const derived = deriveLegacyAllowedDomains(tiers);
  if (levers.allowedDomains === undefined || isSameDomainSet(allowed, derived)) {
    return { ...levers, ...autoAdmit, ...tiers, allowedDomains: derived };
  }

  const next: TierFields =
    allowed.length > 0
      ? { ...tiers, reviewDomains: allowed, unlistedSources: 'drop' }
      : { ...tiers, unlistedSources: 'review' };
  return { ...levers, ...autoAdmit, ...next, allowedDomains: deriveLegacyAllowedDomains(next) };
}
