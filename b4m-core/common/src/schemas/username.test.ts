import { describe, it, expect } from 'vitest';
import { sanitizeUsername, usernameSchema, USERNAME_MAX_LENGTH, USERNAME_RULES_MESSAGE } from './username';

describe('usernameSchema', () => {
  it.each(['bob', 'Jane Doe', "o'brien", 'first.last_name-2', 'Jos\u00e9', '\u5c71\u7530\u592a\u90ce', 'a'])(
    'accepts %s',
    value => {
      expect(usernameSchema.parse(value)).toBe(value);
    }
  );

  it('trims surrounding whitespace', () => {
    expect(usernameSchema.parse('  bob  ')).toBe('bob');
  });

  it.each(['', '   ', '<b>x</b>', 'bob@example.com', 'a+b', 'emoji \u{1F600}', '\u0301', '-', '...', "' _ ."])(
    'rejects %j with the rules message',
    value => {
      const result = usernameSchema.safeParse(value);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(USERNAME_RULES_MESSAGE);
    }
  );

  it('turns NBSP and other whitespace into single plain spaces', () => {
    expect(usernameSchema.parse('\u00a0Jane\u00a0\u00a0Doe\t')).toBe('Jane Doe');
    expect(usernameSchema.parse('line\nbreak')).toBe('line break');
  });

  it('normalizes composed and decomposed spellings to the same value', () => {
    const composed = usernameSchema.parse('Jos\u00e9');
    const decomposed = usernameSchema.parse('Jose\u0301');
    expect(decomposed).toBe(composed);
    expect(composed).toBe('Jos\u00e9');
  });

  it('enforces the length cap', () => {
    expect(usernameSchema.safeParse('a'.repeat(USERNAME_MAX_LENGTH)).success).toBe(true);
    expect(usernameSchema.safeParse('a'.repeat(USERNAME_MAX_LENGTH + 1)).success).toBe(false);
  });
});

describe('sanitizeUsername', () => {
  it('drops disallowed characters and collapses whitespace', () => {
    expect(sanitizeUsername('  <b>Jane</b>\t\tDoe!! ')).toBe('bJaneb Doe');
    expect(sanitizeUsername('john.doe+tag')).toBe('john.doetag');
  });

  it('returns an empty string when nothing usable remains', () => {
    expect(sanitizeUsername('@@@ !!!')).toBe('');
  });

  it('truncates to the requested length without splitting a surrogate pair', () => {
    const astral = '\u{20000}';
    const result = sanitizeUsername(`a${astral}${astral}`, 4);
    expect(result).toBe(`a${astral}`);
    expect(usernameSchema.safeParse(result).success).toBe(true);
  });

  it('trims a space left at the cut point', () => {
    expect(sanitizeUsername('abc def', 4)).toBe('abc');
  });

  it('always yields a value the schema accepts when non-empty', () => {
    for (const raw of ['A  B', "x'--y", '\u00c9milie \u00d6zt\u00fcrk', 'name\u0000with\u0007controls']) {
      const result = sanitizeUsername(raw);
      expect(usernameSchema.safeParse(result).success).toBe(true);
    }
  });
});

describe('sanitizeUsername letter-or-digit rule', () => {
  it('returns an empty string when only punctuation or a combining mark remains', () => {
    expect(sanitizeUsername('---')).toBe('');
    expect(sanitizeUsername('\u0301')).toBe('');
    expect(sanitizeUsername('<<>>')).toBe('');
  });

  it('applies NFC and converts NBSP', () => {
    expect(sanitizeUsername('Jose\u0301\u00a0Perez')).toBe('Jos\u00e9 Perez');
  });

  it('produces values the schema accepts', () => {
    const value = sanitizeUsername('  a<b>c   d ');
    expect(usernameSchema.safeParse(value).success).toBe(true);
  });
});
