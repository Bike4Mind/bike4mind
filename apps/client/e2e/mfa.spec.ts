import { type APIRequestContext, type Page, type Request } from '@playwright/test';
import { test, expect } from './fixtures';
import { TIMEOUTS } from './constants';
import { apiCreateTestUser, apiCreateThrowawayUser, apiGetOtcCode } from './helpers/api';
import { enrollMfa, generateTotp, stubEnforcedMfaSetting, trustedDeviceCookieName } from './helpers/mfa';
import { seedAuthOnPage } from './helpers/auth-seed';
import type { LoginPage } from './pages/LoginPage';

/**
 * Submit the email step and read back the emailed OTC via the non-prod test endpoint (same
 * pattern as auth.spec.ts / signup.spec.ts - there is no test mailbox harness).
 */
async function sendOtcAndReadCode(loginPage: LoginPage, request: APIRequestContext, email: string): Promise<string> {
  await loginPage.submitEmail(email);
  await loginPage.expectOtcStep();

  return apiGetOtcCode(request, email);
}

const MFA_SETUP_PATH = '/api/auth/mfa/setup';

const isMfaSetupCall = (req: Request): boolean =>
  req.method() === 'POST' && new URL(req.url()).pathname === MFA_SETUP_PATH;

/** Sign in through the UI with an emailed code and a TOTP code, optionally ticking "remember this device". */
async function signInWithTotp(
  loginPage: LoginPage,
  request: APIRequestContext,
  email: string,
  totp: string,
  { rememberDevice = false }: { rememberDevice?: boolean } = {}
): Promise<void> {
  await loginPage.goto();
  await loginPage.fillOtc(await sendOtcAndReadCode(loginPage, request, email));
  await loginPage.submitOtcExpectingMfa();
  await loginPage.expectMfaChallenge();
  await loginPage.fillMfaCode(totp);
  if (rememberDevice) {
    await loginPage.checkMuiCheckbox(
      loginPage.page.getByTestId('mfa-modal-remember-device-checkbox').getByRole('checkbox')
    );
  }
  await loginPage.submitMfa();
}

async function cookieNames(page: Page): Promise<string[]> {
  return (await page.context().cookies()).map(c => c.name);
}

test.describe('MFA', () => {
  test('signs in with a TOTP code after OTC verification', async ({ basePage, loginPage, page, request }) => {
    const timestamp = Date.now();
    const email = `mfa-signin-${timestamp}-e2e@test.com`;
    const created = await apiCreateTestUser(request, {
      username: `mfa-signin-${timestamp}`,
      email,
      name: `MFA Signin ${timestamp} e2e`,
      password: 'E2eMfaSigninPass123!',
    });
    const { secret, enrolledStep } = await enrollMfa(request, created.accessToken);

    await basePage.clearAllStorage();
    await loginPage.goto();
    const code = await sendOtcAndReadCode(loginPage, request, email);
    await loginPage.fillOtc(code);
    await loginPage.submitOtcExpectingMfa();

    await loginPage.expectMfaChallenge();
    await loginPage.fillMfaCode(generateTotp(secret, enrolledStep));
    await loginPage.submitMfa();
    await basePage.dismissModals();

    await expect(page).not.toHaveURL(/.*login.*/);
  });

  test('signs in with a backup code after OTC verification', async ({ basePage, loginPage, page, request }) => {
    const timestamp = Date.now();
    const email = `mfa-backup-${timestamp}-e2e@test.com`;
    const created = await apiCreateTestUser(request, {
      username: `mfa-backup-${timestamp}`,
      email,
      name: `MFA Backup ${timestamp} e2e`,
      password: 'E2eMfaBackupPass123!',
    });
    const { backupCodes } = await enrollMfa(request, created.accessToken);

    await basePage.clearAllStorage();
    await loginPage.goto();
    const code = await sendOtcAndReadCode(loginPage, request, email);
    await loginPage.fillOtc(code);
    await loginPage.submitOtcExpectingMfa();

    await loginPage.expectMfaChallenge();
    await loginPage.fillMfaCode(backupCodes[0]);
    await loginPage.submitMfa();
    await basePage.dismissModals();

    await expect(page).not.toHaveURL(/.*login.*/);
  });

  test("admin login-as-user requires the admin's own TOTP code (login-as-with-MFA regression guard)", async ({
    basePage,
    adminPage,
    page,
    request,
  }) => {
    // Isolation: enroll MFA on a freshly-created admin, never the shared setup-admin user -
    // verify-setup bumps tokenVersion and would invalidate .auth/admin.json for every other test.
    const timestamp = Date.now();
    const adminEmail = `mfa-admin-${timestamp}-e2e@test.com`;
    const createdAdmin = await apiCreateTestUser(request, {
      username: `mfa-admin-${timestamp}`,
      email: adminEmail,
      name: `MFA Admin ${timestamp} e2e`,
      password: 'E2eMfaAdminPass123!',
      isAdmin: true,
    });
    const {
      secret: adminSecret,
      tokens: adminTokens,
      enrolledStep: adminEnrolledStep,
    } = await enrollMfa(request, createdAdmin.accessToken);

    const targetName = `MFA Target ${timestamp} e2e`;
    await apiCreateTestUser(request, {
      username: `mfa-target-${timestamp}`,
      email: `mfa-target-${timestamp}-e2e@test.com`,
      name: targetName,
      password: 'E2eMfaTargetPass123!',
    });

    await basePage.clearAllStorage();
    await seedAuthOnPage(page, adminTokens);
    await basePage.dismissModals();

    await adminPage.navigateToAdmin();
    await adminPage.navigateToUsersTab();
    await adminPage.searchUser(targetName);
    await adminPage.waitForUserVisible(targetName);

    await adminPage.clickLoginAs(targetName);
    // Proves the admin's mfa.totpEnabled was projected into currentUser (the select:false
    // migration regression) - a non-enrolled admin gets a "set up two-factor" hint and no code input.
    await adminPage.expectLoginAsMfaModal();
    await adminPage.fillLoginAsMfa(generateTotp(adminSecret, adminEnrolledStep));
    await adminPage.fillLoginAsReason();
    await adminPage.confirmLoginAs();

    // Landing on /new is the success signal. The "logged in as user" toast is deliberately not
    // asserted - useLoginAsUser hard-navigates (window.location.replace) 50ms after firing it, so
    // the toast is torn down before Playwright can reliably observe it (flaky, and /new already
    // proves the impersonation succeeded).
    await expect(page).toHaveURL(/\/new/);
    await expect(page).not.toHaveURL(/.*login.*/);
  });
});

