import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures';
import { apiCreateTestUser } from './helpers/api';
import { getE2ETestId, getTestRunId, getTestUsers } from './helpers/test-users';
import { AdminPage } from './pages/AdminPage';

/**
 * Quarterly admin access review: the core admin (A) reviews a fresh full admin (B, never acted, no
 * MFA, so dormant) and a fresh delegated admin (C), revokes C through the UI and exports the CSV.
 */

const baseURL = process.env.API_URL || 'http://localhost:3000';
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const PASSWORD = 'E2eAccessReviewPass123!';

type ReportRow = { userId: string; fullAdmin: boolean; permissions: string[]; dormant: boolean; noMfa: boolean };

async function stepUp(request: APIRequestContext, token: string, password: string) {
  const res = await request.post(`${baseURL}/api/auth/step-up`, {
    headers: auth(token),
    data: { method: 'password', password },
  });
  expect(res.ok(), `step-up failed: ${res.status()}`).toBe(true);
}

async function createUser(request: APIRequestContext, slug: string, isAdmin: boolean) {
  const e2eId = getE2ETestId();
  const suffix = e2eId ? `${e2eId}-${getTestRunId()}` : getTestRunId();
  const { retry, repeatEachIndex } = test.info();
  const name = `${slug}${retry}r${repeatEachIndex}-${suffix}`;
  const created = await apiCreateTestUser(request, {
    username: name,
    email: `${name}-e2e@test.com`,
    name,
    password: PASSWORD,
    isAdmin,
  });
  return (created.user.id || created.user._id) as string;
}

test.describe('Admin access review', () => {
  test.describe.configure({ mode: 'serial' });

  const adminA = getTestUsers().admin;
  let adminB: string;
  let delegateC: string;

  test.beforeAll(async ({ request }) => {
    adminB = await createUser(request, 'access-review-b', true);
    delegateC = await createUser(request, 'access-review-c', false);
    await stepUp(request, adminA.accessToken, adminA.password);
    const grant = await request.put(`${baseURL}/api/admin/users/${delegateC}/permissions`, {
      headers: auth(adminA.accessToken),
      data: { before: [], adminPermissions: ['users:read'], reason: 'access review e2e setup' },
    });
    expect(grant.ok(), `delegate grant failed: ${grant.status()}`).toBe(true);
  });

  test('the report lists the seeded admins and a self-confirm is refused', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/admin/access-review/report`, { headers: auth(adminA.accessToken) });
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { admins: ReportRow[] };
    const b = body.admins.find(row => row.userId === adminB);
    const c = body.admins.find(row => row.userId === delegateC);
    expect(b).toMatchObject({ fullAdmin: true, dormant: true, noMfa: true });
    expect(c).toMatchObject({ fullAdmin: false, permissions: ['users:read'] });

    const self = await request.post(`${baseURL}/api/admin/access-review/decisions`, {
      headers: auth(adminA.accessToken),
      data: { userId: adminA.userId, decision: 'confirmed' },
    });
    expect(self.status()).toBe(403);
  });

  test('revoking the delegate in the tab removes its access and records the decision', async ({ page, request }) => {
    const admin = new AdminPage(page);
    await admin.gotoAdmin();
    await admin.navigateToAccessReview();

    const own = page.getByTestId(`admin-access-review-row-${adminA.userId}`);
    await expect(own.getByTestId('admin-access-review-row-actions')).toBeDisabled();
    const rowB = page.getByTestId(`admin-access-review-row-${adminB}`);
    await expect(rowB.getByTestId('admin-access-review-dormant-chip')).toBeVisible();
    await expect(rowB.getByTestId('admin-access-review-no-mfa-chip')).toBeVisible();

    await page
      .getByTestId(`admin-access-review-row-${delegateC}`)
      .getByTestId('admin-access-review-row-actions')
      .click();
    await page.getByTestId('admin-access-review-revoke-btn').click();
    await page.getByTestId('admin-access-review-revoke-reason-input').fill('no longer needs admin access');
    await page.getByTestId('admin-access-review-revoke-confirm-btn').click();
    await expect(page.getByTestId('admin-access-review-revoke-dialog')).toBeHidden();
    await expect(page.getByTestId(`admin-access-review-row-${delegateC}`)).toContainText('Revoked');

    const report = await request.get(`${baseURL}/api/admin/access-review/report`, {
      headers: auth(adminA.accessToken),
    });
    const { admins } = (await report.json()) as { admins: ReportRow[] };
    expect(admins.some(row => row.userId === delegateC)).toBe(false);

    const audit = await request.get(`${baseURL}/api/admin/audit-log`, {
      headers: auth(adminA.accessToken),
      params: { action: 'user.permissions.updated', targetKind: 'user', targetId: delegateC },
    });
    expect(audit.ok()).toBe(true);
    const { entries } = (await audit.json()) as { entries: { details?: { after?: unknown } }[] };
    expect(entries.length).toBeGreaterThanOrEqual(2);
  });

  test('the CSV export carries only the allow-listed columns', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/admin/access-review/export`, { headers: auth(adminA.accessToken) });
    expect(res.ok()).toBe(true);
    const csv = await res.text();
    const header = csv.split(/\r?\n/)[0];
    expect(header).toBe(
      'quarter,userId,email,username,fullAdmin,permissions,grantedBy,grantedAt,lastAdminActionAt,lastSignInAt,mfaEnabled,dormant,decision,reviewerName,reviewerUserId,decidedAt,reviewCompletedAt'
    );
    expect(csv).not.toMatch(/totpSecret|backupCodes|keyHash|apiKey/i);
    expect(csv).toContain(delegateC);
  });
});
