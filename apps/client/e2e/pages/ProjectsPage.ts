import { expect } from '@playwright/test';
import { TIMEOUTS } from '../constants';
import { BasePage } from './BasePage';

export class ProjectsPage extends BasePage {
  /** Navigate directly to /projects via URL */
  async gotoProjects() {
    await this.page.goto('/projects');
    await this.page.waitForLoadState('domcontentloaded');
    await this.dismissModals();
    await this.waitForProjectsReady();
  }

  async navigateToProjects() {
    // Projects is an earned-nav destination (Gears): the sidenav row is hidden until
    // the account has a project. Navigate directly (like gotoProjects), robust to
    // earned state - matches how a first-time user reaches it via the Gears CTA.
    await this.gotoProjects();
  }

  /** Wait for project list to be fully loaded */
  private async waitForProjectsReady() {
    await expect(this.page.getByTestId('new-project-btn')).toBeVisible({
      timeout: TIMEOUTS.NAVIGATION,
    });
  }

  async createProject(name: string, description: string) {
    await this.page.getByTestId('new-project-btn').click();

    const form = this.page.getByTestId('create-project-form-container');
    await expect(form).toBeVisible({ timeout: TIMEOUTS.MODAL });

    await form.getByTestId('name-input').getByRole('textbox').fill(name);
    await form.getByTestId('description-textarea').locator('textarea').first().fill(description);

    await this.page.getByTestId('create-project-submit-btn').click();
    await this.waitForResponseOrUI(
      resp => resp.url().includes('/api/projects') && resp.request().method() === 'POST' && resp.ok(),
      () => expect(form).toBeHidden({ timeout: TIMEOUTS.VISIBLE })
    );
  }

  async openProject(name: string) {
    const card = this.page
      .getByTestId('project-card')
      .filter({ has: this.page.getByTestId('project-card-name').filter({ hasText: name }) });
    await card.first().click();
    await this.page.waitForURL(/\/projects\/.+/);
    await expect(this.page.getByTestId('project-tab-list')).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
  }

  async openProjectCardMenu(name: string) {
    const card = this.page
      .getByTestId('project-card')
      .filter({ has: this.page.getByTestId('project-card-name').filter({ hasText: name }) })
      .first();

    // Menu button is hidden until hover
    await card.hover();

    const menuButton = card.getByTestId('project-card-menu-btn');
    await menuButton.click({ force: true });
  }

  async renameProject(oldName: string, newName: string) {
    await this.openProjectCardMenu(oldName);
    await this.page.getByTestId('project-card-menu-edit-item').click();

    const form = this.page.getByTestId('project-edit-modal-form');
    await expect(form).toBeVisible({ timeout: TIMEOUTS.MODAL });

    const nameInput = form.getByTestId('name-input').getByRole('textbox');
    await nameInput.clear();
    await nameInput.fill(newName);

    await this.page.getByTestId('update-project-btn').click();

    await this.waitForToast('Project updated successfully');
  }

  async deleteProject(name: string) {
    await this.openProjectCardMenu(name);
    await this.page.getByTestId('project-card-menu-delete-item').click();

    // Confirmation modal uses okLabel='Delete'
    const confirmBtn = this.page.getByTestId('confirmation-modal-confirm-btn');
    await expect(confirmBtn).toBeVisible({ timeout: TIMEOUTS.MODAL });
    await confirmBtn.click();

    await this.waitForToast('Project deleted successfully');
  }

