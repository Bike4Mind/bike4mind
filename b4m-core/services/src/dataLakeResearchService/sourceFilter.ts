/**
 * The allow/deny source lists (#1682), applied to a search hit BEFORE anything is spent on it -
 * before the relevance judgment, before the fetch. Ordering matters for cost, not just for
 * semantics: these are the only two levers that can drop a candidate for free.
 */

/** The hostname a rule is matched against, or null when the URL is not usable as a source at all. */
export function sourceHostname(url: string): string | null {
  try {
    const parsed = new URL(url);
    // Only http(s) can be a source: `proposeDataLakeContent` answers `unusable_source` for anything
    // else, so admitting one here would spend a judgment and a fetch to reach a guaranteed refusal.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname.toLowerCase();
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

export type SourceVerdict = 'allowed' | 'not_in_allow_list' | 'blocked';

/**
 * Whether a hit's URL may be considered. Deny is applied AFTER allow and wins, which is what lets a
 * config say "everything under example.com except its blog" - the opposite order would make the
 * deny entry unreachable whenever an allow list is set.
 */
export function classifySource(
  url: string,
  levers: { allowedDomains: readonly string[]; blockedDomains: readonly string[] }
): SourceVerdict {
  const hostname = sourceHostname(url);
  // An unparseable or non-http URL is reported as blocked rather than as its own verdict: from the
  // run's point of view the outcome is identical (dropped for free, before any spend), and the
  // queue is the one place that gets to name `unusable_source`.
  if (!hostname) return 'blocked';

  if (levers.allowedDomains.length > 0 && !levers.allowedDomains.some(domain => hostMatchesDomain(hostname, domain))) {
    return 'not_in_allow_list';
  }
  if (levers.blockedDomains.some(domain => hostMatchesDomain(hostname, domain))) return 'blocked';
  return 'allowed';
}
