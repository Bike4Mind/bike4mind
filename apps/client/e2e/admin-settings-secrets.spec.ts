import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { TIMEOUTS } from './constants';
import { SENSITIVE_SETTING_MASK, settingsMap } from '@bike4mind/common';

/**
 * Guards the sensitive-admin-setting boundary in a real browser.
 *
 * Every assertion here is read-only. That is deliberate: once a sensitive value is masked
 * the UI can no longer read it back, so a test that overwrote one could never restore it.
 * The write and clear paths are covered by unit tests (AdminSettingInputField.test.tsx and
 * pages/api/settings/__tests__/update.test.ts) and are left as manual steps on a disposable
 * environment. Do NOT add a save-a-new-value test here unless it targets a throwaway stage.
 */

const SENSITIVE_KEYS = (Object.values(settingsMap) as Array<{ key: string; isSensitive?: boolean }>)
  .filter(s => s.isSensitive === true)
  .map(s => s.key);

const SENSITIVE_KEY_SET = new Set(SENSITIVE_KEYS);

/** Masked means the mask (optionally with a 4-char tail); empty means the setting is unset. */
const isMaskedOrEmpty = (value: unknown) =>
  value === '' ||
  value === null ||
  value === undefined ||
  (typeof value === 'string' && value.startsWith(SENSITIVE_SETTING_MASK));

type SettingDoc = { settingName: string; settingValue: unknown };

/** Open Admin, switch to Admin Settings, and flatten every tab into a single list. */
async function gotoAdminSettings(page: Page, adminPage: { gotoAdmin: () => Promise<void> }) {
  await adminPage.gotoAdmin();

  // The nav renders twice (desktop sidebar and mobile drawer, mounted only while open), so
  // every lookup takes the on-screen one; on a phone the drawer is opened first.
  const navButton = page.getByTestId('admin-settings-btn').filter({ visible: true }).first();
  const mobileMenu = page.getByTestId('admin-mobile-menu-btn').filter({ visible: true });
  await expect(navButton.or(mobileMenu.first())).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
  if (!(await navButton.isVisible())) {
    await mobileMenu.first().click();
  }
  await expect(navButton).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
  await navButton.scrollIntoViewIfNeeded();
  await navButton.click();

  // Joy puts the testid on the Checkbox root span, so check() has to target the real input.
  const allTabs = page.getByTestId('admin-settings-all-tabs-checkbox');
  await expect(allTabs).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
  await allTabs.locator('input[type="checkbox"]').check();
  await expect(page.getByTestId('admin-settings-all-tabs-results')).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
}

/**
 * First sensitive field this environment actually has configured, or null. Resolved by
 * reading each input's live value - a CSS [value^=...] selector would not match, since
 * React controls the property rather than the attribute.
 */
async function findConfiguredSecretField(page: Page) {
  for (const key of SENSITIVE_KEYS) {
    const field = page.getByTestId(`admin-setting-${key}-input`);
    if ((await field.count()) === 0) continue;
    const value = await field.inputValue().catch(() => '');
    if (value.startsWith(SENSITIVE_SETTING_MASK)) {
      return { key, field };
    }
  }
  return null;
}

