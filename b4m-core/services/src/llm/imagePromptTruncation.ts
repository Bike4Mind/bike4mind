import type { ILogger } from '@bike4mind/observability';
import type { ITokenizer } from '@bike4mind/utils';

// TODO make these adminSettings

/**
 * Prompt budget used when the catalog reports no usable cap for the model. Not a provider limit -
 * a self-imposed guard so a runaway prompt is never forwarded whole.
 */
export const IMAGE_PROMPT_TOKEN_THRESHOLD = 1000;

/** Tokens kept when the guard fires. The headroom absorbs provider-side tokenizer differences. */
export const IMAGE_PROMPT_TRUNCATE_TO = 980;

/**
 * A catalog row can report `max_tokens: 0`: mergeCatalog re-derives it via `toModelInfo` as
 * `record.maxOutputTokens ?? Math.min(...)`, and `??` passes a literal 0 straight through. Reading
 * that 0 as a real cap truncates every prompt longer than zero tokens, so treat any non-positive
 * cap as "unknown" and fall back to the threshold.
 */
export function resolveImagePromptTokenCap(maxTokens: number | undefined): number {
  return typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : IMAGE_PROMPT_TOKEN_THRESHOLD;
}

export type TruncatedImagePrompt = {
  /** The text to send to the provider. Always prose, never stringified token ids. */
  prompt: string;
  /** Tokens actually sent. The usage-event input count is derived from this. */
  tokenCount: number;
  truncated: boolean;
};

/**
 * Bound an image prompt to the model's token cap, returning text.
 *
 * Shared by ImageGeneration and ImageEdit - keep them on this one implementation. The predecessor
 * was duplicated in both and did `promptTokens.slice(...).join(' ')`, which sent the provider a
 * space-separated list of token ids ("64 2579 24149"); the models then faithfully illustrated the
 * numbers.
 */
export async function truncateImagePrompt({
  prompt,
  promptTokens,
  maxTokens,
  tokenizer,
  modelId,
  logger,
}: {
  prompt: string;
  promptTokens: number[];
  /** The model catalog's `max_tokens`, unvalidated. */
  maxTokens: number | undefined;
  tokenizer: Pick<ITokenizer, 'decodeTokens'>;
  modelId?: string;
  logger?: ILogger;
}): Promise<TruncatedImagePrompt> {
  const cap = resolveImagePromptTokenCap(maxTokens);
  if (promptTokens.length <= cap) {
    return { prompt, tokenCount: promptTokens.length, truncated: false };
  }

  // Stay under the cap that triggered us, rather than the flat 980 the old code always used.
  const kept = promptTokens.slice(0, Math.min(IMAGE_PROMPT_TRUNCATE_TO, cap));

  try {
    const decoded = await tokenizer.decodeTokens(kept, modelId);
    // A slice can end mid-character, which decodes to a trailing U+FFFD.
    return { prompt: decoded.replace(/\uFFFD+$/, ''), tokenCount: kept.length, truncated: true };
  } catch (error) {
    // Degrade to a proportional slice of the original text, never to token ids. The character
    // budget is approximate, so the result can sit slightly over the cap - still preferable to
    // sending gibberish. Logged so a silent decode failure is distinguishable from no truncation.
    logger?.warn('Image prompt decode failed; falling back to a character slice', error);
    const charBudget = Math.max(1, Math.floor(prompt.length * (kept.length / promptTokens.length)));
    return { prompt: prompt.slice(0, charBudget), tokenCount: kept.length, truncated: true };
  }
}
