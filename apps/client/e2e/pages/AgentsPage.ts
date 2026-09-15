import { expect } from '@playwright/test';
import { TIMEOUTS } from '../constants';
import { BasePage } from './BasePage';

export class AgentsPage extends BasePage {
  /** Navigate directly to /agents via URL - fast, skips UI navigation */
  async gotoAgents() {
    await this.page.goto('/agents');
    await this.page.waitForLoadState('domcontentloaded');
    await this.dismissModals();
    await this.waitForAgentsReady();
  }

  /** Navigate to agents list (alias kept for backward compat with other specs) */
  async navigateToAgents() {
    await this.gotoAgents();
  }

  /** Navigate directly to /agents/new via URL */
  async gotoCreateAgent() {
    await this.page.goto('/agents/new');
    await this.page.waitForLoadState('domcontentloaded');
    await this.dismissModals();
    await expect(this.page.getByTestId('agent-page-heading')).toBeVisible({
      timeout: TIMEOUTS.VISIBLE,
    });
  }

  async navigateToCreateAgent() {
    await this.gotoCreateAgent();
  }

  /** Wait for the agents list page to be fully loaded */
  private async waitForAgentsReady() {
    // Wait for the page heading to confirm we're on the agents page
    await expect(this.page.getByTestId('agent-page-heading')).toBeVisible({
      timeout: TIMEOUTS.NAVIGATION,
    });
  }

  async selectProject(projectName: string) {
    // Project field is hidden in simple mode - switch to Full Custom first if needed
    const switchBtn = this.page.getByTestId('agent-form-switch-to-custom');
    if (await switchBtn.isVisible()) {
      await switchBtn.click();
    }
    const projectSelect = this.page.getByTestId('agent-form-project');
    await expect(projectSelect).toBeVisible({ timeout: TIMEOUTS.ELEMENT_STATE });
    await projectSelect.click();
    await this.page.getByRole('option', { name: projectName }).click();
  }

  async createAgent(options: { name: string; description: string; projectName: string; triggerWord?: string }) {
    const nameInput = this.page.getByTestId('agent-form-name').getByRole('textbox');
    await nameInput.fill(options.name);

    const descriptionInput = this.page.getByTestId('agent-form-description').locator('textarea').first();
    await descriptionInput.fill(options.description);

    await this.selectProject(options.projectName);

    if (options.triggerWord) {
      await this.addTriggerWord(options.triggerWord);
    }

    // Submit form - two buttons share this testid (top + bottom), use first()
    const submitBtn = this.page.getByTestId('agent-form-submit').first();
    await expect(submitBtn).toBeEnabled({ timeout: TIMEOUTS.ACTION });
    await submitBtn.click();

    await this.waitForToast('Agent created successfully!');
  }

  async addTriggerWord(word: string) {
    const triggerInput = this.page.getByTestId('agent-form-trigger-word').getByRole('textbox');
    await triggerInput.fill(word);
    await this.page.getByTestId('agent-form-trigger-word-add').click();
  }

  async openAgent(name: string) {
    const agentCard = this.page.getByTestId('agent-card-name').filter({ hasText: name });
    await expect(agentCard.first()).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await agentCard.first().click();
    await this.page.waitForURL(/\/agents\/.+/);
    await expect(this.page.getByTestId('agent-view-name')).toBeVisible({
      timeout: TIMEOUTS.VISIBLE,
    });
  }

  async editAgent(updates: { name?: string; description?: string }) {
    const editBtn = this.page.getByTestId('agent-edit-btn');
    await expect(editBtn.first()).toBeVisible({ timeout: TIMEOUTS.ACTION });
    await editBtn.first().click();
    await this.page.waitForURL(/\/agents\/.+\/edit/);
    await expect(this.page.getByTestId('agent-form-name')).toBeVisible({ timeout: TIMEOUTS.VISIBLE });

    if (updates.name) {
      const nameInput = this.page.getByTestId('agent-form-name').getByRole('textbox');
      await nameInput.clear();
      await nameInput.fill(updates.name);
    }

    if (updates.description) {
      const descInput = this.page.getByTestId('agent-form-description').locator('textarea').first();
      await descInput.clear();
      await descInput.fill(updates.description);
    }

    // Set step="any" on number inputs to avoid browser validation issues
    // (e.g. Max Tokens default 4000 is invalid with step=100, min=1)
    await this.page.evaluate(() => {
      document.querySelectorAll('input[type="number"]').forEach(i => i.setAttribute('step', 'any'));
    });

    // Save changes - two buttons share this testid (top + bottom), use first()
    const saveBtn = this.page.getByTestId('agent-form-submit').first();
    await expect(saveBtn).toBeEnabled({ timeout: TIMEOUTS.ACTION });
    await saveBtn.click();

    await this.waitForToast('Agent updated successfully!');
  }

  async deleteAgentFromView() {
    const menuBtn = this.page.getByTestId('agent-view-menu-btn');
    await expect(menuBtn).toBeVisible({ timeout: TIMEOUTS.ACTION });
    await menuBtn.click();

    const deleteItem = this.page.getByTestId('agent-delete-menu-item');
    await expect(deleteItem).toBeVisible({ timeout: TIMEOUTS.MODAL });
    await deleteItem.click();

    const dialog = this.page.getByTestId('confirmation-dialog');
    await expect(dialog).toBeVisible({ timeout: TIMEOUTS.MODAL });
    await this.page.getByTestId('confirmation-confirm-btn').click();

    await this.waitForToast('Agent deleted successfully');
  }

  async verifyAgentExists(name: string) {
    await expect(this.page.getByTestId('agent-card-name').filter({ hasText: name }).first()).toBeVisible({
      timeout: TIMEOUTS.VISIBLE,
    });
  }

  async verifyAgentNotExists(name: string) {
    await expect(this.page.getByTestId('agent-card-name').filter({ hasText: name })).toBeHidden({
      timeout: TIMEOUTS.VISIBLE,
    });
  }
}
