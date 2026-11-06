import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';
import { randomUUID } from 'crypto';
import { Resource } from 'sst';
import { test, expect } from './fixtures';
import { TIMEOUTS } from './constants';
import { apiCreateTestUser, apiCreateThrowawayUser, apiUpdateAdminSetting } from './helpers/api';
import { seedAuthOnPage } from './helpers/auth-seed';
import { getE2ETestId, getTestRunId, getTestUsers } from './helpers/test-users';
import { AdminPage } from './pages/AdminPage';

/**
 * Two-person approval for bulk user actions: admin A (the core admin) requests, a second admin B
 * decides. The settings are global: approvals are switched on with a threshold of 1 while this file
 * runs and switched back off afterwards.
 */

const baseURL = process.env.API_URL || 'http://localhost:3000';
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const SUSPEND = { type: 'suspend' } as const;
const PASSWORD = 'E2eApproverPass123!';

type Admin = { userId: string; accessToken: string; refreshToken: string; password: string };

async function stepUp(request: APIRequestContext, admin: Admin) {
  const res = await request.post(`${baseURL}/api/auth/step-up`, {
    headers: auth(admin.accessToken),
    data: { method: 'password', password: admin.password },
  });
  expect(res.ok(), `step-up failed: ${res.status()}`).toBe(true);
}

async function previewSuspend(request: APIRequestContext, token: string, userIds: string[]) {
  const res = await request.post(`${baseURL}/api/admin/users/bulk/preview`, {
    headers: auth(token),
    data: { target: { kind: 'ids', userIds }, action: SUSPEND },
  });
  expect(res.ok(), `preview failed: ${res.status()}`).toBe(true);
  return (await res.json()) as { eligible: number; alreadyApplied: number; cohortHash: string };
}

async function executeSuspend(request: APIRequestContext, token: string, userIds: string[]) {
  const { eligible, cohortHash } = await previewSuspend(request, token, userIds);
  return request.post(`${baseURL}/api/admin/users/bulk/execute`, {
    headers: auth(token),
    data: {
      target: { kind: 'ids', userIds },
      action: SUSPEND,
      reason: 'E2E two-person approval check',
      idempotencyKey: randomUUID(),
      expectedCount: eligible,
      cohortHash,
    },
  });
}

async function requestApproval(request: APIRequestContext, token: string, userIds: string[]) {
  const res = await executeSuspend(request, token, userIds);
  expect(res.status()).toBe(202);
  const body = (await res.json()) as { approvalId: string; status: string };
  expect(body.status).toBe('pending');
  return body.approvalId;
}

const approve = (request: APIRequestContext, token: string, id: string) =>
  request.post(`${baseURL}/api/admin/approvals/${id}/approve`, { headers: auth(token) });

async function editApproval(request: APIRequestContext, approvalId: string, op: 'tamper' | 'expire') {
  const secret = process.env.E2E_CLEANUP_SECRET || Resource.E2E_CLEANUP_SECRET?.value;
  const res = await request.post(`${baseURL}/api/test/admin-approval`, {
    headers: { 'x-e2e-cleanup-secret': secret ?? '' },
    data: { approvalId, op },
  });
  expect(res.ok(), `test approval edit failed: ${res.status()}`).toBe(true);
}

async function openApprovals(page: Page) {
  await new AdminPage(page).gotoAdmin();
  const navButton = page.getByTestId('admin-approvals-btn').filter({ visible: true }).first();
  const mobileMenu = page.getByTestId('admin-mobile-menu-btn').filter({ visible: true });
  await expect(navButton.or(mobileMenu.first())).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
  if (!(await navButton.isVisible())) await mobileMenu.first().click();
  await navButton.click();
  await expect(page.getByTestId('admin-approvals-queue')).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
}

