import type { ResearchUnlistedSources } from '@bike4mind/common';

/**
 * The source lists, applied to a search hit BEFORE anything is spent on it -
 * before the relevance judgment, before the fetch. Ordering matters for cost, not just for
 * semantics: the source lists are the only lever that can drop a candidate for free.
 */

/** The hostname a rule is matched against, or null when the URL is not usable as a source at all. */
export function sourceHostname(url: string): string | null {
  try {
    const parsed = new URL(url);
    // Only http(s) can be a source: `proposeDataLakeContent` answers `unusable_source` for anything
    // else, so admitting one here would spend a judgment and a fetch to reach a guaranteed refusal.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    // The trailing root dot is stripped to meet `normalizeDomainEntry`, which strips it on the rule
    // side: `https://evil.com./x` has hostname `evil.com.`, and a deny entry of `evil.com` would
    // otherwise sail past it. `URL` has already lowercased and punycoded the host.
    return parsed.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

/**
 * Suffix match on LABEL boundaries, not on raw string suffix. `evil-example.com`.endsWith(
 * 'example.com') is true and must not match: a deny list that a lookalike domain slips past is
 * worse than no deny list, because it is trusted.
 */
export function hostMatchesDomain(hostname: string, domain: string): boolean {
  if (!domain) return false;
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export type SourceVerdict = 'trusted' | 'review' | 'blocked' | 'unlisted_dropped';

/** A verdict that reaches the judge and, if it clears, the proposal queue. */
export const isQueueableVerdict = (verdict: SourceVerdict): verdict is 'trusted' | 'review' =>
  verdict === 'trusted' || verdict === 'review';

/**
 * Which tier a hit's URL falls in. A blocked match always wins, which is what lets a config say
 * "everything under example.com except its blog". Otherwise the longest matching entry across the
 * trusted and review lists wins, and a tie (the same entry in both) goes to review: the stricter tier.
 * A hit matching neither list follows `unlistedSources`. Routes by source only; never by score.
 */
export function classifySource(
  url: string,
  levers: {
    trustedDomains: readonly string[];
    reviewDomains: readonly string[];
    blockedDomains: readonly string[];
    unlistedSources: ResearchUnlistedSources;
  }
): SourceVerdict {
  const hostname = sourceHostname(url);
  // An unparseable or non-http URL is reported as blocked rather than as its own verdict: from the
  // run's point of view the outcome is identical (dropped for free, before any spend), and the
  // queue is the one place that gets to name `unusable_source`.
  if (!hostname) return 'blocked';
  if (levers.blockedDomains.some(domain => hostMatchesDomain(hostname, domain))) return 'blocked';

  const longest = (domains: readonly string[]) =>
    domains.reduce((best, domain) => (hostMatchesDomain(hostname, domain) ? Math.max(best, domain.length) : best), -1);
  const trusted = longest(levers.trustedDomains);
  const review = longest(levers.reviewDomains);
  if (trusted >= 0 || review >= 0) return trusted > review ? 'trusted' : 'review';

  return levers.unlistedSources === 'review' ? 'review' : 'unlisted_dropped';
}