// Enforcement is a stage-wide admin setting with no per-user switch, so these tests turn it on in
// the page only (see stubEnforcedMfaSetting) and leave the stage's setting alone.
test.describe('MFA enforcement screen', () => {
  test('a user stuck on the enforced setup screen can sign out and sign in again', async ({
    basePage,
    loginPage,
    page,
    request,
  }) => {
    const user = await apiCreateThrowawayUser(request, 'mfastuck');
    await stubEnforcedMfaSetting(page);
    // Setup that cannot start is what leaves a user stuck on the enforcement screen.
    await page.route(`**${MFA_SETUP_PATH}`, route =>
      route.fulfill({ status: 503, json: { error: 'MFA setup is unavailable' } })
    );

    await basePage.clearAllStorage();
    await seedAuthOnPage(page, user);
    await expect(page.getByTestId('mfa-enforcement-required-screen')).toBeVisible({ timeout: TIMEOUTS.ACTION });
    await expect(page.getByTestId('mfa-enforcement-retry-btn')).toBeVisible({ timeout: TIMEOUTS.VISIBLE });

    await page.getByTestId('mfa-enforcement-sign-out-btn').click();
    await expect(page).toHaveURL(/\/login/, { timeout: TIMEOUTS.ACTION });
    await expect(page.getByTestId('login-email-input')).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });

    // A fresh sign-in may start setup without a step-up check, so this time setup opens.
    await page.unroute(`**${MFA_SETUP_PATH}`);
    const setupResponse = page.waitForResponse(res => isMfaSetupCall(res.request()), { timeout: TIMEOUTS.ACTION });
    await loginPage.fillOtc(await sendOtcAndReadCode(loginPage, request, user.email));
    await loginPage.submitOtcExpectingMfa();

    expect((await setupResponse).status()).toBe(200);
    await expect(page.getByTestId('mfa-modal-content')).toBeVisible({ timeout: TIMEOUTS.MODAL });
    // With the stage's real enforceMFA on, sign-in itself demands enrollment and opens setup on /login;
    // with it off, sign-in completes and the enforcement screen opens setup inside the app.
    if (!/\/login/.test(new URL(page.url()).pathname)) {
      await expect(page.getByTestId('mfa-enforcement-required-screen')).toBeVisible();
    }
  });

  test('an enrolled user is not asked to set up MFA again after a reload', async ({
    basePage,
    loginPage,
    page,
    request,
  }) => {
    const user = await apiCreateThrowawayUser(request, 'mfareload');
    const { secret, enrolledStep } = await enrollMfa(request, user.accessToken);
    await stubEnforcedMfaSetting(page);
    const setupCalls: string[] = [];
    page.on('request', req => {
      if (isMfaSetupCall(req)) setupCalls.push(req.url());
    });

    await basePage.clearAllStorage();
    await signInWithTotp(loginPage, request, user.email, generateTotp(secret, enrolledStep));
    await basePage.dismissModals();
    await expect(page.getByTestId('profile-menu-card')).toBeVisible({ timeout: TIMEOUTS.ACTION });

    // First with the "known enrolled" hint the app keeps, then without it, so both the
    // optimistic and the blocking path of the enforcement check are covered.
    for (const dropHint of [false, true]) {
      if (dropHint) await page.evaluate(() => localStorage.removeItem('mfa-enrollment-hint'));
      const statusChecked = page.waitForResponse(res => new URL(res.url()).pathname === '/api/auth/mfa/status', {
        timeout: TIMEOUTS.ACTION,
      });
      await page.reload();
      expect((await statusChecked).ok()).toBe(true);

      await expect(page.getByTestId('profile-menu-card')).toBeVisible({ timeout: TIMEOUTS.ACTION });
      await expect(page.getByTestId('mfa-enforcement-required-screen')).toBeHidden();
      await expect(page.getByTestId('mfa-modal-content')).toBeHidden();
    }
    expect(setupCalls).toEqual([]);
  });

  test.describe('on a short viewport', () => {
    test.use({ viewport: { width: 375, height: 500 } });

    test('keeps the setup dialog on screen and scrolls it to its verify button', async ({
      basePage,
      page,
      request,
    }) => {
      const user = await apiCreateThrowawayUser(request, 'mfashort');
      await stubEnforcedMfaSetting(page);
      const setupResponse = page.waitForResponse(res => isMfaSetupCall(res.request()), { timeout: TIMEOUTS.ACTION });

      await basePage.clearAllStorage();
      await seedAuthOnPage(page, user);
      const { secret } = (await (await setupResponse).json()) as { secret: string };

      const dialog = page.getByTestId('mfa-modal-content');
      await expect(dialog).toBeVisible({ timeout: TIMEOUTS.MODAL });
      const viewport = page.viewportSize();
      if (!viewport) throw new Error('No viewport size');

      const box = await dialog.boundingBox();
      if (!box) throw new Error('MFA dialog has no bounding box');
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);

      // QR code, key and backup codes do not fit in 500px, so the dialog has to scroll itself.
      const { scrollHeight, clientHeight } = await dialog.evaluate(el => ({
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      }));
      expect(scrollHeight).toBeGreaterThan(clientHeight);

      const verifyBtn = page.getByTestId('mfa-modal-verify-btn');
      await verifyBtn.scrollIntoViewIfNeeded();
      const btnBox = await verifyBtn.boundingBox();
      if (!btnBox) throw new Error('Verify button has no bounding box');
      expect(btnBox.y).toBeGreaterThanOrEqual(box.y);
      expect(btnBox.y + btnBox.height).toBeLessThanOrEqual(box.y + box.height + 1);

      await basePage.fillMuiInput(page.getByTestId('mfa-modal-code-input').locator('input'), generateTotp(secret));
      await verifyBtn.click();
      await expect(dialog).toBeHidden({ timeout: TIMEOUTS.ACTION });
      await expect(page.getByTestId('mfa-enforcement-required-screen')).toBeHidden({ timeout: TIMEOUTS.ACTION });
    });
  });
});

