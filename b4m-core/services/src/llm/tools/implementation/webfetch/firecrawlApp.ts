import FirecrawlDefault from '@mendable/firecrawl-js';
import { UnsafeScrapeTargetError } from './errors';
import { resolveAndVetUrl } from './ssrfGuard';

type FirecrawlAppCtor = new (config: FirecrawlAppConfig) => FirecrawlClient;

/**
 * Resolves the FirecrawlApp constructor regardless of module-interop regime.
 *
 * firecrawl-js ships an `__esModule` CJS build that exports the class via
 * `exports.default`. Rolldown's CJS output (the built @bike4mind/services dist)
 * uses node-mode interop (`__toESM(mod, 1)`), which binds a default import to the
 * package's entire module.exports instead of `exports.default` - so `new` on the
 * raw binding throws "is not a constructor" (as hit by the QuestProcessor service,
 * which loads the .cjs dist via tsx). Bundlers that honor `__esModule` (vitest,
 * webpack) and the real ESM build bind the class directly. This picks the class
 * in both regimes.
 */
export function resolveFirecrawlApp(moduleBinding: unknown): FirecrawlAppCtor {
  const namespace = moduleBinding as { default?: FirecrawlAppCtor };
  return namespace.default ?? (moduleBinding as FirecrawlAppCtor);
}

// satisfies: fails the build if a firecrawl-js upgrade stops fitting FirecrawlClient.
export const FirecrawlApp = resolveFirecrawlApp(FirecrawlDefault satisfies FirecrawlAppCtor);

export interface FirecrawlAppConfig {
  apiKey?: string;
  apiUrl?: string;
}

export interface FirecrawlScrapeParams {
  formats?: ('markdown' | 'html')[];
  timeout?: number;
  onlyMainContent?: boolean;
  maxAge?: number;
  storeInCache?: boolean;
  actions?: ({ type: 'wait'; milliseconds: number } | { type: 'scroll'; direction: 'up' | 'down'; pixels: number })[];
}

export interface FirecrawlScrapeResult {
  error?: string;
  markdown?: string;
  html?: string;
  metadata?: { title?: string; [key: string]: unknown };
}

// The slice of the firecrawl-js client services calls, declared locally so the published .d.ts
// never imports @mendable/firecrawl-js (its types drag in DOM-only event listener types).
export interface FirecrawlClient {
  scrapeUrl: (url: string, params?: FirecrawlScrapeParams) => Promise<FirecrawlScrapeResult>;
  search: (query: string) => Promise<{ data: { url?: string; title?: string; description?: string }[] }>;
}

/**
 * Build a Firecrawl client from resolved config, or null when neither an API key nor a custom API
 * URL is set - the caller then falls back to plain fetch (self-host without Firecrawl). firecrawl-js
 * allows a keyless client when apiUrl targets a self-hosted instance (not api.firecrawl.dev).
 *
 * Returns a guarded wrapper, not the raw client: `scrapeUrl` pre-flights the target through the SSRF
 * guard so every caller inherits it, and only `scrapeUrl`/`search` are exposed (the FirecrawlClient
 * slice services use).
 */
export function createFirecrawlApp(config: FirecrawlAppConfig): FirecrawlClient | null {
  if (!config.apiKey && !config.apiUrl) return null;
  const app = new FirecrawlApp({ apiKey: config.apiKey, apiUrl: config.apiUrl });
  return {
    // Guarded here so every Firecrawl caller (web_fetch, deep research, the research engine)
    // inherits it: a self-hosted instance fetches from inside our network, so a private target is
    // an SSRF. Pre-flight only - Firecrawl re-resolves DNS itself, which we cannot pin.
    scrapeUrl: async (url, params) => {
      const vetted = await resolveAndVetUrl(new URL(url));
      if (!vetted.safe) {
        // A private or protocol-refused target is permanent (no retry); a DNS hiccup is not, so it
        // keeps the caller's normal retry path by staying a plain Error.
        const message = `Refusing to fetch ${url}: ${vetted.reason}`;
        if (vetted.retryable) throw new Error(message);
        throw new UnsafeScrapeTargetError(message);
      }
      return app.scrapeUrl(url, params);
    },
    search: query => app.search(query),
  };
}
