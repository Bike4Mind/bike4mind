import { test, expect, openPageAs } from './fixtures';
import { TIMEOUTS } from './constants';
import { apiCreateThrowawayUser } from './helpers/api';
import { isProductionEnv } from './helpers/env';
import {
  SHORT_SCREEN_MOBILE,
  expectNoHorizontalOverflow,
  expectReachable,
  throttleToSlowLink,
} from './helpers/launch-readiness';
import { BasePage } from './pages/BasePage';

// A6.1: the money paths (signup, first purchase, plan upgrade) work on a short screen over a slow
// link, with no dialog hiding the button that moves the user on. This is the purchase and upgrade
// leg; the signup leg is launch-readiness-signup.spec.ts. Nothing here pays: the credit-pack test
// stops at the Stripe form's submit button, and the upgrade test stops at the Subscribe button.
test.describe(
  'A6.1 buy credits and upgrade a plan on a short screen and a slow link',
  {
    tag: ['@launch-readiness', '@A6.1'],
  },
  () => {
    // Each test mints a throwaway user through /api/test/create-user, which production refuses.
    test.skip(isProductionEnv(), 'Mints test users through /api/test/create-user, which production refuses');

    // The label must be unique per test: the minted username and email derive from it, and
    // create-user rejects a repeat.
    async function openBilling(
      {
        browser,
        baseURL,
        request,
      }: {
        browser: Parameters<typeof openPageAs>[0];
        baseURL: string | undefined;
        request: Parameters<typeof apiCreateThrowawayUser>[0];
      },
      label: string
    ) {
      const user = await apiCreateThrowawayUser(request, label);
      const opened = await openPageAs(browser, baseURL, user, SHORT_SCREEN_MOBILE);
      try {
        const { page } = opened;
        await throttleToSlowLink(page);
        await page.goto('/', { timeout: TIMEOUTS.TEST });
        await new BasePage(page).dismissModals();

        const chip = page.getByTestId('credit-balance-chip');
        await expect(chip).toBeVisible({ timeout: TIMEOUTS.TEST });
        await expectReachable(chip, 'credit balance chip');
        await chip.click();

        await expect(page.getByTestId('billing-modal')).toBeVisible({ timeout: TIMEOUTS.ACTION });
        await expectNoHorizontalOverflow(page);
      } catch (error) {
        await opened.close();
        throw error;
      }
      return opened;
    }

    test('a credit pack purchase reaches the payment form submit button at 375x667', async ({
      browser,
      baseURL,
      request,
    }) => {
      // The slow link stretches the SPA load, the plan and pack fetches, and the Stripe form load.
      test.slow();
      const { page, close } = await openBilling({ browser, baseURL, request }, 'a61credits');
      try {
        const purchaseBtn = page.getByTestId('credits-purchase-btn');
        await expect(purchaseBtn).toBeEnabled({ timeout: TIMEOUTS.ACTION });
        await expectReachable(purchaseBtn, 'Purchase button');
        await purchaseBtn.click();

        // The terms dialog only appears for an account that has not accepted them yet.
        const termsDialog = page.getByTestId('credits-terms-dialog');
        const submitBtn = page.getByTestId('checkout-submit-btn');
        await expect(termsDialog.or(submitBtn)).toBeVisible({ timeout: TIMEOUTS.ACTION });
        if (await termsDialog.isVisible()) {
          const checkbox = page.getByTestId('credits-terms-checkbox').getByRole('checkbox');
          await new BasePage(page).checkMuiCheckbox(checkbox);
          const continueBtn = page.getByTestId('credits-terms-continue-btn');
          await expect(continueBtn).toBeEnabled();
          await expectReachable(continueBtn, 'terms Continue button');
          await continueBtn.click();
        }

        await expect(page.getByTestId('payment-modal-dialog')).toBeVisible({ timeout: TIMEOUTS.ACTION });
        // Disabled until Stripe's form has loaded, which the slow link delays.
        await expect(submitBtn).toBeEnabled({ timeout: TIMEOUTS.ACTION });
        await expectNoHorizontalOverflow(page);
        await expectReachable(submitBtn, 'Pay now button');
      } finally {
        await close();
      }
    });

    test('the first plan Subscribe button is reachable at 375x667', async ({ browser, baseURL, request }) => {
      test.slow();
      const { page, close } = await openBilling({ browser, baseURL, request }, 'a61plan');
      try {
        // Matched by name pattern so a plan rename or reorder does not break the gate.
        const subscribeBtn = page.getByRole('button', { name: /^Subscribe to / }).first();
        await expect(subscribeBtn).toBeVisible({ timeout: TIMEOUTS.ACTION });
        await expect(subscribeBtn).toBeEnabled();
        await expectReachable(subscribeBtn, 'plan Subscribe button');
        await expectNoHorizontalOverflow(page);
      } finally {
        await close();
      }
    });
  }
);
