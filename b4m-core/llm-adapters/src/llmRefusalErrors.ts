import type { LlmTimeoutUsage } from './llmTimeoutErrors';

/**
 * A safety-classifier refusal (stop_reason 'refusal') from a model whose refusalFallback is on, thrown so
 * the completion loop continues on the model's fallback chain. The message keeps the "safety classifier
 * refusal" phrase that isSafetyRefusalError (utils/adminSettings/fallback.ts) matches.
 */
export class SafetyRefusalError extends Error {
  /** What the provider billed before the refusal: tool rounds already run, plus the refused request if it streamed output. */
  readonly usage?: LlmTimeoutUsage;

  constructor(
    readonly model: string,
    usage?: LlmTimeoutUsage
  ) {
    super(`Anthropic safety classifier refusal for ${model} - falling back to an alternative model`);
    this.name = 'SafetyRefusalError';
    this.usage = usage;
  }
}
