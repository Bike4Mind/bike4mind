import { type APIRequestContext, type Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { apiCreateTestUser, apiGetOtcCode } from './helpers/api';
import { enrollMfa, generateTotp } from './helpers/mfa';
import { seedAuthOnPage } from './helpers/auth-seed';
import type { LoginPage } from './pages/LoginPage';

const timestamp = Date.now();

/**
 * Submit the email step and read back the emailed OTC via the non-prod test endpoint (same
 * pattern as auth.spec.ts / signup.spec.ts - there is no test mailbox harness).
 *
 * Rate-limit escape hatch: the OTC send (5/15min per IP) and auth-strategy (10/min per IP)
 * checks are rate limited server-side; on the shared CI egress IP a run can legitimately draw
 * a 429, which leaves the form stuck on the email step. That's an infra limit, not a product
 * regression - annotate + skip rather than fail red (mirrors signup.spec.ts).
 */
async function sendOtcAndReadCode(
  page: Page,
  loginPage: LoginPage,
  request: APIRequestContext,
  email: string
): Promise<string> {
  let rateLimited = false;
  page.on('response', resp => {
    if (resp.status() === 429 && /\/api\/(otc\/send|auth\/strategy)/.test(resp.url())) {
      rateLimited = true;
    }
  });

  await loginPage.submitEmail(email);
  try {
    await loginPage.expectOtcStep();
  } catch (err) {
    if (rateLimited) {
      test.info().annotations.push({
        type: 'rate-limited',
        description:
          'OTC send / auth-strategy returned 429 on the shared CI IP (send 5/15min, strategy 10/min). ' +
          'Infra rate limit, not a product failure - skipping.',
      });
      test.skip();
    }
    throw err;
  }

  return apiGetOtcCode(request, email);
}

test.describe('MFA', () => {
  test('signs in with a TOTP code after OTC verification', async ({ basePage, loginPage, page, request }) => {
    const email = `mfa-signin-${timestamp}-e2e@test.com`;
    const created = await apiCreateTestUser(request, {
      username: `mfa-signin-${timestamp}`,
      email,
      name: `MFA Signin ${timestamp} e2e`,
      password: 'E2eMfaSigninPass123!',
    });
    const { secret } = await enrollMfa(request, created.accessToken);

    await basePage.clearAllStorage();
    await loginPage.goto();
    const code = await sendOtcAndReadCode(page, loginPage, request, email);
    await loginPage.fillOtc(code);
    await loginPage.submitOtcExpectingMfa();

    await loginPage.expectMfaChallenge();
    await loginPage.fillMfaCode(generateTotp(secret));
    await loginPage.submitMfa();
    await basePage.dismissModals();

    await expect(page).not.toHaveURL(/.*login.*/);
  });

  test('signs in with a backup code after OTC verification', async ({ basePage, loginPage, page, request }) => {
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
    const code = await sendOtcAndReadCode(page, loginPage, request, email);
    await loginPage.fillOtc(code);
    await loginPage.submitOtcExpectingMfa();

    await loginPage.expectMfaChallenge();
    await loginPage.fillMfaCode(backupCodes[0]);
    await loginPage.submitMfa();
    await basePage.dismissModals();

    await expect(page).not.toHaveURL(/.*login.*/);
  });

  test('admin login-as-user requires the admin own TOTP code (login-as-with-MFA regression guard)', async ({
    basePage,
    adminPage,
    page,
    request,
  }) => {
    // Isolation: enroll MFA on a freshly-created admin, never the shared setup-admin user -
    // verify-setup bumps tokenVersion and would invalidate .auth/admin.json for every other test.
    const adminEmail = `mfa-admin-${timestamp}-e2e@test.com`;
    const createdAdmin = await apiCreateTestUser(request, {
      username: `mfa-admin-${timestamp}`,
      email: adminEmail,
      name: `MFA Admin ${timestamp} e2e`,
      password: 'E2eMfaAdminPass123!',
      isAdmin: true,
    });
    const { secret: adminSecret, tokens: adminTokens } = await enrollMfa(request, createdAdmin.accessToken);

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
    await adminPage.searchUser(targetName);
    await adminPage.waitForUserVisible(targetName);

    await adminPage.clickLoginAs(targetName);
    // Proves the admin's mfa.totpEnabled was projected into currentUser (the select:false
    // migration regression) - a non-enrolled admin would see login-as-mfa-required-modal instead.
    await adminPage.expectLoginAsMfaModal();
    await adminPage.fillLoginAsMfa(generateTotp(adminSecret));
    await adminPage.confirmLoginAs();

    // Landing on /new is the success signal. The "logged in as user" toast is deliberately not
    // asserted - useLoginAsUser hard-navigates (window.location.replace) 50ms after firing it, so
    // the toast is torn down before Playwright can reliably observe it (flaky, and /new already
    // proves the impersonation succeeded).
    await expect(page).toHaveURL(/\/new/);
    await expect(page).not.toHaveURL(/.*login.*/);
  });
});
