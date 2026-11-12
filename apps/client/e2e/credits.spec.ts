import type { APIRequestContext, Browser, Page } from '@playwright/test';
import { test, expect, openPageAs } from './fixtures';
import { TIMEOUTS } from './constants';
import { apiCreateThrowawayUser } from './helpers/api';
import { isProductionEnv } from './helpers/env';
import { BasePage } from './pages/BasePage';
import { ModelSelectorPage } from './pages/ModelSelectorPage';
import { NavigationPage } from './pages/NavigationPage';

// The credits user starts with 1 credit (credits.setup.ts). The server's pre-flight reservation
// prices PREFLIGHT_RESERVATION_OUTPUT_TOKENS of output and usdToCredits rounds up with a floor of 1
// (b4m-core/common/src/pricing.ts), so for any model priced above ~$0.03/M output the reservation
// exceeds the balance and ChatCompletionProcess throws InsufficientCreditsError before calling the
// model. PromptReplies then renders InsufficientCreditsNotice in place of the reply container.
// Assumes enforceCredits is on (the hosted default); with it off the gate never fires.
test.describe('Credit enforcement', () => {
  test.beforeEach(async ({ page, basePage }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await basePage.dismissModals();
  });

  test('should show the insufficient-credits notice instead of a reply when the balance is below the reservation', async ({
    page,
    navigationPage,
    chatPage,
    modelSelector,
  }) => {
    test.slow();

    await navigationPage.navigateToNewChat();
    await modelSelector.selectTextModel('GPT-4.1 Mini', { disableSmartTools: true });

    // Below LOW_CREDITS_THRESHOLD the low-credits overlay covers the chat input, so the click in
    // sendMessage would be intercepted. Its dismissal is component state, so a reload inside
    // sendMessage's retry loop (ChatPage.typeAndWaitForSendReady) re-mounts it; a locator handler
    // re-dismisses it before every action. It never fires when the overlay is absent (e.g. the
    // negative control with a full balance), so it cannot mask the assertions below.
    await page.addLocatorHandler(page.getByTestId('session-low-credits-warning'), async overlay => {
      await overlay.getByTestId('low-credits-warning-dismiss').click();
    });

    // Not sendMessageAndWaitForResponse: it waits on a reply container that must never render.
    await chatPage.sendMessage('Say hi.');

    const notice = page.getByTestId('insufficient-credits-notice');
    await expect(notice).toBeVisible({ timeout: TIMEOUTS.AI_RESPONSE });
    await expect(notice.getByTestId('insufficient-credits-message')).toHaveText(/credit/i);
    // Scoped to the notice: the dismissed low-credits overlay carries its own session-credits-btn.
    await expect(notice.getByTestId('session-credits-btn')).toBeVisible();
    await expect(notice.getByTestId('session-subscribe-btn')).toBeVisible();

    // Checked only after the notice is up, so an empty chat cannot pass it vacuously.
    await expect(page.getByTestId('ai-response-root-container')).toHaveCount(0);
  });
});

