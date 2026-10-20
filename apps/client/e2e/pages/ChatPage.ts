import { expect } from '@playwright/test';
import { TIMEOUTS } from '../constants';
import { BasePage } from './BasePage';
import { describeStall, isStreamComplete, StreamingTimeoutError, type StreamSnapshot } from '../ai-latency-budget';

export class ChatPage extends BasePage {
  readonly chatInput = this.page.getByTestId('lexical-chat-input-container');
  readonly sendButton = this.page.getByTestId('send-message-btn');
  readonly aiResponseRoot = this.page.getByTestId('ai-response-root-container');

  /**
   * One wrapper per AI message (MessageContent's root, `message-<id>`), holding both the reply
   * container and the footer that carries the credits chip. The `has` filter is what makes the
   * prefix match precise: `message-actions-menu-btn` and friends also start with `message-`.
   */
  private readonly aiMessage = this.page
    .locator('[data-testid^="message-"]')
    .filter({ has: this.page.getByTestId('ai-response-root-container') });

  /**
   * Text of the newest mounted reply, or '' when none is mounted.
   *
   * Reads the reply body (`ai-response-body`), falling back to the whole root container when no
   * body is mounted (syntax-highlight and image-only views). The body test id is what keeps
   * reasoning text and the banner/accessory rows around it out of the returned text: the root
   * wraps those too, and callers assert keywords against this string. The prompt-enhancement
   * banner is the exception - it renders inside the body, so an enhanced prompt's banner text is
   * included. Reading only `ai-response`, the id on the markdown <p> renderer, missed list-only
   * replies entirely and stalled the completion wait until its budget ran out.
   *
   * The count() guards are load-bearing: the config sets no `actionTimeout`, so a bare
   * `.innerText()` on an absent element auto-waits with NO timeout and blocks until the test
   * times out. count() never waits; the bounded innerText then covers Virtuoso unmounting the
   * reply between the two calls.
   */
  private async newestResponseText(): Promise<string> {
    if ((await this.aiResponseRoot.count()) === 0) return '';
    const root = this.aiResponseRoot.last();
    const body = root.getByTestId('ai-response-body');
    const target = (await body.count()) > 0 ? body.first() : root;
    return target.innerText({ timeout: TIMEOUTS.ELEMENT_STATE }).catch(() => '');
  }

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
      try {
        // Bound the click: with no suite-level actionTimeout an unbounded click would hang on
        // the actionability/stability check (background refetch re-rendering the input) instead
        // of throwing, starving this retry loop. Keeping it inside the try also lets a real
        // click failure fall through to the reload-and-retry path.
        await this.chatInput.click({ timeout: TIMEOUTS.ELEMENT_STATE });
        await this.page.keyboard.insertText(text);
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
      // Never anchor on a pre-send index. ChatHistory renders the reply list through
      // react-virtuoso, so only the replies near the viewport stay mounted (3 at 1280x720):
      // a new reply evicts the oldest instead of growing the count, and
      // `.nth(countBeforeSend)` waits forever on an index that can never mount. Anchor on
      // `.last()` (as waitForImageResponse does, for a different reason) and use the newest
      // reply's pre-send text as the baseline that proves what we read back is new.
      await this.typeAndWaitForSendReady(text);
      // Captured after typing, immediately before Enter: from here until the stop button shows,
      // the text-only completion path is live, so a prior reply that gains chrome while the turn
      // is still being prepared must already be in the baseline.
      const previousResponse = await this.newestResponseText();
      await this.page.keyboard.press('Enter');

      // Waits for the first container to mount in a fresh chat; in a resumed chat the prior
      // turn's container already satisfies it. Newness is proven by the streaming lifecycle
      // plus the text baseline, not by this gate.
      await expect(this.aiResponseRoot.last()).toBeVisible({ timeout });

      // Wait for streaming to complete by watching for "Stop Generation" button to disappear
      await this.waitForStreamingComplete(timeout, previousResponse);

      const responseText = await this.newestResponseText();

      // Retry once if the server timed out
      if (attempt < maxAttempts && responseText.includes('request timed out')) {
        continue;
      }

      return responseText;
    }
    return '';
  }

  /**
   * Polls until the turn just sent has finished (see isStreamComplete), or fails with a
   * StreamingTimeoutError once `timeout` runs out.
   *
   * `previousResponse` is the newest reply's text captured before sending. It proves a new reply
   * exists when the stop button flashed by between polls (a short reply can finish in one chunk);
   * chats are resumed across tests, so a prior turn's reply is normally already mounted.
   */
  private async waitForStreamingComplete(timeout: number = TIMEOUTS.AI_RESPONSE, previousResponse = '') {
    const stopButton = this.page.getByTestId('stop-generation-btn');
    let sawStopButton = false;
    let snapshot: StreamSnapshot = { stopVisible: false, text: '' };

    try {
      await expect
        .poll(
          async () => {
            snapshot = {
              stopVisible: await stopButton.isVisible().catch(() => false),
              text: await this.newestResponseText(),
            };
            sawStopButton ||= snapshot.stopVisible;
            return isStreamComplete(snapshot, previousResponse, sawStopButton);
          },
          { timeout, intervals: [250] }
        )
        .toBe(true);
    } catch {
      if (this.page.isClosed()) return;
      throw new StreamingTimeoutError(timeout, describeStall(snapshot));
    }
  }

  async waitForAIResponse(timeout: number = TIMEOUTS.AI_RESPONSE) {
    const response = this.aiResponseRoot.last();
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
      selector: '[data-testid="ai-response-body"]',
    });
  }

  /**
   * Returns the numeric credit count for the newest AI reply's chip, or null if it never renders.
   *
   * Scoped to the newest message wrapper, NOT read off a global chip count. The chip renders in
   * MessageContent's footer once the server populates `messageData.creditsUsed`, which lags
   * behind streaming visually completing - so a bare `creditsUsed.last()` can return the PREVIOUS
   * message's already-rendered chip, a stale value that repeats across runs/models. The old guard
   * ("wait for one more chip than before sending") cannot work here: the chat list is virtualized,
   * so the mounted chip count saturates and a later turn never exceeds the pre-send count, leaving
   * a real measurement unread. Scoping to `aiMessage.last()` fixes both - it resolves to THIS
   * message's chip or to nothing, with no dependence on how many chips are mounted.
   */
  async getCreditsUsed(): Promise<number | null> {
    try {
      const chip = this.aiMessage.last().getByTestId('credits-used');
      await chip.waitFor({ state: 'visible', timeout: 15_000 });
      const text = await chip.innerText();
      // The chip reads "1,234 credits"; drop the grouping commas before parsing.
      const match = text.replace(/,/g, '').match(/\d+/);
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
    const startMs = Date.now();
    const responseText = await this.sendMessageAndWaitForResponse(text, timeout);
    const durationSecs = (Date.now() - startMs) / 1000;
    const credits = await this.getCreditsUsed();
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
    // Baseline the newest reply before sending: when the stop button flashes by unseen,
    // waitForStreamingComplete accepts any reply that differs from this, so without it
    // a prior chat's leftover reply (navigateToNewChat does not await DOM clearing) could be
    // mistaken for this turn's response. Taken after typing so text the previous reply gains
    // during preparation is part of the baseline, not read as this turn's reply.
    await this.typeAndWaitForSendReady(text);
    const previousResponse = await this.newestResponseText();
    await this.page.keyboard.press('Enter');
    await this.waitForStreamingComplete(timeout, previousResponse);
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

  /**
   * Non-throwing {@link waitForImageResponse}: resolves true when an image renders within the
   * budget, false when none does. Lets a caller assert on a produced image but fall back to a
   * text check when the model has no image generation, instead of hard-failing the prompt.
   */
  async tryWaitForImageResponse(timeout: number = TIMEOUTS.IMAGE_GENERATION): Promise<boolean> {
    try {
      await this.waitForImageResponse(timeout);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Waits for the artifact placeholders to clear on the newest reply, so a text scrape reads
   * the resolved content instead of a spinner.
   *
   * Streaming completing (stop-generation-btn gone) does NOT mean the reply text is final. An
   * artifact reply passes through TWO sequential placeholders before its content mounts:
   *   1. "Generating artifact..." (PromptReplies, testid `generating-artifact-indicator`) while
   *      the artifact is being produced, then
   *   2. "Loading artifact..." (ArtifactRenderer, testid `artifact-loading`) while the renderer
   *      resolves and lazy-loads it.
   * ArtifactRenderer mounts already showing "Loading..." in the same commit that removes
   * "Generating...", so the COMBINED count never dips to 0 mid-handoff - polling the sum to 0
   * waits out the whole lifecycle without racing the transition. No-op (returns at once) when
   * neither placeholder is present, so it is safe on prompts that may not render an artifact.
   *
   * Caveat: this only guarantees no placeholder is currently pending, not that an artifact
   * rendered. waitForStreamingComplete can return before "<artifact" has streamed (the stop
   * button flashed by unseen and any new reply text counted as done); in that narrow window the
   * count is already 0 and this returns at once. Fine for these prompts, which do stream an
   * artifact - revisit if a prompt relies on this as proof one mounted.
   */
  async waitForArtifactSettled(timeout: number = TIMEOUTS.IMAGE_GENERATION) {
    const root = this.aiResponseRoot.last();
    const generating = root.getByTestId('generating-artifact-indicator');
    const loading = root.getByTestId('artifact-loading');
    await expect
      .poll(async () => (await generating.count()) + (await loading.count()), {
        timeout,
        message: 'Artifact placeholders ("Generating artifact..." / "Loading artifact...") never cleared',
      })
      .toBe(0);
  }
}
