import { test, expect } from './fixtures';
import { TIMEOUTS } from './constants';

test.describe('Invite Center grant navigation', () => {
  for (const [slug, section] of [
    ['registration-invites', 'invites'],
    ['partner-signup-rules', 'partners'],
    ['held-signup-grants', 'pending'],
  ]) {
    test(`redirects ${slug} into Invite Center`, async ({ page, basePage }) => {
      await page.goto(`/admin?tab=${slug}`);
      await basePage.dismissModals();
      await expect(page.getByTestId(`invite-center-section-${section}`)).toBeVisible({
        timeout: TIMEOUTS.NAVIGATION,
      });
      await expect(page).toHaveURL(/tab=waitlist/);
      await expect(page).toHaveURL(new RegExp(`inviteSection=${section}`));
      await expect(page).not.toHaveURL(new RegExp(`tab=${slug}`));
    });
  }

  test('opens the held grant panel from the held-signup-grants redirect', async ({ page, basePage }) => {
    await page.goto('/admin?tab=held-signup-grants');
    await basePage.dismissModals();
    await expect(page).toHaveURL(/heldGrants=open/);
    await expect(page.getByTestId('held-signup-grants-table')).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
  });

  test('keeps held grant actions inside Pending', async ({ page, basePage }) => {
    await page.goto('/admin?tab=waitlist&inviteSection=pending');
    await basePage.dismissModals();
    await page.getByTestId('invite-center-open-held-grants-btn').click();
    await expect(page.getByTestId('held-signup-grants-table')).toBeVisible();
    await expect(page).toHaveURL(/tab=waitlist/);
    await expect(page).toHaveURL(/inviteSection=pending/);
  });
});
