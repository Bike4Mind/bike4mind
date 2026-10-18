/**
 * A scrape refused by the SSRF pre-flight; never worth retrying.
 *
 * Lives on its own (no imports) so `scrapeWithRetry`, a published subpath, can test for it without
 * pulling firecrawl-js or the SSRF guard into its module graph.
 */
export class UnsafeScrapeTargetError extends Error {
  name = 'UnsafeScrapeTargetError';
}
