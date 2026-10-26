import type { Page } from '@playwright/test';

const WAF_BYPASS_HEADER = 'x-e2e-waf-bypass';

/** Header the edge allows past the hosting-network checks on the passwordless sign-in routes. Empty when unset. */
export function wafBypassHeaders(): Record<string, string> {
  const token = process.env.E2E_WAF_BYPASS_TOKEN;
  return token ? { [WAF_BYPASS_HEADER]: token } : {};
}

/**
 * Adds the header to browser requests for the sign-in routes on the API origin only. A
 * context-wide extraHTTPHeaders would also reach third-party origins and break their CORS
 * preflights. Traces record it, so e2e-run.yml scrubs the token from test output before upload.
 */
export async function installWafBypass(page: Page): Promise<void> {
  const headers = wafBypassHeaders();
  if (!headers[WAF_BYPASS_HEADER]) return;
  const apiOrigin = new URL(process.env.API_URL || 'http://localhost:3000').origin;
  await page.route(
    url => url.origin === apiOrigin && url.pathname.startsWith('/api/otc/'),
    route => route.continue({ headers: { ...route.request().headers(), ...headers } })
  );
}
