import { describe, expect, it } from 'vitest';
import { countCodePoints } from './countCodePoints';

describe('countCodePoints', () => {
  it('counts ASCII text as its length', () => {
    expect(countCodePoints('hello world')).toBe(11);
  });

  it('returns 0 for the empty string', () => {
    expect(countCodePoints('')).toBe(0);
  });

  it('counts an astral character as ONE code point, not two UTF-16 units', () => {
    const emoji = '\u{1F600}';
    expect(emoji.length).toBe(2); // the trap this helper exists to avoid
    expect(countCodePoints(emoji)).toBe(1);
    expect(countCodePoints(`a${emoji}b`)).toBe(3);
  });

  it('counts BMP non-ASCII characters as one each', () => {
    // 'privet' in cyrillic, written as escapes per the repo's ASCII-only source rule
    expect(countCodePoints('\u043f\u0440\u0438\u0432\u0435\u0442')).toBe(6);
  });
});
