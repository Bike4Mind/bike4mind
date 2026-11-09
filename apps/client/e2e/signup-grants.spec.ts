import type { APIRequestContext, Browser } from '@playwright/test';
import { runtimeSignupGrantSchedule, settingsMap, storedGrantCredits } from '@bike4mind/common';
import { test, expect, openPageAs } from './fixtures';
import { TIMEOUTS } from './constants';
import { getTestRunId, getTestUsers } from './helpers/test-users';
import { isSharedRealEnv, isStagingEnv } from './helpers/env';
import { apiGetSignupGrant, apiRegisterViaOtc, apiUpdateAdminSetting, sameOriginHeaders } from './helpers/api';
import { AdminPage } from './pages/AdminPage';
import { BasePage } from './pages/BasePage';

/**
 * Staged signup grants: a new self-serve account gets a small tranche once its email is verified, the
 * rest stays locked until an unlock (activity drip, admin) releases it, and a spent signup pool holds the
 * tranche of signups past it until an admin releases the hold.
 *
 * Two modes, because the grant schedule and pool settings are global:
 * - Previews and localhost: the run sets small known amounts, lifts the per-IP and per-ASN signup caps
 *   (every run signs up from the same runner), pauses the signup pool for the held case, and puts every
 *   touched setting back afterwards. Two accounts are registered.
 * - Staging (the scheduled runs): nothing is written. The amounts are read from staging's own schedule,
 *   one account is registered, and the held case shrinks to a read-only check of the admin page, since
 *   pausing the pool there would hold every real signup. Production is skipped.
 * Each registration goes through the real OTC path, which spends the email domain's hourly new-account
 * budget and counts against the signup caps.
 *
 * Serial mode: the self-serve account walks the grant from tranche to fully released before the held case.
 */
// No retries: a retry re-runs the group from the first registration and spends more domain budget.
test.describe.configure({ mode: 'serial', retries: 0 });

// Previews and localhost only. With a stored drip cap the cap is also the locked remainder an unlock releases.
const FIXED = { signup: 7, unlock: 13, daily: 5 };
// Far above what one run pays, so neither pool holds or skips a payout for a reason the test did not set up.
const ROOMY_POOL = 1_000_000;
const FIXED_MIN_ACTIVE_SECONDS = 60;
// A staging minimum above this would make the drip check wait too long for a scheduled run.
const MAX_LIVE_MIN_ACTIVE_SECONDS = 300;

// The schedule keys are what runtimeSignupGrantSchedule (b4m-core/common/src/signupGrant.ts) reads. An
// unset key resolves to its registry default there, so restoring a missing row to the default changes nothing.
const GRANT_SETTINGS = {
  signupGrantInitialCredits: FIXED.signup,
  signupGrantDailyCredits: FIXED.daily,
  signupGrantDripCap: FIXED.unlock,
  signupGrantSignupPoolDaily: ROOMY_POOL,
  signupGrantTricklePoolDaily: ROOMY_POOL,
  signupGrantRiskPolicy: { enabled: false },
  signupGrantActivityMinActiveSeconds: FIXED_MIN_ACTIVE_SECONDS,
  // Off keeps the drip on the UTC day; on, previews pay it per 5-minute window instead.
  signupGrantActivityPreviewTestMode: false,
  maxSignupsPerIpPerDay: 0,
  maxSignupsPerAsnPerHour: 0,
} as const;
type GrantSettingKey = keyof typeof GRANT_SETTINGS;

const API_URL = process.env.API_URL || 'http://localhost:3000';
const LIVE = isStagingEnv();

interface Account {
  email: string;
  userId: string;
  accessToken: string;
}

interface Expected {
  signup: number;
  unlock: number;
  // What one day's drip pays: the daily amount, bounded by the cap. 0 skips the drip test.
  drip: number;
  minActiveSeconds: number;
  // Why the drip test cannot run on this env, if it cannot.
  dripSkipReason?: string;
}

