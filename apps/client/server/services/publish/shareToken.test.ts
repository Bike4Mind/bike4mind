import { describe, it, expect } from 'vitest';
import { generateShareToken } from './shareToken';

describe('generateShareToken', () => {
  it('is URL-safe base64url (no +, /, or = padding)', () => {
    for (let i = 0; i < 100; i++) {
      expect(generateShareToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('encodes 256 bits -> 43 base64url chars', () => {
    // 32 bytes in base64url is ceil(32/3)*4 minus padding = 43 chars.
    expect(generateShareToken()).toHaveLength(43);
  });

  it('is effectively unique across many draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateShareToken());
    expect(seen.size).toBe(1000);
  });
});
