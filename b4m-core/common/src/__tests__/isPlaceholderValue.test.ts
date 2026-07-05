import { describe, it, expect } from 'vitest';
import {
  isPlaceholderValue,
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
      expect(isPlaceholderValue('https://hooks.example.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX')).toBe(
        false
      );
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