test.describe('Admin Settings - sensitive values never reach the browser', () => {
  test('the settings payload carries no sensitive value', async ({ page, adminPage }) => {
    const payloads: SettingDoc[][] = [];
    page.on('response', async response => {
      if (!response.url().includes('/api/settings/fetch') || !response.ok()) return;
      try {
        payloads.push((await response.json()) as SettingDoc[]);
      } catch {
        // Non-JSON body, nothing to assert against.
      }
    });

    await gotoAdminSettings(page, adminPage);

    expect(payloads.length, 'expected at least one /api/settings/fetch response').toBeGreaterThan(0);

    const sensitiveSeen = payloads.flat().filter(s => SENSITIVE_KEY_SET.has(s.settingName));

    // Without this the assertion below is vacuous: an environment where every sensitive
    // setting is unset trivially has no offenders. core.setup seeds one so it cannot happen.
    const configured = sensitiveSeen.filter(s => s.settingValue !== '' && s.settingValue != null);
    expect(
      configured.length,
      'no configured sensitive setting was present, so masking was never actually exercised'
    ).toBeGreaterThan(0);

    const offenders = sensitiveSeen.filter(s => !isMaskedOrEmpty(s.settingValue)).map(s => s.settingName);

    // Report names only - never echo the offending value into CI logs.
    expect(offenders, `sensitive settings returned unmasked: ${offenders.join(', ')}`).toEqual([]);
  });

  test('a non-sensitive setting is still returned in full', async ({ page, adminPage }) => {
    // Control for the test above: proves the masking is scoped, not blanket redaction.
    let sawRealValue = false;
    page.on('response', async response => {
      if (!response.url().includes('/api/settings/fetch') || !response.ok()) return;
      try {
        const body = (await response.json()) as SettingDoc[];
        sawRealValue ||= body.some(s => !SENSITIVE_KEY_SET.has(s.settingName) && typeof s.settingValue === 'string');
      } catch {
        // Non-JSON body, nothing to assert against.
      }
    });

    await gotoAdminSettings(page, adminPage);
    expect(sawRealValue, 'expected at least one non-sensitive string value to come through intact').toBe(true);
  });

  test('focusing a configured secret reveals nothing and stages no change', async ({ page, adminPage }) => {
    await gotoAdminSettings(page, adminPage);

    const target = await findConfiguredSecretField(page);
    // A hard failure rather than test.skip: core.setup seeds a throwaway sensitive setting, so
    // finding none means the seed regressed, and a silent skip would hide that permanently.
    expect(target, 'no configured sensitive field found - did core.setup seeding regress?').not.toBeNull();
    const { field } = target!;

    await field.scrollIntoViewIfNeeded();
    await field.focus();

    // Focus clears the mask so a replacement can be typed. It must not swap in a real value,
    // and the resulting empty field must not register as an edit. Assert on a derived boolean:
    // toHaveValue prints the actual value into the report, which on the exact regression this
    // test exists to catch would be a live secret.
    expect(await field.inputValue(), 'focus must clear the field, not reveal a value').toBe('');
    // Admin Settings stages edits into the shared SaveBar (SettingsDraftProvider) instead of a
    // per-field Save button, so "not an edit" means the bar never appears.
    await page.waitForTimeout(TIMEOUTS.POST_ACTION);
    await expect(page.getByTestId('admin-save-bar')).toHaveCount(0);
  });

  test('Cmd/Ctrl+S after focusing without typing issues no write and keeps the stored value', async ({
    page,
    adminPage,
  }) => {
    await gotoAdminSettings(page, adminPage);

    const target = await findConfiguredSecretField(page);
    expect(target, 'no configured sensitive field found - did core.setup seeding regress?').not.toBeNull();
    const { field } = target!;

    const writes: string[] = [];
    page.on('request', request => {
      if (request.url().includes('/api/settings/update') && request.method() === 'PUT') writes.push(request.url());
    });

    await field.scrollIntoViewIfNeeded();
    await field.focus();
    expect(await field.inputValue(), 'focus must clear the field, not reveal a value').toBe('');

    // Before the guard this path wrote '' straight over the stored key. The shortcut is the one
    // save path still reachable from a focused field with nothing staged (SaveBar listens for it
    // on window regardless of what is staged).
    await page.keyboard.press('ControlOrMeta+s');
    await page.waitForTimeout(TIMEOUTS.POST_ACTION);

    expect(writes, 'an empty sensitive value must never be written').toEqual([]);

    // Blur restores the mask rather than leaving the field blank, so the value is still stored.
    // Compared as a boolean so a regression cannot print the restored value into the report.
    await field.blur();
    const restored = await field.inputValue();
    expect(restored.startsWith(SENSITIVE_SETTING_MASK), 'blur must restore the mask, not a real value').toBe(true);
  });
});
