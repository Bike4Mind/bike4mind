import { describe, it, expect, afterAll, vi } from 'vitest';
import { TiktokenTokenizer } from './tokenCounting';

/**
 * Real WASM encoder, deliberately: tokenCounting.test.ts mocks tiktoken wholesale, so it can prove
 * decodeTokens calls decode() but not that encode -> slice -> decode reconstructs text. Callers
 * truncate by slicing an encodeTokens result, and the bug this guards against was sending the ids
 * themselves to an image model, which then drew the numbers.
 */

const logger = {
  log: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  updateMetadata: vi.fn(),
};

const tokenizer = new TiktokenTokenizer({ logger: logger as never });

afterAll(() => {
  tokenizer.clearCache();
});

describe('TiktokenTokenizer encode/decode round trip', () => {
  it('reconstructs the original text exactly', async () => {
    const text = 'a red apple on a wooden table';

    const decoded = await tokenizer.decodeTokens(await tokenizer.encodeTokens(text));

    expect(decoded).toBe(text);
  });

  it('decodes a truncating slice to a text prefix, not to token ids', async () => {
    const text = 'a red apple on a wooden table, lit by a single window';
    const tokens = await tokenizer.encodeTokens(text);

    const decoded = await tokenizer.decodeTokens(tokens.slice(0, 4));

    expect(text.startsWith(decoded)).toBe(true);
    expect(decoded).not.toMatch(/(^|\s)\d+(\s|$)/);
  });
});
