import { test, expect } from './fixtures';
import { TIMEOUTS } from './constants';
import { apiGetOtcCode } from './helpers/api';
import {
  SHORT_SCREEN_MOBILE,
  expectNoHorizontalOverflow,
  expectReachable,
  throttleToSlowLink,
} from './helpers/launch-readiness';

// A6.1: the money paths (signup, first purchase, plan upgrade) work on a short screen over a slow
// link, with no dialog hiding the button that moves the user on. This is the signup leg.
// Each run is a REAL signup, so it counts toward the per-IP/ASN signup caps; that is why it lives
// in its own project and not in the `unauthenticated` deploy gate (see playwright.config.ts).
test.use(SHORT_SCREEN_MOBILE);

test.describe('A6.1 signup on a short screen and a slow link', { tag: ['@launch-readiness', '@A6.1'] }, () => {
  // Same gate as signup.spec.ts: with open registration off there is no signup surface to test.
  test.beforeEach(async ({ request }) => {
    const apiUrl = process.env.API_URL || 'http://localhost:3000';
    const resp = await request.get(`${apiUrl}/api/settings/serverConfigPublic`);
    const openRegEnabled = resp.ok() ? Boolean((await resp.json()).allowOpenRegistration) : false;
    test.skip(!openRegEnabled, 'Open registration disabled on this env.');
  });

  test('a new user signs up with an email code, every step reachable at 375x667', async ({
    basePage,
    signupPage,
    page,
    request,
  }) => {
    // The slow link stretches the SPA load and both OTC round trips.
    test.slow();
    await throttleToSlowLink(page);

    const timestamp = Date.now();
    // The -<digits>-e2e@test.com shape is what the CI stale-user sweep deletes.
    const email = `a61-signup-${timestamp}-e2e@test.com`;

    await page.goto('/register', { timeout: TIMEOUTS.TEST });
    await expect(page.getByTestId('register-form')).toBeVisible({ timeout: TIMEOUTS.TEST });
    await expectNoHorizontalOverflow(page);

    // Step 1: email entry and terms acceptance share one form.
    await signupPage.fillUsername(`a61-signup-${timestamp}`);
    await signupPage.fillEmail(email);

    for (const [testId, name] of [
      ['register-terms-link', 'Terms of Service link'],
      ['register-aup-link', 'Acceptable Use Policy link'],
      ['register-privacy-link', 'Privacy Policy link'],
    ] as const) {
      const link = page.getByTestId(testId);
      await expectReachable(link, name);
      await expect(link).toHaveAttribute('href', /^https?:\/\//);
    }

    await expectReachable(page.getByTestId('register-aup-tos-checkbox'), 'terms checkbox');
    await expectReachable(page.getByTestId('register-age-checkbox'), 'age checkbox');
    await signupPage.acceptPolicies();

    const continueBtn = page.getByTestId('register-submit-btn');
    await expect(continueBtn).toBeEnabled();
    await expectReachable(continueBtn, 'Continue button');
    await signupPage.submit();

    // Step 2: code entry. The "code sent" toast lands at the bottom of a phone screen right now,
    // so this is where a covered button would show up.
    await expect(page.getByTestId('register-otc-input')).toBeVisible({ timeout: TIMEOUTS.TEST });
    await expectNoHorizontalOverflow(page);
    await expectReachable(page.getByTestId('register-otc-input'), 'code input');

    const code = await apiGetOtcCode(request, email);
    await signupPage.fillOtc(code);

    const verifyBtn = page.getByTestId('register-verify-btn');
    await expect(verifyBtn).toBeEnabled();
    await expectReachable(verifyBtn, 'Create account button');

    const verified = page.waitForResponse(r => r.url().includes('/api/otc/verify') && r.request().method() === 'POST', {
      timeout: TIMEOUTS.TEST,
    });
    await signupPage.verify();
    const verifyResponse = await verified;
    expect(verifyResponse.ok(), 'OTC verify succeeds').toBe(true);
    const { user, accessToken } = (await verifyResponse.json()) as { user: { id: string }; accessToken: string };
    // The nested shape is a newly created account; a flat one would mean the email already existed.
    expect(user?.id, 'verify created a new account').toBeTruthy();

    // Step 3: signed in and inside the app.
    await page.waitForURL(url => !/\/(register|login)/.test(url.pathname), { timeout: TIMEOUTS.TEST });
    await basePage.dismissModals();
    await expect(page).not.toHaveURL(/\/(register|login)/);

    const identify = await request.get('/api/identify', { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(identify.status(), 'the new session authenticates').toBe(200);
  });
});
