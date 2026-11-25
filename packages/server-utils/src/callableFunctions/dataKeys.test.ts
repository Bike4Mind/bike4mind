import { describe, expect, it } from 'vitest';
import { callableFunctionDataKey } from './dataKeys';

const HASH = 'a'.repeat(64);

describe('callableFunctionDataKey', () => {
  it('lays a key out under data/ as the prefix, a slash, and the hash', () => {
    expect(callableFunctionDataKey('tenant_0-a', HASH)).toBe(`data/tenant_0-a/${HASH}`);
  });

  it('keeps a prefix named like another top-level segment under data/', () => {
    expect(callableFunctionDataKey('outputs', HASH)).toBe(`data/outputs/${HASH}`);
  });

  it('keeps the same bytes under two prefixes apart', () => {
    expect(callableFunctionDataKey('t1', HASH)).not.toBe(callableFunctionDataKey('t2', HASH));
  });

  it.each(['', 'a/b', '..', 'a b', 'x'.repeat(129)])('refuses the prefix %j', prefix => {
    expect(() => callableFunctionDataKey(prefix, HASH)).toThrow('function-data prefix');
  });

  it.each(['', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), `${'a'.repeat(63)}/`])('refuses the hash %j', hash => {
    expect(() => callableFunctionDataKey('t1', hash)).toThrow('function-data hash');
  });
});
