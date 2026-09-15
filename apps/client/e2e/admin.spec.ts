import { test, expect } from './fixtures';
import { TIMEOUTS } from './constants';
import { getTestUsers } from './helpers/test-users';
import { apiCreateInviteCode } from './helpers/api';

// Generate unique test data to avoid collisions across runs
const timestamp = Date.now();
const TEST_USER = {
  username: `admin-${timestamp}`,
  email: `admin-${timestamp}-e2e@test.com`,
  name: `Admin ${timestamp} e2e`,
  password: 'TestPassword123!',
};

const EDITED_NAME = `Edited Admin ${timestamp} e2e`;

test.describe('Admin - Navigation', () => {
  test('should navigate to admin via sidenav menu', async ({ page, basePage, adminPage }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await basePage.dismissModals();

    await adminPage.navigateToAdmin();

    // Verify we landed on the admin page with Users tab active
    await expect(page).toHaveURL(/.*\/admin.*/);
    await expect(adminPage.page.getByTestId('admin-search-users-input')).toBeVisible();
    await expect(adminPage.page.getByTestId('admin-sort-order-btn')).toBeEnabled();
  });

  test('should load admin panel on cold URL (no 403 from CloudFront)', async ({ page, basePage, adminPage }) => {
    // Regression guard: /admin/logos bucket route was shadowing the SPA /admin
    // route in CloudFront's longest-prefix matcher, returning 403 on hard-refresh.
    await page.goto('/admin');
    await page.waitForLoadState('domcontentloaded');
    await basePage.dismissModals();

    await expect(page).not.toHaveURL(/login/);
    await expect(adminPage.page.getByTestId('admin-search-users-input')).toBeVisible({
      timeout: TIMEOUTS.NAVIGATION,
    });
  });
});

// Independent tests - can run in parallel within workers
test.describe('Admin - User Search & Sort', () => {
  test('should search users', async ({ adminPage }) => {
    await adminPage.gotoAdmin();

    // Search by admin email (strip the +alias part since backend search doesn't handle '+')
    const { admin } = getTestUsers();
    const searchTerm = admin.email.split('@')[0].split('+')[0];
    await adminPage.searchUser(searchTerm);

    // Verify search results contain a user row with the admin email
    await expect(adminPage.page.getByTestId('admin-user-card').filter({ hasText: admin.email }).first()).toBeVisible({
      timeout: TIMEOUTS.ACTION,
    });
  });

  test('should sort user list', async ({ adminPage }) => {
    await adminPage.gotoAdmin();

    // Sort by name
    await adminPage.setSortBy('name');

    // Toggle to ascending
    await adminPage.toggleSortOrder();

    // Verify that the sort controls reflect the new state
    const sortButton = adminPage.page.getByTestId('admin-sort-order-btn');
    await expect(sortButton).toBeVisible();

    // Verify at least one user is displayed after sorting
    await expect(adminPage.page.locator('[data-testid^="user-name-"]').first()).toBeVisible({
      timeout: TIMEOUTS.VISIBLE,
    });
  });
});

// Dependent tests - must run in order (create -> edit -> delete)
test.describe('Admin - User CRUD', () => {
  test('should create, edit, and delete a user', async ({ adminPage }) => {
    test.slow();

    await test.step('create a new user', async () => {
      await adminPage.gotoAdmin();
      await adminPage.openCreateUserModal();

      await adminPage.fillCreateUserForm({
        username: TEST_USER.username,
        email: TEST_USER.email,
        name: TEST_USER.name,
      });

      await adminPage.submitCreateUser();
      await adminPage.waitForCreateUserSuccess();
    });

    await test.step('edit user profile', async () => {
      await adminPage.gotoAdmin();
      await adminPage.searchUser(TEST_USER.name);
      await adminPage.waitForUserVisible(TEST_USER.name);

      await adminPage.clickUserProfileButton(TEST_USER.name);
      await adminPage.fillProfileField('Name:', EDITED_NAME);
      await adminPage.saveProfileChanges();
      await adminPage.closeModal();

      // Verify the edit persisted by searching for the new name
      await adminPage.searchUser(EDITED_NAME);
      await adminPage.waitForUserVisible(EDITED_NAME);
    });

    await test.step('delete user', async () => {
      await adminPage.gotoAdmin();
      await adminPage.searchUser(EDITED_NAME);
      await adminPage.waitForUserVisible(EDITED_NAME);

      await adminPage.clickUserAdminButton(EDITED_NAME);
      await adminPage.typeDeleteConfirmation();
      await adminPage.clickDeleteUserButton();
      await adminPage.confirmDeleteUser();

      // Verify user no longer appears in search
      await adminPage.searchUser(EDITED_NAME);
      await expect(adminPage.page.getByTestId(`user-name-${EDITED_NAME}`)).toBeHidden({ timeout: TIMEOUTS.ACTION });
    });
  });
});

test.describe.serial('Admin - Invite Code Management', () => {
  test('should manage invite codes lifecycle', async ({ adminPage, request }) => {
    let createdInviteCode = '';

    await test.step('create invite codes', async () => {
      await adminPage.gotoAdmin();
      await adminPage.navigateToInviteCenter();
      await adminPage.switchToInviteCodesTab();

      const availableBefore = await adminPage.getAvailableCount();

      await adminPage.openCreateInviteModal();
      await adminPage.submitCreateInvite();

      // Refresh and verify Available count increased by 1
      await adminPage.refreshInvites();
      await adminPage.waitForAvailableCount(availableBefore + 1);

      // Extract the invite code (newest-first sort, so the first code is ours)
      createdInviteCode = await adminPage.getFirstInviteCode();
      expect(createdInviteCode).toBeTruthy();
    });

    await test.step('delete invite codes', async () => {
      // Capture baseline before creating the invite we'll delete
      const availableBaseline = await adminPage.getAvailableCount();

      // Create a fresh invite via API so delete step is independent of prior steps
      const { admin } = getTestUsers();
      const accessToken = admin.accessToken;
      const { code: codeToDelete } = await apiCreateInviteCode(request, accessToken);

      // Refresh and wait until the tab count reflects the new invite
      await adminPage.refreshInvites();
      await adminPage.waitForAvailableCount(availableBaseline + 1);

      // Delete the specific invite we just created
      await adminPage.deleteInviteByCode(codeToDelete);

      // Verify Available count returned to baseline
      await adminPage.refreshInvites();
      await adminPage.waitForAvailableCount(availableBaseline);
    });
  });
});
