import { test } from './fixtures';

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
});
