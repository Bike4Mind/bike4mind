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

      // Deliveries pass straight through so streamed text reaches the UI live.
      // The first delivery is the point of no return: the caller has already
      // appended it, so a later failure surfaces instead of falling back (the
      // next model's output would land on top of the partial one - the
      // double-content bug). Failures before any output, like rate limits and
      // auth errors, still fall back.
      let delivered = false;
      const trackingCallback = async (
        text: (string | null | undefined)[],
        completionInfo?: CompletionInfo
      ): Promise<void> => {
        delivered = true;
        await callback(text, completionInfo);
      };

      try {
        await this.inner.complete(modelToTry, messages, options, trackingCallback);
        return;
      } catch (error) {
        // Abort, or output already delivered: propagate - no fallback
        if (options.abortSignal?.aborted || delivered) {
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
