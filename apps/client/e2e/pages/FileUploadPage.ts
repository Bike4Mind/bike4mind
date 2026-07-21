import { expect } from '@playwright/test';
import path from 'path';
import { TIMEOUTS } from '../constants';
import { BasePage } from './BasePage';

export class FileUploadPage extends BasePage {
  async uploadFile(filePath: string) {
    await this.page.getByTestId('attach-files-btn').click();
    await expect(this.page.getByTestId('upload-from-device-btn')).toBeVisible({ timeout: TIMEOUTS.ELEMENT_STATE });

    // Toggle "Notebook Context" switch if visible and not already checked
    const contextSwitch = this.page.getByTestId('notebook-context-switch');
    const isVisible = await contextSwitch.isVisible({ timeout: TIMEOUTS.POST_ACTION }).catch(() => false);
    if (isVisible) {
      const isChecked = await contextSwitch.isChecked().catch(() => false);
      if (!isChecked) {
        await contextSwitch.click();
      }
    }

    // Resolve file path relative to project root
    const resolvedPath = path.resolve(process.cwd(), filePath);

    // Set up file chooser listener BEFORE clicking upload button
    const fileChooserPromise = this.page.waitForEvent('filechooser');
    await this.page.getByTestId('upload-from-device-btn').click();
    const fileChooser = await fileChooserPromise;

    await fileChooser.setFiles(resolvedPath);
    // Wait for upload API or file thumbnail appearing in composer - whichever comes first
    const filename = path.basename(resolvedPath);
    const fileThumbnail = this.page.locator('[data-testid^="message-file-thumbnail-"]').filter({ hasText: filename });
    await this.waitForResponseOrUI(
      response => response.url().includes('createFabFile') && response.ok(),
      () =>
        expect(fileThumbnail).toBeVisible({
          timeout: TIMEOUTS.AI_RESPONSE,
        })
    );
  }

  async closeFileBrowser() {
    const dialog = this.page.getByTestId('file-browser-dialog');
    if (await dialog.isVisible().catch(() => false)) {
      await this.page.getByTestId('file-browser-close-btn').click();
      await expect(dialog).toBeHidden({ timeout: TIMEOUTS.POST_ACTION });
    }
  }

  async openFileBrowser() {
    // Close any existing dialog first so the composer is accessible.
    await this.closeFileBrowser();
    // Files Manager is deliberately NOT a sidenav destination (Gears-page-only), so
    // open the browser via the composer's attach menu. The browser is a global drawer
    // opened OVER the current page (e.g. the notebook the file is being added to), so
    // it must NOT be reached by navigating away.
    await this.page.getByTestId('attach-files-btn').click();
    const browserItem = this.page.getByTestId('add-from-file-browser-btn');
    await expect(browserItem).toBeVisible({ timeout: TIMEOUTS.ELEMENT_STATE });
    await browserItem.click();
  }

  async switchToListView() {
    await this.page.getByTestId('view-mode-list').getByRole('paragraph').click();
  }

  async sortByDateDescending() {
    const dateHeader = this.page.getByTestId('file-browser-sort-createdAt-btn');
    // First click activates createdAt sort (ascending by default)
    await dateHeader.click();
    // Wait for the button to become active before toggling to descending
    await expect(dateHeader).toHaveClass(/colorPrimary/, { timeout: TIMEOUTS.ELEMENT_STATE });
    // Second click toggles to descending
    await dateHeader.click();
  }

  async findFile(filename: string) {
    await this.waitForLoaderToDisappear('file-browser-loader');
    const searchInput = this.page.getByTestId('file-browser-search-input').getByRole('textbox');
    await searchInput.fill(filename);
    await this.waitForLoaderToDisappear('file-browser-loader');
    const file = this.page
      .getByTestId('file-browser-dialog')
      .getByTestId('file-browser-item-name')
      .filter({ hasText: filename })
      .first();
    await expect(file).toBeVisible({ timeout: TIMEOUTS.ACTION });
    return file;
  }

  /** Find the file-browser-list-item row containing the given filename */
  private findFileRow(filename: string) {
    return this.page.getByTestId('file-browser-list-item').filter({ hasText: filename }).first();
  }

