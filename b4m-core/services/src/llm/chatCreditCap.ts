import { getTextModelCost, type ModelInfo, type PromptCacheTtl } from '@bike4mind/common';

/**
 * A round's input priced at the dearest rate the provider can bill it at: uncached, or written to
 * the prompt cache (a 5-minute write costs more than plain input, a 1-hour write more still). The
 * hold prices input at the plain rate, which is fine for an estimate but not for a cap.
 * ChatCompletionProcess caps a turn's output with it (see creditOutputCap there).
 */
export function conservativeRoundInputUsd(modelInfo: ModelInfo, inputTokens: number, cacheTtl: PromptCacheTtl): number {
  if (!(inputTokens > 0)) return 0;
  const uncached = getTextModelCost(modelInfo, inputTokens, 0);
  const cacheWrite = getTextModelCost(modelInfo, 0, 0, 0, inputTokens, inputTokens, cacheTtl === '1h' ? inputTokens : 0);
  return Math.max(uncached, cacheWrite);
}
