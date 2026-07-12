import { type Locator, expect } from '@playwright/test';
import { BasePage } from './BasePage';
import { TIMEOUTS } from '../constants';

export class AdminPage extends BasePage {
  // --- Navigation ---

  async closeFloatingChat() {
    const closeBtn = this.page.getByTestId('floating-chat-close');
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click();
    }
  }

  async navigateToAdmin() {
    await this.closeFloatingChat();

    // Menu items can be detached by React re-renders (WebSocket/polling).
    // Retry: re-open the menu if the click fails due to detachment or visibility.
    for (let attempt = 1; attempt <= 3; attempt++) {
      await this.page.getByTestId('profile-menu-card').click();
      try {
        await this.page.getByTestId('profile-menu-admin').click({ timeout: TIMEOUTS.ELEMENT_STATE });
        break;
      } catch {
        if (attempt === 3) throw new Error('Failed to click Admin menu item after retries');
        await this.page.keyboard.press('Escape');
      }
    }
    await this.waitForAdminReady();
  }

  async gotoAdmin() {
    // Navigate via the Admin sidenav menu (client-side routing) rather than a
    // hard load of /admin, which can hit a CloudFront 403 on deployed envs.
    await this.page.goto('/');
    await this.page.waitForLoadState('domcontentloaded');
    await this.dismissModals();
    await this.navigateToAdmin();
  }

  /** Wait for the admin page to be fully loaded and interactive */
  private async waitForAdminReady() {
    await this.closeFloatingChat();
    await this.waitForLoaderToDisappear('admin-users-loading-indicator');
    await expect(this.page.getByTestId('admin-search-users-input')).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
    await expect(this.page.getByTestId('admin-sort-order-btn')).toBeEnabled({ timeout: TIMEOUTS.ACTION });
  }

  async navigateToUsersTab() {
    await this.page.getByTestId('admin-users-tab-btn').first().click();
    await expect(this.page.getByTestId('admin-search-users-input')).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
  }

  async navigateToInviteCenter() {
    await this.page.getByTestId('admin-invite-center-tab-btn').first().click();
    await expect(this.page.getByTestId('invite-center-codes-tab')).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
  }

  async switchToInviteCodesTab() {
    await this.page.getByTestId('invite-center-codes-tab').click();
  }

  // --- User Search ---

  async searchUser(query: string) {
    const searchInput = this.page.getByTestId('admin-search-users-input').getByRole('textbox');
    await searchInput.clear();
    await searchInput.fill(query);
    await this.waitForResponseOrUI(
      resp => resp.url().includes('/api/users') && resp.request().method() === 'GET' && resp.ok(),
      () => expect(this.page.getByTestId('admin-sort-order-btn')).toBeEnabled({ timeout: TIMEOUTS.ACTION })
    );

    await this.waitForLoaderToDisappear('admin-users-loading-indicator');
  }

  async isUserVisible(name: string): Promise<boolean> {
    return await this.page
      .getByTestId(`user-name-${name}`)
      .isVisible()
      .catch(() => false);
  }

  async waitForUserVisible(name: string) {
    await expect(this.page.getByTestId(`user-name-${name}`)).toBeVisible({ timeout: TIMEOUTS.ACTION });
  }

  // --- Sort ---

  async setSortBy(option: 'name' | 'createdAt') {
    const testId = option === 'name' ? 'sort-option-name' : 'sort-option-created-at';
    // Dropdown options can be detached by React re-renders. Retry: re-open the dropdown.
    for (let attempt = 1; attempt <= 3; attempt++) {
      await this.page.getByTestId('admin-sort-by-select').click();
      try {
        await this.page.getByTestId(testId).click({ timeout: TIMEOUTS.ELEMENT_STATE });
        break;
      } catch {
        if (attempt === 3) throw new Error(`Failed to select sort option "${option}" after retries`);
        await this.page.keyboard.press('Escape');
      }
    }
    await this.waitForLoaderToDisappear('admin-users-loading-indicator');
    await expect(this.page.getByTestId('admin-sort-by-listbox')).toBeHidden({ timeout: TIMEOUTS.ELEMENT_STATE });
  }

  async toggleSortOrder() {
    // The floating AI chat can re-open and overlay the sort controls,
    // intercepting pointer events - close it before clicking.
    await this.closeFloatingChat();
    await this.page.getByTestId('admin-sort-order-btn').click();
    await this.waitForResponseOrUI(
      resp => resp.url().includes('/api/users') && resp.request().method() === 'GET' && resp.ok(),
      () => expect(this.page.getByTestId('admin-sort-order-btn')).toBeEnabled({ timeout: TIMEOUTS.ACTION })
    );
  }

  // --- Create User ---

  async openCreateUserModal() {
    await this.page.getByTestId('admin-create-user-btn').click();
    await expect(this.page.getByTestId('create-user-username-input')).toBeVisible({ timeout: TIMEOUTS.MODAL });
  }

  async fillCreateUserForm(data: { username: string; email: string; name: string }) {
    // MUI Joy Input wraps the <input> inside a div with the data-testid, so target the inner input.
    // Passwordless: the create-user form has no password field; the user signs in via OTC.
    await this.page.getByTestId('create-user-username-input').getByRole('textbox').fill(data.username);
    await this.page.getByTestId('create-user-email-input').getByRole('textbox').fill(data.email);
    await this.page.getByTestId('create-user-name-input').getByRole('textbox').fill(data.name);

    // Select the "Customer" tag (at least one tag is required for form validation)
    await this.page.getByTestId('create-user-tag-customer').click();
  }

  async submitCreateUser() {
    await this.page.getByTestId('create-user-submit-btn').click();
  }

  async waitForCreateUserSuccess() {
    // Closes on success with no toast, so wait for the modal to disappear.
    await expect(this.page.getByTestId('create-user-submit-btn')).toBeHidden({ timeout: TIMEOUTS.ACTION });
  }

  // --- User Row Actions ---

  /** Get the user row card containing the given user name */
  private getUserRow(name: string): Locator {
    return this.page.getByTestId('admin-user-card').filter({ has: this.page.getByTestId(`user-name-${name}`) });
  }

  async clickUserAdminButton(name: string) {
    const row = this.getUserRow(name);
    await row.getByTestId('admin-user-admin-btn').click();
    // Wait for FullUserViewModal to open
    await expect(this.page.getByTestId('full-user-view-modal')).toBeVisible({ timeout: TIMEOUTS.MODAL });
  }

  async clickUserProfileButton(name: string) {
    const row = this.getUserRow(name);
    await row.getByTestId('admin-user-profile-btn').click();
    // Wait for AdminProfileModal to open
    await expect(this.page.getByTestId('admin-profile-modal')).toBeVisible({ timeout: TIMEOUTS.MODAL });
  }

  // --- Login as User (FullUsersView) ---

  /** Open the target user's full view, then click "Login as User". */
  async clickLoginAs(name: string) {
    await this.clickUserAdminButton(name);
    await this.page.getByTestId('login-as-user-btn').click();
  }

  /** Assert the TOTP-token modal opened (proves the acting admin's mfa.totpEnabled was projected into currentUser). */
  async expectLoginAsMfaModal() {
    await expect(this.page.getByTestId('login-as-mfa-modal')).toBeVisible({ timeout: TIMEOUTS.MODAL });
  }

  async fillLoginAsMfa(code: string) {
    await this.fillMuiInput(this.page.getByTestId('login-as-mfa-input').locator('input'), code);
  }

  async confirmLoginAs() {
    const confirmBtn = this.page.getByTestId('login-as-mfa-confirm-btn');
    await expect(confirmBtn).toBeEnabled({ timeout: TIMEOUTS.ELEMENT_STATE });
    await confirmBtn.click();
  }

  // --- Edit User Profile (AdminProfileModal) ---

  async fillProfileField(label: string, value: string) {
    const input = this.getProfileFieldByLabel(label);
    await input.clear();
    if (value) {
      await input.fill(value);
    }
  }

  async saveProfileChanges() {
    const saveBtn = this.page.getByTestId('profile-save-btn');
    await saveBtn.click();
    // Wait for save to complete (button re-enables after API response)
    await expect(saveBtn).toBeEnabled({ timeout: TIMEOUTS.ACTION });
  }

  async closeModal() {
    await this.page.getByTestId('modal-close-btn').click();
    await expect(this.page.getByTestId('modal-close-btn')).toBeHidden({ timeout: TIMEOUTS.ELEMENT_STATE });
  }

  // --- Delete User (SpicyUserActions) ---

  async typeDeleteConfirmation() {
    await this.page.getByTestId('delete-user-confirm-input').getByRole('textbox').fill('DELETE');
  }

  async clickDeleteUserButton() {
    await this.page.getByTestId('delete-user-btn').click();
  }

  async confirmDeleteUser() {
    await this.page.getByTestId('confirm-delete-btn').click();
    // Wait for the confirm button itself to disappear (the delete modal closed)
    await expect(this.page.getByTestId('confirm-delete-btn')).toBeHidden({ timeout: TIMEOUTS.ACTION });
    // Dismiss any follow-up modal (e.g. "User not found" error) if it appears
    const closeBtn = this.page.getByTestId('modal-close-btn');
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click();
      await expect(closeBtn).toBeHidden({ timeout: TIMEOUTS.ELEMENT_STATE });
    }
  }

  // --- Invite Codes ---

  async openCreateInviteModal() {
    await this.page.getByTestId('invite-create-btn').click();
    await expect(this.page.getByTestId('create-invite-modal')).toBeVisible({ timeout: TIMEOUTS.MODAL });
  }

  async submitCreateInvite() {
    // The form defaults to 1 invite, so just submit.
    await this.page.getByTestId('create-invite-submit-btn').click();
    await expect(this.page.getByTestId('create-invite-modal')).toBeHidden({ timeout: TIMEOUTS.ACTION });
  }

  async getFirstInviteCode(): Promise<string> {
    // Invite codes (e.g. "B962-4D8E-C2AB-89BB") are inside a "Click to Copy" tooltip wrapper
    // Match the first text that looks like a 4-group hex code
    const codeLocator = this.page.getByTestId('invite-code-value').first();
    await expect(codeLocator).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    const code = await codeLocator.innerText();
    return code.trim();
  }

  /** Parse the count from the "Available (N)" tab text */
  async getAvailableCount(): Promise<number> {
    const tab = this.page.getByTestId('invite-available-tab');
    const text = await tab.innerText();
    return parseInt(text.match(/\d+/)?.[0] || '0');
  }

  /** Parse the count from the "Used (N)" tab text */
  async getUsedCount(): Promise<number> {
    const tab = this.page.getByTestId('invite-used-tab');
    const text = await tab.innerText();
    return parseInt(text.match(/\d+/)?.[0] || '0');
  }

  /** Poll until Available count equals the expected value */
  async waitForAvailableCount(expected: number) {
    const tab = this.page.getByTestId('invite-available-tab');
    await expect
      .poll(
        async () => {
          const text = await tab.innerText();
          return parseInt(text.match(/\d+/)?.[0] || '0');
        },
        { timeout: TIMEOUTS.ACTION, message: `Expected Available count to be ${expected}` }
      )
      .toBe(expected);
  }

  /** Poll until Used count equals the expected value */
  async waitForUsedCount(expected: number) {
    const tab = this.page.getByTestId('invite-used-tab');
    await expect
      .poll(
        async () => {
          const text = await tab.innerText();
          return parseInt(text.match(/\d+/)?.[0] || '0');
        },
        { timeout: TIMEOUTS.ACTION, message: `Expected Used count to be ${expected}` }
      )
      .toBe(expected);
  }

  /** Delete a specific invite code by finding its row and clicking the delete button */
  async deleteInviteByCode(code: string) {
    const row = this.page.getByTestId('invite-code-card').filter({ hasText: code });
    await expect(row).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    const deleteBtn = row.getByTestId('delete-invite-code-btn');
    await deleteBtn.click();
    await this.waitForResponseOrUI(
      resp => resp.url().includes('/api/reg-invites') && resp.request().method() === 'DELETE' && resp.ok(),
      () => expect(row).toBeHidden({ timeout: TIMEOUTS.ACTION })
    );
  }

  async refreshInvites() {
    await this.page.getByTestId('invite-codes-refresh-btn').click();
    await this.waitForResponseOrUI(
      resp => resp.url().includes('/api/reg-invites') && resp.request().method() === 'GET' && resp.ok(),
      () => expect(this.page.getByTestId('invite-codes-refresh-btn')).toBeEnabled({ timeout: TIMEOUTS.ACTION })
    );
  }
}