  /** Click a file row to toggle selection, retrying if the selection doesn't register */
  private async selectFileRow(filename: string, actionBtnTestId: string) {
    const row = this.findFileRow(filename);
    await expect(row).toBeVisible({ timeout: TIMEOUTS.ELEMENT_STATE });

    const actionBtn = this.page.getByTestId(actionBtnTestId);
    // Retry click - row selection can fail if React re-renders between click and state update.
    // Bound the click (see renameFile): with no suite-level actionTimeout an unbounded click
    // would hang on the stability check instead of throwing, starving this retry loop.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await row.click({ timeout: TIMEOUTS.ELEMENT_STATE });
        await expect(actionBtn).toBeEnabled({ timeout: 2_000 });
        return;
      } catch {
        if (attempt === 3) throw new Error(`File row selection failed for "${filename}" after 3 attempts`);
      }
    }
  }

  async addFileToNotebook(filename: string) {
    await this.findFile(filename);
    await this.selectFileRow(filename, 'file-browser-add-files-btn');
    const addBtn = this.page.getByTestId('file-browser-add-files-btn');
    await addBtn.click();
  }

  async renameFile(oldName: string, newName: string) {
    const file = await this.findFile(oldName);
    // Each file row has a three-dot menu button
    const row = file.locator('xpath=ancestor::*[@data-testid="file-browser-list-item"]');
    const menuButton = row.getByTestId('file-browser-actions-menu-btn');
    const renameInput = this.page.getByTestId('file-browser-rename-input');
    const renameItem = this.page.getByTestId('file-browser-rename-item');

    // Menu items can be detached by React re-renders, or the click may not register.
    // Retry the full open-menu -> click-rename -> wait-for-input sequence.
    // Every click MUST carry an explicit timeout: the suite sets no `actionTimeout`, so an
    // unbounded click() waits forever for actionability. If a background list refetch re-renders
    // the row mid-click, the stability check never resolves and the click hangs until the whole
    // test times out - defeating this retry loop. A bounded click throws so the retry can fire.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await menuButton.click({ timeout: TIMEOUTS.ELEMENT_STATE });
        await renameItem.click({ timeout: TIMEOUTS.ELEMENT_STATE });
        await expect(renameInput).toBeVisible({ timeout: TIMEOUTS.POST_ACTION });
        break;
      } catch {
        if (attempt === 3) throw new Error('Failed to enter rename mode after retries');
        await this.page.keyboard.press('Escape').catch(() => {});
      }
    }

    const renameTextbox = renameInput.getByRole('textbox');
    await renameTextbox.clear({ timeout: TIMEOUTS.ELEMENT_STATE });
    await renameTextbox.fill(newName, { timeout: TIMEOUTS.ELEMENT_STATE });
    await this.page.getByTestId('file-browser-rename-save-btn').click({ timeout: TIMEOUTS.ELEMENT_STATE });
    // Wait for rename API or the inline input to disappear (rename complete)
    await this.waitForResponseOrUI(
      response =>
        /\/api\/files\/[a-f0-9]+$/.test(response.url()) && response.request().method() === 'PUT' && response.ok(),
      () => expect(renameInput).toBeHidden({ timeout: TIMEOUTS.ACTION })
    );
    // Wait for success toast to confirm rename completed and file list refreshed
    await expect(this.page.locator('[data-sonner-toast]').filter({ hasText: /renamed/i })).toBeVisible({
      timeout: TIMEOUTS.VISIBLE,
    });
  }

  async deleteFile(filename: string) {
    await this.findFile(filename);
    await this.selectFileRow(filename, 'file-browser-delete-btn');
    const deleteBtn = this.page.getByTestId('file-browser-delete-btn');
    await deleteBtn.click();
    const confirmBtn = this.page.getByTestId('confirmation-modal-confirm-btn');
    await confirmBtn.click();
    await expect(this.page.locator('[data-sonner-toast]').filter({ hasText: /deleted/i })).toBeVisible({
      timeout: TIMEOUTS.VISIBLE,
    });
  }

  async verifyFileInSidebar(filename: string) {
    await this.page.getByTestId('session-files-btn').click();
    await expect(this.page.getByTestId('session-file-list').getByText(filename, { exact: false })).toBeVisible({
      timeout: TIMEOUTS.VISIBLE,
    });
  }
}
