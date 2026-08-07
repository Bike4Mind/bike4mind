import { describe, it, expect, afterAll, vi } from 'vitest';
import { TiktokenTokenizer } from './tokenCounting';

/**
 * Real WASM encoder, deliberately: tokenCounting.test.ts mocks tiktoken wholesale, so it can prove
 * which method we call but not what that method does with a special-token literal. This file owns
 * that half, because the literals are what untrusted content actually carries.
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

/** Special (and therefore rejected by `encode`) under cl100k_base. `<|im_start|>` is not, so it proves nothing. */
const SPECIAL_TOKEN_LITERALS = ['<|endoftext|>', '<|endofprompt|>', '<|fim_prefix|>'];

describe('TiktokenTokenizer with special-token literals', () => {
  it.each(SPECIAL_TOKEN_LITERALS)('counts %s instead of rejecting it', async literal => {
    await expect(tokenizer.countTokens(`what does ${literal} mean`)).resolves.toBeGreaterThan(0);
  });

  it.each(SPECIAL_TOKEN_LITERALS)('charges %s for its characters, not as one special token', async literal => {
    // Admitting the literal as a real special token (allowed_special: 'all') would make this exactly
    // 1, which under-counts every turn carrying one - the wrong direction for a billing input.
    await expect(tokenizer.countTokens(literal)).resolves.toBeGreaterThan(1);
  });

  it('counts the literal as the characters it is', async () => {
    // 8 under cl100k_base: what the same string costs with the literal spelled out as text. The
    // special-token reading of it is 4, so this pins the direction, not just the absence of a throw.
    await expect(tokenizer.countTokens('hello <|endoftext|> world')).resolves.toBe(8);
  });

  it.each(SPECIAL_TOKEN_LITERALS)('encodes %s to ids instead of rejecting it', async literal => {
    const ids = await tokenizer.encodeTokens(`what does ${literal} mean`);

    expect(ids.length).toBeGreaterThan(0);
    // The two methods must agree - callers size budgets with one and spend against the other.
    expect(ids.length).toBe(await tokenizer.countTokens(`what does ${literal} mean`));
  });

  it('survives a literal on the model-specific encoder too', async () => {
    // A different encoding (o200k_base here) carries a different special-token set, so the
    // model-specific branch needs its own proof.
    await expect(tokenizer.countTokens('hello <|endoftext|> world', 'gpt-4o')).resolves.toBeGreaterThan(1);
    await expect(tokenizer.encodeTokens('hello <|endoftext|> world', 'gpt-4o')).resolves.not.toHaveLength(0);
  });
});
