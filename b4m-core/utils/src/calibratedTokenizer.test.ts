import { describe, it, expect, vi } from 'vitest';
import type { ITokenizer } from './tokenCounting';
import { withTokenEstimateMultiplier } from './calibratedTokenizer';

const createTokenizer = (rawCount: number): ITokenizer => ({
  countTokens: vi.fn(async () => rawCount),
  encodeTokens: vi.fn(async () => [1, 2, 3]),
  decodeTokens: vi.fn(async () => 'decoded'),
});

describe('withTokenEstimateMultiplier', () => {
  it('scales the count and rounds up', async () => {
    const tokenizer = createTokenizer(1001);

    await expect(withTokenEstimateMultiplier(tokenizer, 1.5).countTokens('text', 'claude-sonnet-5')).resolves.toBe(
      1502
    );
    expect(tokenizer.countTokens).toHaveBeenCalledWith('text', 'claude-sonnet-5');
  });

  it('does not round an exact product up past itself', async () => {
    // 100 * 1.09 is 109.00000000000001 in floating point.
    await expect(withTokenEstimateMultiplier(createTokenizer(100), 1.09).countTokens('text')).resolves.toBe(109);
  });

  it('passes encode and decode through to the real encoder', async () => {
    const tokenizer = createTokenizer(10);
    const calibrated = withTokenEstimateMultiplier(tokenizer, 1.5);

    await expect(calibrated.encodeTokens('text', 'm')).resolves.toEqual([1, 2, 3]);
    await expect(calibrated.decodeTokens([1, 2], 'm')).resolves.toBe('decoded');
    expect(tokenizer.encodeTokens).toHaveBeenCalledWith('text', 'm');
    expect(tokenizer.decodeTokens).toHaveBeenCalledWith([1, 2], 'm');
  });

  it('returns the tokenizer itself when there is nothing to scale', () => {
    const tokenizer = createTokenizer(10);

    expect(withTokenEstimateMultiplier(tokenizer, 1)).toBe(tokenizer);
  });
});
