import type { Page } from '@playwright/test';
import { Resource } from 'sst';

// Stands in for Cloudflare's api.js (loaded by app/utils/turnstile.ts) and resolves the widget at
// once with a placeholder token. The server never verifies it: requireTurnstile skips the challenge
// for a -e2e@test.com send carrying the E2E secret header, which the /api/otc/send route below adds.
const TURNSTILE_STUB = `window.turnstile = {
  render: function (_container, options) {
    setTimeout(function () { options.callback('e2e-turnstile-placeholder'); }, 0);
    return 'e2e-turnstile';
  },
  remove: function () {},
};`;

/** Lets the login and register forms request a code on a stage that enforces Turnstile. */
export async function bypassTurnstile(page: Page): Promise<void> {
  await page.route(/^https:\/\/challenges\.cloudflare\.com\/turnstile\//, route =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: TURNSTILE_STUB })
  );
  const apiOrigin = new URL(process.env.API_URL || 'http://localhost:3000').origin;
  await page.route(
    url => url.origin === apiOrigin && url.pathname === '/api/otc/send',
    route => {
      const secret = process.env.E2E_CLEANUP_SECRET || Resource.E2E_CLEANUP_SECRET?.value;
      // fallback, not continue, so installWafBypass's handler (registered earlier, so it runs after
      // this one) still adds its edge header on top of this one.
      if (!secret) return route.fallback();
      return route.fallback({ headers: { ...route.request().headers(), 'x-e2e-cleanup-secret': secret } });
    }
  );
}
