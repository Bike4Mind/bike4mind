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

  it.each(['', '   ', '<b>x</b>', 'bob@example.com', 'a+b', 'tab\tname', 'line\nbreak', 'emoji \u{1F600}'])(
    'rejects %j with the rules message',
    value => {
      const result = usernameSchema.safeParse(value);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe(USERNAME_RULES_MESSAGE);
    }
  );

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
