import { expect, type Locator, type Page } from '@playwright/test';
import { TIMEOUTS } from '../constants';
import { BasePage } from './BasePage';

/**
 * Page object for the Data Lakes surface. The standalone `/data-lakes` page is gone, so
 * every UI path starts in a chat: the header's Data Lake pill turns the session into the
 * tree-left/chat-right surface, and the tree's footer opens the create wizard and the
 * two-pane management modal. Selectors mirror the data-testid attributes in
 * `app/components/datalake/*` and `app/components/DataLakeWizard/*`.
 */
export class DataLakePage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  // ── In-chat surface ───────────────────────────────────────────────────────
  /** Header pill that turns Data Lake mode on. Hidden once mode is already on. */
  get modeToggle(): Locator {
    return this.page.getByTestId('datalake-mode-toggle');
  }
  /** The in-chat explorer. Both hosts emit the same id (see DataLakeExplorer). */
  get explorer(): Locator {
    return this.page.getByTestId('opti-datalake-explorer');
  }
  get sortToggle(): Locator {
    return this.explorer.getByTestId('datalake-sort-toggle');
  }
  /** Tree footer: opens the management modal. */
  get manageBtn(): Locator {
    return this.explorer.getByTestId('datalake-manage-btn');
  }
  /** Tree footer: opens the create wizard. */
  get createBtn(): Locator {
    return this.explorer.getByTestId('datalake-create-btn');
  }
  /** Tree header X: turns Data Lake mode back off. */
  get modeCloseBtn(): Locator {
    return this.explorer.getByTestId('datalake-close-btn');
  }
  fileRow(fabFileId: string): Locator {
    return this.explorer.getByTestId(`datalake-file-${fabFileId}`);
  }
  treeNode(segment: string): Locator {
    return this.explorer.getByTestId(`datalake-node-${segment}`);
  }

  // ── Management modal ──────────────────────────────────────────────────────
  get managerModal(): Locator {
    return this.page.getByTestId('data-lake-manager-modal');
  }
  get managerPanel(): Locator {
    return this.page.getByTestId('datalake-manager-panel');
  }
  get managerNav(): Locator {
    return this.page.getByTestId('datalake-manager-nav');
  }
  get managerSearch(): Locator {
    return this.managerNav.getByTestId('datalake-manager-search').locator('input');
  }
  get managerCreateBtn(): Locator {
    return this.managerNav.getByTestId('datalake-manager-create-btn');
  }
  /** Right pane at root: the "pick a lake" hint. */
  get managerOverview(): Locator {
    return this.page.getByTestId('datalake-manager-overview');
  }
  /** Right pane with a lake selected: name, chips and the per-lake actions. */
  get lakeInfo(): Locator {
    return this.page.getByTestId('datalake-manager-lakeinfo');
  }
  /** Right pane with a file selected. */
  get managerArticle(): Locator {
    return this.managerPanel.getByTestId('datalake-article');
  }
  /** Sidebar row for one lake (root level of the nav). */
  lakeRow(id: string): Locator {
    return this.managerNav.getByTestId(`datalake-manager-lake-${id}`);
  }
  /** Category folder row inside a lake's tree. */
  managerNode(segment: string): Locator {
    return this.managerNav.getByTestId(`datalake-manager-node-${segment}`);
  }
  managerFileRow(fabFileId: string): Locator {
    return this.managerNav.getByTestId(`datalake-manager-file-${fabFileId}`);
  }

  // ── Per-lake actions (right pane; require the lake to be selected) ─────────
  addFilesBtn(id: string): Locator {
    return this.lakeInfo.getByTestId(`datalake-addfiles-btn-${id}`);
  }
  settingsBtn(id: string): Locator {
    return this.lakeInfo.getByTestId(`datalake-settings-btn-${id}`);
  }
  archiveBtn(id: string): Locator {
    return this.lakeInfo.getByTestId(`datalake-archive-btn-${id}`);
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
  /** Lake name: set on the source step in create mode (absent in append mode). */
  get sourceNameInput(): Locator {
    return this.page.getByTestId('source-name-input').locator('input');
  }
  /** Opt-in checkboxes, only rendered once files are selected. */
  get previewToggle(): Locator {
    return this.page.getByTestId('source-toggle-preview').locator('input');
  }
  /**
   * AI tag suggestion. NOT a wizard step any more - it opts into a background job that runs
   * after the upload and is reviewed from the manager, so ticking it never splices a step in.
   */
  get taxonomyToggle(): Locator {
    return this.page.getByTestId('source-toggle-taxonomy').locator('input');
  }

  // ── Settings modal ──────────────────────────────────────────────────────
  get settingsModal(): Locator {
    return this.page.getByTestId('datalake-settings-modal');
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  /**
   * Land on a fresh chat and turn Data Lake mode on, leaving the in-chat tree open.
   *
   * Navigate on 'domcontentloaded', not the default 'load'. Under parallel load the preview's
   * heavy SPA bundles can delay the 'load' event 60s+, hanging goto() on about:blank even though
   * the shell responds in ~2s and the app is otherwise fine. The explorer-visible assertion below
   * is the real readiness gate, so we don't need to block navigation on full 'load'.
   *
   * Mode lives in an in-memory store, so it is off again after every navigation - each entry
   * point has to flip it, which is also what makes the toggle itself visible to click.
   */
  async openChatSurface() {
    await this.page.goto('/new', { waitUntil: 'domcontentloaded' });
    await this.dismissModals();
    // Wait for whichever settles first: the pill to click, or the surface already open
    // (DataLakeToggle renders null once mode is on, so an already-on chat never shows a pill).
    // The .or() is what makes the isVisible() below safe - isVisible resolves against the
    // CURRENT DOM and ignores its timeout, so on its own it would answer false on an unpainted
    // shell and silently leave mode off, which the domcontentloaded navigation above makes
    // likely rather than rare.
    await expect(this.modeToggle.or(this.explorer).first()).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
    if (await this.modeToggle.isVisible()) {
      await this.modeToggle.click();
    }
    await expect(this.explorer).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
  }

  /** From the in-chat tree footer, open the two-pane management modal. */
  async openManager() {
    await this.manageBtn.click();
    await expect(this.managerModal).toBeVisible({ timeout: TIMEOUTS.MODAL });
    await expect(this.managerPanel).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
  }

  /** Convenience: open the in-chat surface and go straight into the manager. */
  async openManagerFromChat() {
    await this.openChatSurface();
    await this.openManager();
  }

  /** Select a lake in the manager sidebar so its details pane (and actions) render. */
  async selectLake(id: string) {
    await expect(this.lakeRow(id)).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await this.lakeRow(id).click();
    await expect(this.lakeInfo).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
  }

  /** Convenience: manager open, lake selected. */
  async openLakeInManager(id: string) {
    await this.openManagerFromChat();
    await this.selectLake(id);
  }

  // ── Wizard flows ──────────────────────────────────────────────────────────

  /** Open the create wizard from the in-chat tree footer. */
  async startCreate() {
    await this.createBtn.click();
    await expect(this.wizardModal).toBeVisible({ timeout: TIMEOUTS.MODAL });
    await expect(this.wizardSourceStep).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
  }

  /** Open the append ("Add files") wizard for the lake selected in the manager. */
  async startAppend(id: string) {
    await this.addFilesBtn(id).click();
    await expect(this.wizardModal).toBeVisible({ timeout: TIMEOUTS.MODAL });
  }

  /** Attach files to the wizard's plain (non-folder) file input. */
  async selectFiles(files: string[] | { name: string; mimeType: string; buffer: Buffer }[]) {
    await this.selectFilesInput.setInputFiles(files);
  }

  /** Name the lake on the source step. Required before Next enables in create mode. */
  async fillLakeName(name: string) {
    await this.fillMuiInput(this.sourceNameInput, name);
  }

  async wizardNext() {
    await expect(this.wizardNextBtn).toBeEnabled({ timeout: TIMEOUTS.ELEMENT_STATE });
    await this.wizardNextBtn.click();
  }

  // ── Wizard step content ──────────────────────────────────────────────────
  get configStep(): Locator {
    return this.page.getByTestId('wizard-config-step');
  }
  get previewStep(): Locator {
    return this.page.getByTestId('wizard-preview-step');
  }
  get uploadStep(): Locator {
    return this.page.getByTestId('wizard-upload-step');
  }
  /** Read-only echo of the name set on the source step. */
  get configSummaryName(): Locator {
    return this.page.getByTestId('config-summary-name');
  }
  get configTagPrefixInput(): Locator {
    return this.configStep.getByTestId('config-tag-prefix-input').locator('input');
  }
  /** The two gate fields carry no testid; locate them by placeholder within the config step. */
  get configAccessTagInput(): Locator {
    return this.configStep.getByPlaceholder('e.g. LegalTeam');
  }
  get configEntitlementInput(): Locator {
    return this.configStep.getByPlaceholder('e.g. product:pro');
  }

  /**
   * Click Next until the Config step is reached. Preview is the only optional step left, so the
   * default create path is a single click from source; the loop still handles it when opted in.
   * In create mode the lake name must already be set - Next is gated on it.
   */
  async advanceToConfig() {
    for (let i = 0; i < 4; i++) {
      if (await this.configStep.isVisible().catch(() => false)) return;
      await expect(this.wizardNextBtn).toBeEnabled({ timeout: TIMEOUTS.ELEMENT_STATE });
      await this.wizardNextBtn.click();
    }
    await expect(this.configStep).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
  }

  /**
   * Start the upload and wait for it to reach the completed state (fires when the S3 puts
   * finish - it does NOT wait for vectorization). Races the success toast against an error
   * toast so a create/batch/upload failure fails fast with the server message instead of
   * timing out on the success matcher. Uses the AI_RESPONSE budget because presign + S3 puts
   * can exceed the 30s ACTION window on a loaded stage.
   */
  async startUploadAndWaitComplete() {
    await expect(this.wizardStartUploadBtn).toBeEnabled({ timeout: TIMEOUTS.ELEMENT_STATE });
    await this.wizardStartUploadBtn.click();

    const success = this.page.locator('[data-sonner-toast]').filter({ hasText: /uploaded successfully|uploaded,/ });
    // Filtered on the Retry action, not just data-type=error. An unfiltered wait is satisfied by a
    // toast ALREADY on screen when the click lands, and the config step auto-fires an advisory
    // dedup check on arrival whose failure raises its own error toast - which would otherwise fail
    // a SUCCEEDING upload with "Failed to check for duplicates". The commit paths are the only
    // ones that attach a Retry action (see dataLakeWizard's shared data-lake-batch-upload-error
    // toast), so that action is what marks the error as this upload's own.
    const errorToast = this.page
      .locator('[data-sonner-toast][data-type="error"]')
      .filter({ has: this.page.getByRole('button', { name: 'Retry' }) });

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

  /**
   * Follow a shared `/data-lakes?article=` deep link. The PAGE behind that path is gone, but the
   * route survives as a redirect into a Data-Lake-mode chat (see router.tsx) - keeping those
   * already-shared links working is the only reason it still exists, so this drives the redirect,
   * never a page.
   */
  async gotoArticle(fabFileId: string) {
    await this.page.goto(`/data-lakes?article=${fabFileId}`, { waitUntil: 'domcontentloaded' });
    await this.dismissModals();
    await expect(this.explorer).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
  }

  /** Close the wizard via the footer Cancel, accepting the unsaved-progress confirm dialog. */
  async closeWizardAcceptingConfirm() {
    this.page.once('dialog', dialog => dialog.accept());
    await this.wizardModal.getByRole('button', { name: 'Cancel' }).click();
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  /** Open the settings modal for the lake currently selected in the manager. */
  async openSettings(id: string) {
    await this.settingsBtn(id).click();
    await expect(this.settingsModal).toBeVisible({ timeout: TIMEOUTS.MODAL });
  }

  /**
   * Fill a MUI Joy field in the settings modal. The data-testid sits on the Joy Input
   * wrapper, so we target the inner native <input> - calling the value setter on the
   * wrapper div throws "Illegal invocation".
   */
  async fillSettingsField(testid: string, value: string) {
    await this.fillMuiInput(this.settingsModal.getByTestId(testid).locator('input'), value);
  }

  /** Inner radio <input> of the "Organization" visibility option (for enabled/disabled checks). */
  get orgVisibilityRadioInput(): Locator {
    return this.settingsModal.getByTestId('datalake-settings-visibility-org').locator('input');
  }

  /** Inner radio <input> of the "Public" visibility option - disabled while the lake is gated. */
  get publicVisibilityRadioInput(): Locator {
    return this.settingsModal.getByTestId('datalake-settings-visibility-public').locator('input');
  }

  async saveSettings() {
    await this.settingsModal.getByTestId('datalake-settings-save-btn').click();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Archive the lake selected in the manager; the panel falls back to the root overview. */
  async archive(id: string) {
    // Counted before the click: waitFor({ state: 'visible' }) is satisfied by an error toast that
    // was already on screen, so nth(errorsBefore) is what makes the wait below mean "this archive
    // failed" rather than "an error toast exists". The archive error carries no Retry action to
    // filter on, unlike the upload's.
    const errorToast = this.page.locator('[data-sonner-toast][data-type="error"]');
    const errorsBefore = await errorToast.count();
    await this.archiveBtn(id).click();

    // Archive cancels in-flight batches and soft-hides files server-side, then invalidates and
    // refetches the active-lakes query before the lake leaves the list. On a loaded stage that
    // round-trip exceeds the VISIBLE budget, so gate on the success toast first (racing an error
    // toast so a real archive failure fails fast with the server message instead of timing out on
    // toBeHidden), then assert the row is gone on the larger ACTION budget.
    const success = this.page.locator('[data-sonner-toast]').filter({ hasText: 'Data lake archived' });
    const newError = errorToast.nth(errorsBefore);
    const outcome = await Promise.race([
      success
        .waitFor({ state: 'visible', timeout: TIMEOUTS.ACTION })
        .then(() => 'success' as const)
        .catch(() => 'timeout' as const),
      newError
        .waitFor({ state: 'visible', timeout: TIMEOUTS.ACTION })
        .then(() => 'error' as const)
        .catch(() => 'timeout' as const),
    ]);
    if (outcome === 'error') {
      // nth(errorsBefore) is the right WAIT (it means "the count grew") but the wrong read:
      // sonner prepends (`[toast, ...toasts]`), so DOM index 0 is the NEWEST toast and the stale
      // ones shift down. Reading nth(errorsBefore) would report the oldest stale toast's text
      // precisely when one was on screen - the case this barrier exists for.
      const message = await errorToast
        .first()
        .innerText()
        .catch(() => '(could not read toast)');
      throw new Error(`Data lake archive failed: ${message}`);
    }

    await expect(this.lakeRow(id)).toBeHidden({ timeout: TIMEOUTS.ACTION });
  }

  /**
   * Expand a lifecycle accordion and wait for one lake's row to arrive in it.
   *
   * Two distinct hazards, which is why the CARD is the signal and the section is only the gate:
   * an empty section renders as a plain Box with no onClick (navChrome), so a click lands and
   * does nothing; and a just-archived lake races the query invalidation, so the section can be
   * open while its row is still missing. The section's "No files" label settles neither - it
   * renders only on the `lakes.length === 0` branch, so it is equally absent while the query is
   * in flight and whenever the section already holds somebody else's lake.
   *
   * The role gate is what keeps this to a single click: clicking again to retry would collapse
   * a section that had already opened.
   */
  private async expandLifecycleSection(testid: string, card: Locator) {
    const toggle = this.managerNav.getByTestId(testid);
    await expect(toggle).toHaveRole('button', { timeout: TIMEOUTS.ACTION });
    await toggle.click();
    await expect(card).toBeVisible({ timeout: TIMEOUTS.ACTION });
  }

  async expandArchived(id: string) {
    await this.expandLifecycleSection('datalake-archived-section-toggle', this.archivedCard(id));
  }

  async expandDeleted(id: string) {
    await this.expandLifecycleSection('datalake-deleted-section-toggle', this.deletedCard(id));
  }

  archivedCard(id: string): Locator {
    return this.managerNav.getByTestId(`datalake-archived-section-card-${id}`);
  }

  deletedCard(id: string): Locator {
    return this.managerNav.getByTestId(`datalake-deleted-section-card-${id}`);
  }

  /**
   * From the Deleted section, purge a lake permanently (through the confirm dialog). The row's
   * actions live behind a three-dots menu, which portals to the body - so the menu item is
   * located on the page, not inside the nav.
   */
  async purge(id: string) {
    await this.managerNav.getByTestId(`datalake-deleted-section-menu-btn-${id}`).click();
    await this.page.getByTestId(`datalake-purge-btn-${id}`).click();
    const confirm = this.page.getByTestId('datalake-purge-confirm');
    await expect(confirm).toBeVisible({ timeout: TIMEOUTS.MODAL });
    await this.page.getByTestId('datalake-purge-confirm-btn').click();
  }

  // ── In-chat file actions ──────────────────────────────────────────────────

  /**
   * Attach a lake file to the chat from its row menu. On /new this mints the grounded session
   * and swaps the URL for the real notebook, which is what the caller usually asserts on.
   */
  async attachFileToChat(fabFileId: string) {
    await this.explorer.getByTestId(`datalake-row-menu-btn-${fabFileId}`).click();
    await this.page.getByTestId(`datalake-attach-item-${fabFileId}`).click();
  }
}
