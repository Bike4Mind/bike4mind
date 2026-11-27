import { expect, type Page } from '@playwright/test';
import { test } from './waf-test';
import { apiGetAdminSettings, apiUpdateAdminSetting } from './helpers/api';
import { isSharedRealEnv } from './helpers/env';
import { getTestUsers } from './helpers/test-users';
import { BasePage } from './pages/BasePage';

// Walks the basics tutorial as a new user. The replies are recorded, so no step calls a model.
const MODULE_ID = 'first-steps';
const PHONE = { width: 390, height: 844 };
// A settings write clears only the process that took it; the others keep the old value for one TTL
// of the shared cache in b4m-core/utils/src/settings.ts. Same wait as free-tier-limits.spec.ts.
const SETTINGS_CACHE_TTL_MS = 5 * 60_000;
const CACHE_MARGIN_MS = 5_000;

test.describe.configure({ mode: 'serial' });

test.describe('basics tutorial', () => {
  // The switch is global: never flip it on a shared environment.
  test.skip(isSharedRealEnv(), 'toggles the global EnableCoreTutorials setting');
  // Each test walks the whole tour through several page loads.
  test.setTimeout(240_000);

  let priorSetting: unknown;
  let flipped = false;

  test.beforeAll(async ({ request }) => {
    const adminToken = getTestUsers().admin.accessToken;
    priorSetting = (await apiGetAdminSettings(request, adminToken)).get('EnableCoreTutorials');
    await apiUpdateAdminSetting(request, adminToken, 'EnableCoreTutorials', true);
    flipped = true;
    if (priorSetting === true) return;
    test.setTimeout(SETTINGS_CACHE_TTL_MS + CACHE_MARGIN_MS + 30_000);
    await new Promise(resolve => setTimeout(resolve, SETTINGS_CACHE_TTL_MS + CACHE_MARGIN_MS));
  });

  test.afterAll(async ({ request }) => {
    if (!flipped) return;
    await apiUpdateAdminSetting(
      request,
      getTestUsers().admin.accessToken,
      'EnableCoreTutorials',
      priorSetting ?? false
    );
  });

  const card = (page: Page) => page.getByTestId('tutorial-coach-card');

  // The cookie banner sits over the composer's Send button at both widths.
  const settle = async (page: Page) => {
    await new BasePage(page).dismissModals();
    const decline = page.getByRole('button', { name: 'Decline' });
    if (
      await decline.waitFor({ timeout: 5_000 }).then(
        () => true,
        () => false
      )
    )
      await decline.click();
  };

  const expectStep = async (page: Page, label: string, title: string) => {
    await expect(card(page)).toContainText(label);
    await expect(card(page)).toContainText(title);
  };

  const openPicker = async (page: Page, phone: boolean) => {
    if (phone) await page.getByTestId('notebook-header-menu-btn').click();
    await page.getByTestId('profile-menu-card').click();
    await page.getByTestId('profile-menu-tutorials').click();
    await expect(page.getByTestId('tutorial-picker')).toBeVisible();
  };

  test('walks every step from the welcome-card offer', async ({ page }) => {
    await page.goto('/new');
    await settle(page);
    await page.getByTestId('tutorial-offer-basics').click();

    await expectStep(page, 'Step 1 of 5', 'Send your first message');
    await expect(page.getByTestId('session-bottom-container')).toContainText('polite email to my landlord');
    await page.getByTestId('send-message-btn').click();
    await expect(page.getByText('Subject:').first()).toBeVisible();

    await expectStep(page, 'Step 2 of 5', 'Ask a follow-up');
    await page.getByTestId('send-message-btn').click();
    await expect(page.getByText('broken for three days').first()).toBeVisible();

    await expectStep(page, 'Step 3 of 5', 'Add a file');
    await page.getByTestId('attach-files-btn').click();
    await page.getByTestId('add-from-file-browser-btn').click();
    await page.locator('[data-testid^="recent-file-"]').filter({ hasText: 'monthly-spending.csv' }).first().click();
    await page.getByTestId('file-browser-add-files-btn').click();

    await expectStep(page, 'Step 4 of 5', 'Ask about the file');
    await page.getByTestId('send-message-btn').click();
    await expect(page.getByText('Possible total').first()).toBeVisible();

    await expectStep(page, 'Step 5 of 5', 'Your conversations are saved');
    await page.getByTestId('tutorial-step-next').click();

    await expect(card(page)).toContainText('Where to go next');
    await page.getByTestId('tutorial-step-next').click();
    await expect(card(page)).toBeHidden();

    await openPicker(page, false);
    await expect(page.getByTestId(`tutorial-picker-status-${MODULE_ID}`)).toContainText(/finished/i);
  });

  test('replays at phone width, skipping every step and resuming after leaving', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/new');
    await settle(page);
    await openPicker(page, true);
    await page.getByTestId(`tutorial-picker-start-${MODULE_ID}`).click();

    await expectStep(page, 'Step 1 of 5', 'Send your first message');
    await page.getByTestId('tutorial-coach-skip').click();
    await expectStep(page, 'Step 2 of 5', 'Ask a follow-up');
    await page.getByTestId('tutorial-coach-skip').click();

    await expectStep(page, 'Step 3 of 5', 'Add a file');
    await page.getByTestId('tutorial-coach-leave').click();
    await expect(card(page)).toBeHidden();
    await page.reload();
    await settle(page);
    // A walk the user left stays left until they resume it.
    await expect(card(page)).toBeHidden();

    await openPicker(page, true);
    await expect(page.getByTestId(`tutorial-picker-status-${MODULE_ID}`)).toContainText(/in progress/i);
    await page.getByTestId(`tutorial-picker-resume-${MODULE_ID}`).click();

    await expectStep(page, 'Step 3 of 5', 'Add a file');
    await page.getByTestId('tutorial-coach-skip').click();
    await expectStep(page, 'Step 4 of 5', 'Ask about the file');
    await page.getByTestId('tutorial-coach-skip').click();
    await expect(page.getByText('Possible total').first()).toBeVisible();
    await expectStep(page, 'Step 5 of 5', 'Your conversations are saved');
    await page.getByTestId('tutorial-coach-skip').click();

    await expect(card(page)).toContainText('Where to go next');
    await page.getByTestId('tutorial-step-next').click();
    await expect(card(page)).toBeHidden();
  });
});
