import {
  DEFAULT_PROMPT_CACHE_TTL,
  ModelBackend,
  oneHourCacheWriteRate,
  PROMPT_CACHE_TTL_MS,
  resolveAppliedRates,
  usdToCredits,
  type PromptCacheTtl,
} from '@bike4mind/common';
import type { ChatModelOption, ChatPromptCacheStamp } from '@shared/chat';

const BACKENDS: ReadonlySet<string> = new Set(Object.values(ModelBackend));
const isModelBackend = (backend: string): backend is ModelBackend => BACKENDS.has(backend);

/** Below this the expired-cache note stays hidden; matches the web composer's threshold. */
export const CACHE_NOTICE_MIN_CREDITS = 500;

/**
 * Credits the first turn on `model` spends just to read this conversation again: no cache is shared
 * across models, so the whole context is input again, and a cache write on direct Anthropic (the
 * only backend Desktop marks for caching, see main/chat/completions.ts) at the rate for `ttl`
 * (1.25x input for 5 minutes, 2x for an hour). Null when it is unpriced.
 */
export function modelSwitchCredits(
  model: ChatModelOption,
  contextTokens: number,
  ttl: PromptCacheTtl = DEFAULT_PROMPT_CACHE_TTL
): number | null {
  if (contextTokens <= 0 || !model.pricing || !model.backend || !isModelBackend(model.backend)) return null;
  const rates = resolveAppliedRates({ pricing: model.pricing, backend: model.backend }, contextTokens);
  if (!rates) return null;
  const writeRate = ttl === '1h' ? oneHourCacheWriteRate(rates) : rates.cacheWrite;
  const perToken = model.backend === ModelBackend.Anthropic ? writeRate : rates.input;
  return perToken > 0 ? usdToCredits(perToken * contextTokens) : null;
}

/** "about N": tens under 1,000, hundreds above. */
export function roundNoticeCredits(credits: number): number {
  const step = credits < 1000 ? 10 : 100;
  return Math.round(credits / step) * step;
}

export function promptCacheExpiresAt(stamp: ChatPromptCacheStamp | undefined): number | null {
  return stamp ? stamp.cachedAt + PROMPT_CACHE_TTL_MS[stamp.ttl] : null;
}

/**
 * The rounded credits the expired-cache note shows, or null to hide it: while the cache is warm,
 * when the conversation has moved to another model since (the model picker prices that), and when
 * the re-write is under CACHE_NOTICE_MIN_CREDITS. `ttl` is what the next message will write at.
 */
export function cacheExpiryNoticeCredits({
  expired,
  stamp,
  model,
  contextTokens,
  ttl,
}: {
  expired: boolean;
  stamp: ChatPromptCacheStamp | undefined;
  model: ChatModelOption | undefined;
  contextTokens: number;
  ttl: PromptCacheTtl;
}): number | null {
  if (!expired || !stamp || !model || model.id !== stamp.model) return null;
  const credits = modelSwitchCredits(model, contextTokens, ttl);
  if (credits === null || credits < CACHE_NOTICE_MIN_CREDITS) return null;
  return roundNoticeCredits(credits);
}