test.describe('MFA remembered device', () => {
  test('is remembered per account in the same browser', async ({
    basePage,
    loginPage,
    navigationPage,
    page,
    request,
  }) => {
    const userA = await apiCreateThrowawayUser(request, 'mfaremembera');
    const userB = await apiCreateThrowawayUser(request, 'mfarememberb');
    const mfaA = await enrollMfa(request, userA.accessToken);
    const mfaB = await enrollMfa(request, userB.accessToken);
    const cookieA = trustedDeviceCookieName(userA.userId);
    const cookieB = trustedDeviceCookieName(userB.userId);

    await basePage.clearAllStorage();
    await signInWithTotp(loginPage, request, userA.email, generateTotp(mfaA.secret, mfaA.enrolledStep), {
      rememberDevice: true,
    });
    expect(await cookieNames(page)).toContain(cookieA);
    await navigationPage.logout();
    await expect(page).toHaveURL(/\/login/, { timeout: TIMEOUTS.ACTION });

    // A's trust must not let B skip its own challenge, and B's grant must not replace A's cookie.
    await signInWithTotp(loginPage, request, userB.email, generateTotp(mfaB.secret, mfaB.enrolledStep), {
      rememberDevice: true,
    });
    expect(await cookieNames(page)).toEqual(expect.arrayContaining([cookieA, cookieB]));
    await navigationPage.logout();
    await expect(page).toHaveURL(/\/login/, { timeout: TIMEOUTS.ACTION });

    await loginPage.goto();
    await loginPage.fillOtc(await sendOtcAndReadCode(loginPage, request, userA.email));
    await loginPage.submitOtcExpectingMfa();
    await expect(page).not.toHaveURL(/\/login/, { timeout: TIMEOUTS.ACTION });
    await expect(page.getByTestId('mfa-modal-code-input')).toBeHidden();
  });
});
