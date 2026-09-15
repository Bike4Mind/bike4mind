// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

vi.mock('@server/utils/config', () => ({
  Config: { OVERWATCH_PSEUDONYM_SALT: 'env-salt-for-test' },
}));

import { pseudonymize, pseudonymizeUserId } from './pseudonymize';

describe('pseudonymize', () => {
  it('produces a 64-char hex string', () => {
    const result = pseudonymize('user-abc', 'test-salt');
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable: same inputs always produce the same output', () => {
    expect(pseudonymize('user-abc', 'test-salt')).toBe(pseudonymize('user-abc', 'test-salt'));
  });

  it('different userIds produce different outputs', () => {
    expect(pseudonymize('user-1', 'salt')).not.toBe(pseudonymize('user-2', 'salt'));
  });

  it('different salts produce different outputs for the same userId', () => {
    expect(pseudonymize('user-1', 'salt-a')).not.toBe(pseudonymize('user-1', 'salt-b'));
  });
});

describe('pseudonymizeUserId', () => {
  it('uses the configured salt', () => {
    const result = pseudonymizeUserId('user-abc');
    expect(result).toBe(pseudonymize('user-abc', 'env-salt-for-test'));
  });

  it('is stable across calls', () => {
    expect(pseudonymizeUserId('user-abc')).toBe(pseudonymizeUserId('user-abc'));
  });
});
