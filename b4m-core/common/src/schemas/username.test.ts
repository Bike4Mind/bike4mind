import { describe, it, expect } from 'vitest';
import {
  isReservedUsername,
  RESERVED_USERNAME_PREFIX,
  sanitizeUsername,
  stripReservedUsernamePrefix,
  usernameSchema,
  USERNAME_MAX_LENGTH,
  USERNAME_RULES_MESSAGE,
} from './username';

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

describe('isReservedUsername', () => {
  it.each([
    ['the plain prefix', 'persona-alice'],
    ['upper case', 'PERSONA-ALICE'],
    ['mixed case', 'Persona-Bob'],
    ['surrounding whitespace', '  persona-alice '],
    ['NBSP before it', '\u00a0persona-alice'],
    ['the bare prefix', 'persona-'],
    ['fullwidth letters (NFKC)', '\uff50\uff45\uff52\uff53\uff4f\uff4e\uff41-x'],
    ['mathematical bold letters (NFKC)', '\u{1d429}\u{1d41e}\u{1d42b}\u{1d42c}\u{1d428}\u{1d427}\u{1d41a}-x'],
    ['long s (NFKC)', 'per\u017fona-x'],
    ['an accent on a letter', 'p\u00e9rsona-x'],
    ['a decomposed accent', 'pe\u0301rsona-x'],
    ['a combining grapheme joiner', 'per\u034fsona-x'],
    ['a leading Hangul filler', '\u3164persona-x'],
    ['a halfwidth Hangul filler', '\uffa0persona-x'],
    ['Cyrillic er, ie and o', '\u0440\u0435rs\u043ena-x'],
    ['Cyrillic capitals mixed with Latin', '\u0420\u0415RS\u041eNA-x'],
    ['Greek rho, omicron and alpha', '\u03c1ers\u03bfn\u03b1-x'],
    ['Cyrillic dze for s', 'per\u0455ona-x'],
    ['Armenian vo for n', 'perso\u0578a-x'],
    ['Latin small capitals', '\u1d18\u1d07\u0280\ua731\u1d0f\u0274\u1d00-x'],
    ['Greek capital epsilon and nu among Latin capitals', 'P\u0395RSO\u039dA-x'],
    ['Cherokee capitals among Latin capitals', '\u13e2\u13ac\u13d2\u13daON\u13aa-x'],
    ['Lisu letters for the whole word', '\ua4d1\ua4f0\ua4e3\ua4e2\ua4f3\ua4e0\ua4ee-x'],
    ['Coptic ro and o', '\u2ca3ers\u2c9fna-x'],
    ['Greek sigma for o', 'pers\u03c3na-x'],
    ['a non-breaking hyphen', 'persona\u2011x'],
    ['an en dash', 'persona\u2013x'],
    ['a fullwidth hyphen-minus (NFKC)', 'persona\uff0dx'],
  ])('reserves %s', (_label, value) => {
    expect(isReservedUsername(value)).toBe(true);
  });

  it.each([
    'alice',
    'persona',
    'personal-site',
    'personas-fan',
    'persona_alice',
    'persona.alice',
    'persona alice',
    'my-persona-alice',
    '_persona-alice',
    'per sona-alice',
    '\u041f\u0435\u0440\u0441\u043e\u043d\u0430-x',
  ])('leaves %j alone', value => {
    expect(isReservedUsername(value)).toBe(false);
  });

  it('agrees with the exported prefix', () => {
    expect(isReservedUsername(`${RESERVED_USERNAME_PREFIX}x`)).toBe(true);
  });
});

describe('stripReservedUsernamePrefix', () => {
  it.each([
    ['persona-alice', 'alice'],
    ['Persona-Bob', 'Bob'],
    ['persona-persona-carol', 'carol'],
    ['persona--_dave', 'dave'],
    ['\u0440\u0435rs\u043ena-erin', 'erin'],
    ['pe\u0301rsona-frank', 'frank'],
    ['persona-', ''],
    ['alice', 'alice'],
    ['personal-site', 'personal-site'],
  ])('%j -> %j', (raw, expected) => {
    expect(stripReservedUsernamePrefix(raw)).toBe(expected);
  });
});

describe('sanitizeUsername never yields a reserved username', () => {
  it.each([
    ['persona-alice', 'alice'],
    ['  PERSONA-Bob  ', 'Bob'],
    ['persona-persona-carol', 'carol'],
    ['<persona>-dave', 'dave'],
    ['\u3164persona-erin', 'erin'],
    ['\uff50ersona-frank', 'frank'],
  ])('strips the prefix from %j', (raw, expected) => {
    expect(sanitizeUsername(raw)).toBe(expected);
  });

  it('returns an empty string when only the prefix remains, leaving the fallback to the caller', () => {
    expect(sanitizeUsername('persona-')).toBe('');
    expect(sanitizeUsername('PERSONA-')).toBe('');
    expect(sanitizeUsername('persona-...')).toBe('');
  });

  it('does not leave an invisible username behind the stripped prefix', () => {
    expect(sanitizeUsername('persona-ㅤ')).toBe('');
    expect(sanitizeUsername('persona-ㅤﾠ')).toBe('');
    expect(sanitizeUsername('persona-ㅤerin')).toBe('erin');
  });

  it('strips a prefix that only appears after truncation', () => {
    expect(sanitizeUsername('persona-abcdef', 10)).toBe('ab');
  });

  it('keeps unreserved names that merely contain the word', () => {
    expect(sanitizeUsername('personal-site')).toBe('personal-site');
    expect(sanitizeUsername('my persona-x')).toBe('my persona-x');
  });

  it('yields schema-valid, unreserved values for prefix variants', () => {
    for (const raw of ['persona-\u0301x', 'persona-\u00e9mile', 'PERSONA-\u5c71\u7530', 'persona-1']) {
      const result = sanitizeUsername(raw);
      expect(isReservedUsername(result)).toBe(false);
      expect(usernameSchema.safeParse(result).success).toBe(true);
    }
  });
});
