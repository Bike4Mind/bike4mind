import { test, expect } from './fixtures';
import { TIMEOUTS } from './constants';

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
