import { expect } from '@playwright/test';
import { BasePage } from './BasePage';
import { TIMEOUTS } from '../constants';

export class ProfilePage extends BasePage {
  /** Navigate directly to /profile via URL */
  async gotoProfile() {
    // Listen for the identify response before navigating - it carries user data
    // that triggers a useEffect reset in the profile form. Waiting ensures the
    // form won't overwrite fields we fill after opening it.
    const identifyPromise = this.page
      .waitForResponse(resp => resp.url().includes('/api/identify') && resp.ok())
      .catch(() => {});
    await this.page.goto('/profile');
    await this.page.waitForLoadState('domcontentloaded');
    await this.dismissModals();
    // "Checking security settings..." overlay runs an MFA enforcement check on every
    // navigation. It must clear before any profile content is interactive.
    await this.waitForLoaderToDisappear('mfa-enforcement-loading-message');
    await this.waitForLoaderToDisappear('profile-detail-loading');
    await this.waitForProfileReady();
    await identifyPromise;
  }

  async navigateToProfile() {
    await this.page.getByTestId('profile-menu-card').click();
    await this.page.getByTestId('profile-menu-profile').click();
    await this.page.waitForURL(/\/profile/, { timeout: TIMEOUTS.NAVIGATION });
    await this.waitForProfileReady();
  }

  /** Wait for the profile page to be fully loaded */
  private async waitForProfileReady() {
    await expect(this.page.getByTestId('profile-tab')).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
  }

  async clickTab(name: string) {
    const tab = this.page.getByTestId(`${name.toLowerCase()}-tab`);
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: TIMEOUTS.ELEMENT_STATE });
    // Wait for the Settings tab's dynamically-imported chunk to finish loading.
    // SettingsTabContent renders a LinearProgress (data-testid="settings-tab-loading")
    // until the JS bundle is fetched; interacting before it disappears races with mounting.
    if (name.toLowerCase() === 'settings') {
      await this.waitForLoaderToDisappear('settings-tab-loading');
    }
  }

  async clickEditProfile() {
    await this.page.getByTestId('profile-edit-btn').click({ timeout: TIMEOUTS.VISIBLE });
    // Wait for the Name field to render (first form field)
    await expect(this.getProfileFieldByLabel('Name:')).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
  }

  async fillField(label: string, value: string) {
    const input = this.getProfileFieldByLabel(label);
    // Use fillMuiInput to ensure React's onChange fires - MUI Joy controlled
    // inputs don't reliably respond to Playwright's fill() method.
    await this.fillMuiInput(input, value);
  }

  async getFieldValue(label: string): Promise<string> {
    return await this.getProfileFieldByLabel(label).inputValue();
  }

  /**
   * Select a dropdown option by label text.
   * The custom Select component renders as a combobox inside a Grid field container.
   * Click the combobox to open, then select the option from the listbox.
   */
  async selectDropdown(label: string, optionText: string) {
    const container = this.page
      .getByTestId('profile-form-field')
      .filter({ has: this.page.getByTestId('profile-form-label').getByText(label, { exact: true }) });
    const combobox = container.getByTestId('profile-form-select');
    await combobox.click();
    // getByRole kept: MUI Joy renders options in a DOM portal outside the component tree
    await this.page.getByRole('option', { name: optionText, exact: true }).click();
    // getByRole kept: MUI Joy renders listbox in a DOM portal outside the component tree
    await expect(this.page.getByRole('listbox')).toBeHidden({ timeout: TIMEOUTS.ELEMENT_STATE });
  }

  async getDropdownValue(label: string): Promise<string> {
    const container = this.page
      .getByTestId('profile-form-field')
      .filter({ has: this.page.getByTestId('profile-form-label').getByText(label, { exact: true }) });
    return await container.getByTestId('profile-form-select').innerText();
  }

  async saveProfile() {
    const saveBtn = this.page.getByTestId('profile-save-btn');
    const responsePromise = this.page.waitForResponse(
      resp => resp.url().includes('/api/users') && resp.request().method() === 'PUT' && resp.ok()
    );
    await saveBtn.click();

    await this.waitForToast('Profile updated successfully');
    await responsePromise;
  }

  /** Find the feature container by title and toggle its switch */
  async toggleFeature(featureTitle: string) {
    const toggle = this.getFeatureToggle(featureTitle);
    const currentState = await toggle.getAttribute('aria-checked');
    const expectedState = currentState === 'true' ? 'false' : 'true';
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', expectedState, { timeout: TIMEOUTS.ELEMENT_STATE });
  }

  async isFeatureEnabled(featureTitle: string): Promise<boolean> {
    const checked = await this.getFeatureToggle(featureTitle).getAttribute('aria-checked');
    return checked === 'true';
  }

  async isFeatureDisabledByAdmin(featureTitle: string): Promise<boolean> {
    const container = this.getFeatureContainer(featureTitle);
    const disabledReason = container.getByTestId('experimental-feature-disabled-reason');
    return await disabledReason.isVisible().catch(() => false);
  }

  async waitForFeaturesLoaded() {
    // Wait for the feature-flag fetch inside ExperimentalFeaturesTabContent to resolve.
    // experimental-feature-loading-text is rendered while useExperimentalFeatureSettings()
    // is in-flight; settings-tab-loading is the outer dynamic-import chunk placeholder
    // and is already handled by clickTab() before this is called.
    await this.waitForLoaderToDisappear('experimental-feature-loading-text');
    await expect(this.page.getByTestId('experimental-feature-container').first()).toBeVisible({
      timeout: TIMEOUTS.ACTION,
    });
  }

  private getFeatureContainer(featureTitle: string) {
    return this.page
      .getByTestId('experimental-feature-container')
      .filter({ has: this.page.getByTestId('experimental-feature-title').getByText(featureTitle, { exact: true }) });
  }

  /**
   * Locate a feature's toggle switch by role rather than testid. Each toggle's
   * data-testid is suffixed with its featureKey (experimental-feature-toggle-<key>),
   * so an exact testid match is brittle; SquareSlideToggle renders role="switch",
   * and there is exactly one per feature container.
   */
  private getFeatureToggle(featureTitle: string) {
    return this.getFeatureContainer(featureTitle).getByRole('switch');
  }
}
