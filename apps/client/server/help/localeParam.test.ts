import { describe, it, expect } from 'vitest';
import { sanitizeLocale, firstQueryValue } from './localeParam';

describe('firstQueryValue', () => {
  it('returns a plain string as-is', () => {
    expect(firstQueryValue('es')).toBe('es');
  });
  it('takes the first element of an array', () => {
    expect(firstQueryValue(['es', 'ja'])).toBe('es');
  });
  it('returns undefined for undefined', () => {
    expect(firstQueryValue(undefined)).toBeUndefined();
  });
});

describe('sanitizeLocale', () => {
  it('defaults to en for undefined/empty', () => {
    expect(sanitizeLocale(undefined)).toBe('en');
    expect(sanitizeLocale('')).toBe('en');
    expect(sanitizeLocale('   ')).toBe('en');
  });

  it('accepts simple and region-coded locales verbatim (case preserved)', () => {
    expect(sanitizeLocale('es')).toBe('es');
    expect(sanitizeLocale('fil')).toBe('fil');
    expect(sanitizeLocale('zh-CN')).toBe('zh-CN');
    expect(sanitizeLocale('zh-TW')).toBe('zh-TW');
    expect(sanitizeLocale(' ja ')).toBe('ja');
  });

  it('rejects path-traversal and separators, falling back to en', () => {
    for (const evil of ['../en', 'es/../../secret', 'en/../../../etc/passwd', 'a/b', 'e.n', 'es\\ja', '..']) {
      expect(sanitizeLocale(evil)).toBe('en');
    }
  });

  it('rejects out-of-shape tokens', () => {
    for (const bad of ['e', 'toolonglang', 'es-', '-es', 'es-TOOLONG', '123', 'e2']) {
      expect(sanitizeLocale(bad)).toBe('en');
    }
  });
});
