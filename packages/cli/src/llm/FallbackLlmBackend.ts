import type { IMessage, ModelInfo } from '@bike4mind/common';
import type {
  ICompletionBackend,
  ICompletionOptions,
  CompletionInfo,
  IChoiceEndToolUse,
} from '@bike4mind/llm-adapters';
import { logger } from '../utils/Logger';

/**
 * LLM backend decorator that provides model-level fallback routing.
 *
 * When the primary model fails (after the inner backend's own retries are exhausted),
 * FallbackLlmBackend tries the next model in the configured fallback chain.
 *
 * Example chain: Opus -> Sonnet -> Haiku (graceful degradation under rate limits)
 *
 * Configured via `CliConfig.fallbackModels`. Wraps any `ICompletionBackend`,
 * fitting cleanly into the existing decorator pattern (NotifyingLlmBackend, etc.).
 */
export class FallbackLlmBackend implements ICompletionBackend {
  private inner: ICompletionBackend;
  private fallbackModels: string[];
  private onFallback: (fromModel: string, toModel: string, error: Error) => void;

  constructor(
    inner: ICompletionBackend,
    fallbackModels: string[],
    onFallback: (fromModel: string, toModel: string, error: Error) => void
  ) {
    this.inner = inner;
    this.fallbackModels = fallbackModels;
    this.onFallback = onFallback;
  }

  get currentModel(): string {
    return this.inner.currentModel;
  }

  set currentModel(model: string) {
    this.inner.currentModel = model;
  }

  async complete(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>,
    callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
  ): Promise<void> {
    // Never fall back on an explicit abort - respect the user's intent
    if (options.abortSignal?.aborted) {
      return this.inner.complete(model, messages, options, callback);
    }

    // Build the ordered list of models to try: primary first, then fallbacks (skipping duplicates)
    const modelsToTry = [model, ...this.fallbackModels.filter(m => m !== model)];

    let lastError: Error | undefined;

    for (let i = 0; i < modelsToTry.length; i++) {
      const modelToTry = modelsToTry[i];

      // Buffer the inner backend's deliveries and flush only once the attempt
      // succeeds. A failed attempt's partial output (OllamaBackend fires the
      // callback per-chunk, so it can stream text before throwing) is discarded
      // and can never replay on top of the next model's output (the
      // double-content bug). This also removes the need for a "callback already
      // fired" guard and lets a stream-then-fail attempt fall back cleanly.
      //
      // Buffering is a no-op for SSE/WebSocket backends (they call the callback
      // once at end-of-turn via accumulator.finalize); it only delays delivery
      // for per-chunk OllamaBackend. No user-visible latency in either CLI mode:
      // neither headless (handleHeadlessCommand) nor the interactive TUI
      // (index.tsx) renders live token streams - both consume turn-level ReAct
      // events and the final answer, emitted only once the turn ends.
      const buffered: Array<{ text: (string | null | undefined)[]; completionInfo?: CompletionInfo }> = [];
      const bufferingCallback = async (
        text: (string | null | undefined)[],
        completionInfo?: CompletionInfo
      ): Promise<void> => {
        buffered.push({ text, completionInfo });
      };

      try {
        await this.inner.complete(modelToTry, messages, options, bufferingCallback);
        // Success - replay the buffered deliveries to the real callback in order.
        for (const delivery of buffered) {
          await callback(delivery.text, delivery.completionInfo);
        }
        return;
      } catch (error) {
        // Propagate abort immediately - no fallback
        if (options.abortSignal?.aborted) {
          throw error;
        }

        lastError = error instanceof Error ? error : new Error(String(error));

        const nextModel = modelsToTry[i + 1];
        if (nextModel) {
          logger.warn(`[FallbackLlmBackend] Model "${modelToTry}" failed: ${lastError.message}`);
          this.onFallback(modelToTry, nextModel, lastError);
        }
      }
    }

    throw lastError ?? new Error('All fallback models exhausted');
  }

  pushToolMessages(
    messages: IMessage[],
    tool: IChoiceEndToolUse['tool'],
    result: string,
    thinkingBlocks?: unknown[]
  ): void {
    this.inner.pushToolMessages(messages, tool, result, thinkingBlocks);
  }

  async getModelInfo(): Promise<ModelInfo[]> {
    return this.inner.getModelInfo();
  }
}
