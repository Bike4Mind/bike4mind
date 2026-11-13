import type { APIRequestContext, Browser, Page } from '@playwright/test';
import { test, expect, openPageAs } from './fixtures';
import { TIMEOUTS } from './constants';
import { apiCreateTestUser, apiCreateThrowawayUser, apiGetAdminSettings, apiUpdateAdminSetting } from './helpers/api';
import { isProductionEnv, isSharedRealEnv } from './helpers/env';
import { getE2ETestId, getTestRunId, getTestUsers } from './helpers/test-users';
import { AdminPage } from './pages/AdminPage';

/**
 * Bulk actions on the admin Users list: Contain (dry run, run, Undo), the help legend, and the
 * routes behind banning a selection or a domain and blocking signup grants. Every write targets
 * only throwaway users this file created, picked by id. Anything global (a domain ban, the approval
 * settings) runs only off staging and production.
 */

const baseURL = process.env.API_URL || 'http://localhost:3000';
const INITIAL_CREDITS = 50;
const REASON = 'E2E bulk action check on throwaway users';
const APPROVER_PASSWORD = 'E2eBulkApproverPass123!';
const BAN_ACTIONS = { ban: true, revokeApiKeys: true, revokeSessions: true, clawbackFreeCredits: false };
const BULK_ACTION_LABELS = {
  suspend: 'Suspend',
  restrict: 'Restrict',
  adjustCredits: 'Adjust credits',
  revokeApiKeys: 'Revoke API keys',
  addTag: 'Add tag',
  contain: 'Contain',
} as const;

type Throwaway = { email: string; userId: string };
type Admin = { userId: string; accessToken: string };

// Bulk routes are csrf-checked on cookie sessions; a same-origin Origin keeps a refusal from being a CSRF one.
const writeHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, Origin: new URL(baseURL).origin });

const runSuffix = () => {
  const e2eId = getE2ETestId();
  return e2eId ? `${e2eId}-${getTestRunId()}` : getTestRunId();
};

async function createThrowaways(request: APIRequestContext, labels: string[]): Promise<Throwaway[]> {
  const users: Throwaway[] = [];
  for (const label of labels) {
    const { email, userId } = await apiCreateThrowawayUser(request, label, {
      initialCredits: INITIAL_CREDITS,
      includePredefinedTags: false,
    });
    users.push({ email, userId });
  }
  return users;
}

