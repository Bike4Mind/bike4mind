import type { ITokenizer } from './tokenCounting';

/**
 * Scale a raw cl100k_base count by `multiplier`, rounded up to the nearest whole token. Paired with
 * tokenEstimateMultiplier (@bike4mind/common) to bring a raw count up to a Claude model's tokenizer.
 * The sync counterpart of withTokenEstimateMultiplier, for callers whose counter is synchronous.
 */
export function scaleTokenEstimate(count: number, multiplier: number): number {
  if (multiplier === 1) {
    return count;
  }

  // Integer math: 100 * 1.09 is 109.00000000000001 in floating point, which would ceil to 110.
  const hundredths = Math.round(multiplier * 100);
  return Math.ceil((count * hundredths) / 100);
}

/**
 * Wrap `tokenizer` so countTokens reports `multiplier` (resolved to hundredths) times the raw count,
 * rounded up. Use it with tokenEstimateMultiplier (@bike4mind/common) to bring a cl100k_base count up
 * to a Claude model's own tokenizer.
 *
 * encodeTokens/decodeTokens pass through unchanged: token ids belong to the real encoder, and a slice
 * of them has to decode back to text. So after wrapping, encodeTokens(text).length no longer equals
 * countTokens(text); budget with countTokens.
 */
export function withTokenEstimateMultiplier(tokenizer: ITokenizer, multiplier: number): ITokenizer {
  if (multiplier === 1) {
    return tokenizer;
  }

  return {
    countTokens: async (text, modelId) => scaleTokenEstimate(await tokenizer.countTokens(text, modelId), multiplier),
    encodeTokens: (text, modelId) => tokenizer.encodeTokens(text, modelId),
    decodeTokens: (tokens, modelId) => tokenizer.decodeTokens(tokens, modelId),
  };
}
