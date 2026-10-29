import { ModelBackend, resolveAppliedRates, usdToCredits } from '@bike4mind/common';
import type { ChatModelOption } from '@shared/chat';

const BACKENDS: ReadonlySet<string> = new Set(Object.values(ModelBackend));
const isModelBackend = (backend: string): backend is ModelBackend => BACKENDS.has(backend);

/**
 * Credits the first turn on `model` spends just to read this conversation again: no cache is shared
 * across models, so the whole context is input again, and a cache write on direct Anthropic (the
 * only backend Desktop marks for caching, see main/chat/completions.ts). Null when it is unpriced.
 */
export function modelSwitchCredits(model: ChatModelOption, contextTokens: number): number | null {
  if (contextTokens <= 0 || !model.pricing || !model.backend || !isModelBackend(model.backend)) return null;
  const rates = resolveAppliedRates({ pricing: model.pricing, backend: model.backend }, contextTokens);
  if (!rates) return null;
  const perToken = model.backend === ModelBackend.Anthropic ? rates.cacheWrite : rates.input;
  return perToken > 0 ? usdToCredits(perToken * contextTokens) : null;
}
