import { describe, it, expect } from 'vitest';
import { isTrustedHookSource } from './hookTrust.js';

describe('isTrustedHookSource', () => {
  it('trusts only user-controlled sources (builtin, global)', () => {
    expect(isTrustedHookSource('builtin')).toBe(true);
    expect(isTrustedHookSource('global')).toBe(true);
  });

  it('rejects sources reachable from an untrusted checkout or the model', () => {
    expect(isTrustedHookSource('project')).toBe(false);
    expect(isTrustedHookSource('remote')).toBe(false);
    expect(isTrustedHookSource('dynamic')).toBe(false);
  });

  it('rejects an undefined source', () => {
    expect(isTrustedHookSource(undefined)).toBe(false);
  });
});
