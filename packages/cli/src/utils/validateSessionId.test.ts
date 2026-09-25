import { describe, it, expect } from 'vitest';
import { isValidSessionId } from './validateSessionId.js';

describe('isValidSessionId', () => {
  it('accepts UUIDs and plain ids', () => {
    expect(isValidSessionId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isValidSessionId('abc-123_XYZ')).toBe(true);
  });

  it('rejects path-traversal and separators', () => {
    for (const bad of ['../config', '..', 'a/b', 'a\\b', '.', '']) {
      expect(isValidSessionId(bad)).toBe(false);
    }
  });

  it('rejects dots, spaces and other special characters', () => {
    for (const bad of ['a.b', 'a b', 'a;b', 'a$b', 'a\0b']) {
      expect(isValidSessionId(bad)).toBe(false);
    }
  });
});
