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

    // A fresh admin session opens on Dashboard.
    await expect(page).toHaveURL(/.*\/admin.*/);
    await expect(adminPage.page.getByTestId('admin-dashboard')).toBeVisible();
  });

  test('should load admin panel on cold URL (no 403 from CloudFront)', async ({ page, basePage, adminPage }) => {
    // Regression guard: /admin/logos bucket route was shadowing the SPA /admin
    // route in CloudFront's longest-prefix matcher, returning 403 on hard-refresh.
    await page.goto('/admin');
    await page.waitForLoadState('domcontentloaded');
    await basePage.dismissModals();

    await expect(page).not.toHaveURL(/login/);
    await expect(adminPage.page.getByTestId('admin-dashboard')).toBeVisible({
      timeout: TIMEOUTS.NAVIGATION,
    });
  });

  test('dashboard panel has no horizontal scroll at phone width', async ({ page, basePage, adminPage }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/admin?tab=dashboard');
    await page.waitForLoadState('domcontentloaded');
    await basePage.dismissModals();
    await expect(adminPage.page.getByTestId('admin-dashboard')).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });

    const panel = page.getByRole('tabpanel').filter({ has: page.getByTestId('admin-dashboard') });
    const { scrollWidth, clientWidth } = await panel.evaluate(el => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(scrollWidth).toBe(clientWidth);
  });
});

// Independent tests - can run in parallel within workers
test.describe('Admin - User Search & Sort', () => {
  test('should search users', async ({ adminPage }) => {
    await adminPage.gotoAdmin();
    await adminPage.navigateToUsersTab();

    // Search by admin email (strip the +alias part since backend search doesn't handle '+')
    const { admin } = getTestUsers();
    const searchTerm = admin.email.split('@')[0].split('+')[0];
    await adminPage.searchUser(searchTerm);

    // Verify search results contain a user row with the admin email
    await expect(adminPage.getUserRow(admin.email).first()).toBeVisible({ timeout: TIMEOUTS.ACTION });
  });

  test('should sort user list', async ({ adminPage }) => {
    await adminPage.gotoAdmin();
    await adminPage.navigateToUsersTab();

    // First click sorts by name ascending, the second flips it
    const header = adminPage.page.getByRole('columnheader', { name: 'User' });
    await adminPage.sortByColumn('user');
    await expect(header).toHaveAttribute('aria-sort', 'ascending');
    await adminPage.sortByColumn('user');
    await expect(header).toHaveAttribute('aria-sort', 'descending');

    // Verify at least one user is displayed after sorting
    await expect(adminPage.page.locator('tr[data-testid^="admin-users-row-"]').first()).toBeVisible({
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
      await adminPage.navigateToUsersTab();
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
      await adminPage.navigateToUsersTab();
      await adminPage.searchUser(TEST_USER.name);
      await adminPage.waitForUserVisible(TEST_USER.name);

      await adminPage.openEditProfileDialog(TEST_USER.name);
      await adminPage.fillEditProfileName(EDITED_NAME);
      await adminPage.saveEditProfile();

      // Verify the edit persisted by searching for the new name (the edit happened on the profile page)
      await adminPage.navigateToUsersTab();
      await adminPage.searchUser(EDITED_NAME);
      await adminPage.waitForUserVisible(EDITED_NAME);
    });

    await test.step('delete user', async () => {
      await adminPage.gotoAdmin();
      await adminPage.navigateToUsersTab();
      await adminPage.searchUser(EDITED_NAME);
      await adminPage.waitForUserVisible(EDITED_NAME);

      await adminPage.openUserProfile(EDITED_NAME);
      await adminPage.clickDeleteUserButton();
      await adminPage.fillDeleteReason();
      await adminPage.typeDeleteConfirmation();
      await adminPage.confirmDeleteUser();

      // Verify user no longer appears in search
      await adminPage.searchUser(EDITED_NAME);
      await expect(adminPage.getUserRow(EDITED_NAME)).toBeHidden({ timeout: TIMEOUTS.ACTION });
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