  async clickTab(tabName: string) {
    // Map tab names to their data-testid values
    const baseName = tabName.replace(/s$/i, '').toLowerCase();
    const tabTestIdMap: Record<string, string> = {
      notebook: 'project-tab-notebooks',
      'project file': 'project-tab-files',
      member: 'project-tab-members',
      'system prompt': 'project-tab-system-prompts',
    };
    const testId = tabTestIdMap[baseName] || `project-tab-${baseName}s`;
    const tab = this.page.getByTestId(testId);
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: TIMEOUTS.ELEMENT_STATE });
  }

  async addNotebook(notebookName: string) {
    await this.page.getByTestId('project-add-notebooks-btn').click();

    const modal = this.page.getByTestId('generic-add-items-modal');
    await expect(modal).toBeVisible({ timeout: TIMEOUTS.MODAL });

    // Wait for items to load then select the matching notebook
    const item = modal.getByTestId('generic-add-items-item').filter({ hasText: notebookName });
    await expect(item.first()).toBeVisible({ timeout: TIMEOUTS.ACTION });
    await item.first().click();

    await modal.getByTestId('generic-add-items-submit-btn').click();

    await this.waitForToast('Sessions added to project successfully');
  }

  async createNotebookInProject() {
    await this.page.getByTestId('project-add-notebooks-btn').click();

    const modal = this.page.getByTestId('generic-add-items-modal');
    await expect(modal).toBeVisible({ timeout: TIMEOUTS.MODAL });

    // Click the "Create" link which navigates to new chat with projectId
    await modal.getByTestId('project-create-notebook-link').click();
    await this.page.waitForURL(/\/new/);
    await this.page.waitForLoadState('domcontentloaded');
  }

  async addFileViaFileBrowser(filename: string) {
    await this.page.getByTestId('project-file-browser-btn').click();

    const modal = this.page.getByTestId('file-browser-modal');
    await expect(modal).toBeVisible({ timeout: TIMEOUTS.MODAL });

    // Click the file card/row that contains the filename to select it
    const fileCard = modal.getByTestId('file-browser-grid-item-card').filter({ hasText: filename });
    const fileListItem = modal.getByTestId('file-browser-list-item').filter({ hasText: filename });
    const fileTarget = fileCard.or(fileListItem);
    await expect(fileTarget.first()).toBeVisible({ timeout: TIMEOUTS.ACTION });
    await fileTarget.first().click();

    const addBtn = modal.getByTestId('file-browser-bulk-add-btn');
    await expect(addBtn).toBeVisible({ timeout: TIMEOUTS.ACTION });
    await addBtn.click();
  }

  async addMember(searchTerm: string) {
    await this.page.getByTestId('project-add-members-btn').click();

    const modal = this.page.getByTestId('generic-add-items-modal');
    await expect(modal).toBeVisible({ timeout: TIMEOUTS.MODAL });

    // Search for the user
    const searchInput = modal.getByTestId('generic-add-items-search-input').getByRole('textbox');
    await searchInput.fill(searchTerm);

    // Search results come from either the API or cache
    const item = modal.getByTestId('generic-add-items-item');
    await this.waitForResponseOrUI(
      resp => resp.url().includes('/api/users') && resp.request().method() === 'GET' && resp.ok(),
      () => expect(item.first()).toBeVisible({ timeout: TIMEOUTS.ACTION })
    );

    // Click the item and verify selection registered. The debounced search can
    // trigger a re-fetch that replaces items with a loading spinner, causing
    // clicks to land on stale elements. Retry until the submit button reflects
    // the selection (e.g. "Add 1 items" instead of "Add 0 items").
    const submitBtn = modal.getByTestId('generic-add-items-submit-btn');
    await expect(async () => {
      await item.first().click();
      await expect(submitBtn).toContainText(/Add 1/i, { timeout: 1_000 });
    }).toPass({ timeout: TIMEOUTS.ACTION });

    await submitBtn.click();

    await this.waitForToast('Sent an invite');
  }

  async addSystemPromptViaFileBrowser(filename: string) {
    // Same pattern as addFileViaFileBrowser but on the System Prompts tab
    await this.addFileViaFileBrowser(filename);
    await this.waitForToast('System prompts added successfully');
  }

  async viewSystemPrompt() {
    const viewButton = this.page.getByTestId('project-system-prompt-item-view-btn');
    await expect(viewButton.first()).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await viewButton.first().click();
  }

  async deleteSystemPrompt() {
    const menuButton = this.page.getByTestId('project-system-prompt-item-menu-btn');
    await expect(menuButton.first()).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await menuButton.first().click();

    await this.page
      .getByTestId('project-system-prompt-item-menu-item')
      .filter({ hasText: /delete/i })
      .first()
      .click();

    const confirmBtn = this.page.getByTestId('confirmation-modal-confirm-btn');
    await expect(confirmBtn).toBeVisible({ timeout: TIMEOUTS.MODAL });
    await confirmBtn.click();

    await this.waitForToast('System prompt removed successfully');
  }

  async closeModal() {
    // Try generic-add-items close button first, then knowledge modal close button
    const genericCloseBtn = this.page.getByTestId('generic-add-items-close-btn');
    const knowledgeCloseBtn = this.page.getByTestId('knowledge-modal-close-btn');
    const closeBtn = genericCloseBtn.or(knowledgeCloseBtn);
    if ((await closeBtn.count()) > 0) {
      await closeBtn.first().click({ force: true });
    }
  }

  async openInbox() {
    await this.page.getByTestId('profile-menu-card').click();
    // Inbox now lives in the "More" flyout of the profile menu.
    await this.page.getByTestId('profile-menu-more').click();
    await this.page.getByTestId('profile-more-inbox').click();
    // Wait for the drawer to open - Invites tab is always visible in the inbox header
    await expect(this.page.getByRole('tab').filter({ hasText: /Invites/i })).toBeVisible({
      timeout: TIMEOUTS.MODAL,
    });
  }

  async closeInboxDrawer() {
    await this.page.keyboard.press('Escape');
  }

  /** Open inbox, switch to Invites tab, and accept the first project invite. */
  async acceptProjectInvite() {
    await this.page
      .getByRole('tab')
      .filter({ hasText: /Invites/i })
      .click();

    const acceptBtn = this.page.getByTestId('invite-accept-btn').first();
    await expect(acceptBtn).toBeVisible({ timeout: TIMEOUTS.ACTION });
    await acceptBtn.click();
    await this.waitForToast('Successfully joined the project');
  }

  /** Verify notebook and system prompt are visible in the shared project. */
  async validateSharedProjectContent(notebookName: string) {
    await this.clickTab('Notebooks');
    await expect(this.page.getByText(notebookName, { exact: false }).first()).toBeVisible({
      timeout: TIMEOUTS.VISIBLE,
    });

    // Verify at least one system prompt is present via the tab label count
    const systemPromptsTab = this.page.getByTestId('project-tab-system-prompts');
    await expect(systemPromptsTab).toContainText(/\([1-9]\d*\)/, { timeout: TIMEOUTS.VISIBLE });
  }
}
