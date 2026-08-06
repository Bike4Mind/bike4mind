import { type Page } from '@playwright/test';

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

export interface SpecAuth {
  accessToken: string;
  userId: string;
}

/**
 * Build an `/auth/success` URL that re-establishes the in-memory access token and then client-side
 * redirects to `target`.
 *
 * The access token is memory-only (app/hooks/useAccessToken.ts) and does NOT survive a full page
 * load, so a raw `page.goto('/projects')` cold-loads with no credential and the router guard bounces
 * to /login. `/auth/success` is the app's own SSO landing route: it calls setVerifiedSession(token)
 * and redirects THROUGH the client router (not a reload), so the token survives. Routing every
 * authenticated navigation through it re-seeds the token on each full load - with no single-use
 * refresh replay (a shared refresh cookie replayed across contexts gets the session revoked by
 * rotateSession's reuse-detection) and no OTC (rate limited). An access token is not single-use, so
 * one value works across every parallel context.
 *
 * Caveat: the access token has a 30m TTL (server/auth/tokenGenerator.ts) and is minted at spec
 * setup, so a tail/retry test on a ~30-minute run can outlive it and bounce to /login. A purely
 * test-side seed cannot mint a fresh token for the seeded user without OTC or a dedicated endpoint.
 */
export function buildAuthSuccessUrl(target: string, auth: SpecAuth): string {
  const params = new URLSearchParams({ token: auth.accessToken, userId: auth.userId });
  // sanitizeRedirectTo (app/utils/authRedirect.ts) requires a leading '/' and rejects bare '/', so
  // omit redirectTo for '/' - /auth/success then falls back to the dashboard, which is '/' anyway.
  if (target !== '/') params.set('redirectTo', target);
  return `/auth/success?${params.toString()}`;
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
