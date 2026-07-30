import { describe, it, expect } from 'vitest';
import {
  isPlaceholderValue,
  isPlaceholderApiKey,
  PLACEHOLDER_API_KEY_TOKENS,
  SST_PLACEHOLDER_VALUE,
  NOT_CONFIGURED_PLACEHOLDER,
} from '../types/entities/SystemSecretsTypes';

describe('isPlaceholderValue', () => {
  describe('returns true for placeholder values', () => {
    it('should return true for SST placeholder value', () => {
      expect(isPlaceholderValue(SST_PLACEHOLDER_VALUE)).toBe(true);
      expect(isPlaceholderValue('my-secret-placeholder-value')).toBe(true);
    });

    it('should return true for not-configured placeholder', () => {
      expect(isPlaceholderValue(NOT_CONFIGURED_PLACEHOLDER)).toBe(true);
      expect(isPlaceholderValue('not-configured')).toBe(true);
    });

    it('should return true for null', () => {
      expect(isPlaceholderValue(null)).toBe(true);
    });

    it('should return true for undefined', () => {
      expect(isPlaceholderValue(undefined)).toBe(true);
    });

    it('should return true for empty string', () => {
      expect(isPlaceholderValue('')).toBe(true);
    });
  });

  describe('case insensitivity', () => {
    it('should detect uppercase NOT-CONFIGURED', () => {
      expect(isPlaceholderValue('NOT-CONFIGURED')).toBe(true);
    });

    it('should detect mixed case Not-Configured', () => {
      expect(isPlaceholderValue('Not-Configured')).toBe(true);
    });

    it('should detect uppercase MY-SECRET-PLACEHOLDER-VALUE', () => {
      expect(isPlaceholderValue('MY-SECRET-PLACEHOLDER-VALUE')).toBe(true);
    });

    it('should detect mixed case My-Secret-Placeholder-Value', () => {
      expect(isPlaceholderValue('My-Secret-Placeholder-Value')).toBe(true);
    });
  });

  describe('whitespace handling', () => {
    it('should detect placeholder with leading whitespace', () => {
      expect(isPlaceholderValue('  not-configured')).toBe(true);
    });

    it('should detect placeholder with trailing whitespace', () => {
      expect(isPlaceholderValue('not-configured  ')).toBe(true);
    });

    it('should detect placeholder with surrounding whitespace', () => {
      expect(isPlaceholderValue('  not-configured  ')).toBe(true);
    });

    it('should detect SST placeholder with whitespace', () => {
      expect(isPlaceholderValue('  my-secret-placeholder-value  ')).toBe(true);
    });
  });

  describe('returns false for valid secrets', () => {
    it('should return false for a real API key', () => {
      expect(isPlaceholderValue('sk-1234567890abcdef')).toBe(false);
    });

    it('should return false for a UUID', () => {
      expect(isPlaceholderValue('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    });

    it('should return false for a real webhook URL', () => {
      // example.com host: a slack.com fixture in canonical format trips GitHub
      // push protection; the impl only compares against the two placeholder
      // constants, so the host is irrelevant to what this test verifies.
      expect(
        isPlaceholderValue('https://hooks.example.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX')
      ).toBe(false);
    });

    it('should return false for a real email', () => {
      expect(isPlaceholderValue('admin@example.com')).toBe(false);
    });

    it('should return false for whitespace-only string', () => {
      // Whitespace-only strings are NOT placeholder values - they're technically
      // non-empty strings that don't match the specific placeholder values.
      // Callers should validate for empty/whitespace separately if needed.
      expect(isPlaceholderValue('   ')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should not match partial placeholder strings', () => {
      expect(isPlaceholderValue('not-configured-extra')).toBe(false);
      expect(isPlaceholderValue('prefix-not-configured')).toBe(false);
      expect(isPlaceholderValue('my-secret-placeholder-value-extra')).toBe(false);
    });

    it('should handle strings that look similar but are different', () => {
      expect(isPlaceholderValue('notconfigured')).toBe(false);
      expect(isPlaceholderValue('not_configured')).toBe(false);
      expect(isPlaceholderValue('not configured')).toBe(false);
    });
  });
});

describe('isPlaceholderApiKey', () => {
  describe('returns true for placeholder / dummy keys', () => {
    it('inherits every isPlaceholderValue case (empty/null/undefined and SST sentinels)', () => {
      expect(isPlaceholderApiKey('')).toBe(true);
      expect(isPlaceholderApiKey(null)).toBe(true);
      expect(isPlaceholderApiKey(undefined)).toBe(true);
      expect(isPlaceholderApiKey(SST_PLACEHOLDER_VALUE)).toBe(true);
      expect(isPlaceholderApiKey(NOT_CONFIGURED_PLACEHOLDER)).toBe(true);
    });

    it('treats a whitespace-only value as a placeholder (unlike isPlaceholderValue)', () => {
      expect(isPlaceholderApiKey('   ')).toBe(true);
    });

    it('detects the reported dummy embedding key', () => {
      expect(isPlaceholderApiKey('sk-oai-dummy-routing-test')).toBe(true);
    });

    it('detects distinctive dummy tokens as whole hyphen-delimited segments', () => {
      expect(isPlaceholderApiKey('your-api-key-here')).toBe(true);
      expect(isPlaceholderApiKey('changeme')).toBe(true);
      expect(isPlaceholderApiKey('change-me')).toBe(true);
      expect(isPlaceholderApiKey('replace-me')).toBe(true);
      expect(isPlaceholderApiKey('not-a-real-key')).toBe(true);
      expect(isPlaceholderApiKey('sk-example-key')).toBe(true);
      expect(isPlaceholderApiKey('this-is-a-placeholder')).toBe(true);
    });

    it('normalizes underscores so REPLACE_ME / YOUR_API_KEY style values are caught', () => {
      expect(isPlaceholderApiKey('REPLACE_ME')).toBe(true);
      expect(isPlaceholderApiKey('YOUR_API_KEY')).toBe(true);
      expect(isPlaceholderApiKey('CHANGE_ME')).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(isPlaceholderApiKey('SK-OAI-DUMMY-ROUTING-TEST')).toBe(true);
      expect(isPlaceholderApiKey('Your-Api-Key')).toBe(true);
    });
  });

  describe('never rejects a real key (a false positive is worse than the bug)', () => {
    // Fixtures below are deliberately synthetic/low-entropy (no real-key marker) so push
    // protection doesn't flag them, which costs nothing here: the predicate matches delimited
    // segments and never inspects entropy, so a low-entropy body exercises it identically.
    // (Entropy is why the token list is safe against real keys - see isPlaceholderApiKey - which
    // is a separate argument from what these fixtures cover.)
    it('accepts real-looking OpenAI keys', () => {
      expect(isPlaceholderApiKey('sk-1234567890abcdefABCDEF')).toBe(false);
      expect(isPlaceholderApiKey('sk-proj-0000aaaa1111bbbb2222cccc3333dddd')).toBe(false);
      expect(isPlaceholderApiKey('sk-svcacct-0000aaaa1111bbbb2222cccc3333')).toBe(false);
    });

    it('accepts a real-looking Voyage key', () => {
      expect(isPlaceholderApiKey('pa-0000aaaa1111bbbb2222cccc')).toBe(false);
    });

    it('does not fire on a dummy word embedded inside a contiguous segment (only whole segments match)', () => {
      // "example"/"dummy" as substrings of a contiguous body must NOT match - only a whole
      // hyphen/underscore-delimited segment does.
      expect(isPlaceholderApiKey('sk-examplekey0000aaaa1111')).toBe(false);
      expect(isPlaceholderApiKey('sk-mydummykey0000aaaa1111')).toBe(false);
    });

    it('does not fire on a long contiguous body with no delimited dummy token', () => {
      const bodies = [
        'sk-0000aaaa1111bbbb2222cccc3333dddd4444eeee',
        'sk-proj-0000aaaa1111bbbb2222cccc3333dddd4444',
        'pa-0000aaaa1111bbbb2222cccc3333dddd',
      ];
      for (const b of bodies) expect(isPlaceholderApiKey(b)).toBe(false);
    });

    it('accepts a modern base64url key whose body genuinely carries `-` and `_`', () => {
      // Every fixture above is a contiguous body, so none of them can catch a regression here:
      // modern sk-proj-/sk-svcacct- keys are base64url and legitimately contain `-`/`_`, which the
      // `_` -> `-` normalization splits into segments the token regex scans. Nothing structural
      // keeps those segments from matching - only the tokens' length does.
      expect(isPlaceholderApiKey('sk-proj-0000aaaa_1111bbbb-2222cccc_3333dddd')).toBe(false);
      expect(isPlaceholderApiKey('sk-svcacct-0000aaaa-1111bbbb_2222cccc')).toBe(false);
    });
  });
});

describe('PLACEHOLDER_API_KEY_TOKENS', () => {
  // Tokens are regex fragments, so a raw `.length` measures the pattern (`change-?me` is 10) and
  // not what it can match (`changeme`, 8). Drop optional groups and optional single chars to get
  // the shortest string a token can match.
  //
  // CONTRACT: this understands literals, an optional single char (`x?`) and ONE non-nested
  // optional group (`(...)?`) - exactly the forms in use. It cannot reason about alternation,
  // quantifiers or character classes, and for those it reports a length that is too LARGE
  // (`dummy|key` measures 9 but matches `key`), which would smuggle a short token past the floor
  // below. The syntax guard test keeps such a token out rather than measuring it wrong.
  const shortestMatch = (token: string) => token.replace(/\([^)]*\)\?/g, '').replace(/.\?/g, '');

  // Constructs that let a token match something shorter than shortestMatch reports.
  const UNMEASURABLE_SYNTAX = /[|{}[\]*+\\]|\([^)]*\(/;

  const MIN_TOKEN_LENGTH = 5;

  it('every token is long enough that a random key body will not collide with it', () => {
    // The predicate is safe because of entropy, not structure (see isPlaceholderApiKey): a real
    // base64url body DOES split into `-`-delimited segments, so a short token collides orders of
    // magnitude more often - a 3-char token roughly 64^2 (~4000x) more often than a 5-char one.
    const tooShort = PLACEHOLDER_API_KEY_TOKENS.filter(t => shortestMatch(t).length < MIN_TOKEN_LENGTH);
    expect(
      tooShort,
      `tokens shorter than ${MIN_TOKEN_LENGTH} chars at their shortest match: ${tooShort.join(', ')}`
    ).toEqual([]);
  });

  it('every token sticks to the syntax the length check can actually measure', () => {
    // Guards the floor above from being measured with the wrong ruler: a token using alternation,
    // a quantifier or a character class would report a too-large length and pass while still
    // matching a short segment. Such a token must be rejected here, or shortestMatch extended.
    const unmeasurable = PLACEHOLDER_API_KEY_TOKENS.filter(t => UNMEASURABLE_SYNTAX.test(t));
    expect(unmeasurable, `tokens using syntax shortestMatch cannot measure: ${unmeasurable.join(', ')}`).toEqual([]);
  });

  it('reports a string each token can genuinely match', () => {
    // shortestMatch is string surgery, not a regex engine, so prove its output is a real match of
    // the token rather than a plausible-looking string.
    for (const token of PLACEHOLDER_API_KEY_TOKENS) {
      const candidate = shortestMatch(token);
      expect(new RegExp(`^(?:${token})$`).test(candidate), `${token} -> ${candidate}`).toBe(true);
    }
  });

  it('measures the shortest match, so the invariant above is not vacuous', () => {
    // Without this, the assertion above would still pass if shortestMatch were wrong in the
    // permissive direction and silently let a short token through.
    expect(shortestMatch('change-?me')).toBe('changeme');
    expect(shortestMatch('your-?(api-?)?key')).toBe('yourkey');
    for (const short of ['key', 'test', 'demo', 'fake', 'k(ey)?']) {
      expect(shortestMatch(short).length).toBeLessThan(MIN_TOKEN_LENGTH);
    }
  });

  it('the syntax guard catches the forms that would defeat the length floor', () => {
    // Each of these measures >= 5 by shortestMatch while actually matching a much shorter segment
    // (`dummy|key` -> `key`, `keyy*` -> `key`, `a{3,}` -> `aaa`, `[abcde]` -> `a`), so the guard,
    // not the floor, is what keeps them out. `((a)?b)?` covers the nested-group case.
    for (const hostile of ['dummy|key', 'keyy*', 'keyy+', 'a{3,}', '[abcde]', 'abc\\?def', '((a)?b)?']) {
      expect(UNMEASURABLE_SYNTAX.test(hostile), `should be rejected: ${hostile}`).toBe(true);
    }
    // The forms actually in use must NOT trip the guard, or it would fail the whole token list.
    for (const supported of ['dummy', 'change-?me', 'your-?(api-?)?key', 'not-a-real']) {
      expect(UNMEASURABLE_SYNTAX.test(supported), `should be allowed: ${supported}`).toBe(false);
    }
  });
});
