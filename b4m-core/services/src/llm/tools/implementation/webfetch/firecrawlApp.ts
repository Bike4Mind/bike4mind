import FirecrawlDefault from '@mendable/firecrawl-js';

type FirecrawlAppCtor = typeof FirecrawlDefault;

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

export const FirecrawlApp = resolveFirecrawlApp(FirecrawlDefault);

export interface FirecrawlAppConfig {
  apiKey?: string;
  apiUrl?: string;
}

/**
 * Build a FirecrawlApp from resolved config, or null when neither an API key nor a custom API URL
 * is set - the caller then falls back to plain fetch (self-host without Firecrawl). firecrawl-js
 * allows a keyless client when apiUrl targets a self-hosted instance (not api.firecrawl.dev).
 */
export function createFirecrawlApp(config: FirecrawlAppConfig): InstanceType<FirecrawlAppCtor> | null {
  if (!config.apiKey && !config.apiUrl) return null;
  return new FirecrawlApp({ apiKey: config.apiKey, apiUrl: config.apiUrl });
}
