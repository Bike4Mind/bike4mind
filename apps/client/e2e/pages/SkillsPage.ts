import { expect, type Locator, type Response } from '@playwright/test';
import { TIMEOUTS } from '../constants';
import { BasePage } from './BasePage';

export interface SkillFormValues {
  name: string;
  description: string;
  body: string;
  argumentHint?: string;
  disableModelInvocation?: boolean;
}

/** POST /api/skills (create) - method + exact path, no id segment, ignoring any query. */
const isCreateSkillResponse = (r: Response): boolean =>
  r.request().method() === 'POST' && /\/api\/skills(?:\?|$)/.test(r.url());

/** PUT /api/skills/:id (update) - has an id segment, not the /share sub-path. */
const isUpdateSkillResponse = (r: Response): boolean =>
  r.request().method() === 'PUT' && /\/api\/skills\/[^/?]+(?:\?|$)/.test(r.url());

/** DELETE /api/skills/:id. */
const isDeleteSkillResponse = (r: Response): boolean =>
  r.request().method() === 'DELETE' && /\/api\/skills\/[^/?]+(?:\?|$)/.test(r.url());

/** PUT /api/skills/:id/share (sharing config replace). */
const isShareSkillResponse = (r: Response): boolean =>
  r.request().method() === 'PUT' && /\/api\/skills\/[^/]+\/share(?:\?|$)/.test(r.url());

/**
 * Page object for the Skills management surface (`/skills`, `/skills/new`,
 * `/skills/$id`, `/skills/$id/edit`) and the share dialog.
 *
 * Selector notes:
 *  - The `SkillForm` inputs carry their `data-testid` on the NATIVE element via
 *    `slotProps` (input / textarea), so they are `fill()`-able directly.
 *  - The share dialog's email `Input` and the two `Switch`es put the testid on
 *    the MUI Joy ROOT element, so the native control is reached via
 *    `.locator('input')`.
 */
export class SkillsPage extends BasePage {
  /** Navigate directly to the list via URL - fast, skips UI navigation. */
  async gotoList() {
    await this.page.goto('/skills');
    await this.page.waitForLoadState('domcontentloaded');
    await this.dismissModals();
    await expect(this.page.getByTestId('skills-list-page')).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
  }

  /** Reach the list the way a user does: profile menu -> Skills. */
  async openViaNav() {
    await this.page.goto('/');
    await this.page.waitForLoadState('domcontentloaded');
    await this.dismissModals();

    await this.page.getByTestId('profile-menu-card').click();
    const skillsItem = this.page.getByTestId('profile-menu-skills');
    await expect(skillsItem).toBeVisible({ timeout: TIMEOUTS.MODAL });
    await skillsItem.click();

    await this.page.waitForURL('**/skills', { timeout: TIMEOUTS.NAVIGATION });
    await expect(this.page.getByTestId('skills-list-page')).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
  }

  async gotoCreate() {
    await this.page.goto('/skills/new');
    await this.page.waitForLoadState('domcontentloaded');
    await this.dismissModals();
    await expect(this.page.getByTestId('new-skill-page')).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
  }

  /** Fill only the provided fields. `clear` first for the edit flow's prefilled inputs. */
  async fillForm(values: Partial<SkillFormValues>, opts: { clear?: boolean } = {}) {
    if (values.name !== undefined) await this.setInput('skill-name-input', values.name, opts.clear);
    if (values.description !== undefined)
      await this.setInput('skill-description-input', values.description, opts.clear);
    if (values.argumentHint !== undefined)
      await this.setInput('skill-argument-hint-input', values.argumentHint, opts.clear);
    if (values.body !== undefined) await this.setInput('skill-body-input', values.body, opts.clear);
    if (values.disableModelInvocation !== undefined) {
      const checkbox = this.page.getByTestId('skill-disable-model-invocation');
      if ((await checkbox.isChecked()) !== values.disableModelInvocation) await checkbox.click();
    }
  }

  private async setInput(testId: string, value: string, clear?: boolean) {
    const el = this.page.getByTestId(testId);
    await el.click();
    if (clear) await el.clear();
    await el.fill(value);
  }

  get submitButton(): Locator {
    return this.page.getByTestId('skill-form-submit');
  }

  async submit() {
    await expect(this.submitButton).toBeEnabled({ timeout: TIMEOUTS.ACTION });
    await this.submitButton.click();
  }

  /** Create a skill through the form; asserts the POST fires and we land on the detail page. */
  async createSkillViaUi(values: SkillFormValues) {
    await this.gotoCreate();
    await this.fillForm(values);
    const [response] = await Promise.all([
      this.page.waitForResponse(isCreateSkillResponse, { timeout: TIMEOUTS.ACTION }),
      this.submit(),
    ]);
    await this.page.waitForURL(/\/skills\/[^/]+$/, { timeout: TIMEOUTS.NAVIGATION });
    await expect(this.page.getByTestId('skill-detail-page')).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    return response;
  }

