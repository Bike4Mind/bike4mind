import { describe, it, expect } from 'vitest';
import { obfuscateApiKey } from '../apikey';

describe('obfuscateApiKey', () => {
  it('obfuscates a normal-length key', () => {
    const key = 'sk-abc123def456';
    const result = obfuscateApiKey(key);
    expect(result.slice(0, 3)).toBe('sk-');
    expect(result.slice(-3)).toBe('456');
    expect(result.length).toBe(key.length);
  });

  it('preserves first 3 and last 3 characters', () => {
    const key = 'abcdefghij';
    const result = obfuscateApiKey(key);
    expect(result.slice(0, 3)).toBe('abc');
    expect(result.slice(-3)).toBe('hij');
  });

  it('returns empty string for empty input', () => {
    expect(obfuscateApiKey('')).toBe('');
  });

  it('handles exactly 6-character key', () => {
    const result = obfuscateApiKey('abcdef');
    expect(result).toBe('abcdef');
  });
});
