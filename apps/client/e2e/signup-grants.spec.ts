import type { APIRequestContext, Browser } from '@playwright/test';
import { settingsMap } from '@bike4mind/common';
import { test, expect, openPageAs } from './fixtures';
import { TIMEOUTS } from './constants';
import { getTestRunId, getTestUsers } from './helpers/test-users';
import { isSharedRealEnv } from './helpers/env';
import { apiGetSignupGrant, apiRegisterViaOtc, apiUpdateAdminSetting } from './helpers/api';
import { AdminPage } from './pages/AdminPage';
import { BasePage } from './pages/BasePage';

/**
 * Staged signup grants: a new self-serve account gets a small tranche once its email is verified, the
 * rest stays locked until an unlock (activity drip, admin) releases it, and a daily budget holds the
 * tranche of signups past it until an admin releases the hold.
 *
 * The staged grant settings are global, so this file only runs where flipping them is safe (previews,
 * localhost) and puts every touched setting back afterwards. It registers exactly two accounts through
 * the real OTC path because each one spends the email domain's hourly new-account budget.
 *
 * Serial mode: the self-serve account walks the grant from tranche to fully released, and the held
 * account relies on the budget day the first account's payouts already drew from.
 */
test.describe.configure({ mode: 'serial' });

const SIGNUP_CREDITS = 7;
const UNLOCK_CREDITS = 13;
const DRIP_CREDITS = 5;
// Large enough that the first account's payouts always reserve, so they touch today's budget row.
const ROOMY_BUDGET = 1_000_000;
// recordHeartbeat credits the real gap between pings, so the second ping must land past the minimum.
const MIN_ACTIVE_SECONDS = 60;
const HEARTBEAT_GAP_MS = (MIN_ACTIVE_SECONDS + 2) * 1000;

const GRANT_SETTINGS = {
  stagedSignupGrantEnabled: true,
  signupGrantCredits: SIGNUP_CREDITS,
  verifiedUnlockCredits: UNLOCK_CREDITS,
  signupGrantDailyBudget: ROOMY_BUDGET,
  signupGrantRiskPolicy: { enabled: false },
  signupGrantActivityEnabled: true,
  signupGrantActivityMinActiveSeconds: MIN_ACTIVE_SECONDS,
  signupGrantActivityDailyCredits: DRIP_CREDITS,
  signupGrantActivityMaxCredits: DRIP_CREDITS,
  signupGrantActivityPreviewTestMode: false,
} as const;
type GrantSettingKey = keyof typeof GRANT_SETTINGS;

const API_URL = process.env.API_URL || 'http://localhost:3000';
const RUN_ID = getTestRunId();

interface Account {
  email: string;
  userId: string;
  accessToken: string;
}

let priorSettings: Partial<Record<GrantSettingKey, unknown>> = {};
let selfServe: Account;
let held: Account;

function adminToken(): string {
  return getTestUsers().admin.accessToken;
}

async function readSettings(request: APIRequestContext): Promise<Map<string, unknown>> {
  const response = await request.get(`${API_URL}/api/settings/fetch`, {
    headers: { Authorization: `Bearer ${adminToken()}` },
  });
  expect(response.ok(), 'admin settings fetch').toBe(true);
  const rows = (await response.json()) as Array<{ settingName: string; settingValue: unknown }>;
  return new Map(rows.map(row => [row.settingName, row.settingValue]));
}

async function register(request: APIRequestContext, label: string): Promise<Account> {
  // The -<digits>-e2e@test.com tail is what the teardown sweep deletes.
  const email = `grant-${label}-${RUN_ID}-e2e@test.com`;
  const session = await apiRegisterViaOtc(request, { email, username: `grant-${label}-${RUN_ID}` });
  return { email, userId: session.userId, accessToken: session.accessToken };
}

async function heartbeat(request: APIRequestContext, account: Account) {
  const response = await request.post(`${API_URL}/api/users/active-session`, {
    headers: { Authorization: `Bearer ${account.accessToken}` },
  });
  expect(response.ok(), 'active-session heartbeat').toBe(true);
  return (await response.json()) as { creditsGranted: number; paidToday: boolean; activeSeconds: number };
}

