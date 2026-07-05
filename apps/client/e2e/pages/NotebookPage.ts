import { expect } from '@playwright/test';
import { TIMEOUTS } from '../constants';
import { BasePage } from './BasePage';

export class NotebookPage extends BasePage {
  async selectFirstSession() {
    await this.page.getByTestId('sidenav-item-session-btn').first().click();
  }

  async openSessionMenu() {
    const sessionItem = this.page.getByTestId('sidenav-item-session-btn').first();
    await sessionItem.hover();
    // Multiple menu buttons exist (header + each sidebar item); only the selected/hovered one is visible
    const menuButton = this.page.locator('[data-testid="sidenav-item-menu-btn"]:visible');
    await menuButton.first().click();
  }

  async renameSession(name: string) {
    await this.openSessionMenu();
    await this.page.getByTestId('sidenav-item-menuitem-rename').first().click();
    const renameContainer = this.page.getByTestId('sidenav-item-rename-input');
    const input = renameContainer.getByRole('textbox');
    await input.clear();
    await input.fill(name);
    await input.press('Enter');
  }

  async deleteSession() {
    await this.openSessionMenu();
    await this.page.getByTestId('sidenav-item-menuitem-delete').first().click();
    const modal = this.page.getByTestId('confirm-delete-modal');
    await modal.getByTestId('confirm-modal-confirm-btn').click();
    await this.waitForToast('Successfully deleted session');
  }

  async openSessionInfo() {
    await this.openSessionMenu();
    await this.page.getByTestId('sidenav-item-menuitem-viewinfo').first().click();
  }

  async addTag(tagName: string) {
    await this.page.getByTestId('session-metadata-tag-input').first().getByRole('textbox').fill(tagName);
    await this.page.getByTestId('session-metadata-tag-add-btn').first().click();
    await expect(this.page.getByTestId('session-metadata-tag').filter({ hasText: tagName })).toBeVisible({
      timeout: TIMEOUTS.VISIBLE,
    });
  }

  async closeSessionInfo() {
    await this.page.getByTestId('session-metadata-close-btn').first().click();
  }
}
