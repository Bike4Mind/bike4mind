import { test, expect } from './fixtures';
import { SKILLS_MEMBER_KEY, TIMEOUTS } from './constants';
import { getTestUsers, type TestUser } from './helpers/test-users';
import { apiCreateSkill, apiDeleteAllSkills, apiShareSkill } from './helpers/api';

/**
 * Skills web UI: list, create, detail, edit, share - plus the non-admin side of
 * the global-share gate, as a second (non-admin) user.
 *
 * Serial mode: every test drives the SAME seeded backend user, so the search
 * assertions need a deterministic set of owned skills. Running in order (with
 * API cleanup in before/after hooks) keeps one test's skills from leaking into
 * another's list. The list also carries global-read and (for this admin user)
 * system skills that no cleanup may touch, which is why the true-empty step
 * stubs the list response instead of relying on the DB.
 */
test.describe.configure({ mode: 'serial' });
// The empty-state step stubs the list with page.route, which cannot see a request the service worker
// answers (same as notebook.spec.ts's map test).
test.use({ serviceWorkers: 'block' });

// kebab-case only (SkillModel `name` regex); TEST_RUN_ID is digits, so it's valid.
const TEST_RUN_ID = Date.now().toString().slice(-6);
const SKILL_NAME = `e2e-skill-${TEST_RUN_ID}`;
const SEARCH_HIT = `e2e-find-me-${TEST_RUN_ID}`;
const SEARCH_MISS = `e2e-other-${TEST_RUN_ID}`;

let token: string;
let userId: string;
let member: TestUser;

/** GET /api/skills?limit=..&page=.. (the list query) - not /api/skills/:id or /api/skills/market/... */
const SKILLS_LIST_URL = /\/api\/skills\?/;

