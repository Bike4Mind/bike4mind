import { expect, type Locator, type Page } from '@playwright/test';
import { TIMEOUTS } from '../constants';
import { BasePage } from './BasePage';

/**
 * Page object for the Data Lakes surface: the `/data-lakes` explorer, the management
 * panel (list + lifecycle), the create/append wizard, the settings modal, and the
 * lake viewer. Selectors mirror the data-testid attributes in
 * `app/components/datalake/*` and `app/components/DataLakeWizard/*`.
 */
export class DataLakePage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  // ── Explorer / manager ──────────────────────────────────────────────────
  get manageBtn(): Locator {
    return this.page.getByTestId('datalake-manage-btn');
  }
  get listPanel(): Locator {
    return this.page.getByTestId('datalake-list-panel');
  }
  get createBtn(): Locator {
    return this.listPanel.getByRole('button', { name: 'Create' });
  }

  // ── Wizard ────────────────────────────────────────────────────────────────
  get wizardModal(): Locator {
    return this.page.getByTestId('data-lake-wizard-modal');
  }
  get wizardSourceStep(): Locator {
    return this.page.getByTestId('wizard-source-step');
  }
  get wizardNextBtn(): Locator {
    return this.page.getByTestId('wizard-next-btn');
  }
  get wizardStartUploadBtn(): Locator {
    return this.page.getByTestId('wizard-start-upload-btn');
  }
  get wizardStepIndicator(): Locator {
    return this.page.getByTestId('wizard-step-indicator');
  }
  get selectFilesInput(): Locator {
    // The two hidden inputs are the folder input (first) and the plain multi-file input (last).
    return this.wizardSourceStep.locator('input[type="file"]').last();
  }

  // ── Settings modal ──────────────────────────────────────────────────────
  get settingsModal(): Locator {
    return this.page.getByTestId('datalake-settings-modal');
  }

  // ── Viewer ─────────────────────────────────────────────────────────────
  get viewer(): Locator {
    return this.page.getByTestId('datalake-viewer');
  }
  get viewerSearch(): Locator {
    return this.viewer.getByPlaceholder('Filter...');
  }
  /** The tag tree scoped to the viewer modal (the explorer behind it renders its own). */
  get viewerTree(): Locator {
    return this.viewer.getByTestId('datalake-tree');
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  /** Open the `/data-lakes` explorer home and clear startup modals. */
  async gotoDataLakes() {
    await this.page.goto('/data-lakes');
    await this.dismissModals();
    await expect(this.page.getByTestId('opti-datalake-explorer')).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
  }

  /** From the explorer, open the management panel (list of lakes + lifecycle). */
  async openManager() {
    await this.manageBtn.click();
    await expect(this.listPanel).toBeVisible({ timeout: TIMEOUTS.MODAL });
  }

  /** Convenience: land on `/data-lakes` and open the manager panel. */
  async openManagerFromHome() {
    await this.gotoDataLakes();
    await this.openManager();
  }

  // ── Card lookups (by lake id) ────────────────────────────────────────────
  card(id: string): Locator {
    return this.page.getByTestId(`datalake-card-${id}`);
  }
  addFilesBtn(id: string): Locator {
    return this.page.getByTestId(`datalake-addfiles-btn-${id}`);
  }
  settingsBtn(id: string): Locator {
    return this.page.getByTestId(`datalake-settings-btn-${id}`);
  }
  archiveBtn(id: string): Locator {
    return this.page.getByTestId(`datalake-archive-btn-${id}`);
  }

  // ── Wizard flows ──────────────────────────────────────────────────────────

  /** Open the create wizard from the manager panel. */
  async startCreate() {
    await this.createBtn.click();
    await expect(this.wizardModal).toBeVisible({ timeout: TIMEOUTS.MODAL });
    await expect(this.wizardSourceStep).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
  }

  /** Open the append ("Add files") wizard for an existing lake. */
  async startAppend(id: string) {
    await this.addFilesBtn(id).click();
    await expect(this.wizardModal).toBeVisible({ timeout: TIMEOUTS.MODAL });
  }

  /** Attach files to the wizard's plain (non-folder) file input. */
  async selectFiles(filePaths: string[]) {
    await this.selectFilesInput.setInputFiles(filePaths);
  }

  async wizardNext() {
    await expect(this.wizardNextBtn).toBeEnabled({ timeout: TIMEOUTS.ELEMENT_STATE });
    await this.wizardNextBtn.click();
  }

  // ── Wizard step content ──────────────────────────────────────────────────
  get configStep(): Locator {
    return this.page.getByTestId('wizard-config-step');
  }
  get taxonomyStep(): Locator {
    return this.page.getByTestId('wizard-taxonomy-step');
  }
  get uploadStep(): Locator {
    return this.page.getByTestId('wizard-upload-step');
  }
  get configNameInput(): Locator {
    return this.page.getByTestId('config-name-input').locator('input');
  }
  /** Config-step inputs have no testids; locate them by placeholder within the config step. */
  get configTagPrefixInput(): Locator {
    return this.configStep.getByPlaceholder('e.g. legal:');
  }
  get configAccessTagInput(): Locator {
    return this.configStep.getByPlaceholder('e.g. LegalTeam');
  }
  get configEntitlementInput(): Locator {
    return this.configStep.getByPlaceholder('e.g. product:pro');
  }
  get taxonomyTagCards(): Locator {
    return this.taxonomyStep.getByTestId('taxonomy-tag-card');
  }

  /**
   * Click Next until the Config step is reached. Handles the Taxonomy step, whose Next stays
   * disabled until AI analysis completes (waited for with the AI_RESPONSE budget), and the
   * Preview step (auto-skipped for flat file selections).
   */
  async advanceToConfig() {
    for (let i = 0; i < 6; i++) {
      if (await this.configStep.isVisible().catch(() => false)) return;
      await expect(this.wizardNextBtn).toBeEnabled({ timeout: TIMEOUTS.AI_RESPONSE });
      await this.wizardNextBtn.click();
    }
    await expect(this.configStep).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
  }

  /** Wait for the taxonomy step's AI analysis to finish (tag cards rendered, Next enabled). */
  async waitForTaxonomyReady() {
    await expect(this.taxonomyStep).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await expect(this.taxonomyTagCards.first()).toBeVisible({ timeout: TIMEOUTS.AI_RESPONSE });
  }

  /**
   * Click Next until the Taxonomy step is reached and its analysis has finished. The Preview
   * step (auto-skipped for flat file selections) is clicked through if it appears. We check
   * visibility BEFORE clicking so we stop ON taxonomy rather than advancing past it to Config.
   */
  async advanceToTaxonomy() {
    for (let i = 0; i < 4; i++) {
      if (await this.taxonomyStep.isVisible().catch(() => false)) {
        await this.waitForTaxonomyReady();
        return;
      }
      await expect(this.wizardNextBtn).toBeEnabled({ timeout: TIMEOUTS.AI_RESPONSE });
      await this.wizardNextBtn.click();
    }
    await this.waitForTaxonomyReady();
  }

  /** Delete the first taxonomy tag card and return the card count before deletion. */
  async deleteFirstTaxonomyTag(): Promise<number> {
    const before = await this.taxonomyTagCards.count();
    await this.taxonomyStep.getByTestId('taxonomy-tag-delete').first().click();
    return before;
  }

  /**
   * Start the upload and wait for it to reach the completed state (fires when the S3 puts
   * finish — it does NOT wait for vectorization). Races the success toast against an error
   * toast so a create/batch/upload failure fails fast with the server message instead of
   * timing out on the success matcher. Uses the AI_RESPONSE budget because presign + S3 puts
   * can exceed the 30s ACTION window on a loaded stage.
   */
  async startUploadAndWaitComplete() {
    await expect(this.wizardStartUploadBtn).toBeEnabled({ timeout: TIMEOUTS.ELEMENT_STATE });
    await this.wizardStartUploadBtn.click();

    const success = this.page.locator('[data-sonner-toast]').filter({ hasText: /uploaded successfully|uploaded,/ });
    const errorToast = this.page.locator('[data-sonner-toast][data-type="error"]');

    const outcome = await Promise.race([
      success
        .waitFor({ state: 'visible', timeout: TIMEOUTS.AI_RESPONSE })
        .then(() => 'success' as const)
        .catch(() => 'timeout' as const),
      errorToast
        .waitFor({ state: 'visible', timeout: TIMEOUTS.AI_RESPONSE })
        .then(() => 'error' as const)
        .catch(() => 'timeout' as const),
    ]);

    if (outcome === 'error') {
      const message = await errorToast
        .first()
        .innerText()
        .catch(() => '(could not read toast)');
      throw new Error(`Data lake upload failed: ${message}`);
    }
    await expect(success).toBeVisible({ timeout: TIMEOUTS.POST_ACTION });
  }

  // ── Explorer article (deep-linked) ────────────────────────────────────────
  get article(): Locator {
    return this.page.getByTestId('datalake-article');
  }
  get askAboutBtn(): Locator {
    return this.page.getByTestId('datalake-ask-about');
  }
  get sortToggle(): Locator {
    return this.page.getByTestId('datalake-sort-toggle');
  }

  /** Open a lake article directly via the explorer's deep-link search param. */
  async gotoArticle(fabFileId: string) {
    await this.page.goto(`/data-lakes?article=${fabFileId}`);
    await this.dismissModals();
    await expect(this.article).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
  }

  /** Close the wizard via the footer Cancel, accepting the unsaved-progress confirm dialog. */
  async closeWizardAcceptingConfirm() {
    this.page.once('dialog', dialog => dialog.accept());
    await this.wizardModal.getByRole('button', { name: 'Cancel' }).click();
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  async openSettings(id: string) {
    await this.settingsBtn(id).click();
    await expect(this.settingsModal).toBeVisible({ timeout: TIMEOUTS.MODAL });
  }

  /**
   * Fill a MUI Joy field in the settings modal. The data-testid sits on the Joy Input
   * wrapper, so we target the inner native <input> — calling the value setter on the
   * wrapper div throws "Illegal invocation".
   */
  async fillSettingsField(testid: string, value: string) {
    await this.fillMuiInput(this.settingsModal.getByTestId(testid).locator('input'), value);
  }

  /** Inner radio <input> of the "Organization" visibility option (for enabled/disabled checks). */
  get orgVisibilityRadioInput(): Locator {
    return this.settingsModal.getByTestId('datalake-settings-visibility-org').locator('input');
  }

  async saveSettings() {
    await this.settingsModal.getByTestId('datalake-settings-save-btn').click();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async archive(id: string) {
    await this.archiveBtn(id).click();
    await expect(this.card(id)).toBeHidden({ timeout: TIMEOUTS.VISIBLE });
  }

  async expandArchived() {
    await this.page.getByTestId('datalake-archived-section-toggle').click();
  }

  async expandDeleted() {
    await this.page.getByTestId('datalake-deleted-section-toggle').click();
  }

  /** From the Deleted section, purge a lake permanently (through the confirm dialog). */
  async purge(id: string) {
    await this.page.getByTestId(`datalake-purge-btn-${id}`).click();
    const confirm = this.page.getByTestId('datalake-purge-confirm');
    await expect(confirm).toBeVisible({ timeout: TIMEOUTS.MODAL });
    await this.page.getByTestId('datalake-purge-confirm-btn').click();
  }

  // ── Viewer ─────────────────────────────────────────────────────────────

  /** Open a lake's viewer by clicking its card. */
  async openViewer(id: string) {
    await this.card(id).click();
    await expect(this.viewer).toBeVisible({ timeout: TIMEOUTS.MODAL });
  }

  async searchViewer(query: string) {
    await this.viewerSearch.fill(query);
  }
}
