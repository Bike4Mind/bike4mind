import {
  DEFAULT_PROMPT_CACHE_TTL,
  ModelBackend,
  oneHourCacheWriteRate,
  resolveAppliedRates,
  usdToCreditsExpected,
  type ModelInfo,
  type PromptCacheTtl,
} from '@bike4mind/common';
import { estimateNextInputTokens } from '@client/app/utils/creditEstimate';

/** Below this the notice stays hidden: a re-write that small is not worth interrupting for. */
export const MODEL_SWITCH_NOTICE_MIN_CREDITS = 500;

const CACHE_WRITE_BACKENDS: ReadonlySet<string> = new Set([ModelBackend.Anthropic, ModelBackend.Bedrock]);

/**
 * Credits the next message spends writing this conversation into `model`'s prompt cache, which is
 * per model: the last turn's prompt, in `model`'s tokens, at the cache-write rate settlement charges
 * for `ttl` (1.25x input for 5 minutes, 2x for an hour; the plain input rate for backends that bill
 * no cache writes). Null when unpriced or free.
 */
export function modelSwitchCacheCredits(
  model: ModelInfo,
  previousInputTokens: number,
  previousModelId: string | undefined,
  ttl: PromptCacheTtl = DEFAULT_PROMPT_CACHE_TTL
): number | null {
  if (model.freeToRun || !model.pricing) return null;
  const promptTokens = estimateNextInputTokens(previousInputTokens, '', model.id, previousModelId);
  const rates = resolveAppliedRates(model, promptTokens);
  if (!rates) return null;
  const billsCacheWrite =
    CACHE_WRITE_BACKENDS.has(model.backend) || model.pricing[rates.tierKey]?.cache_write !== undefined;
  const writeRate = !billsCacheWrite ? rates.input : ttl === '1h' ? oneHourCacheWriteRate(rates) : rates.cacheWrite;
  const credits = usdToCreditsExpected(writeRate * promptTokens);
  return credits > 0 ? credits : null;
}

/** "about N": tens under 1,000, hundreds above. */
export function roundNoticeCredits(credits: number): number {
  const step = credits < 1000 ? 10 : 100;
  return Math.round(credits / step) * step;
}

interface CacheCostNoticeInput {
  selectedModel: ModelInfo | undefined;
  answeredModelId: string | undefined;
  previousInputTokens: number | undefined;
  previousInputModelId: string | undefined;
  /** The provider's count of the last prompt, in the answering model's tokens; preferred over the estimate. */
  providerInputTokens?: number;
  /** The TTL the next message will write at. */
  cacheTtl?: PromptCacheTtl;
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
  cacheTtl,
}: CacheCostNoticeInput): number | null {
  if (!selectedModel || !answeredModelId || !previousInputTokens) return null;
  // The user's last pick is not a switch, and the model that answered (after any fallback) holds the cache.
  if (selectedModel.id === answeredModelId || selectedModel.id === previousInputModelId) return null;
  return noticeCredits(
    selectedModel,
    previousInputTokens,
    previousInputModelId,
    answeredModelId,
    providerInputTokens,
    cacheTtl
  );
}

/**
 * The credits to show when the cache the last turn left on the same model has expired, priced and
 * gated like getModelSwitchCostNotice; null while it is warm, after a switch (that note covers it),
 * and for a new conversation.
 */
export function getCacheExpiryCostNotice({
  expired,
  selectedModel,
  answeredModelId,
  previousInputTokens,
  previousInputModelId,
  providerInputTokens,
  cacheTtl,
}: CacheCostNoticeInput & { expired: boolean }): number | null {
  if (!expired || !selectedModel || !answeredModelId || !previousInputTokens) return null;
  if (selectedModel.id !== answeredModelId) return null;
  return noticeCredits(
    selectedModel,
    previousInputTokens,
    previousInputModelId,
    answeredModelId,
    providerInputTokens,
    cacheTtl
  );
}

function noticeCredits(
  model: ModelInfo,
  previousInputTokens: number,
  previousInputModelId: string | undefined,
  answeredModelId: string,
  providerInputTokens: number | undefined,
  cacheTtl: PromptCacheTtl | undefined
): number | null {
  const credits = providerInputTokens
    ? modelSwitchCacheCredits(model, providerInputTokens, answeredModelId, cacheTtl)
    : modelSwitchCacheCredits(model, previousInputTokens, previousInputModelId, cacheTtl);
  if (credits === null || credits < MODEL_SWITCH_NOTICE_MIN_CREDITS) return null;
  return roundNoticeCredits(credits);
}
