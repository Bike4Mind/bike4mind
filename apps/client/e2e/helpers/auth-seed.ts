import { type Page } from '@playwright/test';

/**
 * Token-seed auth helpers.
 *
 * This is the machine auth path now that login is passwordless (email OTC).
 * `apiCreateTestUser` returns real access/refresh tokens, so we can write the
 * app's persisted auth directly into localStorage - no UI round-trip and no OTC
 * email to read. An agent (e.g. Claude Code + Playwright MCP) authenticates the
 * same way: seed the token, never drive the OTC UI.
 *
 * We seed BOTH the token store AND the user store (currentUser). The user store is
 * load-bearing: the router guard (`router.tsx` beforeLoad) redirects to /login
 * whenever `currentUser` is null, and /login's on-mount `clearClientCaches()` +
 * `removeQueries()` (routes/login.tsx) tears the session down before `/api/identify`
 * can populate it - so seeding the token alone races the guard and lands on the
 * hostile /login route. Resolving the user up-front (the same endpoint the app uses)
 * and seeding `currentUser` lets the app boot straight into the authenticated shell.
 *
 * The values are injected via `addInitScript` (runs before any app script on the
 * next navigation), so Zustand's persist middleware hydrates from them instead of
 * an empty store - then we navigate to `/`, never to /login.
 */

/**
 * localStorage keys for the app's Zustand persist stores. Mirror the app:
 *   token: ACCESS_TOKEN_STORAGE_KEY in apps/client/app/hooks/useAccessToken.ts
 *   user:  name/version in apps/client/app/contexts/UserContext.tsx (currently v2)
 * Hardcoded here so the e2e suite doesn't import from the app - keep in sync.
 */
const ACCESS_TOKEN_STORAGE_KEY = 'access-token-storage';
const USER_CONTEXT_STORAGE_KEY = 'user-context';
const USER_CONTEXT_VERSION = 2; // v2: persisted currentUser includes `preferences`

interface SeedTokens {
  accessToken: string;
  refreshToken: string;
}

/** Persisted token store (version 0) - shape mirrors the partialize in useAccessToken.ts. */
function buildTokenValue(tokens: SeedTokens): string {
  return JSON.stringify({
    state: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      returnToken: null,
      returnRefreshToken: null,
      expired: false,
      expiredReason: null,
    },
    version: 0,
  });
}

/** Persisted user store - seeds currentUser so the router guard passes on first load. */
function buildUserContextValue(user: unknown): string {
  return JSON.stringify({ state: { currentUser: user }, version: USER_CONTEXT_VERSION });
}

/**
 * Resolve the full user with the same call the app makes (`/api/identify`), so the
 * seeded currentUser is complete (incl. preferences -> useGetIdentify uses it as
 * initialData and skips a refetch). Throws if the token is rejected.
 */
async function resolveUser(page: Page, accessToken: string): Promise<unknown> {
  const resp = await page.request.get('/api/identify', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok()) {
    throw new Error(`auth-seed: /api/identify returned ${resp.status()} for the provided token`);
  }
  const { user } = (await resp.json()) as { user: unknown };
  return user;
}

/** Inject both persisted stores before app scripts run on the next navigation. */
async function injectStores(page: Page, tokens: SeedTokens, user: unknown): Promise<void> {
  const entries: [string, string][] = [
    [ACCESS_TOKEN_STORAGE_KEY, buildTokenValue(tokens)],
    [USER_CONTEXT_STORAGE_KEY, buildUserContextValue(user)],
  ];
  await page.addInitScript(items => {
    for (const [key, value] of items) localStorage.setItem(key, value);
  }, entries);
}

/**
 * Seed auth (token + currentUser) and write a Playwright storageState file.
 * Boots to `/` (never /login) so the seeded session isn't torn down.
 */
export async function seedAuthStorageState(page: Page, tokens: SeedTokens, path: string): Promise<void> {
  const user = await resolveUser(page, tokens.accessToken);
  await injectStores(page, tokens, user);
  await page.goto('/');
  await page.context().storageState({ path });
}

/**
 * Seed auth (token + currentUser) directly onto a page (mid-test user switching),
 * then bootstrap the authenticated app by navigating to `/`.
 */
export async function seedAuthOnPage(page: Page, tokens: SeedTokens): Promise<void> {
  const user = await resolveUser(page, tokens.accessToken);
  await injectStores(page, tokens, user);
  await page.goto('/');
}