async function openWelcomeAs(browser: Browser, baseURL: string | undefined, account: Account) {
  const session = await openPageAs(browser, baseURL, account);
  await session.page.goto('/');
  await new BasePage(session.page).dismissModals();
  return session;
}

test.describe('Staged signup grants', () => {
  test.beforeAll(async ({ request }) => {
    test.skip(isSharedRealEnv(), 'Flips global signup grant settings - run on a preview or localhost only.');
    const config = await request.get(`${API_URL}/api/settings/serverConfigPublic`);
    const openRegistration = config.ok() ? Boolean((await config.json()).allowOpenRegistration) : false;
    test.skip(!openRegistration, 'Open registration is off on this env (core.setup enables it on previews).');

    const current = await readSettings(request);
    priorSettings = Object.fromEntries(
      (Object.keys(GRANT_SETTINGS) as GrantSettingKey[]).map(key => [
        key,
        current.has(key) ? current.get(key) : settingsMap[key].defaultValue,
      ])
    );
    for (const [key, value] of Object.entries(GRANT_SETTINGS)) {
      await apiUpdateAdminSetting(request, adminToken(), key, value);
    }
  });

  test.afterAll(async ({ request }) => {
    for (const [key, value] of Object.entries(priorSettings)) {
      await apiUpdateAdminSetting(request, adminToken(), key, value);
    }
  });

  test('a new self-serve account is enrolled and gets only the signup tranche', async ({
    request,
    browser,
    baseURL,
  }) => {
    selfServe = await register(request, 'staged');

    const view = await apiGetSignupGrant(request, selfServe.accessToken, selfServe.userId);
    expect(view.signupGrant).toMatchObject({
      stage: 'signup',
      signupCredits: SIGNUP_CREDITS,
      unlockCredits: UNLOCK_CREDITS,
      creditsReleased: SIGNUP_CREDITS,
      nextCondition: 'verification',
    });
    expect(view.currentCredits).toBe(SIGNUP_CREDITS);
    expect(view.signupGrantHeldReason).toBeNull();

    const { page, close } = await openWelcomeAs(browser, baseURL, selfServe);
    try {
      await expect(page.getByTestId('signup-grant-released')).toContainText(
        `${SIGNUP_CREDITS} signup credits released. ${UNLOCK_CREDITS} more credits are still locked.`,
        { timeout: TIMEOUTS.ACTION }
      );
      await expect(page.getByTestId('signup-grant-unlock-paths')).toBeVisible();
    } finally {
      await close();
    }
  });

  test('the activity drip pays once after the minimum active time', async ({ request }) => {
    test.setTimeout(HEARTBEAT_GAP_MS + TIMEOUTS.TEST);

    const first = await heartbeat(request, selfServe);
    expect(first.creditsGranted).toBe(0);
    // Active time is measured on the server clock between pings, so the wait cannot be shortened.
    await new Promise(resolve => setTimeout(resolve, HEARTBEAT_GAP_MS));

    const second = await heartbeat(request, selfServe);
    expect(second.activeSeconds).toBeGreaterThanOrEqual(MIN_ACTIVE_SECONDS);
    expect(second).toMatchObject({ creditsGranted: DRIP_CREDITS, paidToday: true });

    const view = await apiGetSignupGrant(request, selfServe.accessToken, selfServe.userId);
    expect(view.currentCredits).toBe(SIGNUP_CREDITS + DRIP_CREDITS);
    expect(view.signupGrant).toMatchObject({
      stage: 'signup',
      creditsReleased: SIGNUP_CREDITS + DRIP_CREDITS,
      dripCredits: DRIP_CREDITS,
      unlockedBy: 'activity_drip',
    });

    // The day's drip is spent: another ping pays nothing more.
    expect((await heartbeat(request, selfServe)).creditsGranted).toBe(0);
  });

  test('an admin unlock releases the locked remainder, and the account cannot unlock itself', async ({
    request,
    browser,
    baseURL,
  }) => {
    const unlockUrl = `${API_URL}/api/admin/users/${selfServe.userId}/unlock-signup-grant`;
    const reason = 'E2E staged signup grant unlock';

    const selfAttempt = await request.post(unlockUrl, {
      headers: { Authorization: `Bearer ${selfServe.accessToken}` },
      data: { reason },
    });
    expect(selfAttempt.status()).toBe(403);

    const unlock = await request.post(unlockUrl, {
      headers: { Authorization: `Bearer ${adminToken()}` },
      data: { reason },
    });
    expect(unlock.ok(), await unlock.text()).toBe(true);
    const total = SIGNUP_CREDITS + UNLOCK_CREDITS;
    expect(await unlock.json()).toMatchObject({
      creditsGranted: total - SIGNUP_CREDITS - DRIP_CREDITS,
      currentCredits: total,
    });

    const view = await apiGetSignupGrant(request, selfServe.accessToken, selfServe.userId);
    expect(view.signupGrant).toMatchObject({
      stage: 'unlocked',
      creditsReleased: total,
      nextCondition: null,
      unlockedBy: 'admin',
    });

    const { page, close } = await openWelcomeAs(browser, baseURL, selfServe);
    try {
      await expect(page.getByTestId('signup-grant-released')).toContainText(
        `${total} signup credits released. Your signup grant is fully released.`,
        { timeout: TIMEOUTS.ACTION }
      );
      await expect(page.getByTestId('signup-grant-unlock-paths')).toHaveCount(0);
    } finally {
      await close();
    }
  });

  test('a spent daily budget holds the tranche until an admin releases it, and revoke takes it back', async ({
    request,
    browser,
    baseURL,
    page,
  }) => {
    // The first account's payouts drew from today's budget row, so a budget of 1 is already spent.
    await apiUpdateAdminSetting(request, adminToken(), 'signupGrantDailyBudget', 1);
    held = await register(request, 'held');

    const heldView = await apiGetSignupGrant(request, held.accessToken, held.userId);
    expect(heldView.signupGrant).toMatchObject({ stage: 'pending_email', creditsReleased: 0 });
    expect(heldView.signupGrantHeldReason).toBe('budget_exhausted');
    expect(heldView.currentCredits).toBe(0);

    const welcome = await openWelcomeAs(browser, baseURL, held);
    try {
      await expect(welcome.page.getByTestId('signup-grant-status')).toHaveText(
        'Your free credits are being prepared.',
        {
          timeout: TIMEOUTS.ACTION,
        }
      );
    } finally {
      await welcome.close();
    }

    const adminPage = new AdminPage(page);
    await adminPage.gotoAdmin();
    await adminPage.navigateToHeldSignupGrants();
    // Oldest first, 25 a page: on a fresh preview the run's own held account is on the first page.
    await page.getByTestId(`held-signup-grants-select-${held.userId}`).check();
    await page.getByTestId('held-signup-grants-release-btn').click();
    await expect(page.getByTestId('held-signup-grants-release-result')).toContainText(
      `Released 1 of 1 grants (${SIGNUP_CREDITS} credits)`,
      { timeout: TIMEOUTS.ACTION }
    );

    const released = await apiGetSignupGrant(request, held.accessToken, held.userId);
    expect(released.signupGrant).toMatchObject({ stage: 'signup', creditsReleased: SIGNUP_CREDITS });
    expect(released.signupGrantHeldReason).toBeNull();
    expect(released.currentCredits).toBe(SIGNUP_CREDITS);

    await page.getByTestId('held-signup-grants-revoke-btn').click();
    await expect(page.getByTestId('held-signup-grants-revoke-dialog')).toBeVisible();
    await page.getByTestId('held-signup-grants-revoke-confirm-btn').click();
    await expect(page.getByTestId('held-signup-grants-revoke-result')).toContainText('Revoked 1 of 1 grants.', {
      timeout: TIMEOUTS.ACTION,
    });
    expect((await apiGetSignupGrant(request, held.accessToken, held.userId)).currentCredits).toBe(0);
  });
});
