import type { Browser } from '@playwright/test';
import { test, expect, openPageAs } from './fixtures';
import { TEAMS_INVITEE_KEY, TEAMS_MANAGER_KEY, TEAMS_MEMBER_KEY, TIMEOUTS } from './constants';
import { getTestUsers, type TestUser } from './helpers/test-users';
import { apiAddTeamMember, apiDeleteGrantedTeam, apiGetTeam, apiGrantTeam, apiRevokeTeamGrant } from './helpers/api';
import { AdminPage } from './pages/AdminPage';
import { ALL_TEAM_TABS, TeamsPage } from './pages/TeamsPage';

/**
 * Teams (organizations on the Team plan): list, detail, members, roles, settings.
 *
 * Every team here is seeded through the admin grant endpoint, never Stripe, so this file runs on any
 * env. Seats are the grant's `seats` field and the admin panel's "Adjust seats" action; buying seats
 * through Stripe is teams-checkout.spec.ts, which runs on staging only.
 *
 * Serial mode: the tests share three seeded teams and walk one roster through invite, cancel, add
 * and revoke, so a later test relies on the state an earlier one left.
 *
 * The fixture page is always the owner. Every other identity gets its own browser context via
 * openTeamsPageAs: switching identity on one page let the previous user's persisted session leak into
 * the next (requests for the old user id 401'd and the app bounced to /login?error=session_expired).
 */
test.describe.configure({ mode: 'serial' });

const RUN_ID = Date.now().toString().slice(-6);
const MAIN_TEAM = `E2E Team ${RUN_ID}`;
// Full means owner + members >= seats (organizationService/addMember.ts): 2 seats with one member.
const FULL_TEAM = `E2E Full Team ${RUN_ID}`;
const DISPOSABLE_TEAM = `E2E Disposable Team ${RUN_ID}`;

let admin: TestUser;
let adminToken: string;
let owner: TestUser;
let member: TestUser;
let manager: TestUser;
let invitee: TestUser;
let mainTeamId: string;
let fullTeamId: string;
let disposableTeamId: string;

async function openTeamsPageAs(browser: Browser, baseURL: string | undefined, user: TestUser) {
  const { page, close } = await openPageAs(browser, baseURL, user);
  return { page, teamsPage: new TeamsPage(page), close };
}

/** Names follow the `Setup <key> <suffix>` shape teams.setup.ts gives them. */
function seededName(user: TestUser): string {
  return user.email.replace(/^setup-(\w+)-(.+)-e2e@test\.com$/, 'Setup $1 $2');
}

