import { describe, it, expect, vi } from 'vitest';
import type { ITokenizer } from './tokenCounting';
import { scaleTokenEstimate, withTokenEstimateMultiplier } from './calibratedTokenizer';

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

describe('scaleTokenEstimate', () => {
  it('rounds the scaled count up', () => {
    expect(scaleTokenEstimate(1001, 1.5)).toBe(1502);
    expect(scaleTokenEstimate(1, 1.5)).toBe(2);
  });

  it('does not round 100 * 1.09 up to 110', () => {
    expect(scaleTokenEstimate(100, 1.09)).toBe(109);
  });

  it('is the identity for a multiplier of 1', () => {
    expect(scaleTokenEstimate(0, 1)).toBe(0);
    expect(scaleTokenEstimate(12_345, 1)).toBe(12_345);
  });

  it('keeps zero at zero', () => {
    expect(scaleTokenEstimate(0, 1.5)).toBe(0);
  });
});
