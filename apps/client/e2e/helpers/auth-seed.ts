import { type Page, type APIRequestContext } from '@playwright/test';
import { apiLoginViaOtc } from './api';

/**
 * Cookie-seed auth helpers.
 *
 * This is the machine auth path now that login is passwordless (email OTC).
 * `apiCreateTestUser` returns a real opaque `<sid>.<secret>` refresh token, so we can plant it
 * as the app's HttpOnly refresh cookie and let the app's own cold-load silent refresh
 * (app/utils/sessionBootstrap.ts) exchange it for an access token - no UI round-trip and no OTC
 * email to read. An agent (e.g. Claude Code + Playwright MCP) authenticates the same way.
 *
 * This deliberately seeds NOTHING in localStorage. The access token is memory-only and the
 * refresh token is HttpOnly, so a cookie is the only thing there is to seed - and driving the
 * real bootstrap path means the suite exercises the same cold-load sequence a user gets.
 * Because the router guard awaits that bootstrap before evaluating `currentUser`, seeding the
 * `user-context` store to get past it (which the old localStorage seed had to do) is no longer
 * necessary.
 */

/** Mirrors REFRESH_COOKIE_NAME / COOKIE_PATH in apps/client/server/auth/refreshCookie.ts.
 *  Hardcoded so the e2e suite doesn't import from the app - keep in sync. */
const REFRESH_COOKIE_NAME = 'b4m_rt';
const REFRESH_COOKIE_PATH = '/api';

interface SeedTokens {
  accessToken: string;
  refreshToken: string;
}

/** Plant the refresh cookie on the browser context so the next navigation boots authenticated. */
async function injectRefreshCookie(page: Page, tokens: SeedTokens): Promise<void> {
  const baseURL = process.env.API_URL || 'http://localhost:3000';
  const { hostname } = new URL(baseURL);
  await page.context().addCookies([
    {
      name: REFRESH_COOKIE_NAME,
      value: tokens.refreshToken,
      domain: hostname,
      path: REFRESH_COOKIE_PATH,
      httpOnly: true,
      // Secure is omitted: e2e runs against plain http, and a Secure cookie would be dropped.
      sameSite: 'Strict',
    },
  ]);
}

/**
 * Seed auth (refresh cookie) and write a Playwright storageState file.
 * Boots to `/` (never /login) so the seeded session isn't torn down by the login route's
 * on-mount clearClientCaches().
 */
export async function seedAuthStorageState(page: Page, tokens: SeedTokens, path: string): Promise<void> {
  await injectRefreshCookie(page, tokens);
  await page.goto('/');
  await page.context().storageState({ path });
}

/**
 * Mint a FRESH single-use refresh cookie for `email` and plant it, WITHOUT navigating.
 *
 * The opaque refresh token is single-use: rotateSession's reuse-detection revokes the whole
 * session the moment an already-rotated token is replayed (b4m-core/services/src/authSessionService/
 * rotateSession.ts, 60s grace). A token baked once into a shared Playwright storageState is
 * replayed by every test AND every retry that cold-loads from it; past the grace window the
 * replay is treated as theft, the session is revoked, and every later cold load 401s -> /login.
 * That is exactly the projects/agents/profile/tavern/search failure. Handing each test its OWN
 * freshly-minted token means the app's bootstrap exchange (sessionBootstrap.ts) spends it exactly
 * once, so reuse-detection never fires - which is what keeps the cookie-seed model compatible with
 * single-use rotation.
 *
 * The caller must NOT have navigated yet: the test's own first `page.goto` performs the single
 * cold-load exchange that consumes this token.
 */
export async function seedFreshRefreshCookie(page: Page, request: APIRequestContext, email: string): Promise<void> {
  const tokens = await apiLoginViaOtc(request, email);
  // Drop any stale cookie the per-project storageState planted, so only the fresh token is present.
  await page.context().clearCookies({ name: REFRESH_COOKIE_NAME });
  await injectRefreshCookie(page, tokens);
}

/**
 * Seed auth directly onto a page (mid-test user switching), then bootstrap the authenticated
 * app by navigating to `/`.
 */
export async function seedAuthOnPage(page: Page, tokens: SeedTokens): Promise<void> {
  // Clear the previous identity's refresh cookie first: the app boots from whichever cookie is
  // present, so a leftover one would silently win the mid-test user switch. The persisted
  // user-context store still holds the old identity at this point, but the router guard awaits
  // the bootstrap refresh (which rewrites currentUser) before reading it, so nothing renders
  // under the stale identity.
  await page.context().clearCookies({ name: REFRESH_COOKIE_NAME });
  await injectRefreshCookie(page, tokens);
  await page.goto('/');
}