test.describe('Skills - list, create, detail, edit, share', () => {
  // `request` (test-scoped) isn't available in beforeAll/afterAll, so mint a
  // short-lived API context from the worker-scoped `playwright` fixture.
  test.beforeAll(async ({ playwright }) => {
    const { specUsers } = getTestUsers();
    ({ accessToken: token, userId } = specUsers.skills);
    member = specUsers[SKILLS_MEMBER_KEY];
    if (!member) throw new Error(`No ${SKILLS_MEMBER_KEY} spec user - skills.setup.ts must run first`);
    const ctx = await playwright.request.newContext();
    await apiDeleteAllSkills(ctx, token, userId);
    await apiDeleteAllSkills(ctx, member.accessToken, member.userId);
    await ctx.dispose();
  });

  test.afterAll(async ({ playwright }) => {
    // Independent deletes: the member's legacy global-read skill is visible to every user on the
    // stage, so a failed admin delete must not skip it. Either user is absent if beforeAll threw
    // before assigning it.
    const ctx = await playwright.request.newContext();
    const results = await Promise.allSettled([
      token ? apiDeleteAllSkills(ctx, token, userId) : Promise.resolve(),
      member ? apiDeleteAllSkills(ctx, member.accessToken, member.userId) : Promise.resolve(),
    ]);
    await ctx.dispose();
    const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failure) throw failure.reason;
  });

  // --- List page -----------------------------------------------------------

  test('nav entry, empty state, then search filter', async ({ page, skillsPage, request }) => {
    // Every global-read or system skill on the DB lands in this user's list, so a
    // real fetch is only empty on a pristine DB. Stub the list for the empty-state steps only.
    // The page falls back to an empty list on a fetch error too, so record that the stub served.
    let stubServed = false;
    await page.route(SKILLS_LIST_URL, route => {
      if (route.request().method() !== 'GET') return route.fallback();
      stubServed = true;
      return route.fulfill({ json: { data: [], hasMore: false, total: 0 } });
    });

    await test.step('reach /skills from the profile menu', async () => {
      await skillsPage.openViaNav();
      await expect(page.getByTestId('skills-list-page').getByRole('heading', { name: 'Skills', level: 2 })).toBeVisible(
        {
          timeout: TIMEOUTS.VISIBLE,
        }
      );
    });

    await test.step('empty state for a user with no skills', async () => {
      const empty = page.getByTestId('skills-empty-state');
      await expect(empty).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
      await expect(empty).toContainText('No skills yet');
      expect(stubServed).toBe(true);
      await page.unroute(SKILLS_LIST_URL);
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
      // A full navigation drops the stubbed (empty) query cache and refetches for real.
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

    // Reset so the lifecycle test's list starts from no owned skills.
    await apiDeleteAllSkills(request, token, userId);
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

  // --- Non-admin share gate ------------------------------------------------

  test('non-admin: global toggles gated, legacy global retractable, 403 on publish', async ({
    skillsPage,
    request,
    loginAsUser,
  }) => {
    test.slow();

    const fresh = await apiCreateSkill(request, member.accessToken, {
      name: `e2e-member-fresh-${TEST_RUN_ID}`,
      description: 'Non-admin skill that was never global',
      body: 'Body',
    });
    const legacy = await apiCreateSkill(request, member.accessToken, {
      name: `e2e-member-legacy-${TEST_RUN_ID}`,
      description: 'Non-admin skill made global before publishing moved to the Market',
      body: 'Body',
      // It is briefly global-read; keep it out of every other user's auto-invocation set meanwhile.
      disableModelInvocation: true,
    });

    const openShareFor = async (skillId: string) => {
      await skillsPage.gotoDetail(skillId);
      await skillsPage.openShareDialog();
    };

    await test.step('switch to the non-admin user', async () => {
      await loginAsUser(member);
    });

    await test.step('fresh skill: no global toggles, Skill Market hint instead', async () => {
      await openShareFor(fresh.id);
      await skillsPage.expectGlobalTogglesHidden();
    });

    await test.step('PUT .../share turning either global flag on is 403 for a non-admin', async () => {
      const read = await apiShareSkill(request, member.accessToken, fresh.id, { isGlobalRead: true });
      expect(read.status()).toBe(403);
      // The owner passes the manage-sharing gate, so the refusal has to come from the publish gate.
      expect(await read.text()).toContain('Skill Market');
      const write = await apiShareSkill(request, member.accessToken, fresh.id, { isGlobalWrite: true });
      expect(write.status()).toBe(403);
    });

    await test.step('legacy global skill: read is on and enabled, write stays off and locked', async () => {
      // Stand-in for a skill made global before the gate: only an admin can set the flag now.
      // Until this step retracts it (or afterAll deletes it), the skill is visible to every user.
      const seeded = await apiShareSkill(request, token, legacy.id, { isGlobalRead: true });
      expect(seeded.status()).toBe(200);

      await openShareFor(legacy.id);
      await skillsPage.expectGlobalReadChecked(true);
      await skillsPage.expectGlobalReadEnabled(true);
      await skillsPage.expectGlobalWriteChecked(false);
      await skillsPage.expectGlobalWriteEnabled(false);
    });

    await test.step('saving with read left on does not re-send the admin-only flag', async () => {
      // A non-admin re-sending isGlobalRead: true would 403, so the dialog must omit it.
      const response = await skillsPage.saveShare();
      expect(response.status()).toBe(200);
      const body = response.request().postDataJSON();
      expect(body).not.toHaveProperty('isGlobalRead');
      expect(body).toMatchObject({ isGlobalWrite: false });
    });

    await test.step('read can be turned off', async () => {
      await openShareFor(legacy.id);
      // The previous save left read on. If it had been dropped, the switch renders disabled and
      // `setGlobalRead(false)` would be a no-op against an already-false state.
      await skillsPage.expectGlobalReadChecked(true);
      await skillsPage.expectGlobalReadEnabled(true);
      await skillsPage.setGlobalRead(false);
      // Off is terminal for a non-admin: they cannot switch it back on.
      await skillsPage.expectGlobalReadEnabled(false);
      const response = await skillsPage.saveShare();
      expect(response.status()).toBe(200);
      expect(response.request().postDataJSON()).toMatchObject({ isGlobalRead: false, isGlobalWrite: false });
    });

    await test.step('once retracted, the skill is no longer global and the toggles are gone', async () => {
      // Reload rather than reopen: the dialog seeds from the detail page's cached skill (see the
      // lifecycle test's fresh-load step).
      await openShareFor(legacy.id);
      await skillsPage.expectGlobalTogglesHidden();
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