  async openSkillFromList(name: string) {
    const card = this.page.getByTestId(`skill-card-${name}`);
    await expect(card).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await card.click();
    await expect(this.page.getByTestId('skill-detail-page')).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
  }

  async editFromDetail() {
    const editBtn = this.page.getByTestId('skill-detail-edit');
    await expect(editBtn).toBeVisible({ timeout: TIMEOUTS.ACTION });
    await editBtn.click();
    await expect(this.page.getByTestId('edit-skill-page')).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
  }

  /** Save the edit form; asserts the PUT fires and we return to the detail page. */
  async saveEdit() {
    const [response] = await Promise.all([
      this.page.waitForResponse(isUpdateSkillResponse, { timeout: TIMEOUTS.ACTION }),
      this.submit(),
    ]);
    await this.page.waitForURL(/\/skills\/[^/]+$/, { timeout: TIMEOUTS.NAVIGATION });
    await expect(this.page.getByTestId('skill-detail-page')).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    return response;
  }

  /** Delete from the detail page. Accepts the native window.confirm and waits for the DELETE + redirect. */
  async deleteFromDetail() {
    this.page.once('dialog', dialog => dialog.accept());
    const [response] = await Promise.all([
      this.page.waitForResponse(isDeleteSkillResponse, { timeout: TIMEOUTS.ACTION }),
      this.page.getByTestId('skill-detail-delete').click(),
    ]);
    await this.page.waitForURL('**/skills', { timeout: TIMEOUTS.NAVIGATION });
    return response;
  }

  /** Delete from a list card. `accept: false` dismisses the confirm (cancel path). */
  async deleteFromList(name: string, opts: { accept?: boolean } = {}) {
    const accept = opts.accept ?? true;
    this.page.once('dialog', dialog => (accept ? dialog.accept() : dialog.dismiss()));
    await this.page.getByTestId(`skill-delete-${name}`).click();
  }

  async search(term: string) {
    await this.page.getByTestId('skills-search-input').fill(term);
  }

  async expectCardVisible(name: string) {
    await expect(this.page.getByTestId(`skill-card-${name}`)).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
  }

  async expectCardHidden(name: string) {
    await expect(this.page.getByTestId(`skill-card-${name}`)).toBeHidden({ timeout: TIMEOUTS.VISIBLE });
  }

  // --- Share dialog ---------------------------------------------------------

  async openShareDialog() {
    const shareBtn = this.page.getByTestId('skill-detail-share');
    await expect(shareBtn).toBeVisible({ timeout: TIMEOUTS.ACTION });
    await shareBtn.click();
    await expect(this.page.getByTestId('skill-share-dialog')).toBeVisible({ timeout: TIMEOUTS.MODAL });
  }

  /** Try to add a share recipient by email (Add button). Returns without asserting outcome. */
  async addShareByEmail(email: string) {
    await this.page.getByTestId('skill-share-email-input').locator('input').fill(email);
    await this.page.getByTestId('skill-share-add-btn').click();
  }

  /** Native checkbox inside a MUI Joy Switch (testid is on the switch root). */
  private switchInput(testId: string): Locator {
    return this.page.getByTestId(testId).locator('input');
  }

  async setGlobalRead(on: boolean) {
    if ((await this.switchInput('skill-share-global-read').isChecked()) !== on) {
      await this.page.getByTestId('skill-share-global-read').click();
    }
  }

  async setGlobalWrite(on: boolean) {
    if ((await this.switchInput('skill-share-global-write').isChecked()) !== on) {
      await this.page.getByTestId('skill-share-global-write').click();
    }
  }

  async expectGlobalReadChecked(checked: boolean) {
    const input = this.switchInput('skill-share-global-read');
    if (checked) await expect(input).toBeChecked();
    else await expect(input).not.toBeChecked();
  }

  async expectGlobalWriteChecked(checked: boolean) {
    const input = this.switchInput('skill-share-global-write');
    if (checked) await expect(input).toBeChecked();
    else await expect(input).not.toBeChecked();
  }

  /** Save the share dialog; asserts the PUT .../share fires and the dialog closes. */
  async saveShare() {
    const [response] = await Promise.all([
      this.page.waitForResponse(isShareSkillResponse, { timeout: TIMEOUTS.ACTION }),
      this.page.getByTestId('skill-share-save-btn').click(),
    ]);
    await expect(this.page.getByTestId('skill-share-dialog')).toBeHidden({ timeout: TIMEOUTS.MODAL });
    return response;
  }
}
