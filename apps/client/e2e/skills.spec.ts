import { test, expect } from './fixtures';
import { TIMEOUTS } from './constants';
import { getTestUsers } from './helpers/test-users';
import { apiCreateSkill, apiDeleteAllSkills } from './helpers/api';

/**
 * Skills web UI: list, create, detail, edit, share.
 * See `e2e/skills.scenarios.md` for the scenario catalog.
 *
 * Serial mode: every test drives the SAME seeded backend user, so the
 * empty-state and search assertions need a deterministic data set. Running in
 * order (with API cleanup in before/after hooks) keeps one test's skills from
 * leaking into another's list.
 */
test.describe.configure({ mode: 'serial' });

// kebab-case only (SkillModel `name` regex); TEST_RUN_ID is digits, so it's valid.
const TEST_RUN_ID = Date.now().toString().slice(-6);
const SKILL_NAME = `e2e-skill-${TEST_RUN_ID}`;
const SEARCH_HIT = `e2e-find-me-${TEST_RUN_ID}`;
const SEARCH_MISS = `e2e-other-${TEST_RUN_ID}`;

let token: string;

test.describe('Skills - list, create, detail, edit, share', () => {
  // `request` (test-scoped) isn't available in beforeAll/afterAll, so mint a
  // short-lived API context from the worker-scoped `playwright` fixture.
  test.beforeAll(async ({ playwright }) => {
    token = getTestUsers().specUsers.skills.accessToken;
    const ctx = await playwright.request.newContext();
    // Clean slate so the empty-state assertion is deterministic.
    await apiDeleteAllSkills(ctx, token);
    await ctx.dispose();
  });

  test.afterAll(async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    await apiDeleteAllSkills(ctx, token);
    await ctx.dispose();
  });

  // --- List page -----------------------------------------------------------

  test('nav entry, empty state, then search filter', async ({ page, skillsPage, request }) => {
    await test.step('reach /skills from the profile menu', async () => {
      await skillsPage.openViaNav();
      await expect(page.getByRole('heading', { name: 'Skills' })).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    });

    await test.step('empty state for a user with no skills', async () => {
      const empty = page.getByTestId('skills-empty-state');
      await expect(empty).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
      await expect(empty).toContainText('No skills yet');
    });

    await test.step('client-side search filters by name/description', async () => {
      // Seed two skills via API (fast) and reload the list.
      await apiCreateSkill(request, token, {
        name: SEARCH_HIT,
        description: 'A skill that should match the search',
        body: 'Body for $ARGUMENTS',
      });
      await apiCreateSkill(request, token, {
        name: SEARCH_MISS,
        description: 'Unrelated template',
        body: 'Body',
      });
      await skillsPage.gotoList();
      await skillsPage.expectCardVisible(SEARCH_HIT);
      await skillsPage.expectCardVisible(SEARCH_MISS);

      await skillsPage.search('find-me');
      await skillsPage.expectCardVisible(SEARCH_HIT);
      await skillsPage.expectCardHidden(SEARCH_MISS);

      // No match -> the "no results" empty state (distinct copy from the true-empty one).
      await skillsPage.search('zzz-no-such-skill');
      await expect(page.getByTestId('skills-empty-state')).toContainText('No skills match your search', {
        timeout: TIMEOUTS.VISIBLE,
      });
    });

    // Reset so the true-empty assertion in later runs / the lifecycle test isn't polluted.
    await apiDeleteAllSkills(request, token);
  });

  // --- Full lifecycle ------------------------------------------------------

  test('create, view, edit, share, delete a skill', async ({ page, skillsPage }) => {
    test.slow();

    await test.step('create a skill end-to-end', async () => {
      await skillsPage.createSkillViaUi({
        name: SKILL_NAME,
        description: 'An E2E skill for automated testing',
        body: 'Summarize the following: $ARGUMENTS',
        argumentHint: '[topic]',
      });
    });

    await test.step('detail page renders name, hint, and body', async () => {
      const detailName = page.getByTestId('skill-detail-name');
      await expect(detailName).toContainText(`/${SKILL_NAME}`);
      await expect(detailName).toContainText('[topic]');
      await expect(page.getByTestId('skill-detail-body')).toContainText('Summarize the following: $ARGUMENTS');
    });

    await test.step('owner sees Share / Edit / Delete actions', async () => {
      await expect(page.getByTestId('skill-detail-share')).toBeVisible();
      await expect(page.getByTestId('skill-detail-edit')).toBeVisible();
      await expect(page.getByTestId('skill-detail-delete')).toBeVisible();
    });

    await test.step('skill appears on the list and opens from a card', async () => {
      await skillsPage.gotoList();
      await skillsPage.expectCardVisible(SKILL_NAME);
      await skillsPage.openSkillFromList(SKILL_NAME);
      await expect(page).toHaveURL(/\/skills\/[^/]+$/);
    });

    await test.step('edit prefills and persists a new description', async () => {
      await skillsPage.editFromDetail();
      // Form is prefilled from the existing skill.
      await expect(page.getByTestId('skill-name-input')).toHaveValue(SKILL_NAME);
      await skillsPage.fillForm({ description: 'Updated description for E2E' }, { clear: true });
      await skillsPage.saveEdit();
      await expect(page.getByTestId('skill-detail-page')).toContainText('Updated description for E2E', {
        timeout: TIMEOUTS.VISIBLE,
      });
    });

    await test.step('toggling "hide from LLM" shows the warning chip on detail', async () => {
      await skillsPage.editFromDetail();
      await skillsPage.fillForm({ disableModelInvocation: true });
      await skillsPage.saveEdit();
      await expect(page.getByTestId('skill-detail-page')).toContainText('Hidden from LLM auto-invocation', {
        timeout: TIMEOUTS.VISIBLE,
      });
    });

    await test.step('share dialog opens; unknown email surfaces an error', async () => {
      await skillsPage.openShareDialog();
      await expect(page.getByTestId('skill-share-dialog')).toContainText('Not shared with anyone yet');
      await skillsPage.addShareByEmail(`nobody-${TEST_RUN_ID}@example.com`);
      await expect(page.getByTestId('skill-share-error')).toContainText('No user found', {
        timeout: TIMEOUTS.VISIBLE,
      });
    });

    await test.step('global-write auto-enables global-read + warning, and PUT .../share fires', async () => {
      await skillsPage.setGlobalWrite(true);
      await skillsPage.expectGlobalWriteChecked(true);
      await skillsPage.expectGlobalReadChecked(true); // write implies read (UI couples them)
      await expect(page.getByTestId('skill-share-global-write-warning')).toBeVisible();

      await skillsPage.saveShare();
    });

    await test.step('a fresh load shows the saved global-write state', async () => {
      // The share dialog seeds its switch state once, at mount, from the detail
      // page's cached skill. After save, that cache refetch is still in flight,
      // so reopening immediately would re-mount against stale data. Reload to
      // force a fresh GET /api/skills/:id, then reopen - now it seeds correctly.
      await page.reload();
      await page.waitForLoadState('domcontentloaded');
      await skillsPage.dismissModals();
      await expect(page.getByTestId('skill-detail-page')).toBeVisible({ timeout: TIMEOUTS.VISIBLE });

      await skillsPage.openShareDialog();
      await skillsPage.expectGlobalWriteChecked(true);
      await skillsPage.expectGlobalReadChecked(true);
      // Close without changes.
      await page.getByTestId('skill-share-dialog').getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByTestId('skill-share-dialog')).toBeHidden({ timeout: TIMEOUTS.MODAL });
    });

    await test.step('delete from the detail page (confirm) removes it from the list', async () => {
      await skillsPage.deleteFromDetail();
      await skillsPage.gotoList();
      await skillsPage.expectCardHidden(SKILL_NAME);
    });
  });

  // --- Form validation -----------------------------------------------------

  test('form validation gates submit', async ({ page, skillsPage }) => {
    await skillsPage.gotoCreate();

    await test.step('submit disabled with an empty form', async () => {
      await expect(skillsPage.submitButton).toBeDisabled();
    });

    await test.step('invalid (non-kebab) name shows an error and keeps submit disabled', async () => {
      await skillsPage.fillForm({ name: 'Bad Name' }); // spaces + uppercase
      await expect(page.getByText('Use lowercase letters, digits, and hyphens', { exact: false })).toBeVisible({
        timeout: TIMEOUTS.VISIBLE,
      });
      await expect(skillsPage.submitButton).toBeDisabled();
    });

    await test.step('name valid but description/body empty keeps submit disabled', async () => {
      await skillsPage.fillForm({ name: `e2e-valid-${TEST_RUN_ID}` }, { clear: true });
      await expect(skillsPage.submitButton).toBeDisabled();
    });

    await test.step('all fields valid enables submit', async () => {
      await skillsPage.fillForm({ description: 'Valid description', body: 'Valid body' });
      await expect(skillsPage.submitButton).toBeEnabled({ timeout: TIMEOUTS.VISIBLE });
    });
  });

  // --- Cancel + duplicate name ---------------------------------------------

  test('cancel discards, duplicate name is rejected', async ({ page, skillsPage, request }) => {
    const dupeName = `e2e-dupe-${TEST_RUN_ID}`;

    await test.step('cancel returns to the list without creating', async () => {
      await skillsPage.gotoCreate();
      await skillsPage.fillForm({ name: `e2e-cancel-${TEST_RUN_ID}`, description: 'x', body: 'y' });
      await page.getByTestId('skill-form-cancel').click();
      await page.waitForURL('**/skills', { timeout: TIMEOUTS.NAVIGATION });
      await skillsPage.expectCardHidden(`e2e-cancel-${TEST_RUN_ID}`);
    });

    await test.step('creating a duplicate name is rejected (no navigation off the form)', async () => {
      // Seed the first skill via API so the UI attempt is the duplicate.
      await apiCreateSkill(request, token, { name: dupeName, description: 'first', body: 'first body' });

      await skillsPage.gotoCreate();
      await skillsPage.fillForm({ name: dupeName, description: 'second', body: 'second body' });
      // The POST returns 400; the mutation rejects, so we stay on /skills/new.
      const [response] = await Promise.all([
        page.waitForResponse(r => r.request().method() === 'POST' && /\/api\/skills(?:\?|$)/.test(r.url()), {
          timeout: TIMEOUTS.ACTION,
        }),
        skillsPage.submit(),
      ]);
      expect(response.status()).toBe(400);
      await expect(page).toHaveURL(/\/skills\/new$/);
    });
  });
});
