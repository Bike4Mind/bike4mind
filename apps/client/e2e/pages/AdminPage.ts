import { type Locator, type Response, expect } from '@playwright/test';
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
      try {
        // Bound the click so a stuck menu-open (unbounded stability check) fails fast into the
        // retry rather than hanging; keeping it inside the try lets a throw retry too.
        await this.page.getByTestId('profile-menu-card').click({ timeout: TIMEOUTS.ELEMENT_STATE });
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

  /** Wait for admin navigation without assuming a particular active tab. */
  private async waitForAdminReady() {
    await this.closeFloatingChat();
    const navigation = this.page
      .getByTestId('admin-dashboard-tab-btn')
      .or(this.page.getByTestId('admin-mobile-menu-btn'))
      .filter({ visible: true })
      .first();
    await expect(navigation).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
    await expect(navigation).toBeEnabled({ timeout: TIMEOUTS.ACTION });
  }

  /** The sidebar has no accordions now; on a phone the drawer must be opened to reach any item. */
  private async expandUserOps() {
    const usersLink = this.page.getByTestId('admin-users-tab-btn').filter({ visible: true }).first();
    if (!(await usersLink.isVisible())) {
      await this.page.getByTestId('admin-mobile-menu-btn').click();
    }
    await expect(usersLink).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
  }

  async navigateToUsersTab() {
    await this.expandUserOps();
    await this.page.getByTestId('admin-users-tab-btn').filter({ visible: true }).first().click();
    await expect(this.page.getByTestId('admin-users-search-input')).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await this.waitForUsersLoaded();
  }

  /** The users table renders skeleton rows while a page is fetching. */
  private async waitForUsersLoaded() {
    await expect(this.page.getByTestId('admin-table-skeleton-row')).toHaveCount(0, { timeout: TIMEOUTS.ACTION });
  }

  private isUsersListResponse(resp: Response) {
    return resp.url().includes('/api/admin/users?') && resp.request().method() === 'GET' && resp.ok();
  }

  async navigateToOrganizationsTab() {
    await this.expandUserOps();
    await this.page.getByTestId('admin-organizations-tab-btn').filter({ visible: true }).first().click();
    await expect(this.page.getByTestId('admin-organizations-search-input')).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
  }

  async navigateToInviteCenter() {
    await this.expandUserOps();
    await this.page.getByTestId('admin-invite-center-tab-btn').filter({ visible: true }).first().click();
    await expect(this.page.getByTestId('invite-center-codes-tab')).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
  }

  async switchToInviteCodesTab() {
    await this.page.getByTestId('invite-center-codes-tab').click();
  }

  // --- User Search ---

  async searchUser(query: string) {
    const searchInput = this.page.getByTestId('admin-users-search-input');
    await searchInput.clear();
    await searchInput.fill(query);
    await this.waitForResponseOrUI(
      resp => this.isUsersListResponse(resp) && resp.url().includes('search='),
      () => this.waitForUsersLoaded()
    );
    await this.waitForUsersLoaded();
  }

  async isUserVisible(name: string): Promise<boolean> {
    return await this.getUserRow(name)
      .isVisible()
      .catch(() => false);
  }

  async waitForUserVisible(name: string) {
    await expect(this.getUserRow(name)).toBeVisible({ timeout: TIMEOUTS.ACTION });
  }

  // --- Sort ---

  /** Click a sortable column header; each click flips the direction. */
  async sortByColumn(columnId: 'user' | 'signedUp' | 'lastActive' | 'credits') {
    // The floating AI chat can re-open and overlay the table header, intercepting pointer events.
    await this.closeFloatingChat();
    await this.page.getByTestId(`admin-table-sort-${columnId}-btn`).click();
    await this.waitForResponseOrUI(
      resp => this.isUsersListResponse(resp),
      () => this.waitForUsersLoaded()
    );
    await this.waitForUsersLoaded();
  }

  // --- Create User ---

  async openCreateUserModal() {
    await this.page.getByTestId('admin-users-create-btn').click();
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

  /** The users table row whose text contains the given name or email. */
  getUserRow(text: string): Locator {
    return this.page.locator('tr[data-testid^="admin-users-row-"]').filter({ hasText: text });
  }

  /**
   * Opens the /admin/users/$userId profile page by activating the row from the keyboard: at 1280x720
   * the Users page header (signups chart, filters) leaves the scrolling list almost no height, so the
   * bottom pager covers the row and a pointer click never lands.
   */
  async openUserProfile(name: string) {
    const row = this.getUserRow(name);
    await row.focus();
    await row.press('Enter');
    await expect(this.page.getByTestId('user-profile-view')).toBeVisible({ timeout: TIMEOUTS.MODAL });
  }

  /** Pick an action from the profile header's More menu. */
  private async clickProfileMenuItem(action: 'loginAs' | 'delete') {
    await this.page.getByTestId('user-profile-more-btn').click();
    await this.page.getByTestId(`user-profile-menu-${action}-item`).click();
  }

  async clickUserProfileButton(name: string) {
    await this.openUserProfile(name);
    await this.page.getByTestId('admin-user-profile-btn').click();
    await expect(this.page.getByTestId('admin-profile-modal')).toBeVisible({ timeout: TIMEOUTS.MODAL });
  }

  // --- Login as User (profile page) ---

  /** Open the target user's profile, then pick "Log in as user" from the More menu. */
  async clickLoginAs(name: string) {
    await this.openUserProfile(name);
    await this.clickProfileMenuItem('loginAs');
  }

  /**
   * Assert the dialog asks for the admin's TOTP code. LoginAsDialog renders the code input only
   * when the acting admin's mfa.totpEnabled was projected into currentUser.
   */
  async expectLoginAsMfaModal() {
    await expect(this.page.getByTestId('login-as-dialog-mfa-input')).toBeVisible({ timeout: TIMEOUTS.MODAL });
  }

  async fillLoginAsMfa(code: string) {
    await this.fillMuiInput(this.page.getByTestId('login-as-dialog-mfa-input'), code);
  }

  /** Confirm stays disabled until the audited reason meets ADMIN_ACTION_REASON_MIN_LENGTH. */
  async fillLoginAsReason(reason = 'E2E login-as regression guard') {
    await this.page.getByTestId('login-as-dialog-reason-input').fill(reason);
  }

  async confirmLoginAs() {
    const confirmBtn = this.page.getByTestId('login-as-dialog-confirm-btn');
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

  // --- Delete User (profile More menu) ---

  async clickDeleteUserButton() {
    await this.clickProfileMenuItem('delete');
  }

  /** The delete dialog asks for the account's email; read it from the dialog rather than the fixture. */
  async typeDeleteConfirmation() {
    const expected = await this.page.getByTestId('delete-user-dialog-typed-expected').innerText();
    await this.page.getByTestId('delete-user-dialog-typed-input').fill(expected);
  }

  /** The confirm-delete button stays disabled until the audited reason meets ADMIN_ACTION_REASON_MIN_LENGTH. */
  async fillDeleteReason(reason = 'E2E user CRUD cleanup') {
    await this.page.getByTestId('delete-user-dialog-reason-input').fill(reason);
  }

  async confirmDeleteUser() {
    await this.page.getByTestId('delete-user-dialog-confirm-btn').click();
    // Wait for the confirm button itself to disappear (the delete modal closed)
    await expect(this.page.getByTestId('delete-user-dialog-confirm-btn')).toBeHidden({ timeout: TIMEOUTS.ACTION });
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
