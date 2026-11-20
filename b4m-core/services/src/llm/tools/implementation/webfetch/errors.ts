/**
 * A fetch refused by the SSRF pre-flight, or one whose host would not resolve. The message is
 * deliberately the same for both (see `refuseFetch` in ssrfGuard.ts): telling them apart to the
 * caller would let anyone probe which internal hostnames exist. A plain instance is a DNS failure,
 * which a retry wrapper may retry; `UnsafeScrapeTargetError` is the permanent block.
 *
 * Lives on its own (no imports) so `scrapeWithRetry`, a published subpath, can test for it without
 * pulling firecrawl-js or the SSRF guard into its module graph.
 */
export class RefusedFetchTargetError extends Error {
  name = 'RefusedFetchTargetError';
}

/** A scrape refused by the SSRF pre-flight; never worth retrying. */
export class UnsafeScrapeTargetError extends RefusedFetchTargetError {
  name = 'UnsafeScrapeTargetError';
}
