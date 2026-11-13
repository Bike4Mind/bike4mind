import type { APIRequestContext, Page } from '@playwright/test';
import type { AdminPermissionId } from '@bike4mind/common';
import { test, expect, openPageAs } from './fixtures';
import { TIMEOUTS } from './constants';
import { apiCreateThrowawayUser } from './helpers/api';
import { isProductionEnv } from './helpers/env';
import { getTestUsers, type TestUser } from './helpers/test-users';

/**
 * Delegated admin permissions: a full admin grants and revokes them through the profile editor
 * and its endpoint, and a delegate sees only the console tabs and API routes they open.
 *
 * Grants go only to throwaway users this run creates, and afterAll revokes whatever is still held
 * before global teardown deletes them. Nothing here changes a global admin setting.
 */

const baseURL = process.env.API_URL || 'http://localhost:3000';
const REASON = 'E2E delegated admin permissions check';
const EDITOR_GRANT: AdminPermissionId[] = ['support:read', 'settings:manage'];

type Delegate = { email: string; userId: string; accessToken: string };

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
// The request fixture carries the admin's session cookie, so csrfProtection checks the Origin of every write.
const writeHeaders = (token: string) => ({ ...bearer(token), Origin: new URL(baseURL).origin });

async function stepUp(request: APIRequestContext, admin: TestUser) {
  const res = await request.post(`${baseURL}/api/auth/step-up`, {
    headers: writeHeaders(admin.accessToken),
    data: { method: 'password', password: admin.password },
  });
  expect(res.ok(), `step-up failed: ${res.status()}`).toBe(true);
}

/** The target's stored permissions, read from the admin users list so cleanup never guesses them. */
async function readPermissions(request: APIRequestContext, admin: TestUser, email: string) {
  const res = await request.get(`${baseURL}/api/admin/users`, {
    headers: bearer(admin.accessToken),
    params: { search: email },
  });
  expect(res.ok(), `users list failed: ${res.status()}`).toBe(true);
  const { users } = (await res.json()) as { users: Array<{ email?: string; adminPermissions?: AdminPermissionId[] }> };
  const row = users.find(user => user.email === email);
  expect(row, `no users-list row for ${email}`).toBeDefined();
  return row?.adminPermissions ?? [];
}

function putPermissions(
  request: APIRequestContext,
  admin: TestUser,
  userId: string,
  before: AdminPermissionId[],
  adminPermissions: AdminPermissionId[]
) {
  return request.put(`${baseURL}/api/admin/users/${userId}/permissions`, {
    headers: writeHeaders(admin.accessToken),
    data: { before, adminPermissions, reason: REASON },
  });
}

async function revokeAll(request: APIRequestContext, admin: TestUser, delegate: Delegate) {
  const held = await readPermissions(request, admin, delegate.email);
  if (held.length === 0) return;
  const res = await putPermissions(request, admin, delegate.userId, held, []);
  expect(res.ok(), `revoke failed: ${res.status()} ${await res.text()}`).toBe(true);
}

async function latestPermissionsAudit(request: APIRequestContext, admin: TestUser, userId: string) {
  const res = await request.get(`${baseURL}/api/admin/audit-log`, {
    headers: bearer(admin.accessToken),
    params: { action: 'user.permissions.updated', targetId: userId, limit: '1' },
  });
  expect(res.ok(), `audit log failed: ${res.status()}`).toBe(true);
  const { entries } = (await res.json()) as {
    entries: Array<{ actor?: { userId?: string }; details?: { granted?: string[]; revoked?: string[] } }>;
  };
  return entries[0];
}

async function openConsole(page: Page) {
  await page.goto('/admin');
  await expect(page.getByTestId('admin-sidebar-nav').filter({ visible: true })).toBeVisible({
    timeout: TIMEOUTS.NAVIGATION,
  });
  // Long sections fold items behind "More"; open them all so a missing link means hidden, not folded.
  const folded = page.locator('[data-testid^="admin-sidebar-more-"][aria-expanded="false"]');
  for (let opened = 0; opened < 10 && (await folded.count()) > 0; opened++) {
    await folded.first().click();
  }
  await expect(folded).toHaveCount(0);
}

