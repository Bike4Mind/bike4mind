import { expect } from '@playwright/test';
import { TIMEOUTS } from '../constants';
import { BasePage } from './BasePage';

export class ChatPage extends BasePage {
  readonly chatInput = this.page.getByTestId('lexical-chat-input-container');
  readonly sendButton = this.page.getByTestId('send-message-btn');
  readonly aiResponse = this.page.getByTestId('ai-response');
  readonly creditsUsed = this.page.getByTestId('credits-used');
  readonly aiResponseRoot = this.page.getByTestId('ai-response-root-container');

  async sendMessage(text: string) {
    await this.typeAndWaitForSendReady(text);
    await this.page.keyboard.press('Enter');
  }

  /**
   * Type text into the chat input and wait for the send button to become enabled.
   * The enabled send button is the readiness signal - it stays disabled until the
   * editor (and its underlying connection) is ready to submit. If it doesn't enable,
   * reload the page and retry.
   */
  private async typeAndWaitForSendReady(text: string) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await this.chatInput.click();
      await this.page.keyboard.insertText(text);
      try {
        await expect(this.sendButton).toBeEnabled({ timeout: TIMEOUTS.NAVIGATION });
        return;
      } catch {
        if (attempt === 3) throw new Error('Send button did not become enabled after retries');
        // Reload and retry - the editor may not have been ready yet
        await this.page.reload({ waitUntil: 'domcontentloaded' });
      }
    }
  }

  async sendMessageAndWaitForResponse(text: string, timeout: number = TIMEOUTS.AI_RESPONSE) {
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Track response count before sending so we can wait for the NEW response
      const responsesBeforeSend = await this.aiResponseRoot.count();

      await this.typeAndWaitForSendReady(text);
      await this.page.keyboard.press('Enter');

      // Wait for a new ai-response element to appear (beyond those already present)
      await expect(this.aiResponseRoot.nth(responsesBeforeSend)).toBeVisible({ timeout });

      // Wait for streaming to complete by watching for "Stop Generation" button to disappear
      await this.waitForStreamingComplete(timeout);

      const responseText = await this.aiResponse
        .last()
        .innerText()
        .catch(() => '');

      // Retry once if the server timed out
      if (attempt < maxAttempts && responseText.includes('request timed out')) {
        continue;
      }

      return responseText;
    }
    return '';
  }

  private async waitForStreamingComplete(timeout: number = TIMEOUTS.AI_RESPONSE) {
    const stopButton = this.page.getByTestId('stop-generation-btn');

    // First, wait for the stop button to appear (streaming started)
    try {
      await expect(stopButton).toBeVisible({ timeout: TIMEOUTS.ACTION });
    } catch {
      // Stop button never appeared within ACTION timeout. This can happen when:
      // 1. Response completed instantly (fast model, short answer)
      // 2. Smart Tools processing takes longer than ACTION before streaming starts
      // Guard the entire block - the page may have been closed by the time we get here
      // (e.g. test timeout / context teardown), in which case all locator calls throw.
      try {
        const hasResponse = await this.aiResponse.count();
        if (hasResponse > 0) return;

        // No response yet - Smart Tools likely still processing. Wait for either
        // the Stop button to eventually appear or an ai-response element to show up.
        await Promise.race([
          expect(stopButton)
            .toBeVisible({ timeout })
            .catch(() => {}),
          expect(this.aiResponse.first())
            .toBeVisible({ timeout })
            .catch(() => {}),
        ]);

        // If the Stop button appeared during the race, wait for it to disappear
        const isStopVisible = await stopButton.isVisible().catch(() => false);
        if (!isStopVisible) return;
      } catch {
        // Page/context was closed - nothing left to wait for
        return;
      }
    }

    // Wait for the stop button to disappear (streaming finished).
    // Fallback: if the response content stabilises while the Stop button stays visible
    // (e.g., server-side streaming stalls), treat it as complete.
    try {
      await expect(stopButton).toBeHidden({ timeout });
    } catch {
      // Stop button still visible - check if the response text has stabilised
      const text1 = await this.aiResponse
        .last()
        .innerText()
        .catch(() => '');
      if (text1.length > 0) {
        await this.page.waitForTimeout(TIMEOUTS.POST_ACTION);
        const text2 = await this.aiResponse
          .last()
          .innerText()
          .catch(() => '');
        if (text1 === text2) {
          // Response hasn't changed - streaming is effectively done
          return;
        }
      }
      // If still changing or empty, re-throw
      throw new Error(`Streaming did not complete within ${timeout}ms`);
    }
  }

  async waitForAIResponse(timeout: number = TIMEOUTS.AI_RESPONSE) {
    // Fallback: just wait for the ai-response element in DOM
    const response = this.aiResponse.last();
    await expect(response).toBeVisible({ timeout });
    return await response.innerText().catch(() => '');
  }

  async sendAndVerify(
    prompt: string,
    answers: string | string[],
    options: {
      logic?: 'and' | 'or';
      timeout?: number;
      verifyAnswers: (answers: string | string[], options?: Record<string, unknown>) => Promise<void>;
    }
  ) {
    await this.sendMessageAndWaitForResponse(prompt, options.timeout);
    await options.verifyAnswers(answers, {
      logic: options.logic,
      selector: '[data-testid="ai-response"]',
    });
  }

  /**
   * Returns the numeric credit count for the newest AI response chip, or null if not shown.
   *
   * The per-message credits chip only renders once the server populates
   * `messageData.creditsUsed`, which lags behind streaming visually completing. Reading
   * `.last()` too early therefore returns the PREVIOUS message's already-rendered chip -
   * a stale value that repeats across runs/models. `minCount` (the chip count captured
   * before sending) is required so we wait for a brand-new chip to appear before reading it -
   * a zero-arg call would silently reintroduce the stale-read bug this method exists to fix.
   */
  async getCreditsUsed(minCount: number): Promise<number | null> {
    try {
      // Wait for a new credits chip (beyond those present before sending) to render.
      await expect.poll(() => this.creditsUsed.count(), { timeout: 15_000 }).toBeGreaterThan(minCount);
      const chip = this.creditsUsed.last();
      await chip.waitFor({ state: 'visible', timeout: 10_000 });
      const text = await chip.innerText();
      const match = text.match(/\d+/);
      return match ? parseInt(match[0]) : null;
    } catch (err) {
      console.debug('[getCreditsUsed] credits chip not found:', (err as Error).message);
      return null;
    }
  }

  /**
   * Send a message, wait for the AI response, and return timing + credits.
   * Timer starts just before the message is sent.
   */
  async sendMessageAndMeasure(
    text: string,
    timeout: number = TIMEOUTS.AI_RESPONSE
  ): Promise<{ responseText: string; durationSecs: number; credits: number | null }> {
    // Capture how many credits chips exist before sending so getCreditsUsed can wait for
    // THIS message's chip to render, rather than reading a stale prior-message value.
    const creditsBefore = await this.creditsUsed.count();
    const startMs = Date.now();
    const responseText = await this.sendMessageAndWaitForResponse(text, timeout);
    const durationSecs = (Date.now() - startMs) / 1000;
    const credits = await this.getCreditsUsed(creditsBefore);
    return { responseText, durationSecs, credits };
  }

  /**
   * Send an image-generation prompt and wait for streaming to complete.
   *
   * Intentionally diverges from {@link sendMessageAndWaitForResponse}: it does NOT
   * gate on `aiResponseRoot` becoming visible. For text, the response container mounts
   * the moment streaming starts (well within the streaming budget). For images, the
   * container is part of the long-pole render - it only mounts once the generated image
   * arrives (up to IMAGE_GENERATION), so an early toBeVisible gate bounded by the
   * streaming timeout would always time out. The new-response assertion is therefore
   * deferred to {@link waitForImageResponse}, which holds the full IMAGE_GENERATION budget.
   */
  async sendImageMessageAndWaitForResponse(text: string, timeout: number = TIMEOUTS.IMAGE_GENERATION) {
    await this.typeAndWaitForSendReady(text);
    await this.page.keyboard.press('Enter');
    await this.waitForStreamingComplete(timeout);
  }

  /**
   * Asserts the generated image rendered. Call ONLY after
   * {@link sendImageMessageAndWaitForResponse} - by then streaming is done and the
   * <img> is mounted from messageData.images. This does NOT recover from WS drops on
   * its own; if invoked after a plain {@link sendMessage}, the resilience is lost.
   *
   * Anchors on `aiResponseRoot.last()`: the newest response container. We deliberately
   * do NOT anchor on a pre-send index - navigateToNewChat does not await the prior
   * chat's DOM clearing, so a count captured before sending is not reliably zero, and
   * `.nth(staleCount)` would wait on a container that never receives the image. `.last()`
   * always resolves to the current turn's container. The suite sends one image prompt
   * per fresh chat; revisit only if a multi-turn image test is ever added.
   */
  async waitForImageResponse(timeout: number = TIMEOUTS.IMAGE_GENERATION) {
    // The <img> lives inside the AI response container, so waiting on it
    // implicitly waits for the container too.
    const img = this.aiResponseRoot.last().getByTestId('ai-response-image').first();

    // Streaming has already completed by the time this is called, so the <img>
    // should be mounted (PromptReplies renders it from messageData.images).
    await expect(img).toBeVisible({ timeout });

    // Wait for the image to fully load (naturalWidth > 0).
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout }).toBeGreaterThan(0);

    return img;
  }
}