test.describe('Admin approvals - a second admin decides bulk suspends', () => {
  test.describe.configure({ mode: 'serial' });

  let adminA: Admin;
  let adminB: Admin;
  let targets: string[];
  // One context for B: its refresh token rotates on first use, and replaying it revokes the session.
  let contextB: BrowserContext;
  let pageB: Page;

  test.beforeAll(async ({ request, browser }) => {
    const core = getTestUsers().admin;
    adminA = { ...core };
    const e2eId = getE2ETestId();
    const suffix = e2eId ? `${e2eId}-${getTestRunId()}` : getTestRunId();
    const created = await apiCreateTestUser(request, {
      username: `setup-approver-${suffix}`,
      email: `setup-approver-${suffix}-e2e@test.com`,
      name: `Setup approver ${suffix}`,
      password: PASSWORD,
      isAdmin: true,
    });
    adminB = {
      userId: (created.user.id || created.user._id) as string,
      accessToken: created.accessToken,
      refreshToken: created.refreshToken,
      password: PASSWORD,
    };
    targets = [];
    for (const label of ['apra', 'aprb', 'aprc', 'aprd', 'apre']) {
      targets.push((await apiCreateThrowawayUser(request, label)).userId);
    }

    await apiUpdateAdminSetting(request, adminA.accessToken, 'AdminApprovalBulkUserThreshold', 1);
    await apiUpdateAdminSetting(request, adminA.accessToken, 'AdminApprovalsEnabled', true);
    await stepUp(request, adminA);
    await stepUp(request, adminB);

    contextB = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
    pageB = await contextB.newPage();
    await seedAuthOnPage(pageB, adminB);
  });

  test.afterAll(async ({ request }) => {
    await contextB?.close();
    await apiUpdateAdminSetting(request, adminA.accessToken, 'AdminApprovalsEnabled', false);
    await apiUpdateAdminSetting(request, adminA.accessToken, 'AdminApprovalBulkUserThreshold', 25);
  });

  test('a held suspend cannot be self-approved and runs once the second admin approves it', async ({
    page,
    request,
  }) => {
    const pair = [targets[0], targets[1]];
    const approvalId = await requestApproval(request, adminA.accessToken, pair);
    expect((await previewSuspend(request, adminA.accessToken, pair)).alreadyApplied).toBe(0);

    const selfApprove = await approve(request, adminA.accessToken, approvalId);
    expect(selfApprove.status()).toBe(403);
    expect(await selfApprove.text()).not.toContain('step_up');
    expect((await previewSuspend(request, adminA.accessToken, pair)).alreadyApplied).toBe(0);

    await openApprovals(page);
    const ownRow = page.getByTestId(`admin-approval-row-${approvalId}`);
    await expect(ownRow).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
    await expect(ownRow.getByTestId('admin-approve-btn')).toBeDisabled();

    await openApprovals(pageB);
    const row = pageB.getByTestId(`admin-approval-row-${approvalId}`);
    await expect(row).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
    await row.getByTestId('admin-approve-btn').click();
    await expect(row).toHaveCount(0, { timeout: TIMEOUTS.ACTION });

    await expect
      .poll(async () => (await previewSuspend(request, adminA.accessToken, pair)).alreadyApplied, {
        timeout: TIMEOUTS.ACTION,
      })
      .toBe(2);
  });

  test('tampered params answer 409, an expired request 410, and neither changes anyone', async ({ request }) => {
    const pair = [targets[2], targets[3]];
    const tampered = await requestApproval(request, adminA.accessToken, pair);
    await editApproval(request, tampered, 'tamper');
    expect((await approve(request, adminB.accessToken, tampered)).status()).toBe(409);

    const expired = await requestApproval(request, adminA.accessToken, pair);
    await editApproval(request, expired, 'expire');
    expect((await approve(request, adminB.accessToken, expired)).status()).toBe(410);

    expect((await previewSuspend(request, adminA.accessToken, pair)).alreadyApplied).toBe(0);
  });

  test('the second admin rejects a held request from the queue', async ({ request }) => {
    const pair = [targets[2], targets[3]];
    const approvalId = await requestApproval(request, adminA.accessToken, pair);

    await openApprovals(pageB);
    const row = pageB.getByTestId(`admin-approval-row-${approvalId}`);
    await expect(row).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
    await row.getByTestId('admin-reject-btn').click();
    await pageB.getByTestId('admin-approval-reject-dialog-reason-input').fill('Not needed after review');
    await pageB.getByTestId('admin-approval-reject-dialog-confirm-btn').click();
    await expect(row).toHaveCount(0, { timeout: TIMEOUTS.ACTION });

    expect((await approve(request, adminB.accessToken, approvalId)).status()).toBe(409);
    expect((await previewSuspend(request, adminA.accessToken, pair)).alreadyApplied).toBe(0);
  });

  test('a suspend at the threshold runs immediately', async ({ request }) => {
    const single = [targets[4]];
    const res = await executeSuspend(request, adminA.accessToken, single);
    expect(res.status()).toBe(200);
    expect((await previewSuspend(request, adminA.accessToken, single)).alreadyApplied).toBe(1);
  });
});
