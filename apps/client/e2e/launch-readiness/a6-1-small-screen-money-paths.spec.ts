import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { TIMEOUTS } from '../constants';
import { apiGetOtcCode } from '../helpers/api';
import { guardLaunchReadiness, isStagingEnv, STAGING_ONLY_SKIP } from './guard';
import { discardSignupInvite, freshIdentity, registerFreshAccount, signupInviteIfNeeded } from './support';

guardLaunchReadiness();

test.use({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });

// Chrome DevTools' "Fast 3G" profile: 562.5 ms round trip, about 1.4 Mbit/s down and 675 kbit/s up.
const FAST_3G = {
  offline: false,
  latency: 562.5,
  downloadThroughput: (1.6 * 1024 * 1024 * 0.9) / 8,
  uploadThroughput: (750 * 1024 * 0.9) / 8,
};

async function throttle(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', FAST_3G);
}

/** On screen once scrolled to, and nothing (a dialog, a banner, a backdrop) sits on top of it. */
async function expectReachable(control: Locator): Promise<void> {
  await expect(control).toBeVisible({ timeout: TIMEOUTS.ACTION });
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeInViewport();
  await control.click({ trial: true, timeout: TIMEOUTS.ELEMENT_STATE });
}

test.describe('A6.1 money paths at 375x667 on a throttled link', () => {
  test('A6.1 signup completes at 375x667 on a throttled link', async ({ page, request, signupPage }) => {
    test.slow();
    const identity = freshIdentity('a61sign');
    const invite = await signupInviteIfNeeded(request);
    try {
      await throttle(page);
      await signupPage.goto();
      await signupPage.fillUsername(identity.username);
      await signupPage.fillEmail(identity.email);
      if (invite) await signupPage.fillInviteCode(invite.code);
      await signupPage.acceptPolicies();
      await expectReachable(page.getByTestId('register-submit-btn'));
      await signupPage.submit();
      await signupPage.expectOtcStep();

      await signupPage.fillOtc(await apiGetOtcCode(request, identity.email));
      await expectReachable(page.getByTestId('register-verify-btn'));
      await signupPage.verify();
      await page.waitForURL(url => !/\/(register|login)/.test(url.pathname), { timeout: TIMEOUTS.TEST });
    } finally {
      await discardSignupInvite(request, invite);
    }
  });

  test('A6.1 the credits pay button is reachable at 375x667 on a throttled link', async ({
    page,
    request,
    loginAsUser,
    basePage,
  }) => {
    test.skip(!isStagingEnv(), STAGING_ONLY_SKIP);
    test.slow();
    const account = await registerFreshAccount(request, freshIdentity('a61buy'));
    await loginAsUser({ accessToken: account.accessToken, userId: account.userId });
    await throttle(page);
    await page.goto('/?billing=credits');
    await basePage.dismissModals();

    await expectReachable(page.getByTestId('credits-purchase-btn').first());
    await page.getByTestId('credits-purchase-btn').first().click();
    await expect(page.getByTestId('payment-modal-dialog')).toBeVisible({ timeout: TIMEOUTS.ACTION });
    await expect(
      page.frameLocator('iframe[title="Secure payment input frame"]').first().locator('input[name="number"]')
    ).toBeVisible({
      timeout: TIMEOUTS.TEST,
    });
    await expectReachable(page.getByTestId('checkout-submit-btn'));
  });

  test('A6.1 the plan upgrade button is reachable at 375x667 on a throttled link', async ({
    page,
    request,
    loginAsUser,
    basePage,
  }) => {
    test.slow();
    const account = await registerFreshAccount(request, freshIdentity('a61plan'));
    await loginAsUser({ accessToken: account.accessToken, userId: account.userId });
    await throttle(page);
    await page.goto('/?billing=plans');
    await basePage.dismissModals();

    await expectReachable(page.getByRole('button', { name: /^Subscribe to / }).first());
  });
});