let priorSettings: Partial<Record<GrantSettingKey, unknown>> = {};
let expected: Expected;
let selfServe: Account;
let enrolled = false;
// Set on staging when a signup domain hold would withhold every E2E signup's credits.
let domainHoldReason: string | undefined;
let dripPaid = 0;
let held: Account;

function adminToken(): string {
  return getTestUsers().admin.accessToken;
}

// Matches SignupGrantStatus, which formats with en-US grouping (1,000).
const credits = (amount: number) => amount.toLocaleString('en-US');

async function readSettings(request: APIRequestContext): Promise<Map<string, unknown>> {
  const response = await request.get(`${API_URL}/api/settings/fetch`, {
    headers: { Authorization: `Bearer ${adminToken()}` },
  });
  expect(response.ok(), 'admin settings fetch').toBe(true);
  const rows = (await response.json()) as Array<{ settingName: string; settingValue: unknown }>;
  return new Map(rows.map(row => [row.settingName, row.settingValue]));
}

/** Staging's own schedule, or the reason it cannot show a staged grant. Reads only; writes nothing. */
function liveExpectations(current: Map<string, unknown>): Expected | string {
  const schedule = runtimeSignupGrantSchedule(key => storedGrantCredits(key, current.get(key)));
  const pool = (key: 'signupGrantSignupPoolDaily' | 'signupGrantTricklePoolDaily') => {
    const parsed = settingsMap[key].schema.safeParse(current.get(key));
    return parsed.success ? parsed.data : 0;
  };
  const policy = current.get('signupGrantRiskPolicy') as { enabled?: unknown } | undefined;
  if (schedule.paysFlat) return 'Staging pays signup grants flat (drip cap 0), so nothing is staged.';
  if (schedule.initialCredits <= 0) return 'Staging pays no initial signup credits.';
  if (pool('signupGrantSignupPoolDaily') <= 0) return 'The staging signup pool is paused, so new grants are held.';
  if (policy?.enabled === true) return 'The staging risk policy is on, so a new grant may be held for review.';

  const parsedMin = settingsMap.signupGrantActivityMinActiveSeconds.schema.safeParse(
    current.get('signupGrantActivityMinActiveSeconds')
  );
  const minActiveSeconds = parsedMin.success
    ? parsedMin.data
    : (settingsMap.signupGrantActivityMinActiveSeconds.defaultValue ?? FIXED_MIN_ACTIVE_SECONDS);
  const drip = Math.min(schedule.dailyCredits, schedule.dripCap);
  let dripSkipReason: string | undefined;
  if (drip <= 0) dripSkipReason = 'Staging pays no daily activity drip.';
  else if (pool('signupGrantTricklePoolDaily') <= 0) dripSkipReason = 'The staging trickle pool is paused.';
  else if (minActiveSeconds > MAX_LIVE_MIN_ACTIVE_SECONDS)
    dripSkipReason = `Staging needs ${minActiveSeconds}s of active time, too long for a scheduled run.`;
  return { signup: schedule.initialCredits, unlock: schedule.unlockCredits, drip, minActiveSeconds, dripSkipReason };
}

// Kept on test.com because /api/test/otc-code and the teardown sweep only accept -e2e@test.com addresses.
// Staging currently holds test.com signups (signup domain hold), so the staging grant tests skip via
// e2eDomainHold below until the email used for staging E2E signups is settled; no code change is needed
// once the hold is released or test.com is added to Synthetic User Email Domains.
const E2E_EMAIL_DOMAIN = 'test.com';

/**
 * Why a new E2E signup's credits would be withheld by a signup domain hold, or undefined when they are not.
 * Any review row short of released holds every signup from the domain (protectSignupCredits in
 * b4m-core/services/src/userService/signupProtection.ts); a Synthetic User Email Domains entry skips the check.
 */
