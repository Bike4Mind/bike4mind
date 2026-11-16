import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { TIMEOUTS } from './constants';
import { apiCreateThrowawayUser } from './helpers/api';
import { isProductionEnv, isStagingEnv } from './helpers/env';
import { expectNoHorizontalOverflow, expectReachable, openShortScreenPageAs } from './helpers/launch-readiness';
import { payButton } from './helpers/stripe-pay-button';
import { wafBypassHeaders } from './helpers/waf-bypass';
import { BasePage } from './pages/BasePage';

// A6.1: the money paths (signup, first purchase, plan upgrade) work on a short screen over a slow
// link, with no dialog hiding the button that moves the user on. These are the purchase and
// upgrade legs; launch-readiness-signup.spec.ts is the signup leg. Test titles start with the gate
// id because the readiness checker keys its verdict on that prefix.
//
// Each test mints a free-tier throwaway user (swept by global teardown) and drives it on a page with
// no modal stubs, so a dialog or banner that covers a pay button fails the test.
test.describe('A6.1 money paths on a short screen and a slow link', { tag: ['@launch-readiness', '@A6.1'] }, () => {
  test.skip(isProductionEnv(), 'Mints test users through /api/test/create-user, which production refuses');

  async function isCreditsEnforced(request: APIRequestContext, accessToken: string): Promise<boolean> {
    const apiUrl = process.env.API_URL || 'http://localhost:3000';
    const resp = await request.get(`${apiUrl}/api/settings/fetch`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(resp.ok(), 'settings fetch succeeds').toBe(true);
    const rows = (await resp.json()) as { settingName: string; settingValue: unknown }[];
    return rows.some(row => row.settingName === 'enforceCredits' && row.settingValue === true);
  }

  // A user lands on the app first and clears whatever greets them, then opens billing. Anything that
  // opens after that and covers the button is what this gate is about, so it is not dismissed.
  async function landAndOpenBilling(page: Page, goto: (path: string) => Promise<void>, path: string) {
    await goto('/');
    await new BasePage(page).dismissModals();
    await goto(path);
    const billing = page.getByTestId('billing-modal');
    await expect(billing, 'billing opens').toBeVisible({
      timeout: TIMEOUTS.TEST,
    });
    await expectNoHorizontalOverflow(page);
    return billing;
  }

  test('A6.1 a first credit purchase reaches Pay now and pays at 375x667 on a throttled link', async ({
    browser,
    baseURL,
    request,
  }) => {
    test.slow();
    // A near-empty balance is the state a first purchase starts from, low-balance banners included.
    const user = await apiCreateThrowawayUser(request, 'a61buy', { initialCredits: 1, includePredefinedTags: false });
    test.skip(
      !(await isCreditsEnforced(request, user.accessToken)),
      'enforceCredits is off on this stage, so there is no credit purchase surface'
    );
    const { page, goto, close } = await openShortScreenPageAs(browser, baseURL, user);
    try {
      const billing = await landAndOpenBilling(page, goto, '/billing/credits');

      const buyBtn = billing.getByTestId('credits-purchase-btn');
      await expect(buyBtn).toBeEnabled({ timeout: TIMEOUTS.TEST });
      await expectReachable(buyBtn, 'Buy credits button');

      const startPayment = page.waitForResponse(
        r => new URL(r.url()).pathname === '/api/stripe/start-payment' && r.request().method() === 'POST',
        { timeout: TIMEOUTS.TEST }
      );
      await buyBtn.click();

      // With requireCheckoutTermsConsent on, a terms step comes first; it must not strand the user.
      const termsDialog = page.getByTestId('credits-terms-dialog');
      const paymentModal = page.getByTestId('payment-modal-dialog');
      await expect(termsDialog.or(paymentModal)).toBeVisible({ timeout: TIMEOUTS.TEST });
      if (await termsDialog.isVisible()) {
        await expectReachable(termsDialog.getByTestId('credits-terms-checkbox'), 'terms checkbox');
        await termsDialog.getByTestId('credits-terms-checkbox').click();
        const continueBtn = termsDialog.getByTestId('credits-terms-continue-btn');
        await expect(continueBtn).toBeEnabled();
        await expectReachable(continueBtn, 'terms Continue button');
        await continueBtn.click();
      }

      const started = await startPayment;
      expect(started.ok(), 'start-payment succeeds').toBe(true);
      const { publishableKey } = (await started.json()) as { publishableKey?: string };
      // Hard stop before any card is entered: only a Stripe test-mode key may ever be paid against.
      expect(publishableKey, 'the stage uses Stripe test mode').toMatch(/^pk_test_/);

      await expect(paymentModal).toBeVisible({ timeout: TIMEOUTS.TEST });
      const payNow = paymentModal.getByTestId('checkout-submit-btn');
      // Enabled once Stripe.js and the Payment Element have loaded over the slow link.
      await expect(payNow).toBeEnabled({ timeout: TIMEOUTS.TEST });
      await expectNoHorizontalOverflow(page);
      await expectReachable(payNow, 'Pay now button');

      // Stripe's documented always-succeeds test card; no 3-D Secure step.
      const card = paymentModal.frameLocator('#payment-element iframe').first();
      await card.locator('input[name="number"]').fill('4242424242424242', { timeout: TIMEOUTS.TEST });
      await card.locator('input[name="expiry"]').fill('12 / 34');
      await card.locator('input[name="cvc"]').fill('123');
      // Stripe adds a postal code field only for some countries, and it can render after the card fields.
      const postalCode = card.locator('input[name="postalCode"]');
      const hasPostalCode = await postalCode
        .waitFor({ state: 'visible', timeout: 5_000 }) // ms, on the slow link
        .then(() => true)
        .catch(() => false);
      if (hasPostalCode) await postalCode.fill('10001');

      // Filling the form must not push Pay now out of reach (an error line or expanded field can).
      await expectReachable(payNow, 'Pay now button after card entry');
      await payNow.click();
      await expect(paymentModal.getByTestId('checkout-payment-message')).toHaveText('Payment succeeded!', {
        timeout: TIMEOUTS.TEST,
      });
    } finally {
      await close();
    }
  });

  test('A6.1 a plan upgrade reaches the Stripe pay button at 375x667 on a throttled link', async ({
    browser,
    baseURL,
    request,
  }) => {
    // Previews have no Stripe plan prices and production is live mode (same gate as teams-checkout).
    test.skip(!isStagingEnv(), 'Plan checkout needs Stripe test-mode plan prices, which only staging has');
    test.slow();
    const user = await apiCreateThrowawayUser(request, 'a61plan', { includePredefinedTags: false });
    const { page, goto, close } = await openShortScreenPageAs(browser, baseURL, user);
    try {
      const billing = await landAndOpenBilling(page, goto, '/billing/plans');

      const subscribeBtn = billing.getByTestId('subscription-subscribe-btn').first();
      await expect(subscribeBtn).toBeEnabled({ timeout: TIMEOUTS.TEST });
      await expectReachable(subscribeBtn, 'Subscribe button');

      // The app navigates to Stripe as soon as subscribe returns, dropping the response body, so
      // read it through the route. Fulfilling skips installWafBypass's handler: add its header here.
      let body = '';
      await page.route('**/api/subscriptions/subscribe', async route => {
        if (route.request().method() !== 'POST') return route.fallback();
        const fetched = await route.fetch({ headers: { ...route.request().headers(), ...wafBypassHeaders() } });
        body = await fetched.text();
        await route.fulfill({ response: fetched, body });
      });
      const subscribed = page.waitForResponse(
        r => new URL(r.url()).pathname === '/api/subscriptions/subscribe' && r.request().method() === 'POST',
        { timeout: TIMEOUTS.TEST }
      );
      await subscribeBtn.click();
      expect((await subscribed).status(), body).toBe(200);
      const { sessionUrl } = JSON.parse(body) as { sessionUrl: string };
      expect(sessionUrl, 'checkout opens in Stripe test mode').toMatch(/cs_test_/);

      await page.waitForURL(/^https:\/\/checkout\.stripe\.com\//, { timeout: TIMEOUTS.TEST });
      // Stops short of paying: a paid run leaves a test-mode subscription that nothing tears down.
      const pay = await payButton(page, TIMEOUTS.TEST);
      await expectReachable(pay, 'Stripe Checkout pay button');
    } finally {
      await close();
    }
  });
});
