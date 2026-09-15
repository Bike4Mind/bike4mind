import { describe, it, expect } from 'vitest';
import { generateRequestId, sanitizeRequestId, resolveRequestId, MAX_REQUEST_ID_LENGTH } from './requestId';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('sanitizeRequestId', () => {
  it('returns a clean caller value unchanged', () => {
    expect(sanitizeRequestId('my-trace-001')).toBe('my-trace-001');
    expect(sanitizeRequestId('abc.DEF_123-xyz')).toBe('abc.DEF_123-xyz');
  });

  it('strips characters outside the allowlist, defeating log injection', () => {
    expect(sanitizeRequestId('abc\r\ndef')).toBe('abcdef');
    expect(sanitizeRequestId('a b\tc')).toBe('abc');
    expect(sanitizeRequestId('id<script>')).toBe('idscript');
  });

  it('caps length at MAX_REQUEST_ID_LENGTH', () => {
    const long = 'a'.repeat(MAX_REQUEST_ID_LENGTH + 50);
    expect(sanitizeRequestId(long)).toHaveLength(MAX_REQUEST_ID_LENGTH);
  });

  it('returns null when nothing usable remains', () => {
    expect(sanitizeRequestId('')).toBeNull();
    expect(sanitizeRequestId('\r\n\t ')).toBeNull();
    expect(sanitizeRequestId('!@#$%')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(sanitizeRequestId(undefined)).toBeNull();
    expect(sanitizeRequestId(null)).toBeNull();
    expect(sanitizeRequestId(123)).toBeNull();
    expect(sanitizeRequestId(['a'])).toBeNull();
  });
});

describe('generateRequestId', () => {
  it('returns a UUID v4 string', () => {
    expect(generateRequestId()).toMatch(UUID_V4);
  });

  it('returns a different value each call', () => {
    expect(generateRequestId()).not.toBe(generateRequestId());
  });
});

describe('resolveRequestId', () => {
  it('uses the first sanitizable caller candidate', () => {
    expect(resolveRequestId('caller-id')).toBe('caller-id');
    expect(resolveRequestId(undefined, 'second')).toBe('second');
    expect(resolveRequestId('   ', 'legacy-id')).toBe('legacy-id');
  });

  it('sanitizes the chosen caller candidate', () => {
    expect(resolveRequestId('inject\r\nme')).toBe('injectme');
  });

  it('generates a fresh id when no candidate is usable', () => {
    expect(resolveRequestId(undefined, null, '')).toMatch(UUID_V4);
  });
});
