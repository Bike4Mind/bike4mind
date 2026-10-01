import type { ITokenizer } from './tokenCounting';

/**
 * Wrap `tokenizer` so countTokens reports `multiplier` times the raw count, rounded up. Use it with
 * tokenEstimateMultiplier (@bike4mind/common) to bring a cl100k_base count up to a Claude model's
 * own tokenizer.
 *
 * encodeTokens/decodeTokens pass through unchanged: token ids belong to the real encoder, and a slice
 * of them has to decode back to text. So after wrapping, encodeTokens(text).length no longer equals
 * countTokens(text). A caller that budgets from an encode length (buildAndSortMessages's user prompt)
 * is still counting in raw cl100k units.
 */
export function withTokenEstimateMultiplier(tokenizer: ITokenizer, multiplier: number): ITokenizer {
  if (multiplier === 1) {
    return tokenizer;
  }

  return {
    countTokens: async (text, modelId) => Math.ceil((await tokenizer.countTokens(text, modelId)) * multiplier),
    encodeTokens: (text, modelId) => tokenizer.encodeTokens(text, modelId),
    decodeTokens: (tokens, modelId) => tokenizer.decodeTokens(tokens, modelId),
  };
}
