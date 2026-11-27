import type { Page } from '@playwright/test';
import { test, expect, openPageAs } from './fixtures';
import { TIMEOUTS } from './constants';
import { apiAcceptPolicies, apiCreateThrowawayUser } from './helpers/api';
import { getTestUsers } from './helpers/test-users';
import { installWafBypass } from './helpers/waf-bypass';

// OIDC RP-Initiated Logout: an admin registers a post-logout redirect URI, then /oauth/logout
// sends browsers back to it. The relying party's landing page is stubbed with page.route.
const APP_URL = process.env.API_URL || 'http://localhost:3000';
const SIGNED_OUT_URI = `${APP_URL}/e2e-oauth-signed-out`;
const CLIENT_NAME = `E2E Logout RP ${Date.now()}`;

// browser.newContext() inherits the project's `use`, and this spec runs in the admin project, whose
// storageState holds the admin's refresh cookie. Without an explicit empty state the "no session"
// browser bootstraps an admin session and gets the confirmation screen instead of the redirect.
const NO_SESSION = { cookies: [], origins: [] };

let clientId = '';

const logoutUrl = (params: Record<string, string>) => `/oauth/logout?${new URLSearchParams(params).toString()}`;

async function stubRelyingParty(page: Page) {
  await page.route(`${SIGNED_OUT_URI}**`, route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<p>relying party</p>' })
  );
}

test.describe.serial('OAuth RP-Initiated Logout', () => {
  test('admin registers a client with a post-logout redirect URI', async ({ page, basePage }) => {
    await page.goto('/admin?tab=oauth-clients');
    await page.waitForLoadState('domcontentloaded');
    await basePage.dismissModals();
    await expect(page.getByTestId('oauth-clients-tab')).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });

    await page.getByTestId('oauth-client-add-btn').click();
    await page.getByTestId('oauth-client-name-input').fill(CLIENT_NAME);
    await page.getByTestId('oauth-client-redirect-uris-input').fill(`${APP_URL}/e2e-oauth-callback`);
    await page.getByTestId('oauth-client-post-logout-uris-input').fill(SIGNED_OUT_URI);
    await page.getByTestId('oauth-client-create-submit-btn').click();

    await expect(page.getByTestId('oauth-client-secret-modal')).toBeVisible();
    await page.getByTestId('oauth-client-secret-done-btn').click();

    const nameCell = page.locator('[data-testid^="oauth-client-name-"]', { hasText: CLIENT_NAME });
    await expect(nameCell).toBeVisible();
    clientId = ((await nameCell.getAttribute('data-testid')) ?? '').replace('oauth-client-name-', '');
    expect(clientId).not.toBe('');

    await page.getByTestId(`oauth-client-actions-${clientId}`).click();
    await page.getByTestId(`oauth-client-edit-${clientId}`).click();
    await expect(page.getByTestId('oauth-client-edit-post-logout-uris-input')).toHaveValue(SIGNED_OUT_URI);
  });

  test('a browser without a session is sent straight back with its state', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, storageState: NO_SESSION });
    const page = await context.newPage();
    try {
      await installWafBypass(context);
      await stubRelyingParty(page);
      await page.goto(logoutUrl({ client_id: clientId, post_logout_redirect_uri: SIGNED_OUT_URI, state: 'e2e-s1' }));
      await expect(page).toHaveURL(`${SIGNED_OUT_URI}?state=e2e-s1`, { timeout: TIMEOUTS.NAVIGATION });
    } finally {
      await context.close();
    }
  });

  test('an unregistered post-logout URI is refused without redirecting', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, storageState: NO_SESSION });
    const page = await context.newPage();
    try {
      await installWafBypass(context);
      await page.goto(logoutUrl({ client_id: clientId, post_logout_redirect_uri: 'https://elsewhere.example.test/' }));
      await expect(page.getByTestId('oauth-logout-error-message')).toContainText('not registered', {
        timeout: TIMEOUTS.NAVIGATION,
      });
      expect(new URL(page.url()).pathname).toBe('/oauth/logout');
    } finally {
      await context.close();
    }
  });

  test('a signed-in admin can decline and stay signed in', async ({ page }) => {
    await stubRelyingParty(page);
    await page.goto(logoutUrl({ client_id: clientId, post_logout_redirect_uri: SIGNED_OUT_URI, state: 'e2e-s2' }));
    await expect(page.getByTestId('oauth-logout-confirm')).toContainText(CLIENT_NAME, {
      timeout: TIMEOUTS.NAVIGATION,
    });
    await page.getByTestId('oauth-logout-stay-btn').click();
    await expect(page).toHaveURL(`${SIGNED_OUT_URI}?state=e2e-s2`);
  });

  test('a signed-in user confirms, is signed out and sent back', async ({ browser, baseURL, request }) => {
    const user = await apiCreateThrowawayUser(request, 'rplogout');
    await apiAcceptPolicies(request, user.accessToken);
    // A clean context, so the sign-out it confirms acts on this user's browser alone, never beside the
    // admin refresh cookie the project's storageState would otherwise carry in.
    const { page, close } = await openPageAs(browser, baseURL, user, { storageState: NO_SESSION });
    try {
      await stubRelyingParty(page);
      await page.goto(logoutUrl({ client_id: clientId, post_logout_redirect_uri: SIGNED_OUT_URI, state: 'e2e-s3' }));
      await page.getByTestId('oauth-logout-confirm-btn').click({ timeout: TIMEOUTS.NAVIGATION });
      await expect(page).toHaveURL(`${SIGNED_OUT_URI}?state=e2e-s3`, { timeout: TIMEOUTS.NAVIGATION });
    } finally {
      await close();
    }
  });

  test.afterAll(async ({ browser, baseURL }) => {
    if (!clientId) return;
    const { page, close } = await openPageAs(browser, baseURL, getTestUsers().admin);
    try {
      await page.goto('/admin?tab=oauth-clients');
      await page.getByTestId(`oauth-client-toggle-${clientId}`).click({ timeout: TIMEOUTS.NAVIGATION });
      // Deactivate stays disabled until an admin reason is picked; without one this click waits out the
      // hook timeout and the client is left active.
      await page.getByTestId('oauth-client-deactivate-modal-reason-input-preset-0').click();
      await page.getByTestId('oauth-client-deactivate-confirm-btn').click();
      await expect(page.getByTestId(`oauth-client-toggle-${clientId}`)).not.toBeChecked();
    } finally {
      await close();
    }
  });
});