async function e2eDomainHold(request: APIRequestContext, current: Map<string, unknown>): Promise<string | undefined> {
  const synthetic = String(current.get('syntheticUserEmailDomains') ?? '')
    .split(',')
    .map(domain => domain.trim().toLowerCase());
  if (synthetic.includes(E2E_EMAIL_DOMAIN)) return undefined;
  for (let page = 1; ; page++) {
    const response = await request.get(
      `${API_URL}/api/admin/signup-domain-holds?status=all&includeOlder=true&page=${page}`,
      { headers: { Authorization: `Bearer ${adminToken()}` } }
    );
    expect(response.ok(), 'admin signup domain holds list').toBe(true);
    const body = (await response.json()) as { data: Array<{ domain: string; status: string }>; total: number };
    const row = body.data.find(hold => hold.domain.toLowerCase() === E2E_EMAIL_DOMAIN);
    if (row) return row.status === 'released' ? undefined : row.status;
    if (body.data.length === 0 || page * body.data.length >= body.total) return undefined;
  }
}

async function register(request: APIRequestContext, label: string): Promise<Account> {
  // Read at run time: core.setup writes the run id after every spec file has loaded.
  const runId = getTestRunId();
  // The -<digits>-e2e@test.com tail is what the teardown sweep deletes.
  const email = `grant-${label}-${runId}-e2e@${E2E_EMAIL_DOMAIN}`;
  const session = await apiRegisterViaOtc(request, { email, username: `grant-${label}-${runId}` });
  return { email, userId: session.userId, accessToken: session.accessToken };
}

