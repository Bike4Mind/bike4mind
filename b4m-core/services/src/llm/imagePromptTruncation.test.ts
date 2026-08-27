import { describe, it, expect, vi } from 'vitest';
import {
  IMAGE_PROMPT_TOKEN_THRESHOLD,
  IMAGE_PROMPT_TRUNCATE_TO,
  resolveImagePromptTokenCap,
  truncateImagePrompt,
} from './imagePromptTruncation';

// One id per word keeps the arithmetic legible; the real caller passes a tiktoken encoding.
const wordTokenizer = {
  decodeTokens: vi.fn(async (tokens: number[]) => tokens.map(id => `w${id}`).join(' ')),
};

const tokens = (count: number) => Array.from({ length: count }, (_, i) => i + 1);

describe('resolveImagePromptTokenCap', () => {
  it('uses the catalog cap when it is positive', () => {
    expect(resolveImagePromptTokenCap(10_000)).toBe(10_000);
  });

  it.each([
    ['undefined (model missing from the catalog)', undefined],
    ['0 (a catalog row whose maxOutputTokens is a literal 0)', 0],
    ['negative', -1],
  ])('falls back to the threshold when the cap is %s', (_label, cap) => {
    expect(resolveImagePromptTokenCap(cap)).toBe(IMAGE_PROMPT_TOKEN_THRESHOLD);
  });
});

describe('truncateImagePrompt', () => {
  it('passes a prompt under the cap through verbatim', async () => {
    const result = await truncateImagePrompt({
      prompt: 'a red apple',
      promptTokens: tokens(3),
      maxTokens: 10_000,
      tokenizer: wordTokenizer,
    });

    expect(result).toEqual({ prompt: 'a red apple', tokenCount: 3, truncated: false });
  });

  // The regression this module exists for: max_tokens: 0 used to read as a real cap, so every
  // prompt longer than zero tokens was "truncated" - and truncation emitted token ids.
  it('does not truncate a short prompt when the catalog reports max_tokens: 0', async () => {
    const result = await truncateImagePrompt({
      prompt: 'a red apple',
      promptTokens: tokens(3),
      maxTokens: 0,
      tokenizer: wordTokenizer,
    });

    expect(result.truncated).toBe(false);
    expect(result.prompt).toBe('a red apple');
  });

  it('truncates an over-cap prompt to decoded text, never to token ids', async () => {
    const promptTokens = tokens(IMAGE_PROMPT_TOKEN_THRESHOLD + 1);
    const result = await truncateImagePrompt({
      prompt: 'x'.repeat(5_000),
      promptTokens,
      maxTokens: undefined,
      tokenizer: wordTokenizer,
      modelId: 'gpt-image-2',
    });

    expect(result.truncated).toBe(true);
    expect(result.tokenCount).toBe(IMAGE_PROMPT_TRUNCATE_TO);
    expect(wordTokenizer.decodeTokens).toHaveBeenCalledWith(
      promptTokens.slice(0, IMAGE_PROMPT_TRUNCATE_TO),
      'gpt-image-2'
    );
    // A bare digit run is the signature of the old `.join(' ')` on number[].
    expect(result.prompt).not.toMatch(/(^|\s)\d+(\s|$)/);
  });

  it('keeps the kept slice under a cap smaller than the flat truncate-to figure', async () => {
    const result = await truncateImagePrompt({
      prompt: 'long prompt',
      promptTokens: tokens(200),
      maxTokens: 100,
      tokenizer: wordTokenizer,
    });

    expect(result.tokenCount).toBe(100);
  });

  it('trims the replacement character left by a slice that ends mid-character', async () => {
    const result = await truncateImagePrompt({
      prompt: 'long prompt',
      promptTokens: tokens(2_000),
      maxTokens: undefined,
      tokenizer: { decodeTokens: async () => 'a partial emoji \uFFFD' },
    });

    expect(result.prompt).toBe('a partial emoji ');
  });

  it('degrades to a proportional character slice of the original text when decoding throws', async () => {
    const logger = { warn: vi.fn() };
    const result = await truncateImagePrompt({
      prompt: 'a'.repeat(4_000),
      promptTokens: tokens(2_000),
      maxTokens: undefined,
      tokenizer: {
        decodeTokens: async () => {
          throw new Error('encoder freed');
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: logger as any,
    });

    // 980/2000 of a 4000-character prompt.
    expect(result.prompt).toBe('a'.repeat(1_960));
    expect(result.tokenCount).toBe(IMAGE_PROMPT_TRUNCATE_TO);
    expect(logger.warn).toHaveBeenCalled();
  });
});
