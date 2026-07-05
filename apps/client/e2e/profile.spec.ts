import { test, expect } from './fixtures';
import { TIMEOUTS } from './constants';
import editUserData from './fixtures/edit-user.json';

const testUser = editUserData[0];

test.describe('Profile - Navigation', () => {
  test('should navigate to profile via sidenav', async ({ page, basePage }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await basePage.dismissModals();

    await page.getByTestId('profile-menu-card').click();
    await page.getByTestId('profile-menu-profile').click();

    await expect(page).toHaveURL(/.*\/profile.*/);
    await expect(page.getByTestId('profile-tab')).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
  });
});

test.describe.serial('Profile - Settings', () => {
  test('should update and revert profile settings', async ({ profilePage }) => {
    test.slow();
    await test.step('update user profile settings', async () => {
      await profilePage.gotoProfile();
      await profilePage.clickEditProfile();

      await profilePage.fillField('Name:', testUser.newName);
      await profilePage.fillField('Team:', testUser.newTeam);
      await profilePage.fillField('Role:', testUser.newRole);
      await profilePage.fillField('Phone:', testUser.phone);
      await profilePage.selectDropdown('Preferred Contact:', testUser.preferredContactMethod);
      await profilePage.selectDropdown('T-shirt Size:', testUser.tShirtSize);

      await profilePage.saveProfile();

      // Navigate away and back to verify persistence
      await profilePage.gotoProfile();
      await profilePage.clickEditProfile();

      await expect.poll(() => profilePage.getFieldValue('Name:'), { timeout: TIMEOUTS.VISIBLE }).toBe(testUser.newName);
      await expect.poll(() => profilePage.getFieldValue('Team:'), { timeout: TIMEOUTS.VISIBLE }).toBe(testUser.newTeam);
      await expect.poll(() => profilePage.getFieldValue('Role:'), { timeout: TIMEOUTS.VISIBLE }).toBe(testUser.newRole);
      await expect.poll(() => profilePage.getFieldValue('Phone:'), { timeout: TIMEOUTS.VISIBLE }).toBe(testUser.phone);

      const contactValue = await profilePage.getDropdownValue('Preferred Contact:');
      expect(contactValue).toBe(testUser.preferredContactMethod);
      const shirtValue = await profilePage.getDropdownValue('T-shirt Size:');
      expect(shirtValue).toBe(testUser.tShirtSize);
    });

    await test.step('revert user profile settings', async () => {
      await profilePage.gotoProfile();
      await profilePage.clickEditProfile();

      // Revert to original values
      await profilePage.fillField('Name:', testUser.originalName);
      await profilePage.fillField('Team:', '');
      await profilePage.fillField('Role:', '');
      await profilePage.fillField('Phone:', '');
      await profilePage.selectDropdown('Preferred Contact:', 'None');
      await profilePage.selectDropdown('T-shirt Size:', 'None');

      await profilePage.saveProfile();

      // Navigate away and back to verify persistence
      await profilePage.gotoProfile();
      await profilePage.clickEditProfile();

      await expect
        .poll(() => profilePage.getFieldValue('Name:'), { timeout: TIMEOUTS.AI_RESPONSE })
        .toBe(testUser.originalName);
      await expect.poll(() => profilePage.getFieldValue('Team:'), { timeout: TIMEOUTS.VISIBLE }).toBe('');
      await expect.poll(() => profilePage.getFieldValue('Role:'), { timeout: TIMEOUTS.VISIBLE }).toBe('');
      await expect.poll(() => profilePage.getFieldValue('Phone:'), { timeout: TIMEOUTS.VISIBLE }).toBe('');
    });
  });

  test('should verify profile page elements', async ({ profilePage }) => {
    await profilePage.gotoProfile();

    await expect(profilePage.page.getByTestId('profile-edit-btn')).toBeVisible({
      timeout: TIMEOUTS.VISIBLE,
    });

    const tabList = profilePage.page.getByTestId('profile-tablist');
    await expect(tabList).toBeVisible({ timeout: TIMEOUTS.VISIBLE });

    await expect(profilePage.page.getByTestId('profile-tab')).toBeVisible();
    await expect(profilePage.page.getByTestId('settings-tab')).toBeVisible();
    await expect(profilePage.page.getByTestId('community-tab')).toBeVisible();
  });

  test('should toggle experimental features', async ({ profilePage }) => {
    await profilePage.gotoProfile();
    await profilePage.clickTab('Settings');
    await profilePage.waitForFeaturesLoaded();

    // Use Research Mode - it is never admin-gated (disabled={false} hardcoded)
    const featureName = 'Research Mode';

    // Skip if somehow disabled by admin
    const isDisabled = await profilePage.isFeatureDisabledByAdmin(featureName);
    if (isDisabled) {
      test.skip(true, `${featureName} is disabled by administrator`);
      return;
    }

    const initialState = await profilePage.isFeatureEnabled(featureName);

    await profilePage.toggleFeature(featureName);
    const toggledState = await profilePage.isFeatureEnabled(featureName);
    expect(toggledState).toBe(!initialState);

    // Toggle back to restore original state
    await profilePage.toggleFeature(featureName);
    const restoredState = await profilePage.isFeatureEnabled(featureName);
    expect(restoredState).toBe(initialState);
  });
});
