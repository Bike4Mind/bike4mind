import type { BrowserContext, Page } from '@playwright/test';

const WAF_BYPASS_HEADER = 'x-e2e-waf-bypass';

/** Header the edge allows past the hosting-network checks. Empty when unset. */
export function wafBypassHeaders(): Record<string, string> {
  const token = process.env.E2E_WAF_BYPASS_TOKEN;
  return token ? { [WAF_BYPASS_HEADER]: token } : {};
}

/**
 * Adds the header to every browser request on the API origin (pages, static assets, API calls)
 * and nowhere else. A context-wide extraHTTPHeaders would also reach third-party origins and
 * break their CORS preflights. Traces record it, so e2e-run.yml scrubs the token from test
 * output before upload. Install it before other routes: later handlers run first and must
 * route.fallback() to reach it.
 */
export async function installWafBypass(target: Page | BrowserContext): Promise<void> {
  const headers = wafBypassHeaders();
  if (!headers[WAF_BYPASS_HEADER]) return;
  const apiOrigin = new URL(process.env.API_URL || 'http://localhost:3000').origin;
  await target.route(
    url => url.origin === apiOrigin,
    route => route.continue({ headers: { ...route.request().headers(), ...headers } })
  );
}
