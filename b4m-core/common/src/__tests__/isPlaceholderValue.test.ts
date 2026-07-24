import { describe, it, expect } from 'vitest';
import {
  isPlaceholderValue,
  isPlaceholderApiKey,
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
    // protection doesn't flag them; entropy is irrelevant here - the predicate only looks
    // for a dummy token as a whole delimited segment.
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
  });
});
