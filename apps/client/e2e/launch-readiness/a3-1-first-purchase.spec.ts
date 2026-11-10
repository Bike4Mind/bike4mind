import type { Locator, Page } from '@playwright/test';
import { settingsMap } from '@bike4mind/common';
import { test, expect } from '../fixtures';
import { TIMEOUTS } from '../constants';
import { guardLaunchReadiness, isStagingEnv, STAGING_ONLY_SKIP } from './guard';
import {
  adminReadUser,
  freshIdentity,
  liveSetting,
  registerFreshAccount,
  settledSignupGrant,
  type UserRecord,
} from './support';

guardLaunchReadiness();

// Stripe's test card that supports 3-D Secure without demanding it, so a challenge appears only
// because the app asked for one.
const CHALLENGE_ON_REQUEST_CARD = '4000000000003055';
const HOUR_MS = 3_600_000;
const CLOCK_SLACK_MS = 10 * 60_000;

async function fillPaymentElementCard(page: Page, cardNumber: string): Promise<void> {
  const card = page.frameLocator('iframe[title="Secure payment input frame"]').first();
  await card.locator('input[name="number"]').fill(cardNumber);
  await card.locator('input[name="expiry"]').fill('12 / 34');
  await card.locator('input[name="cvc"]').fill('123');
  const postalCode = card.locator('input[name="postalCode"]');
  if (await postalCode.isVisible().catch(() => false)) await postalCode.fill('10001');
}

/** Stripe's test-mode challenge page sits several frames deep; find its approve button wherever it lands. */
async function approveThreeDSecureChallenge(page: Page): Promise<void> {
  const found: { button?: Locator } = {};
  await expect
    .poll(
      async () => {
        for (const frame of page.frames()) {
          const button = frame.locator('#test-source-authorize-3ds');
          if ((await button.count().catch(() => 0)) > 0) {
            found.button = button;
            return true;
          }
        }
        return false;
      },
      { message: 'the 3-D Secure challenge appears', timeout: TIMEOUTS.ACTION }
    )
    .toBe(true);
  await found.button!.click();
}

test('A3.1 3-D Secure on a first purchase defaults on and is on for this stage', async ({ request }) => {
  expect(settingsMap.requireThreeDSecureOnFirstPurchase.defaultValue).toBe(true);
  expect(settingsMap.threeDSecureNewAccountDays.defaultValue).toBeGreaterThanOrEqual(7);
  expect(await liveSetting<boolean>(request, 'requireThreeDSecureOnFirstPurchase')).toBe(true);
  expect(await liveSetting<number>(request, 'threeDSecureNewAccountDays')).toBeGreaterThanOrEqual(7);
});

test.describe.serial('A3.1 and A3.5 first card purchase on a fresh account', () => {
  let purchase: { userId: string; paidAt: number; before: UserRecord } | undefined;

  test('A3.1 a first purchase on a fresh account goes through the 3-D Secure step', async ({
    page,
    request,
    loginAsUser,
    basePage,
  }) => {
    test.skip(!isStagingEnv(), STAGING_ONLY_SKIP);
    test.slow();
    const account = await registerFreshAccount(request, freshIdentity('a31buy'));
    const before = await settledSignupGrant(request, account.userId);

    await loginAsUser({ accessToken: account.accessToken, userId: account.userId });
    await page.goto('/?billing=credits');
    await basePage.dismissModals();

    const started = page.waitForResponse(
      res => res.url().includes('/api/stripe/start-payment') && res.request().method() === 'POST'
    );
    await page.getByTestId('credits-purchase-btn').first().click();
    const startedRes = await started;
    expect(startedRes.status()).toBe(200);
    const { publishableKey } = (await startedRes.json()) as { publishableKey?: string };
    if (!publishableKey?.startsWith('pk_test_')) {
      throw new Error('Refusing to enter a card: the stage did not hand out a Stripe test-mode key');
    }

    await expect(page.getByTestId('payment-modal-dialog')).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
    await fillPaymentElementCard(page, CHALLENGE_ON_REQUEST_CARD);
    await page.getByTestId('checkout-submit-btn').click();
    await approveThreeDSecureChallenge(page);

    await expect(page.getByTestId('checkout-payment-message')).toHaveText('Payment succeeded!', {
      timeout: TIMEOUTS.ACTION,
    });
    purchase = { userId: account.userId, paidAt: Date.now(), before };
  });

  test('A3.5 a first card purchase holds the unlock bonus instead of paying it at checkout', async ({ request }) => {
    test.skip(!isStagingEnv(), STAGING_ONLY_SKIP);
    const hours = await liveSetting<number>(request, 'signupUnlockPaymentHoldHours');
    test.skip(hours === 0, 'The stage pays unlock bonuses at once (signupUnlockPaymentHoldHours is 0)');
    const bought = purchase!;
    test.skip(
      !bought.before.signupGrant?.unlockCredits,
      'The stage stages no unlock bonus for a new account (unlockCredits is 0), so a payment has nothing to hold'
    );

    const held: { record?: UserRecord } = {};
    await expect
      .poll(
        async () => {
          held.record = await adminReadUser(request, bought.userId);
          return Boolean(held.record.signupGrant?.heldUnlock);
        },
        { message: 'the payment webhook records the hold', timeout: TIMEOUTS.TEST }
      )
      .toBe(true);
    const grant = held.record!.signupGrant!;
    const releaseAt = Date.parse(grant.heldUnlock!.releaseAt);
    expect(releaseAt).toBeGreaterThan(bought.paidAt + hours * HOUR_MS - CLOCK_SLACK_MS);
    expect(releaseAt).toBeLessThan(Date.now() + hours * HOUR_MS + CLOCK_SLACK_MS);
    expect(grant.creditsReleased).toBe(bought.before.signupGrant!.creditsReleased);
  });
});