async function heartbeat(request: APIRequestContext, account: Account) {
  const response = await request.post(`${API_URL}/api/users/active-session`, {
    headers: { Authorization: `Bearer ${account.accessToken}`, ...sameOriginHeaders() },
  });
  expect(response.ok(), `active-session heartbeat: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as {
    creditsGranted: number;
    paidToday: boolean;
    withheld: boolean;
    activeSeconds: number;
  };
}

async function openWelcomeAs(browser: Browser, baseURL: string | undefined, account: Account) {
  const session = await openPageAs(browser, baseURL, account);
  await session.page.goto('/');
  await new BasePage(session.page).dismissModals();
  return session;
}

test.describe('Staged signup grants', () => {
  test.beforeAll(async ({ request }) => {
    test.skip(isSharedRealEnv() && !LIVE, 'Never registers accounts on production.');
    const config = await request.get(`${API_URL}/api/settings/serverConfigPublic`);
    const openRegistration = config.ok() ? Boolean((await config.json()).allowOpenRegistration) : false;
    test.skip(!openRegistration, 'Open registration is off on this env (core.setup enables it on previews).');

    const current = await readSettings(request);
    if (LIVE) {
      const live = liveExpectations(current);
      test.skip(typeof live === 'string', `${live}`);
      expected = live as Expected;
      const hold = await e2eDomainHold(request, current);
      if (hold !== undefined)
        domainHoldReason =
          `Staging holds every @${E2E_EMAIL_DOMAIN} signup's credits (signup domain hold: ${hold}). Add ` +
          `${E2E_EMAIL_DOMAIN} to Synthetic User Email Domains, or release the hold, to run this on staging.`;
      return;
    }

    expected = { ...FIXED, drip: FIXED.daily, minActiveSeconds: FIXED_MIN_ACTIVE_SECONDS };
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
    test.skip(!!domainHoldReason, `${domainHoldReason}`);
    selfServe = await register(request, 'staged');

    const view = await apiGetSignupGrant(request, selfServe.accessToken, selfServe.userId);
    // A grant held for review or behind a staging backlog is that env's state, not a staged-grant fault.
    test.skip(
      LIVE && view.signupGrantHeldReason !== null,
      `Staging held the new grant (${view.signupGrantHeldReason}); the staged path cannot be checked this run.`
    );
    expect(view.signupGrant).toMatchObject({
      stage: 'signup',
      signupCredits: expected.signup,
      unlockCredits: expected.unlock,
      creditsReleased: expected.signup,
      nextCondition: 'verification',
    });
    expect(view.currentCredits).toBe(expected.signup);
    expect(view.signupGrantHeldReason).toBeNull();
    enrolled = true;

    const { page, close } = await openWelcomeAs(browser, baseURL, selfServe);
    try {
      await expect(page.getByTestId('signup-grant-released')).toContainText(
        `${credits(expected.signup)} signup credits released. ${credits(expected.unlock)} more credits are still locked.`,
        { timeout: TIMEOUTS.ACTION }
      );
      await expect(page.getByTestId('signup-grant-unlock-paths')).toBeVisible();
    } finally {
      await close();
    }
  });

  test('the activity drip pays once after the minimum active time', async ({ request }) => {
    test.skip(!enrolled, 'The account was not enrolled in a staged grant.');
    test.skip(!!expected.dripSkipReason, `${expected.dripSkipReason}`);
    // recordHeartbeat credits the real gap between pings, so the second ping must land past the minimum.
    const gapMs = (expected.minActiveSeconds + 2) * 1000;
    test.setTimeout(gapMs + TIMEOUTS.TEST);

    const first = await heartbeat(request, selfServe);
    expect(first.creditsGranted).toBe(0);
    // Active time is measured on the server clock between pings, so the wait cannot be shortened.
    await new Promise(resolve => setTimeout(resolve, gapMs));

    const second = await heartbeat(request, selfServe);
    expect(second.activeSeconds).toBeGreaterThanOrEqual(expected.minActiveSeconds);
    // On staging the trickle pool also pays queued rewards first; a withheld drip is that queue, not a fault.
    test.skip(LIVE && second.withheld, 'The staging trickle pool withheld the drip this run.');
    expect(second).toMatchObject({ creditsGranted: expected.drip, paidToday: true });
    dripPaid = expected.drip;

    const view = await apiGetSignupGrant(request, selfServe.accessToken, selfServe.userId);
    expect(view.currentCredits).toBe(expected.signup + expected.drip);
    expect(view.signupGrant).toMatchObject({
      stage: 'signup',
      creditsReleased: expected.signup + expected.drip,
      dripCredits: expected.drip,
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
    test.skip(!enrolled, 'The account was not enrolled in a staged grant.');
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
    const total = expected.signup + expected.unlock;
    expect(await unlock.json()).toEqual({ outcome: 'applied', credits: total - expected.signup - dripPaid });

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
        `${credits(total)} signup credits released. Your signup grant is fully released.`,
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
    test.skip(LIVE, 'Pausing the staging signup pool would hold every real signup.');
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
      `Released 1 of 1 grants (${FIXED.signup} credits)`,
      { timeout: TIMEOUTS.ACTION }
    );

    const released = await apiGetSignupGrant(request, held.accessToken, held.userId);
    expect(released.signupGrant).toMatchObject({ stage: 'signup', creditsReleased: FIXED.signup });
    expect(released.signupGrantHeldReason).toBeNull();
    expect(released.currentCredits).toBe(FIXED.signup);

    await page.getByTestId('held-signup-grants-revoke-btn').click();
    await expect(page.getByTestId('held-signup-grants-revoke-dialog')).toBeVisible();
    await page.getByTestId('held-signup-grants-revoke-confirm-btn').click();
    await expect(page.getByTestId('held-signup-grants-revoke-result')).toContainText('Revoked 1 of 1 grants.', {
      timeout: TIMEOUTS.ACTION,
    });
    expect((await apiGetSignupGrant(request, held.accessToken, held.userId)).currentCredits).toBe(0);
  });

  test('the held signup grants page opens for an admin (staging, read-only)', async ({ page }) => {
    test.skip(!LIVE, 'The held-grant test above covers this page on previews.');
    const adminPage = new AdminPage(page);
    await adminPage.gotoAdmin();
    await adminPage.navigateToHeldSignupGrants();
    await expect(page.getByTestId('held-signup-grants-tab')).toBeVisible({ timeout: TIMEOUTS.ACTION });
    // Nothing is selected, so the page loaded without the test touching any held grant.
    await expect(page.getByTestId('held-signup-grants-release-btn')).toBeDisabled();
  });
});
