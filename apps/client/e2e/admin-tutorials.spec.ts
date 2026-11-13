import { test, expect } from './fixtures';
import { TIMEOUTS } from './constants';

/**
 * The admin Tutorials tab: the Core section with its switch card, module list and made-tutorials card. With no core tutorial
 * registered the list shows its empty state. The switch is toggled on and put back, since the setting is global.
 */
test.describe('Admin - Tutorials tab', () => {
  test('shows the Core section and toggles the core switch', async ({ page, basePage }) => {
    await page.goto('/admin?tab=tutorials');
    await page.waitForLoadState('domcontentloaded');
    await basePage.dismissModals();

    await expect(page.getByTestId('tutorials-tab')).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
    await expect(page.getByTestId('tutorials-core-section')).toBeVisible();
    await expect(page.getByTestId('tutorials-switch-card')).toBeVisible();

    const modules = page.getByTestId('tutorial-modules-card');
    await expect(modules).toBeVisible();
    await expect(
      modules.getByTestId('tutorial-modules-empty').or(modules.locator('[data-testid^="tutorial-module-row-"]').first())
    ).toBeVisible();

    const drafts = page.getByTestId('tutorial-drafts-card');
    await expect(drafts).toBeVisible();
    await expect(drafts.getByTestId('tutorial-capture-submit')).toBeVisible();
    // The list is an empty Stack with no height while no draft exists, so Playwright reports it
    // hidden: attached is the right bar for "the drafts read finished without an error".
    await expect(
      drafts.getByTestId('tutorial-drafts-list').or(drafts.getByTestId('tutorial-drafts-error'))
    ).toBeAttached();
    await expect(drafts.getByTestId('tutorial-drafts-error')).toHaveCount(0);

    const toggle = page.getByTestId('tutorials-switch');
    await expect(toggle).toBeAttached();
    if (await toggle.isDisabled()) return;
    const before = await toggle.isChecked();
    try {
      await toggle.click();
      await expect(toggle).toBeChecked({ checked: !before });
    } finally {
      if ((await toggle.isChecked()) !== before) await toggle.click();
      await expect(toggle).toBeChecked({ checked: before });
    }
  });
});
