import { describe, it, expect } from 'vitest';
import { generatePassphrase, PASSPHRASE_WORDS } from './generatePassphrase';

describe('generatePassphrase', () => {
  it('produces the readable word-number-word shape', () => {
    expect(generatePassphrase()).toMatch(/^[a-z]+-[a-z]+-\d{2}-[a-z]+-[a-z]+$/);
  });

  it('always clears the 8-character minimum the gate enforces', () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePassphrase().length).toBeGreaterThanOrEqual(8);
    }
  });

  it('never emits a leading-zero number group, which is lost when retyped', () => {
    for (let i = 0; i < 500; i++) {
      const group = generatePassphrase().split('-')[2];
      expect(group).toMatch(/^[1-9]\d$/);
    }
  });

  it('does not repeat across draws', () => {
    // Not a randomness test - a guard against a generator wired to a constant seed or a
    // memoized value, which would silently hand every artifact the same passphrase.
    const seen = new Set(Array.from({ length: 200 }, () => generatePassphrase()));
    expect(seen.size).toBeGreaterThan(190);
  });

  it('keeps the wordlist at the size and uniqueness the entropy claim assumes', () => {
    // 4 words from 128 (4 x 7 bits) + ~6.6 bits of number is the ~34 bits documented against
    // the gate's online-attack bound. Shrinking the list - or letting a duplicate in, which
    // costs entropy just as silently - weakens every passphrase generated from it.
    expect(PASSPHRASE_WORDS).toHaveLength(128);
    expect(new Set(PASSPHRASE_WORDS).size).toBe(PASSPHRASE_WORDS.length);
  });

  it('draws only from the published wordlist', () => {
    const allowed = new Set(PASSPHRASE_WORDS);
    for (let i = 0; i < 200; i++) {
      for (const part of generatePassphrase().split('-')) {
        if (/^\d+$/.test(part)) continue;
        expect(allowed.has(part)).toBe(true);
      }
    }
  });
});
