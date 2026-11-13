import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { TIMEOUTS } from './constants';
import { apiCreateThrowawayUser, apiLoginViaOtc } from './helpers/api';
import { apiGetApiKeyEligibility, apiMintUserApiKey } from './helpers/api-keys';
import { isProductionEnv } from './helpers/env';
import { getTestRunId } from './helpers/test-users';
import { AdminPage } from './pages/AdminPage';

/**
 * The tabs of /admin/users/$userId, each checked against a throwaway user this file creates. Only
 * per-user admin actions are taken; no global admin setting is read or changed.
 */

type ProfileTab = 'overview' | 'activity' | 'credits' | 'keys' | 'signins' | 'admin';

/** The UTC day (YYYY-MM-DD) of `at`, moved by `offsetDays`. */
const utcDay = (at: number, offsetDays = 0) =>
  new Date(at + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

async function openProfile(page: Page, userId: string, tab: ProfileTab = 'overview') {
  await page.goto(tab === 'overview' ? `/admin/users/${userId}` : `/admin/users/${userId}?tab=${tab}`);
  const adminPage = new AdminPage(page);
  await adminPage.dismissModals();
  await adminPage.closeFloatingChat();
  await expect(page.getByTestId('user-profile-view')).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
  await expect(page.getByTestId(`user-profile-panel-${tab}`)).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
}

async function switchTab(page: Page, tab: ProfileTab) {
  await page.getByTestId(`user-profile-tab-${tab}`).click();
  await expect(page.getByTestId(`user-profile-panel-${tab}`)).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
}

test.describe('Admin - User profile tabs', () => {
  test.skip(isProductionEnv(), 'creates and adjusts throwaway users');

  test('Sign-ins and Activity show the target user signing in', async ({ page, request }) => {
    const target = await apiCreateThrowawayUser(request, 'upsignin');
    // The session /api/test/create-user issues is not an audited sign-in, so sign in once for real.
    await apiLoginViaOtc(request, target.email);
    await openProfile(page, target.userId, 'signins');

    const signIn = page
      .getByTestId('user-signins-row')
      .filter({ has: page.getByTestId('user-signin-result').filter({ hasText: 'Success' }) });
    await expect(signIn.first()).toBeVisible({ timeout: TIMEOUTS.ACTION });
    await expect(signIn.first()).toContainText('One-time code');

    await switchTab(page, 'activity');
    await expect(page.getByTestId('user-timeline-row').filter({ hasText: 'Signed in' }).first()).toBeVisible({
      timeout: TIMEOUTS.ACTION,
    });
  });

  test('Adjust credits changes the balance and lands in the Admin log and the filtered ledger', async ({
    page,
    request,
  }) => {
    test.slow();
    const target = await apiCreateThrowawayUser(request, 'upcredits', { initialCredits: 1000 });
    const reason = `E2E profile tabs credit check ${getTestRunId()}`;
    await openProfile(page, target.userId);
    const balance = page.getByTestId('admin-stat-tile').filter({ hasText: 'Credit balance' });
    await expect(balance).toContainText('1,000', { timeout: TIMEOUTS.VISIBLE });
    let adjustedAt = 0;

    await test.step('subtract 250 credits with a reason', async () => {
      await page.getByTestId('user-profile-adjust-credits-btn').click();
      const dialog = page.getByTestId('adjust-credits-dialog');
      await expect(dialog).toBeVisible({ timeout: TIMEOUTS.MODAL });
      // A deduction never waits on a second admin's credit-grant approval.
      await page.getByTestId('adjust-credits-mode-subtract').click();
      await page.getByTestId('adjust-credits-amount-input').fill('250');
      await expect(page.getByTestId('adjust-credits-preview')).toContainText('750');
      await page.getByTestId('adjust-credits-dialog-reason-input').fill(reason);
      const confirm = page.getByTestId('adjust-credits-dialog-confirm-btn');
      await expect(confirm).toBeEnabled({ timeout: TIMEOUTS.ELEMENT_STATE });
      await confirm.click();
      adjustedAt = Date.now();
      await expect(dialog).toBeHidden({ timeout: TIMEOUTS.ACTION });
      await expect(balance).toContainText('750', { timeout: TIMEOUTS.ACTION });
    });

    await test.step('the Admin log shows the adjustment with its reason', async () => {
      await switchTab(page, 'admin');
      const entry = page.getByTestId('user-admin-log-row').filter({ hasText: `Reason: ${reason}` });
      await expect(entry).toBeVisible({ timeout: TIMEOUTS.ACTION });
      await expect(entry).toContainText('250');
    });

    await test.step('the Credits ledger shows it, and each filter narrows the rows', async () => {
      await switchTab(page, 'credits');
      const ledger = page.getByTestId('user-credits-ledger');
      const adjustment = page
        .getByTestId('user-credits-table')
        .locator('[data-testid^="admin-table-row-"]')
        .filter({ hasText: reason });
      const noMatch = ledger.getByText('No transactions match these filters.');
      const clear = page.getByTestId('user-credits-clear-filters-btn');
      const expectNarrowedOut = async () => {
        await expect(noMatch).toBeVisible({ timeout: TIMEOUTS.ACTION });
        await expect(adjustment).toHaveCount(0);
      };
      const expectShown = async () => {
        await expect(adjustment).toHaveCount(1, { timeout: TIMEOUTS.ACTION });
        await expect(noMatch).toBeHidden();
      };

      await expectShown();
      await expect(adjustment).toContainText('Admin');
      await expect(adjustment).toContainText('750');

      await page.getByTestId('user-credits-filter-adjustment').click();
      await expectShown();
      await page.getByTestId('user-credits-filter-usage').click();
      await expectNarrowedOut();
      await clear.click();
      await expectShown();

      // Only completions carry a source and a model, so either filter leaves an admin adjustment out.
      await page.getByTestId('user-credits-source-filter').click();
      await page.getByTestId('user-credits-source-option-web').click();
      await expectNarrowedOut();
      await clear.click();
      await expectShown();

      const model = page.getByTestId('user-credits-model-filter');
      await model.fill('e2e-no-such-model');
      await model.press('Enter');
      await expectNarrowedOut();
      await clear.click();
      await expectShown();

      const from = page.getByTestId('user-credits-from');
      await from.fill(utcDay(adjustedAt));
      await expectShown();
      await from.fill(utcDay(adjustedAt, 1));
      await expectNarrowedOut();
      await clear.click();
      await expectShown();
    });
  });

  test('API keys lists a key the target user owns', async ({ page, request }) => {
    // Trust-approved and carrying the default Developer tag, so neither the trust gate nor the access switch refuses it.
    const target = await apiCreateThrowawayUser(request, 'upkeys', { apiKeyTrustApproved: true });
    const eligibility = await apiGetApiKeyEligibility(request, target.accessToken);
    test.skip(!eligibility.canCreate, `personal API keys are refused here: ${eligibility.message}`);

    const name = `E2E profile key ${getTestRunId()}`;
    const minted = await apiMintUserApiKey(request, target.accessToken, { name, scopes: ['notebooks:read'] });
    expect(minted.status(), await minted.text()).toBe(201);
    const { id } = (await minted.json()) as { id: string };

    await openProfile(page, target.userId, 'keys');
    await expect(page.getByTestId(`user-keys-row-${id}`)).toContainText(name, { timeout: TIMEOUTS.ACTION });
  });

  test('Recent activity refreshes without a reload after Edit profile saves', async ({ page, request, adminPage }) => {
    const target = await apiCreateThrowawayUser(request, 'uprecent');
    const reason = `E2E recent activity refresh ${getTestRunId()}`;
    await openProfile(page, target.userId);

    const entry = page
      .getByTestId('user-profile-activity-card')
      .getByTestId('user-profile-recent-activity-row')
      .filter({ hasText: `Reason: ${reason}` });
    await expect(page.getByTestId('user-profile-recent-activity-row').first()).toBeVisible({
      timeout: TIMEOUTS.ACTION,
    });
    await expect(entry).toHaveCount(0);

    // A full load would drop this marker, so its survival proves the card refetched in place.
    await page.evaluate(() => Object.assign(window, { __e2eProfileNoReload: true }));
    await adminPage.clickProfileMenuItem('editProfile');
    await expect(page.getByTestId('edit-profile-dialog')).toBeVisible({ timeout: TIMEOUTS.MODAL });
    await adminPage.fillEditProfileName(`Renamed ${getTestRunId()} e2e`);
    await adminPage.saveEditProfile(reason);

    await expect(entry).toBeVisible({ timeout: TIMEOUTS.ACTION });
    expect(await page.evaluate(() => '__e2eProfileNoReload' in window)).toBe(true);
  });
});