test.describe('Teams', () => {
  test.beforeAll(async ({ playwright }) => {
    const users = getTestUsers();
    admin = users.admin;
    adminToken = admin.accessToken;
    owner = users.specUsers.teams;
    member = users.specUsers[TEAMS_MEMBER_KEY];
    manager = users.specUsers[TEAMS_MANAGER_KEY];
    invitee = users.specUsers[TEAMS_INVITEE_KEY];
    if (!owner || !member || !manager || !invitee) {
      throw new Error('Missing teams spec users - teams.setup.ts must run first');
    }

    const ctx = await playwright.request.newContext();
    mainTeamId = await apiGrantTeam(ctx, adminToken, { name: MAIN_TEAM, ownerEmail: owner.email, seats: 6 });
    await apiAddTeamMember(ctx, owner.accessToken, mainTeamId, member.userId);
    await apiAddTeamMember(ctx, owner.accessToken, mainTeamId, manager.userId);

    fullTeamId = await apiGrantTeam(ctx, adminToken, { name: FULL_TEAM, ownerEmail: owner.email, seats: 2 });
    await apiAddTeamMember(ctx, owner.accessToken, fullTeamId, member.userId);

    disposableTeamId = await apiGrantTeam(ctx, adminToken, {
      name: DISPOSABLE_TEAM,
      ownerEmail: owner.email,
      seats: 2,
    });
    await ctx.dispose();
  });

  test.afterAll(async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    await Promise.allSettled(
      [mainTeamId, fullTeamId, disposableTeamId].filter(Boolean).map(id => apiDeleteGrantedTeam(ctx, adminToken, id))
    );
    await ctx.dispose();
  });

  // --- List ---------------------------------------------------------------------

  test('team list shows the teams the owner was granted', async ({ teamsPage }) => {
    await teamsPage.gotoList();
    await expect(teamsPage.teamCard(mainTeamId)).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await expect(teamsPage.teamCard(mainTeamId)).toContainText(MAIN_TEAM);
    await expect(teamsPage.teamCard(fullTeamId)).toBeVisible();
  });

  test('search filters the team list and shows the empty state on no match', async ({ page, teamsPage }) => {
    await teamsPage.gotoList();
    await expect(teamsPage.teamCard(mainTeamId)).toBeVisible({ timeout: TIMEOUTS.VISIBLE });

    await teamsPage.search(MAIN_TEAM);
    await expect(teamsPage.teamCard(mainTeamId)).toBeVisible();
    await expect(teamsPage.teamCard(fullTeamId)).toBeHidden();

    await teamsPage.search(`no-such-team-${RUN_ID}`);
    await expect(page.getByTestId('organizations-empty-state')).toBeVisible();
  });

  test('Create Team is disabled while the team plan is closed', async ({ page, teamsPage }) => {
    // Stubbed rather than toggled: enableTeamPlan is a shared admin setting, and flipping it on a
    // shared env would close team purchases for real users for the length of the test.
    await page.route('**/api/settings/fetch', async route => {
      const response = await route.fetch();
      const settings: { settingName: string; settingValue: unknown }[] = await response.json();
      const rest = settings.filter(s => s.settingName !== 'enableTeamPlan');
      await route.fulfill({ response, json: [...rest, { settingName: 'enableTeamPlan', settingValue: 'false' }] });
    });

    await teamsPage.gotoList();
    await expect(page.getByTestId('organizations-create-team-btn')).toBeDisabled();
  });

  // --- Detail as owner -------------------------------------------------------------

  test('overview shows the plan and seat utilization', async ({ page, teamsPage }) => {
    await teamsPage.gotoList();
    await teamsPage.teamCard(mainTeamId).getByTestId('organization-card-view-btn').click();
    await page.waitForURL(`**/organizations/${mainTeamId}*`, { timeout: TIMEOUTS.NAVIGATION });

    await expect(teamsPage.tab('Overview')).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveTitle(new RegExp(MAIN_TEAM));
    await expect(page.getByTestId('subscription-status-card')).toContainText('Team Plan');
    await expect(page.getByTestId('seats-utilization-card')).toContainText('/ 6');
  });

  test('the owner sees every tab', async ({ teamsPage }) => {
    await teamsPage.gotoTeam(mainTeamId);
    expect(await teamsPage.visibleTabs()).toEqual(ALL_TEAM_TABS);
  });

  test('a ?tab= deep link opens that tab', async ({ page, teamsPage }) => {
    await teamsPage.gotoTeam(mainTeamId, 'members');
    await expect(teamsPage.tab('Members')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('organization-members-seats-card')).toBeVisible();
  });

  // --- Members --------------------------------------------------------------------

  test('inviting a user adds a pending row and takes a seat', async ({ teamsPage }) => {
    await teamsPage.gotoTeam(mainTeamId, 'members');
    await expect(teamsPage.memberRow(member.userId)).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    const before = await teamsPage.seatsUsed();

    // The invitee shares no team or project with the owner, so the non-admin picker only reaches
    // them by their exact, fully typed email (pages/api/users/index.ts); a name search finds nothing.
    await teamsPage.inviteMember(invitee.email, seededName(invitee));

    const row = teamsPage.memberRow(invitee.userId);
    await expect(row).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await expect(row).toContainText('Pending');
    await expect.poll(async () => (await teamsPage.seatsUsed()).used).toBe(before.used + 1);
  });

  test('cancelling a pending invite frees the seat', async ({ teamsPage, page }) => {
    await teamsPage.gotoTeam(mainTeamId, 'members');
    await expect(teamsPage.memberRow(invitee.userId)).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    const before = await teamsPage.seatsUsed();

    await teamsPage.openMemberMenu(invitee.userId);
    await page.getByTestId('organization-user-card-cancel-invite').click();
    await teamsPage.confirm();

    await expect(teamsPage.memberRow(invitee.userId)).toBeHidden({ timeout: TIMEOUTS.VISIBLE });
    await expect.poll(async () => (await teamsPage.seatsUsed()).used).toBe(before.used - 1);
  });

  test('revoking an active member removes them from the roster', async ({ teamsPage, page, request }) => {
    await apiAddTeamMember(request, owner.accessToken, mainTeamId, invitee.userId);

    await teamsPage.gotoTeam(mainTeamId, 'members');
    const row = teamsPage.memberRow(invitee.userId);
    await expect(row).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await expect(row).not.toContainText('Pending');

    await teamsPage.openMemberMenu(invitee.userId);
    await page.getByTestId('organization-user-card-revoke-access').click();
    await teamsPage.confirm();

    await expect(row).toBeHidden({ timeout: TIMEOUTS.VISIBLE });
  });

  test('member search filters the roster and sort reverses it', async ({ page, teamsPage }) => {
    await teamsPage.gotoTeam(mainTeamId, 'members');
    await expect(teamsPage.memberRow(member.userId)).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await expect(teamsPage.memberRow(manager.userId)).toBeVisible();

    const rowIds = () => teamsPage.memberRows().evaluateAll(rows => rows.map(r => r.getAttribute('data-user-id')));
    const ascending = await rowIds();
    await page.getByTestId('organization-members-sort-btn').click();
    await expect.poll(rowIds).toEqual([...ascending].reverse());

    await page.getByTestId('organization-members-search-input').fill(seededName(member));
    await expect(teamsPage.memberRow(manager.userId)).toBeHidden({ timeout: TIMEOUTS.VISIBLE });
    await expect(teamsPage.memberRow(member.userId)).toBeVisible();
  });

  test('the owner can set a member monthly credit limit', async ({ page, teamsPage }) => {
    await teamsPage.gotoTeam(mainTeamId, 'members');
    await expect(teamsPage.memberRow(member.userId)).toBeVisible({ timeout: TIMEOUTS.VISIBLE });

    await teamsPage.openMemberMenu(member.userId);
    await page.getByTestId('organization-user-card-set-limit').click();
    const modal = page.getByTestId('credit-limit-modal');
    await expect(modal).toBeVisible({ timeout: TIMEOUTS.MODAL });
    await page.getByTestId('credit-limit-input').fill('500');
    await page.getByTestId('credit-limit-save-btn').click();
    await expect(modal).toBeHidden({ timeout: TIMEOUTS.MODAL });

    await expect(teamsPage.memberRow(member.userId).getByTestId('organization-user-card-credit-usage')).toContainText(
      '(own limit)',
      { timeout: TIMEOUTS.VISIBLE }
    );
  });

  // --- Seats ------------------------------------------------------------------------

  test('a full team blocks Add Member', async ({ page, teamsPage }) => {
    await teamsPage.gotoTeam(fullTeamId, 'members');
    await expect(page.getByTestId('organization-members-seats-limit')).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await expect(page.getByTestId('organization-members-add-btn')).toHaveCount(0);

    await page.getByTestId('organization-members-add-no-seats-btn').click();
    await expect(page.getByText('No seats available', { exact: false }).first()).toBeVisible({
      timeout: TIMEOUTS.VISIBLE,
    });
  });

  test('an admin raising seats re-opens Add Member for the owner', async ({ page, teamsPage, browser, baseURL }) => {
    const asAdmin = await openTeamsPageAs(browser, baseURL, admin);
    try {
      const adminPage = new AdminPage(asAdmin.page);
      await adminPage.gotoAdmin();
      await adminPage.navigateToOrganizationsTab();
      await asAdmin.page.getByTestId('admin-organizations-search-input').fill(FULL_TEAM);
      await asAdmin.page.getByTestId(`org-actions-${fullTeamId}`).filter({ visible: true }).first().click();
      await asAdmin.page.getByTestId(`adjust-seats-${fullTeamId}`).click();
      await asAdmin.page.getByTestId('seats-input').locator('input').fill('4');
      await asAdmin.page.getByTestId('seats-reason-input-preset-0').click();
      const seatsSaved = asAdmin.page.waitForResponse(
        r => r.request().method() === 'PATCH' && r.url().includes(`/api/admin/organizations/${fullTeamId}/seats`)
      );
      await asAdmin.page.getByTestId('seats-submit').click();
      expect((await seatsSaved).ok()).toBe(true);
    } finally {
      await asAdmin.close();
    }

    await teamsPage.gotoTeam(fullTeamId, 'members');
    await expect(page.getByTestId('organization-members-add-btn')).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await expect(page.getByTestId('organization-members-seats-limit')).toBeHidden();
    expect((await teamsPage.seatsUsed()).max).toBe(4);
  });

  // --- Roles ------------------------------------------------------------------------

  test('a plain member sees only Overview and Members, with no roster controls', async ({ browser, baseURL }) => {
    const { page, teamsPage, close } = await openTeamsPageAs(browser, baseURL, member);
    try {
      await teamsPage.gotoTeam(mainTeamId);
      expect(await teamsPage.visibleTabs()).toEqual(['Overview', 'Members']);

      await teamsPage.openTab('Members');
      await expect(teamsPage.memberRow(manager.userId)).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
      await expect(page.getByTestId('organization-members-add-btn')).toHaveCount(0);
      await expect(page.getByTestId('organization-members-seats-card')).toHaveCount(0);
      await expect(teamsPage.memberRow(manager.userId).getByTestId('org-user-card-menu-btn')).toHaveCount(0);

      // A deep link to an owner-only tab falls back to Overview rather than rendering it.
      await teamsPage.gotoTeam(mainTeamId, 'billing');
      await expect(teamsPage.tab('Overview')).toHaveAttribute('aria-selected', 'true');
    } finally {
      await close();
    }
  });

  test('the owner appoints a manager, who gains roster control but not billing', async ({
    page,
    teamsPage,
    browser,
    baseURL,
  }) => {
    await teamsPage.gotoTeam(mainTeamId, 'groups');
    const managersInput = page.getByTestId('org-admins-input').locator('input');
    await managersInput.click();
    await managersInput.fill(seededName(manager));
    await page.getByRole('option', { name: seededName(manager) }).click();
    const saved = page.waitForResponse(
      r => r.request().method() === 'PUT' && r.url().includes(`/api/organizations/${mainTeamId}/admins`)
    );
    await page.getByTestId('org-admins-save-btn').click();
    expect((await saved).ok()).toBe(true);

    const asManager = await openTeamsPageAs(browser, baseURL, manager);
    try {
      await asManager.teamsPage.gotoTeam(mainTeamId);
      const tabs = await asManager.teamsPage.visibleTabs();
      expect(tabs).toEqual(expect.arrayContaining(['Overview', 'Members', 'Analysis']));
      for (const ownerOnly of ['Billing', 'Usage', 'Integrations']) {
        expect(tabs).not.toContain(ownerOnly);
      }

      await asManager.teamsPage.openTab('Members');
      await expect(asManager.page.getByTestId('organization-members-add-btn')).toBeVisible({
        timeout: TIMEOUTS.VISIBLE,
      });
    } finally {
      await asManager.close();
    }
  });

  // --- Settings ---------------------------------------------------------------------

  test('the team AI context saves and survives a reload', async ({ page, teamsPage }) => {
    const context = `E2E team context ${RUN_ID}`;
    await teamsPage.gotoTeam(mainTeamId, 'settings');
    const input = page.getByTestId('organization-settings-system-prompt-input');
    await input.fill(context);
    const saved = page.waitForResponse(
      r => r.request().method() === 'PUT' && new URL(r.url()).pathname === `/api/organizations/${mainTeamId}`
    );
    await page.getByTestId('organization-settings-system-prompt-save-btn').click();
    expect((await saved).ok()).toBe(true);

    await teamsPage.gotoTeam(mainTeamId, 'settings');
    await expect(page.getByTestId('organization-settings-system-prompt-input')).toHaveValue(context);
  });

  test('a team with an active subscription cannot be deleted', async ({ page, teamsPage, request }) => {
    await teamsPage.gotoTeam(disposableTeamId, 'settings');
    await page.getByTestId('organization-settings-delete-btn').click();
    await teamsPage.confirm();

    await expect(page.getByText('Organization has active subscriptions', { exact: false }).first()).toBeVisible({
      timeout: TIMEOUTS.VISIBLE,
    });
    await expect(page).toHaveURL(new RegExp(`/organizations/${disposableTeamId}`));
    expect(await apiGetTeam(request, owner.accessToken, disposableTeamId)).not.toBeNull();
  });

  test('deleting a team returns to the list without it', async ({ page, teamsPage, request }) => {
    // The seeded grant is an active subscription, which blocks deletion (previous test).
    expect((await apiRevokeTeamGrant(request, adminToken, disposableTeamId)).ok()).toBe(true);

    await teamsPage.gotoTeam(disposableTeamId, 'settings');
    await page.getByTestId('organization-settings-delete-btn').click();
    await teamsPage.confirm();

    await page.waitForURL(/\/organizations\/?(?:\?|$)/, { timeout: TIMEOUTS.NAVIGATION });
    await expect(teamsPage.teamCard(mainTeamId)).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await expect(teamsPage.teamCard(disposableTeamId)).toHaveCount(0);
    expect(await apiGetTeam(request, owner.accessToken, disposableTeamId)).toBeNull();
  });
});
