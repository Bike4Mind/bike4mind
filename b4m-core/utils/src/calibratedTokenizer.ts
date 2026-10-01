import type { ITokenizer } from './tokenCounting';

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

  // Integer math: 100 * 1.09 is 109.00000000000001 in floating point, which would ceil to 110.
  const hundredths = Math.round(multiplier * 100);
  return {
    countTokens: async (text, modelId) => Math.ceil(((await tokenizer.countTokens(text, modelId)) * hundredths) / 100),
    encodeTokens: (text, modelId) => tokenizer.encodeTokens(text, modelId),
    decodeTokens: (tokens, modelId) => tokenizer.decodeTokens(tokens, modelId),
  };
}
