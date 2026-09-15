import { describe, expect, it } from 'vitest';
import { assertSafeObjectKey, FORBIDDEN_OBJECT_KEYS, isForbiddenObjectKey } from './safeObjectKey';

describe('safeObjectKey', () => {
  it('flags the prototype-chain keys', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expect(isForbiddenObjectKey(key)).toBe(true);
    }
    expect([...FORBIDDEN_OBJECT_KEYS].sort()).toEqual(['__proto__', 'constructor', 'prototype']);
  });

  it('allows ordinary keys', () => {
    for (const key of ['revenue', 'Q1_2024', 'proto', '__proto', 'proto__', 'Sheet1', '']) {
      expect(isForbiddenObjectKey(key)).toBe(false);
    }
  });

  it('assertSafeObjectKey throws on a reserved key and names the kind', () => {
    expect(() => assertSafeObjectKey('__proto__', 'entity')).toThrow(/entity.*__proto__/);
    expect(() => assertSafeObjectKey('constructor')).toThrow(/reserved name/);
  });

  it('assertSafeObjectKey is a no-op for ordinary keys', () => {
    expect(() => assertSafeObjectKey('revenue', 'entity')).not.toThrow();
  });
});