// Each test mints its own throwaway user with a fixed starting balance, so no shared user's balance
// moves and no global setting is touched; global-teardown sweeps the users. No prompt is sent.
// Claude Opus 5.5 is selected for its price: its admission hold is several hundred credits, while
// the cheapest text models hold less than LOW_BALANCE, so the affordable-model offer must appear.
test.describe('Balance explainer', () => {
  const EXPENSIVE_MODEL = 'Claude Opus 5.5';
  const LOW_BALANCE = 40;

  test.skip(isProductionEnv(), 'Mints test users through /api/test/create-user, which production refuses');

  async function openChatWithBalance(
    { browser, baseURL, request }: { browser: Browser; baseURL: string | undefined; request: APIRequestContext },
    label: string,
    initialCredits?: number
  ) {
    const user = await apiCreateThrowawayUser(request, label, { initialCredits });
    const opened = await openPageAs(browser, baseURL, user);
    await opened.page.goto('/');
    await new BasePage(opened.page).dismissModals();
    await new NavigationPage(opened.page).navigateToNewChat();
    return opened;
  }

  async function openExplainer(page: Page) {
    await page.getByTestId('credit-balance-chip').click();
    const explainer = page.getByTestId('billing-modal').getByTestId('credits-explanation');
    await expect(explainer).toBeVisible();
    return explainer;
  }

  test('a normal balance shows answers left and no low-balance offer', async ({ browser, baseURL, request }) => {
    // No initialCredits: create-user's effectively unlimited default balance.
    const { page, close } = await openChatWithBalance({ browser, baseURL, request }, 'balfine');
    try {
      await new ModelSelectorPage(page).selectTextModel(EXPENSIVE_MODEL);
      // The chip counts answers only once the model catalog has loaded, which is also what the
      // offer waits on, so the absence checks below cannot pass before the offer could render.
      await expect(page.getByTestId('credit-balance-chip')).toHaveText(/^~[\d,]+ answers$/);
      await expect(page.getByTestId('affordable-model-offer')).toHaveCount(0);
      await expect(page.getByTestId('session-low-credits-warning')).toHaveCount(0);
      await expect(page.getByTestId('session-credits-warning')).toHaveCount(0);

      const explainer = await openExplainer(page);
      await expect(explainer.getByTestId('credits-explanation-answers')).toHaveText(
        /^About [\d,]+ typical answers left$/
      );
      await expect(explainer).toContainText(`On ${EXPENSIVE_MODEL}, based on a typical answer.`);
    } finally {
      await close();
    }
  });

  test('a low balance explains itself and offers an affordable model that can be picked', async ({
    browser,
    baseURL,
    request,
  }) => {
    const { page, close } = await openChatWithBalance({ browser, baseURL, request }, 'ballow', LOW_BALANCE);
    try {
      await new ModelSelectorPage(page).selectTextModel(EXPENSIVE_MODEL);
      await expect(page.getByTestId('credit-balance-chip')).toHaveText('<1 answer');
      await expect(page.getByTestId('session-credits-warning')).toHaveCount(0);

      const offer = page.getByTestId('affordable-model-offer');
      await expect(offer).toBeVisible();
      await expect(offer).toContainText(`${EXPENSIVE_MODEL} needs an estimated`);
      const useBtn = offer.getByTestId('affordable-model-use-btn');
      const offeredModel = ((await useBtn.textContent()) ?? '').replace(/^Switch to /, '').trim();
      expect(offeredModel).not.toBe('');
      expect(offeredModel).not.toBe(EXPENSIVE_MODEL);

      const explainer = await openExplainer(page);
      await expect(explainer.getByTestId('credits-explanation-answers')).toHaveText('Less than 1 typical answer left');
      await expect(explainer.getByTestId('credits-explanation-balance')).toHaveText(`${LOW_BALANCE} credits available`);
      await page.getByTestId('billing-modal-close').click();
      await expect(page.getByTestId('billing-modal')).toBeHidden();

      await useBtn.click();
      await expect(page.getByTestId('ai-settings-btn').first()).toHaveAttribute(
        'aria-label',
        `AI Settings, model: ${offeredModel}`
      );
      // The offered model's hold fits the balance, so the offer has nothing left to suggest.
      await expect(offer).toHaveCount(0);

      const afterSwitch = await openExplainer(page);
      await expect(afterSwitch).toContainText(`On ${offeredModel}`);
    } finally {
      await close();
    }
  });

  test('a zero balance explains that no answers are left and offers no model', async ({
    browser,
    baseURL,
    request,
  }) => {
    const { page, close } = await openChatWithBalance({ browser, baseURL, request }, 'balzero', 0);
    try {
      await expect(page.getByTestId('session-credits-warning')).toBeVisible();
      await expect(page.getByTestId('credit-balance-chip')).toHaveText('0 answers');
      // A switch cannot help at zero: the composer blocks every model, free ones included.
      await expect(page.getByTestId('affordable-model-offer')).toHaveCount(0);

      const explainer = await openExplainer(page);
      await expect(explainer.getByTestId('credits-explanation-answers')).toHaveText('No typical answers left');
      await expect(explainer.getByTestId('credits-explanation-balance')).toHaveText('0 credits available');
    } finally {
      await close();
    }
  });
});
