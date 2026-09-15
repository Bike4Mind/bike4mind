import { expect, type Locator } from '@playwright/test';
import { MODEL_SEARCH_DEBOUNCE_MS, TIMEOUTS } from '../constants';
import { BasePage } from './BasePage';

export class ModelSelectorPage extends BasePage {
  async openModelSelector() {
    await this.page.getByTestId('ai-settings-btn').first().click();
    // Wait for model list to finish loading (models + user data) before interacting.
    // The spinner may resolve instantly if data is cached, so also confirm at least
    // one model card is rendered as a reliable signal that the list is ready.
    await this.waitForLoaderToDisappear('model-selection-loading');
    const dialog = this.page.getByTestId('ai-settings-modal');
    await expect(dialog.locator('[data-testid^="model-card-"]').first()).toBeVisible({
      timeout: TIMEOUTS.AI_RESPONSE,
    });
  }

  async selectTextModel(modelName: string, options?: { disableSmartTools?: boolean }) {
    await this.openModelSelector();
    // Scope all interactions to the AI Settings dialog
    const dialog = this.page.getByTestId('ai-settings-modal');

    if (options?.disableSmartTools) {
      // Switch to "Fast" mode (no tools) BEFORE selecting model to avoid reset
      try {
        const fastOption = dialog.getByTestId('view-mode-fast').getByRole('paragraph');
        await fastOption.click({ timeout: TIMEOUTS.ELEMENT_STATE });
      } catch {
        // Fast toggle may not be available - skip
      }
    }

    await this.clickModelCardByExactName(dialog, modelName);
    await this.closeModelSelector();
  }

  /**
   * Returns the names of all *available* (selectable, not "Unavailable") model cards
   * matching the given search term, as they appear in the AI Settings modal.
   *
   * Typing into the search box expands every backend accordion (see ModelSelection's
   * expandedBackends), so this surfaces matching models across all providers in one read.
   * Unavailable models render with `data-disabled` on their card and are excluded. The
   * model name is the first `<p>` in each card (the body-md name Typography precedes the
   * body-xs description). Favourited models appear twice (Favorites + backend section),
   * so results are de-duplicated.
   */
  async getAvailableModelNames(searchTerm: string): Promise<string[]> {
    const [names] = await this.getAvailableModelNamesAcross([searchTerm]);
    return names;
  }

  /**
   * Like getAvailableModelNames but runs several searches within a SINGLE modal
   * open/close cycle (one bring-up instead of one per term). Returns one
   * de-duplicated name list per search term, in the same order as `searchTerms`.
   */
  async getAvailableModelNamesAcross(searchTerms: string[]): Promise<string[][]> {
    await this.openModelSelector();
    const dialog = this.page.getByTestId('ai-settings-modal');
    const searchInput = dialog.getByTestId('model-search-input').getByRole('textbox');
    const results: string[][] = [];
    for (const term of searchTerms) {
      // fill() replaces the prior term, so no explicit clear is needed between searches.
      await searchInput.fill(term);
      // Search uses a 500ms debounce - wait for it to settle before reading filtered results.
      await this.page.waitForTimeout(MODEL_SEARCH_DEBOUNCE_MS);
      const names = await dialog
        .locator('[data-testid^="model-card-"]:not([data-disabled])')
        .evaluateAll(cards => cards.map(card => card.querySelector('p')?.textContent?.trim() ?? '').filter(Boolean));
      results.push([...new Set(names)]);
    }
    await this.closeModelSelector();
    return results;
  }

  async selectImageModel(modelName: string) {
    await this.openModelSelector();
    const dialog = this.page.getByTestId('ai-settings-modal');
    // Switch to image models category via the filter dropdown
    await dialog.getByTestId('model-filter-select').getByRole('combobox').click();
    // Use getByRole instead of getByTestId - MUI Joy renders duplicate Option elements
    // in the DOM, causing strict mode violation with getByTestId('model-filter-option-image')
    await this.page.getByRole('option', { name: 'Image models' }).click({ timeout: TIMEOUTS.MODAL });
    await this.clickModelCardByExactName(dialog, modelName);
    await this.closeModelSelector();
  }

  /**
   * Search for and click a model card by EXACT name within the open AI Settings dialog.
   *
   * Matching on the exact child text avoids the substring collision a plain hasText
   * filter hits when one name is a prefix of another - e.g. "GPT-Image-1" also matches
   * "GPT-Image-1.5" and "GPT-Image-1 Mini".
   *
   * Model cards live inside a nested overflow:auto scroll container inside the modal.
   * Playwright's coordinate-based click cannot reliably target elements in nested scroll
   * containers, so we use evaluate() to fire the DOM click directly.
   */
  private async clickModelCardByExactName(dialog: Locator, modelName: string) {
    const searchInput = dialog.getByTestId('model-search-input').getByRole('textbox');
    await searchInput.fill(modelName);
    // Search uses a 500ms debounce - wait for it to settle before asserting filtered results
    await this.page.waitForTimeout(MODEL_SEARCH_DEBOUNCE_MS);
    const modelCard = dialog
      .locator('[data-testid^="model-card-"]')
      .filter({ has: this.page.getByText(modelName, { exact: true }) })
      .first();
    await expect(modelCard).toBeVisible({ timeout: TIMEOUTS.ACTION });
    await modelCard.evaluate(el => (el as HTMLElement).click());
  }

  async closeModelSelector() {
    try {
      const closeBtn = this.page.getByTestId('ai-settings-close-btn');
      await closeBtn.click({ timeout: TIMEOUTS.ELEMENT_STATE });
    } catch {
      await this.page.keyboard.press('Escape');
    }
    await this.page.getByTestId('ai-settings-modal').waitFor({ state: 'hidden', timeout: TIMEOUTS.MODAL });
  }

  async disableSmartTools() {
    // Open the AI Settings dialog and switch to "Fast" mode (no tools)
    await this.openModelSelector();
    try {
      const fastOption = this.page.getByTestId('view-mode-fast').getByRole('paragraph');
      await fastOption.click({ timeout: TIMEOUTS.ELEMENT_STATE });
    } catch {
      // Fast toggle may not exist - skip
    }
    await this.closeModelSelector();
  }

  async verifyModelSelected(modelName: string) {
    await expect(this.page.getByText(modelName, { exact: false }).first()).toBeVisible();
  }
}
