import { ModelBackend, resolveAppliedRates, usdToCreditsExpected, type ModelInfo } from '@bike4mind/common';
import { estimateNextInputTokens } from '@client/app/utils/creditEstimate';

/** Below this the notice stays hidden: a re-write that small is not worth interrupting for. */
export const MODEL_SWITCH_NOTICE_MIN_CREDITS = 500;

const CACHE_WRITE_BACKENDS: ReadonlySet<string> = new Set([ModelBackend.Anthropic, ModelBackend.Bedrock]);

/**
 * Credits the next message spends writing this conversation into `model`'s prompt cache, which is
 * per model: the last turn's prompt, in `model`'s tokens, at the cache-write rate settlement charges
 * (the plain input rate for backends that bill no cache writes).
 * Null when unpriced or free.
 */
export function modelSwitchCacheCredits(
  model: ModelInfo,
  previousInputTokens: number,
  previousModelId: string | undefined
): number | null {
  if (model.freeToRun || !model.pricing) return null;
  const promptTokens = estimateNextInputTokens(previousInputTokens, '', model.id, previousModelId);
  const rates = resolveAppliedRates(model, promptTokens);
  if (!rates) return null;
  const billsCacheWrite =
    CACHE_WRITE_BACKENDS.has(model.backend) || model.pricing[rates.tierKey]?.cache_write !== undefined;
  const credits = usdToCreditsExpected((billsCacheWrite ? rates.cacheWrite : rates.input) * promptTokens);
  return credits > 0 ? credits : null;
}

/** "about N": tens under 1,000, hundreds above. */
export function roundNoticeCredits(credits: number): number {
  const step = credits < 1000 ? 10 : 100;
  return Math.round(credits / step) * step;
}

/**
 * The credits to show when the selected model differs from the one that answered the last turn and
 * re-writing the history there costs at least MODEL_SWITCH_NOTICE_MIN_CREDITS; null otherwise,
 * including for a new or empty conversation.
 */
export function getModelSwitchCostNotice({
  selectedModel,
  answeredModelId,
  previousInputTokens,
  previousInputModelId,
  providerInputTokens,
}: {
  selectedModel: ModelInfo | undefined;
  answeredModelId: string | undefined;
  previousInputTokens: number | undefined;
  previousInputModelId: string | undefined;
  /** The provider's count of the last prompt, in the answering model's tokens; preferred over the estimate. */
  providerInputTokens?: number;
}): number | null {
  if (!selectedModel || !answeredModelId || !previousInputTokens) return null;
  if (selectedModel.id === (previousInputModelId ?? answeredModelId)) return null;
  const credits = providerInputTokens
    ? modelSwitchCacheCredits(selectedModel, providerInputTokens, answeredModelId)
    : modelSwitchCacheCredits(selectedModel, previousInputTokens, previousInputModelId);
  if (credits === null || credits < MODEL_SWITCH_NOTICE_MIN_CREDITS) return null;
  return roundNoticeCredits(credits);
}
