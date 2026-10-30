import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { TIMEOUTS } from './constants';
import { apiGetOtcCode, apiLoginViaOtc } from './helpers/api';
import type { LoginPage } from './pages/LoginPage';

/**
 * Sign-in for an account that already existed before the deploy under test. Every other login test
 * mints its account seconds earlier, so none of them exercises a long-lived account's stored state
 * or the cookies an earlier release left in its browser.
 *
 * Uses the standing seeded account (packages/scripts/seeders/UserSeeder.ts). Its address has no
 * `-<digits>` segment, so the teardown sweep never deletes it (server/utils/e2eCleanupScope.ts).
 *
 * Serial mode: /api/test/otc-code returns the last code sent to an inbox, so two tests signing in to
 * the same account at once would read each other's codes.
 */
test.describe.configure({ mode: 'serial' });

const EXISTING_USER_EMAIL = 'qa-user-e2e@test.com';
// Must stay in sync with REFRESH_COOKIE_NAME and LEGACY_COOKIE_PATH in
// packages/server-utils/src/auth/refreshCookie.ts.
const BARE_REFRESH_COOKIE = 'b4m_rt';
const BARE_REFRESH_COOKIE_PATH = '/api';

/** Signs in through the login form and returns the verify response the app received. */
async function signInThroughForm(page: Page, loginPage: LoginPage, request: APIRequestContext) {
  await loginPage.goto();
  await loginPage.fillEmail(EXISTING_USER_EMAIL);
  const code = await apiGetOtcCode(request, EXISTING_USER_EMAIL);
  await loginPage.fillOtc(code);
  const verified = page.waitForResponse(
    response => response.url().includes('/api/otc/verify') && response.request().method() === 'POST'
  );
  await loginPage.submit();
  const response = await verified;
  expect(response.status(), 'OTC verify').toBe(200);
  return (await response.json()) as { email?: string; registrationRequired?: boolean; mfaRequired?: boolean };
}

async function expectSignedIn(page: Page) {
  await expect(page).not.toHaveURL(/.*login.*/);
  await expect(page.getByTestId('profile-menu-card')).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
}

test.describe('Existing user sign-in', () => {
  test('signs in, keeps the session across a reload and a deep link, signs out and back in', async ({
    basePage,
    loginPage,
    navigationPage,
    page,
    request,
  }) => {
    // Two full OTC sign-ins plus a reload and a cold deep link, each waiting out the app's modals.
    test.slow();
    await basePage.clearAllStorage();

    await test.step('the code logs in to the existing account instead of starting a registration', async () => {
      const body = await signInThroughForm(page, loginPage, request);
      expect(body.registrationRequired, 'an existing account must not be asked to register').toBeFalsy();
      expect(body.mfaRequired, 'the standing account is expected to have no MFA').toBeFalsy();
      expect(body.email).toBe(EXISTING_USER_EMAIL);
      await basePage.dismissModals();
      await expectSignedIn(page);
    });

    await test.step('a full reload restores the session from the refresh cookie', async () => {
      await page.reload();
      await basePage.dismissModals();
      await expectSignedIn(page);
    });

    await test.step('a cold deep link restores the session too', async () => {
      await page.goto('/new');
      await basePage.dismissModals();
      await expectSignedIn(page);
    });

    await test.step('signing out returns to the login page', async () => {
      await navigationPage.logout();
      await loginPage.expectLoginPage();
    });

    await test.step('the same account signs straight back in', async () => {
      await signInThroughForm(page, loginPage, request);
      await basePage.dismissModals();
      await expectSignedIn(page);
    });
  });

  test('a browser holding only the pre-rename bare refresh cookie lands on sign-in and signs in', async ({
    basePage,
    loginPage,
    page,
    request,
  }) => {
    const apiUrl = new URL(process.env.API_URL || 'http://localhost:3000');
    // Over plain http the bare name is still the live cookie name, so there is no legacy state to model.
    test.skip(apiUrl.protocol !== 'https:', 'The __Host- session cookie only exists on https deployments.');

    // A real, unrevoked session parked under the old cookie name, as a browser that last visited
    // before the rename would still hold it. The refresh route no longer reads that name.
    const parked = await apiLoginViaOtc(request, EXISTING_USER_EMAIL);
    await basePage.clearAllStorage();
    await page.context().clearCookies();
    await page.context().addCookies([
      {
        name: BARE_REFRESH_COOKIE,
        value: parked.refreshToken,
        domain: apiUrl.hostname,
        path: BARE_REFRESH_COOKIE_PATH,
        httpOnly: true,
        secure: true,
        sameSite: 'Strict',
      },
    ]);

    await page.goto('/new');
    // Lands on the sign-in form, not a blank screen, an error page or a redirect loop.
    await loginPage.expectLoginPage();
    await expect(page.getByTestId('login-email-input')).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });

    const body = await signInThroughForm(page, loginPage, request);
    expect(body.email).toBe(EXISTING_USER_EMAIL);
    await basePage.dismissModals();
    await expectSignedIn(page);

    // Every session write also expires the bare name, so the stale copy is gone after sign-in.
    const stale = (await page.context().cookies()).filter(
      cookie => cookie.name === BARE_REFRESH_COOKIE && cookie.path === BARE_REFRESH_COOKIE_PATH
    );
    expect(stale).toEqual([]);

    // Revoke only the parked session (per-device logout), so the shared account keeps no orphan.
    const logout = await request.get('/api/logout', { headers: { Authorization: `Bearer ${parked.accessToken}` } });
    expect(logout.status()).toBe(200);
  });
});
