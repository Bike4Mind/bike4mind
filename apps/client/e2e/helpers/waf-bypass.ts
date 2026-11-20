import type { Page } from '@playwright/test';

const WAF_BYPASS_HEADER = 'x-e2e-waf-bypass';

/**
 * API paths the edge checks against the hosting-network lists. Must stay in step with the
 * staging edge policy: a path checked there but missing here is blocked for every CI runner,
 * since runners come from cloud address space, while a developer's browser passes.
 */
const WAF_BYPASS_PATHS = [
  '/api/otc/',
  '/api/user-api-keys',
  '/api/organizations/subscriptions/subscribe',
  '/api/subscriptions/subscribe',
  '/api/stripe/start-payment',
  '/api/stripe/payment-intent',
];

/** Header the edge allows past the hosting-network checks on the paths above. Empty when unset. */
export function wafBypassHeaders(): Record<string, string> {
  const token = process.env.E2E_WAF_BYPASS_TOKEN;
  return token ? { [WAF_BYPASS_HEADER]: token } : {};
}

/**
 * Adds the header to browser requests for the checked paths on the API origin only. A
 * context-wide extraHTTPHeaders would also reach third-party origins and break their CORS
 * preflights. Traces record it, so e2e-run.yml scrubs the token from test output before upload.
 */
export async function installWafBypass(page: Page): Promise<void> {
  const headers = wafBypassHeaders();
  if (!headers[WAF_BYPASS_HEADER]) return;
  const apiOrigin = new URL(process.env.API_URL || 'http://localhost:3000').origin;
  await page.route(
    url => url.origin === apiOrigin && WAF_BYPASS_PATHS.some(path => url.pathname.startsWith(path)),
    route => route.continue({ headers: { ...route.request().headers(), ...headers } })
  );
}
