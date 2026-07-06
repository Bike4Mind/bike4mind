import { test, expect } from './fixtures';
import { apiGetOtcCode } from './helpers/api';

test.describe('Signup', () => {
  // The "Sign up" link + /register are gated on the global `allowOpenRegistration` setting.
  // core.setup only enables it on ephemeral preview/localhost envs and deliberately refuses to
  // toggle it on shared envs (staging/prod). With it off there's no register entry point, so
  // gotoFromLogin() would time out - skip the suite instead of failing. Run signup coverage on
  // a preview build (see core.setup.ts).
  test.beforeEach(async ({ request }) => {
    const apiUrl = process.env.API_URL || 'http://localhost:3000';
    const resp = await request.get(`${apiUrl}/api/settings/serverConfigPublic`);
    const openRegEnabled = resp.ok() ? Boolean((await resp.json()).allowOpenRegistration) : false;
    test.skip(!openRegEnabled, 'Open registration disabled on this env — run signup coverage on a preview build.');
  });

  test('should show error for invalid email format', async ({ signupPage }) => {
    await signupPage.gotoFromLogin();
    await signupPage.fillUsername('testuser');
    await signupPage.fillEmail('bike4mind-email.com');
    // The submit button stays disabled while the email is invalid, so we can't click it.
    // Register surfaces the inline validation error on blur (onChange validation + blur-gated
    // display), so blur the field to trigger it rather than submitting.
    await signupPage.blurEmail();

    await signupPage.expectValidationError('Invalid email');
  });

  test('should request a one-time code and show the code-entry step', async ({ signupPage }) => {
    // Registration is passwordless (OTC): submitting username + email emails a code
    // and advances to the code-entry step. We can't read the emailed code (there is
    // no test mailbox harness - see auth.spec.ts / e2e/README.md), so we assert the
    // flow reaches the OTC step rather than completing registration. A unique email
    // per run avoids the per-recipient send cooldown.
    const timestamp = Date.now();
    await signupPage.gotoFromLogin();
    await signupPage.fillUsername(`signup-${timestamp}`);
    await signupPage.fillEmail(`signup-${timestamp}-e2e@test.com`);
    // Registration requires accepting Terms/AUP/Privacy + confirming 18+ (both are
    // z.literal(true) in the schema); the submit button stays disabled otherwise.
    await signupPage.acceptPolicies();
    await signupPage.submit();

    await signupPage.expectOtcStep();
  });

  test('registers inline from the login form (email → code → username → account)', async ({
    basePage,
    loginPage,
    page,
    request,
  }) => {
    // The login form doubles as registration: entering an email with no account, verifying the
    // emailed code, then picking a username creates the account WITHOUT visiting /register (see
    // MultiStepLogin's `register-username` step, gated on the same allowOpenRegistration setting
    // as the beforeEach above). Unlike auth.spec.ts's login happy-path, this needs a brand-new
    // email so the verified code returns `registrationRequired` instead of logging in.
    //
    // The full flow is only completable end-to-end because the emailed code is read back via the
    // non-prod /api/test/otc-code endpoint (gated by E2E_CLEANUP_SECRET + a -e2e@test.com email
    // restriction - there's no test mailbox). A unique email per run dodges the account-already-
    // exists shape and the per-recipient send cooldown.
    const timestamp = Date.now();
    const email = `inline-signup-${timestamp}-e2e@test.com`;

    await basePage.clearAllStorage();
    await loginPage.goto();
    await loginPage.fillEmail(email); // sends the code and advances to the OTC step
    const code = await apiGetOtcCode(request, email);
    await loginPage.fillOtc(code);
    // New email → the verified code returns registrationRequired, so login stays put and reveals
    // the inline username step rather than redirecting into the app.
    await loginPage.submitExpectingInlineRegister();
    await loginPage.expectInlineRegisterStep();

    await loginPage.fillInlineRegisterUsername(`inline-signup-${timestamp}`);
    await loginPage.acceptInlineRegisterPolicies();
    await loginPage.submitInlineRegister();
    await basePage.dismissModals();

    // Account created and signed in - we're off /login and into the app.
    await expect(page).not.toHaveURL(/.*login.*/);
  });
});