async function expectSidebar(page: Page, { shown, hidden }: { shown: string[]; hidden: string[] }) {
  for (const testId of shown) {
    await expect(page.getByTestId(testId).filter({ visible: true }), `${testId} should show`).toBeVisible();
  }
  for (const testId of hidden) {
    await expect(page.getByTestId(testId), `${testId} should be hidden`).toHaveCount(0);
  }
}

async function expectStatus(request: APIRequestContext, token: string, path: string, status: number) {
  const res = await request.get(`${baseURL}${path}`, { headers: bearer(token) });
  expect(res.status(), `GET ${path}`).toBe(status);
}

test.describe('Admin permissions - grant, scope and revoke through the editor', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(isProductionEnv(), 'Grants admin permissions; never on production');

  let admin: TestUser;
  let delegate: Delegate;
  // The delegate's own context: the request fixture would send the admin's session cookie along.
  let delegateApi: APIRequestContext;
  let delegatePage: Page;
  let closeDelegate: () => Promise<void>;

  test.beforeAll(async ({ request, browser, playwright }) => {
    admin = getTestUsers().admin;
    delegate = await apiCreateThrowawayUser(request, 'perm');
    delegateApi = await playwright.request.newContext();
    ({ page: delegatePage, close: closeDelegate } = await openPageAs(browser, baseURL, delegate));
  });

  test.afterAll(async ({ request }) => {
    await closeDelegate?.();
    await delegateApi?.dispose();
    if (!delegate) return;
    await stepUp(request, admin);
    await revokeAll(request, admin, delegate);
  });

  test('a full admin grants permissions in the profile editor and the grant is audited', async ({ page, request }) => {
    // The editor's PUT is step-up gated; the page runs on this same session, so stepping up here covers it.
    await stepUp(request, admin);
    await page.goto(`/admin/users/${delegate.userId}`);
    const fact = page.getByTestId('user-profile-fact-admin-permissions');
    await expect(fact).toContainText('None', { timeout: TIMEOUTS.NAVIGATION });

    await page.getByTestId('user-profile-admin-permissions-btn').click();
    const dialog = page.getByTestId('admin-permissions-dialog');
    await expect(dialog).toBeVisible({ timeout: TIMEOUTS.MODAL });
    await dialog.getByTestId('admin-permissions-dialog-support-read-checkbox').getByRole('checkbox').check();
    await dialog.getByTestId('admin-permissions-dialog-settings-manage-checkbox').getByRole('checkbox').check();
    await expect(dialog.getByTestId('admin-permissions-dialog-preview')).toContainText('Support read');
    await dialog.getByTestId('admin-permissions-dialog-reason-input').fill(REASON);
    await dialog.getByTestId('admin-permissions-dialog-confirm-btn').click();
    await expect(dialog).toBeHidden({ timeout: TIMEOUTS.ACTION });

    await expect(fact).toContainText('Support read', { timeout: TIMEOUTS.ACTION });
    await expect(fact).toContainText('Manage settings');
    expect(await readPermissions(request, admin, delegate.email)).toEqual(EDITOR_GRANT);

    const entry = await latestPermissionsAudit(request, admin, delegate.userId);
    expect(entry?.actor?.userId).toBe(admin.userId);
    expect(entry?.details?.granted).toEqual(EDITOR_GRANT);

    await page.goto(`/admin/users/${delegate.userId}?tab=admin`);
    await expect(
      page.getByTestId('user-admin-log-row').filter({ hasText: `Admin permissions: added ${EDITOR_GRANT.join(', ')}` })
    ).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
  });

  test('the delegate sees only the console tabs the grant opens', async () => {
    await openConsole(delegatePage);
    await expectSidebar(delegatePage, {
      shown: ['admin-audit-log-btn', 'admin-retrieval-rate-btn', 'admin-modals-tab-btn'],
      hidden: ['admin-dashboard-tab-btn', 'admin-users-tab-btn', 'admin-settings-btn', 'admin-security-dashboard-btn'],
    });
  });

  test('routes outside the grant refuse the delegate', async () => {
    await expectStatus(delegateApi, delegate.accessToken, '/api/admin/audit-log?limit=1', 200);
    await expectStatus(delegateApi, delegate.accessToken, '/api/settings', 200);
    await expectStatus(delegateApi, delegate.accessToken, '/api/admin/held-signup-grants', 403);
    await expectStatus(delegateApi, delegate.accessToken, '/api/subscribers/waiting-count', 403);

    // settings:manage admits the request, but changing permissions stays with full admins.
    const escalate = await delegateApi.put(`${baseURL}/api/admin/users/${admin.userId}/permissions`, {
      headers: writeHeaders(delegate.accessToken),
      data: { before: [], adminPermissions: ['credits:adjust'], reason: REASON },
    });
    expect(escalate.status()).toBe(403);

    await delegatePage.goto(`/admin/users/${admin.userId}`);
    await expect(delegatePage.getByTestId('admin-missing-permission-state')).toContainText(
      'Full admin access required',
      { timeout: TIMEOUTS.NAVIGATION }
    );
    await expect(delegatePage.getByTestId('user-profile-view')).toHaveCount(0);
  });

  test('revoking the grant closes the console and its routes to the delegate', async ({ request }) => {
    await stepUp(request, admin);
    const res = await putPermissions(request, admin, delegate.userId, EDITOR_GRANT, []);
    expect(res.status()).toBe(200);
    expect(await readPermissions(request, admin, delegate.email)).toEqual([]);
    expect((await latestPermissionsAudit(request, admin, delegate.userId))?.details?.revoked).toEqual(EDITOR_GRANT);

    await expectStatus(delegateApi, delegate.accessToken, '/api/admin/audit-log?limit=1', 403);
    await expectStatus(delegateApi, delegate.accessToken, '/api/settings', 403);

    await delegatePage.goto('/admin');
    await expect(delegatePage).toHaveURL(/\/new(?:[/?#]|$)/, { timeout: TIMEOUTS.NAVIGATION });
    await expect(delegatePage.getByTestId('admin-layout')).toHaveCount(0);
  });
});

test.describe('Admin permissions - a delegate seeded at creation', () => {
  test.skip(isProductionEnv(), 'Creates a delegated admin; never on production');

  let admin: TestUser;
  let delegate: Delegate;
  let delegateApi: APIRequestContext;

  test.beforeAll(async ({ request, playwright }) => {
    admin = getTestUsers().admin;
    delegate = await apiCreateThrowawayUser(request, 'permseed', { adminPermissions: ['users:moderate'] });
    delegateApi = await playwright.request.newContext();
  });

  test.afterAll(async ({ request }) => {
    await delegateApi?.dispose();
    if (!delegate) return;
    await stepUp(request, admin);
    await revokeAll(request, admin, delegate);
  });

  test('a users:moderate delegate opens the moderation pages and nothing else', async ({ browser }) => {
    await expectStatus(delegateApi, delegate.accessToken, '/api/admin/rate-limits', 200);
    await expectStatus(delegateApi, delegate.accessToken, '/api/admin/audit-log?limit=1', 403);
    await expectStatus(delegateApi, delegate.accessToken, '/api/settings', 403);

    const { page, close } = await openPageAs(browser, baseURL, delegate);
    try {
      await openConsole(page);
      await expectSidebar(page, {
        shown: ['admin-rate-limits-btn'],
        hidden: ['admin-audit-log-btn', 'admin-modals-tab-btn', 'admin-users-tab-btn', 'admin-dashboard-tab-btn'],
      });
    } finally {
      await close();
    }
  });
});