async function postJson<T>(request: APIRequestContext, token: string, path: string, data: unknown): Promise<T> {
  const res = await request.post(`${baseURL}${path}`, { headers: writeHeaders(token), data });
  expect(res.ok(), `${path} answered ${res.status()}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

type ContainPreview = { eligible: number; alreadyApplied: number; creditsDelta: number };
const previewContain = (request: APIRequestContext, token: string, users: Throwaway[]) =>
  postJson<ContainPreview>(request, token, '/api/admin/users/bulk/preview', {
    target: { kind: 'ids', userIds: users.map(user => user.userId) },
    action: { type: 'contain' },
  });

async function expectNotContained(request: APIRequestContext, token: string, users: Throwaway[]) {
  const preview = await previewContain(request, token, users);
  expect(preview).toMatchObject({
    eligible: users.length,
    alreadyApplied: 0,
    creditsDelta: users.length * INITIAL_CREDITS,
  });
}

/**
 * Lists only this run's accounts (rows are then picked one by one by id). Waits for the searched page
 * itself: the list changing its filter drops any selection, so ticking a row of the previous page loses it.
 */
async function openUsersList(page: Page) {
  const adminPage = new AdminPage(page);
  await adminPage.gotoAdmin();
  await adminPage.navigateToUsersTab();
  const query = runSuffix();
  const input = page.getByTestId('admin-users-search-input');
  // The search persists per browser, so a second visit in the same test already shows it.
  if ((await input.inputValue()) !== query) {
    const searched = page.waitForResponse(
      res => res.url().includes('/api/admin/users?') && new URL(res.url()).searchParams.get('search') === query
    );
    await input.fill(query);
    await searched;
  }
  await expect(page.locator('tr[data-testid^="admin-users-row-"]').filter({ hasNotText: query })).toHaveCount(0, {
    timeout: TIMEOUTS.ACTION,
  });
  await expect(page.getByTestId('admin-table-skeleton-row')).toHaveCount(0, { timeout: TIMEOUTS.ACTION });
}

/** Ticks each row from the keyboard: at 1280x720 the docked bulk bar can cover a checkbox. */
async function selectRows(page: Page, users: Throwaway[]) {
  for (const { userId } of users) {
    const row = page.getByTestId(`admin-users-row-${userId}`);
    await expect(row).toBeVisible({ timeout: TIMEOUTS.ACTION });
    await row.focus();
    await row.press('x');
    await expect(row).toHaveAttribute('aria-selected', 'true');
  }
  await expect(page.getByTestId('admin-bulk-action-bar')).toContainText(`${users.length} selected`);
}

async function expectStatus(page: Page, users: Throwaway[], label: 'Suspended' | 'New') {
  for (const { userId } of users) {
    await expect(page.getByTestId(`admin-users-status-${userId}`)).toHaveText(label, { timeout: TIMEOUTS.ACTION });
  }
}

/** Opens the Contain dialog and checks the dry run names exactly the selected users. */
async function openContainDryRun(page: Page, users: Throwaway[]) {
  const previewRequest = page.waitForRequest(
    req => req.url().includes('/api/admin/users/bulk/preview') && req.method() === 'POST'
  );
  await page.getByTestId('admin-users-bulk-contain-btn').click();
  const body = (await previewRequest).postDataJSON() as { target: { kind: string; userIds?: string[] } };
  expect(body.target.kind).toBe('ids');
  expect([...(body.target.userIds ?? [])].sort()).toEqual(users.map(user => user.userId).sort());

  const dialog = page.getByTestId('admin-users-bulk-contain');
  const dryRun = dialog.getByTestId('admin-users-bulk-dry-run');
  await expect(dryRun).toContainText(`${users.length} users will change.`, { timeout: TIMEOUTS.ACTION });
  for (const { email } of users) await expect(dryRun).toContainText(email);
  await expect(dryRun).not.toContainText('New signups blocked');
  return dialog;
}

async function stepUp(request: APIRequestContext, token: string, password: string) {
  const res = await request.post(`${baseURL}/api/auth/step-up`, {
    headers: writeHeaders(token),
    data: { method: 'password', password },
  });
  expect(res.ok(), `step-up failed: ${res.status()}`).toBe(true);
}

/** A second full admin, signed in on a page of its own and freshly stepped up to approve. */
async function openApprover(
  browser: Browser,
  request: APIRequestContext
): Promise<{ page: Page; close: () => Promise<void> }> {
  const { retry, repeatEachIndex } = test.info();
  const slug = `setup-bulkapprover${retry}r${repeatEachIndex}`;
  const suffix = runSuffix();
  const created = await apiCreateTestUser(request, {
    username: `${slug}-${suffix}`,
    email: `${slug}-${suffix}-e2e@test.com`,
    name: `Setup bulk approver ${suffix}`,
    password: APPROVER_PASSWORD,
    isAdmin: true,
  });
  const approver: Admin = { userId: (created.user.id || created.user._id) as string, accessToken: created.accessToken };
  await stepUp(request, approver.accessToken, APPROVER_PASSWORD);
  return openPageAs(browser, baseURL, approver);
}

async function approveInQueue(page: Page, approvalId: string) {
  await new AdminPage(page).gotoAdmin();
  const navButton = page.getByTestId('admin-approvals-btn').filter({ visible: true }).first();
  const mobileMenu = page.getByTestId('admin-mobile-menu-btn').filter({ visible: true });
  await expect(navButton.or(mobileMenu.first())).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
  if (!(await navButton.isVisible())) await mobileMenu.first().click();
  await navButton.click();
  const row = page.getByTestId(`admin-approval-row-${approvalId}`);
  await expect(row).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
  await row.getByTestId('admin-approve-btn').click();
  await expect(row).toHaveCount(0, { timeout: TIMEOUTS.ACTION });
}

/**
 * Selection, dry run, Contain and Undo through the Users list. Over the approval threshold the run is
 * held: it changes nobody until a second admin approves it, whose page then carries the Undo toast.
 */
async function containThenUndo(
  page: Page,
  browser: Browser,
  request: APIRequestContext,
  users: Throwaway[],
  expectHeld?: boolean
) {
  const admin = getTestUsers().admin;
  await expectNotContained(request, admin.accessToken, users);

  await openUsersList(page);
  await selectRows(page, users);

  let dialog = await openContainDryRun(page, users);
  await dialog.getByTestId('admin-users-bulk-contain-cancel-btn').click();
  await expect(dialog).toBeHidden({ timeout: TIMEOUTS.MODAL });
  await expectStatus(page, users, 'New');
  await expectNotContained(request, admin.accessToken, users);

  dialog = await openContainDryRun(page, users);
  await dialog.getByTestId('admin-users-bulk-contain-reason-input-preset-0').click();
  const executed = page.waitForResponse(
    res => res.url().includes('/api/admin/users/bulk/execute') && res.request().method() === 'POST'
  );
  await dialog.getByTestId('admin-users-bulk-contain-confirm-btn').click();
  const response = await executed;
  expect([200, 202], `execute answered ${response.status()}`).toContain(response.status());
  const held = response.status() === 202;
  if (expectHeld !== undefined) expect(held, 'whether Contain waits for a second admin').toBe(expectHeld);

  let resultPage = page;
  let closeApprover: (() => Promise<void>) | undefined;
  try {
    if (held) {
      const { approvalId } = (await response.json()) as { approvalId: string };
      await expect(page.getByText('Submitted for approval.')).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
      await expectNotContained(request, admin.accessToken, users);
      const approver = await openApprover(browser, request);
      closeApprover = approver.close;
      resultPage = approver.page;
      await approveInQueue(resultPage, approvalId);
    }

    // Undo is offered for 30 s from the run, so the contained state is checked over the API, not the list.
    await expect(resultPage.getByTestId('undo-toast-message')).toContainText(`Contained ${users.length} users`, {
      timeout: TIMEOUTS.ACTION,
    });
    const contained = await previewContain(request, admin.accessToken, users);
    expect(contained).toMatchObject({ alreadyApplied: users.length, creditsDelta: 0 });

    await resultPage.getByTestId('undo-toast-undo-btn').click();
    await expect(resultPage.getByText(`Restored ${users.length} users`)).toBeVisible({ timeout: TIMEOUTS.ACTION });
  } finally {
    await closeApprover?.();
  }

  await expectNotContained(request, admin.accessToken, users);
  await openUsersList(page);
  await expectStatus(page, users, 'New');
}

test.describe('Admin bulk actions on the Users list', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(isProductionEnv(), 'Creates and bans throwaway accounts; never run on production.');
  test.setTimeout(180_000);

  test('the help legend explains every bulk action', async ({ page, request }) => {
    const users = await createThrowaways(request, ['bklga']);
    await openUsersList(page);
    await selectRows(page, users);

    await page.getByTestId('admin-users-bulk-help-btn').click();
    const legend = page.getByTestId('admin-users-bulk-legend');
    await expect(legend).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await expect(legend.locator('[data-testid^="admin-users-bulk-legend-"]')).toHaveCount(
      Object.keys(BULK_ACTION_LABELS).length
    );
    for (const [type, label] of Object.entries(BULK_ACTION_LABELS)) {
      // Typography nested in the tooltip renders as spans, so the entry reads as the label then its description.
      await expect(legend.getByTestId(`admin-users-bulk-legend-${type}`)).toHaveText(
        new RegExp(`^${label}\\s*\\S.{10,}`)
      );
    }
    await expect(legend).toContainText('undo it for 30 seconds');

    // A click pins the legend open over the bar; a second click on the help button closes it.
    await page.getByTestId('admin-users-bulk-help-btn').click();
    await expect(legend).toBeHidden();
    await page.getByTestId('admin-clear-selection-btn').click();
    await expect(page.getByTestId('admin-bulk-action-bar')).toBeHidden();
  });

  test('Contain: the dry run changes nothing, the run contains the selection and Undo restores it', async ({
    page,
    browser,
    request,
  }) => {
    // Approvals are a global setting left as found; if another run has them on, the held path runs.
    const users = await createThrowaways(request, ['bkcta', 'bkctb']);
    await containThenUndo(page, browser, request, users);
  });

  test('Contain over the approval threshold waits for a second admin', async ({ page, browser, request }) => {
    test.skip(
      isSharedRealEnv(),
      'Turns on two-person approval, a global setting; runs only off staging and production.'
    );
    const admin = getTestUsers().admin;
    const settings = await apiGetAdminSettings(request, admin.accessToken);
    const users = await createThrowaways(request, ['bkapa', 'bkapb']);
    await apiUpdateAdminSetting(request, admin.accessToken, 'AdminApprovalBulkUserThreshold', 1);
    await apiUpdateAdminSetting(request, admin.accessToken, 'AdminApprovalsEnabled', true);
    try {
      await containThenUndo(page, browser, request, users, true);
    } finally {
      await apiUpdateAdminSetting(
        request,
        admin.accessToken,
        'AdminApprovalsEnabled',
        settings.get('AdminApprovalsEnabled') ?? false
      );
      await apiUpdateAdminSetting(
        request,
        admin.accessToken,
        'AdminApprovalBulkUserThreshold',
        settings.get('AdminApprovalBulkUserThreshold') ?? 25
      );
    }
  });

  // The ban dialog opens only from the signup risk review queue, which throwaway accounts never enter,
  // so the ban runs over its routes and is reversed from the profile page.
  test('ban a selection: the preview names only the selection, the run bans it, Reinstate reverses it', async ({
    page,
    request,
  }) => {
    const admin = getTestUsers().admin;
    const users = await createThrowaways(request, ['bkbna', 'bkbnb']);
    const target = { kind: 'users', userIds: users.map(user => user.userId) };

    type BanPreview = {
      includedCount: number;
      alreadyBannedCount: number;
      excluded: unknown[];
      blocksDomain: string | null;
      previewToken: string;
    };
    const preview = await postJson<BanPreview>(request, admin.accessToken, '/api/admin/abuse/bulk-preview', {
      target,
      actions: BAN_ACTIONS,
    });
    expect(preview).toMatchObject({ includedCount: 2, alreadyBannedCount: 0, excluded: [], blocksDomain: null });
    const again = await postJson<BanPreview>(request, admin.accessToken, '/api/admin/abuse/bulk-preview', {
      target,
      actions: BAN_ACTIONS,
    });
    expect(again.alreadyBannedCount, 'a preview bans nobody').toBe(0);

    const result = await postJson<{ bannedCount: number; failedCount: number; blockedDomain: string | null }>(
      request,
      admin.accessToken,
      '/api/admin/abuse/bulk-execute',
      { target, actions: BAN_ACTIONS, previewToken: preview.previewToken, reason: REASON }
    );
    expect(result).toMatchObject({ bannedCount: 2, failedCount: 0, blockedDomain: null });

    await openUsersList(page);
    await expectStatus(page, users, 'Suspended');

    for (const { userId } of users) {
      await page.goto(`/admin/users/${userId}`);
      await expect(page.getByTestId('user-profile-status-banner')).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
      await page.getByTestId('user-profile-reinstate-btn').click();
      const dialog = page.getByTestId('reinstate-dialog');
      await dialog.getByTestId('reinstate-dialog-reason-input-preset-0').click();
      await dialog.getByTestId('reinstate-dialog-confirm-btn').click();
      await expect(dialog).toBeHidden({ timeout: TIMEOUTS.ACTION });
      await expect(page.getByTestId('user-profile-status-banner')).toBeHidden({ timeout: TIMEOUTS.ACTION });
    }

    const after = await postJson<BanPreview>(request, admin.accessToken, '/api/admin/abuse/bulk-preview', {
      target,
      actions: BAN_ACTIONS,
    });
    expect(after.alreadyBannedCount).toBe(0);
    await openUsersList(page);
    await expectStatus(page, users, 'New');
  });

  test('ban a domain: the preview changes nothing and the run blocks new signups from it', async ({ request }) => {
    test.skip(isSharedRealEnv(), 'Writes the global blocked email domains list; runs only off staging and production.');
    const admin = getTestUsers().admin;
    const { retry, repeatEachIndex } = test.info();
    // A reserved .test name nobody can sign up with, unique to this run.
    const domain = `bulk-ban-${runSuffix()}-${retry}r${repeatEachIndex}.e2e.test`.toLowerCase();
    const target = { kind: 'domain', domain };
    const blockedDomains = async () => {
      const value = (await apiGetAdminSettings(request, admin.accessToken)).get('blockedEmailDomains');
      return Array.isArray(value) ? value.map(String) : [];
    };

    const preview = await postJson<{ includedCount: number; blocksDomain: string | null; previewToken: string }>(
      request,
      admin.accessToken,
      '/api/admin/abuse/bulk-preview',
      { target, actions: BAN_ACTIONS }
    );
    expect(preview).toMatchObject({ includedCount: 0, blocksDomain: domain });
    expect(await blockedDomains()).not.toContain(domain);

    try {
      const result = await postJson<{ bannedCount: number; blockedDomain: string | null }>(
        request,
        admin.accessToken,
        '/api/admin/abuse/bulk-execute',
        { target, actions: BAN_ACTIONS, previewToken: preview.previewToken, reason: REASON }
      );
      expect(result).toMatchObject({ bannedCount: 0, blockedDomain: domain });
      expect(await blockedDomains()).toContain(domain);
    } finally {
      const remaining = (await blockedDomains()).filter(entry => entry !== domain);
      await apiUpdateAdminSetting(request, admin.accessToken, 'blockedEmailDomains', remaining);
    }
    expect(await blockedDomains()).not.toContain(domain);
  });

  // create-user accounts carry no signup grant, so both runs must answer no_grant and change nothing.
  test('signup grant block and unblock: dry run and run both refuse accounts with no grant', async ({ request }) => {
    const admin = getTestUsers().admin;
    const users = await createThrowaways(request, ['bkgra', 'bkgrb']);
    const userIds = users.map(user => user.userId);
    type GrantResult = {
      dryRun: boolean;
      results: { userId: string; outcome: string; reason?: string }[];
      undoUserIds: string[];
    };

    for (const action of ['bulk-block', 'bulk-unblock'] as const) {
      const path = `/api/admin/signup-grants/${action}`;
      const dryRun = await postJson<GrantResult>(request, admin.accessToken, path, { userIds, dryRun: true });
      const run = await postJson<GrantResult>(request, admin.accessToken, path, { userIds, reason: REASON });
      for (const [result, isDryRun] of [
        [dryRun, true],
        [run, false],
      ] as const) {
        expect(result.dryRun).toBe(isDryRun);
        expect(result.undoUserIds).toEqual([]);
        const rows = result.results.map(({ userId, outcome, reason }) => ({ userId, outcome, reason }));
        expect(rows.sort((a, b) => a.userId.localeCompare(b.userId))).toEqual(
          [...userIds].sort().map(userId => ({ userId, outcome: 'noop', reason: 'no_grant' }))
        );
      }
    }
  });
});
