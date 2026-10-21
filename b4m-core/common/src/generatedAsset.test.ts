import { describe, expect, it } from 'vitest';
import { GENERATED_ASSET_MAX_STORED_TEXT_CHARS as CAP, isStoredPromptPossiblyTruncated } from './generatedAsset';

describe('isStoredPromptPossiblyTruncated', () => {
  const capLength = 'x'.repeat(CAP);

  it.each([
    ['a set flag', { prompt: 'short', promptTruncated: true }, true],
    ['a cleared flag, even at cap length', { prompt: capLength, promptTruncated: false }, false],
    ['no flag at cap length (saved before the flag existed)', { prompt: capLength }, true],
    ['no flag on a short prompt', { prompt: 'short' }, false],
  ])('answers %s', (_label, generation, expected) => {
    expect(isStoredPromptPossiblyTruncated(generation)).toBe(expected);
  });
});
