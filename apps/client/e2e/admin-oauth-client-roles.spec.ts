import type { Page } from '@playwright/test';
import { test, expect, openPageAs } from './fixtures';
import { TIMEOUTS } from './constants';
import { apiCreateThrowawayUser } from './helpers/api';
import { getTestUsers } from './helpers/test-users';

// Per-client roles: an admin defines a role on an OAuth client, assigns it from a user's profile,
// sees the holder on the client, then removes the assignment and the role.
const APP_URL = process.env.API_URL || 'http://localhost:3000';
const CLIENT_NAME = `E2E Roles RP ${Date.now()}`;
const ROLE = 'editor';

let clientId = '';
let user: Awaited<ReturnType<typeof apiCreateThrowawayUser>>;

async function openClients(page: Page, dismissModals: () => Promise<void>) {
  await page.goto('/admin?tab=oauth-clients');
  await page.waitForLoadState('domcontentloaded');
  await dismissModals();
  await expect(page.getByTestId('oauth-clients-tab')).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
}

async function openRoles(page: Page) {
  await page.getByTestId(`oauth-client-actions-${clientId}`).click();
  await page.getByTestId(`oauth-client-roles-${clientId}`).click();
  await expect(page.getByTestId('oauth-client-roles-section')).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
}

test.describe.serial('Admin - OAuth client roles', () => {
  test.beforeAll(async ({ request }) => {
    user = await apiCreateThrowawayUser(request, 'oauthrole');
  });

  test('admin registers a client and adds a role to it', async ({ page, basePage }) => {
    await openClients(page, () => basePage.dismissModals());
    await page.getByTestId('oauth-client-add-btn').click();
    await page.getByTestId('oauth-client-name-input').fill(CLIENT_NAME);
    await page.getByTestId('oauth-client-redirect-uris-input').fill(`${APP_URL}/e2e-oauth-callback`);
    await page.getByTestId('oauth-client-create-submit-btn').click();
    await expect(page.getByTestId('oauth-client-secret-modal')).toBeVisible();
    await page.getByTestId('oauth-client-secret-done-btn').click();

    const nameCell = page.locator('[data-testid^="oauth-client-name-"]', { hasText: CLIENT_NAME });
    await expect(nameCell).toBeVisible();
    clientId = ((await nameCell.getAttribute('data-testid')) ?? '').replace('oauth-client-name-', '');
    expect(clientId).not.toBe('');

    await openRoles(page);
    await page.getByTestId('oauth-client-role-empty-add-btn').click();
    await page.getByTestId('oauth-client-role-key-input').fill(ROLE);
    await page.getByTestId('oauth-client-role-label-input').fill('Editor');
    await page.getByTestId('oauth-client-role-add-modal-reason-input-preset-0').click();
    await page.getByTestId('oauth-client-role-add-modal-confirm-btn').click();
    await expect(page.getByTestId(`oauth-client-role-row-${ROLE}`)).toBeVisible({ timeout: TIMEOUTS.ACTION });
    await expect(page.getByTestId(`oauth-client-role-holders-${ROLE}`)).toHaveText('-');
  });

  test('admin assigns the role from the user profile, and the client lists the holder', async ({ page, basePage }) => {
    await page.goto(`/admin/users/${user.userId}`);
    await expect(page.getByTestId('user-oauth-roles-card')).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
    await page.getByTestId('user-oauth-role-assign-btn').click();
    await page.getByTestId('user-oauth-role-client-select').getByRole('combobox').click();
    await page.getByTestId(`user-oauth-role-client-option-${clientId}`).click();
    await page.getByTestId('user-oauth-role-role-select').getByRole('combobox').click();
    await page.getByTestId(`user-oauth-role-role-option-${ROLE}`).click();
    await page.getByTestId('user-oauth-role-assign-dialog-reason-input-preset-0').click();
    await page.getByTestId('user-oauth-role-assign-dialog-confirm-btn').click();
    await expect(page.getByTestId(`user-oauth-role-${clientId}-${ROLE}`)).toBeVisible({ timeout: TIMEOUTS.ACTION });

    await openClients(page, () => basePage.dismissModals());
    await openRoles(page);
    await expect(page.getByTestId(`oauth-client-role-holders-${ROLE}`)).toHaveText(user.email);
  });

  test('admin removes the assignment, then the role', async ({ page, basePage }) => {
    await page.goto(`/admin/users/${user.userId}`);
    await page.getByTestId(`user-oauth-role-${clientId}-${ROLE}-remove-btn`).click({ timeout: TIMEOUTS.NAVIGATION });
    await page.getByTestId('user-oauth-role-remove-dialog-reason-input-preset-0').click();
    await page.getByTestId('user-oauth-role-remove-dialog-confirm-btn').click();
    await expect(page.getByTestId('user-oauth-roles-empty')).toBeVisible({ timeout: TIMEOUTS.ACTION });

    await openClients(page, () => basePage.dismissModals());
    await openRoles(page);
    await page.getByTestId(`oauth-client-role-actions-${ROLE}`).click();
    await page.getByTestId(`oauth-client-role-remove-${ROLE}`).click();
    await expect(page.getByTestId('oauth-client-role-remove-modal')).toContainText('0 people lose it');
    await page.getByTestId('oauth-client-role-remove-modal-reason-input-preset-0').click();
    await page.getByTestId('oauth-client-role-remove-modal-confirm-btn').click();
    await expect(page.getByTestId(`oauth-client-role-row-${ROLE}`)).toHaveCount(0, { timeout: TIMEOUTS.ACTION });
  });

  test.afterAll(async ({ browser, baseURL }) => {
    if (!clientId) return;
    const { page, close } = await openPageAs(browser, baseURL, getTestUsers().admin);
    try {
      await page.goto('/admin?tab=oauth-clients');
      await page.getByTestId(`oauth-client-toggle-${clientId}`).click({ timeout: TIMEOUTS.NAVIGATION });
      await page.getByTestId('oauth-client-deactivate-modal-reason-input-preset-0').click();
      await page.getByTestId('oauth-client-deactivate-confirm-btn').click();
      await expect(page.getByTestId(`oauth-client-toggle-${clientId}`)).not.toBeChecked();
    } finally {
      await close();
    }
  });
});
