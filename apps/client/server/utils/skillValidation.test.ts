import { describe, it, expect } from 'vitest';
import {
  validateSkillName,
  validateSkillDescription,
  validateSkillBody,
  validateSkillArgumentHint,
  validateSkillAllowedTools,
} from './skillValidation';

describe('skillValidation', () => {
  describe('validateSkillName', () => {
    it('accepts lowercase kebab-case names', () => {
      expect(validateSkillName('summarize')).toBe('summarize');
      expect(validateSkillName('review-pr')).toBe('review-pr');
      expect(validateSkillName('foo-bar-baz')).toBe('foo-bar-baz');
      expect(validateSkillName('skill1')).toBe('skill1');
    });

    it('trims surrounding whitespace', () => {
      expect(validateSkillName('  summarize  ')).toBe('summarize');
    });

    it('rejects uppercase letters', () => {
      expect(() => validateSkillName('Summarize')).toThrow(/kebab-case/);
      expect(() => validateSkillName('SUMMARIZE')).toThrow(/kebab-case/);
    });

    it('rejects whitespace inside the name', () => {
      expect(() => validateSkillName('review pr')).toThrow(/kebab-case/);
    });

    it('rejects leading or trailing hyphens', () => {
      expect(() => validateSkillName('-foo')).toThrow(/kebab-case/);
      expect(() => validateSkillName('foo-')).toThrow(/kebab-case/);
    });

    it('rejects underscores and other punctuation', () => {
      expect(() => validateSkillName('review_pr')).toThrow(/kebab-case/);
      expect(() => validateSkillName('review/pr')).toThrow(/kebab-case/);
    });

    it('rejects empty and non-string values', () => {
      expect(() => validateSkillName('')).toThrow(/required/);
      expect(() => validateSkillName('   ')).toThrow(/required/);
      expect(() => validateSkillName(undefined)).toThrow(/required/);
      expect(() => validateSkillName(123)).toThrow(/required/);
    });

    it('rejects names over 64 characters', () => {
      expect(() => validateSkillName('a'.repeat(65))).toThrow(/64 characters/);
    });
  });

  describe('validateSkillDescription', () => {
    it('accepts non-empty strings', () => {
      expect(validateSkillDescription('Summarize a long text')).toBe('Summarize a long text');
    });

    it('rejects empty strings', () => {
      expect(() => validateSkillDescription('')).toThrow(/required/);
    });

    it('rejects descriptions over 500 characters', () => {
      expect(() => validateSkillDescription('x'.repeat(501))).toThrow(/500 characters/);
    });
  });

  describe('validateSkillBody', () => {
    it('accepts non-empty bodies and preserves internal whitespace', () => {
      expect(validateSkillBody('Step 1\nStep 2')).toBe('Step 1\nStep 2');
    });

    it('rejects empty bodies', () => {
      expect(() => validateSkillBody('')).toThrow(/required/);
    });

    it('rejects bodies over 50000 characters', () => {
      expect(() => validateSkillBody('x'.repeat(50_001))).toThrow(/50000 characters/);
    });
  });

  describe('validateSkillArgumentHint', () => {
    it('returns undefined for empty / null / undefined input', () => {
      expect(validateSkillArgumentHint(undefined)).toBeUndefined();
      expect(validateSkillArgumentHint(null)).toBeUndefined();
      expect(validateSkillArgumentHint('')).toBeUndefined();
    });

    it('accepts strings within the 200-character cap', () => {
      expect(validateSkillArgumentHint('[file] [priority]')).toBe('[file] [priority]');
    });

    it('rejects strings over 200 characters', () => {
      expect(() => validateSkillArgumentHint('x'.repeat(201))).toThrow(/200 characters/);
    });
  });

  describe('validateSkillAllowedTools', () => {
    it('returns undefined when not provided', () => {
      expect(validateSkillAllowedTools(undefined)).toBeUndefined();
    });

    it('accepts an array of tool names', () => {
      expect(validateSkillAllowedTools(['Read', 'Edit'])).toEqual(['Read', 'Edit']);
    });

    it('rejects non-array values', () => {
      expect(() => validateSkillAllowedTools('Read')).toThrow(/array of strings/);
    });
  });
});
