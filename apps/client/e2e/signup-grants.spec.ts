import type { APIRequestContext, Browser } from '@playwright/test';
import { isStoredToggleOn, settingsMap, signupGrantScheduleFromValues, storedGrantCredits } from '@bike4mind/common';
import { test, expect, openPageAs } from './fixtures';
import { TIMEOUTS } from './constants';
import { getTestRunId, getTestUsers } from './helpers/test-users';
import { isSharedRealEnv } from './helpers/env';
import { apiGetSignupGrant, apiRegisterViaOtc, apiUpdateAdminSetting, sameOriginHeaders } from './helpers/api';
import { AdminPage } from './pages/AdminPage';
import { BasePage } from './pages/BasePage';

/**
 * Staged signup grants: a new self-serve account gets a small tranche once its email is verified, the
 * rest stays locked until an unlock (activity drip, admin) releases it, and a spent signup pool holds the
 * tranche of signups past it until an admin releases the hold.
 *
 * The grant schedule and pool settings are global, so this file only runs where flipping them is safe (previews,
 * localhost) and puts every touched setting back afterwards. It also lifts the per-IP and per-ASN signup
 * caps for the run, since every run signs up from the same runner. It registers exactly two accounts
 * through the real OTC path because each one spends the email domain's hourly new-account budget,
 * which no setting can raise.
 *
 * Serial mode: the self-serve account walks the grant from tranche to fully released before the signup
 * pool is paused for the held account.
 */
// No retries: a retry re-runs the group from the first registration and spends more domain budget.
test.describe.configure({ mode: 'serial', retries: 0 });

const SIGNUP_CREDITS = 7;
// With a stored drip cap the cap is also the locked remainder a full unlock releases.
const UNLOCK_CREDITS = 13;
const DRIP_CREDITS = 5;
// Far above what one run pays, so neither pool holds or skips a payout for a reason the test did not set up.
const ROOMY_POOL = 1_000_000;
// recordHeartbeat credits the real gap between pings, so the second ping must land past the minimum.
const MIN_ACTIVE_SECONDS = 60;
const HEARTBEAT_GAP_MS = (MIN_ACTIVE_SECONDS + 2) * 1000;

// The schedule keys are what resolveSignupGrantSchedule (b4m-core/common/src/signupGrant.ts) reads; the older
// signupGrantCredits / verifiedUnlockCredits / signupGrantActivity*Credits keys are only its fallback while unset.
const GRANT_SETTINGS = {
  signupGrantInitialCredits: SIGNUP_CREDITS,
  signupGrantDailyCredits: DRIP_CREDITS,
  signupGrantDripCap: UNLOCK_CREDITS,
  signupGrantSignupPoolDaily: ROOMY_POOL,
  signupGrantTricklePoolDaily: ROOMY_POOL,
  signupGrantRiskPolicy: { enabled: false },
  signupGrantActivityMinActiveSeconds: MIN_ACTIVE_SECONDS,
  // Off keeps the drip on the UTC day; on, previews pay it per 5-minute window instead.
  signupGrantActivityPreviewTestMode: false,
  maxSignupsPerIpPerDay: 0,
  maxSignupsPerAsnPerHour: 0,
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
    headers: { Authorization: `Bearer ${account.accessToken}`, ...sameOriginHeaders() },
  });
  expect(response.ok(), `active-session heartbeat: ${response.status()} ${await response.text()}`).toBe(true);
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
    const schedule = signupGrantScheduleFromValues(key => storedGrantCredits(key, current.get(key)), {
      staged: isStoredToggleOn(current.get('stagedSignupGrantEnabled')),
      activity: isStoredToggleOn(current.get('signupGrantActivityEnabled')),
    });
    // The schedule keys cannot be cleared once written, so one that had no row goes back to what the env paid.
    const unsetSchedule: Partial<Record<GrantSettingKey, number>> = {
      signupGrantInitialCredits: schedule.initialCredits,
      signupGrantDailyCredits: schedule.dailyCredits,
      signupGrantDripCap: schedule.dripCap,
    };
    priorSettings = Object.fromEntries(
      (Object.keys(GRANT_SETTINGS) as GrantSettingKey[]).map(key => [
        key,
        current.has(key) ? current.get(key) : (unsetSchedule[key] ?? settingsMap[key].defaultValue),
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
    expect(await heartbeat(request, selfServe)).toMatchObject({ creditsGranted: 0, paidToday: true });
  });

  test('an admin unlock releases the locked remainder, and the account cannot unlock itself', async ({
    request,
    browser,
    baseURL,
  }) => {
    const unlockUrl = `${API_URL}/api/admin/users/${selfServe.userId}/unlock-signup-grant`;
    const reason = 'E2E staged signup grant unlock';

    const selfAttempt = await request.post(unlockUrl, {
      headers: { Authorization: `Bearer ${selfServe.accessToken}`, ...sameOriginHeaders() },
      data: { reason },
    });
    expect(selfAttempt.status()).toBe(403);
    // Not the CSRF 403: the request must reach the route's own admin check.
    expect(await selfAttempt.text()).toContain('Admin access required');

    const unlock = await request.post(unlockUrl, {
      headers: { Authorization: `Bearer ${adminToken()}`, ...sameOriginHeaders() },
      data: { reason },
    });
    expect(unlock.ok(), await unlock.text()).toBe(true);
    const total = SIGNUP_CREDITS + UNLOCK_CREDITS;
    expect(await unlock.json()).toEqual({ outcome: 'applied', credits: total - SIGNUP_CREDITS - DRIP_CREDITS });

    const view = await apiGetSignupGrant(request, selfServe.accessToken, selfServe.userId);
    expect(view.currentCredits).toBe(total);
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

  test('a paused signup pool holds the tranche until an admin releases it, and revoke takes it back', async ({
    request,
    browser,
    baseURL,
    page,
  }) => {
    // A 0 pool pauses initial grants outright; an admin release bypasses the pool.
    await apiUpdateAdminSetting(request, adminToken(), 'signupGrantSignupPoolDaily', 0);
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
