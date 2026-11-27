import { describe, it, expect } from 'vitest';
import { isUnconfiguredSecret, requireConfiguredSecret } from '../types/entities/SystemSecretsTypes';

const REAL = 'a3f1c9e07b2d4e6f8a1b3c5d7e9f0a2b4c6d8e0f1a3b5c7d9e1f3a5b7c9d1e3f';

describe('isUnconfiguredSecret', () => {
  it.each([
    undefined,
    null,
    '',
    '   ',
    'my-secret-placeholder-value',
    'not-configured',
    ' NOT-CONFIGURED ',
    'change-me-openssl-rand-hex-32',
    'CHANGEME',
    'replace-with-generated-secret',
    'replace-with-64-hexadecimal-characters',
    'replace-me',
    'your-secret-key',
    'xxx',
  ])('treats %j as unset', value => {
    expect(isUnconfiguredSecret(value)).toBe(true);
  });

  it.each([REAL, 'test-jwt-secret', 'Zm9vYmFyYmF6cXV4'])('accepts %j', value => {
    expect(isUnconfiguredSecret(value)).toBe(false);
  });
});

describe('requireConfiguredSecret', () => {
  it('returns a configured value', () => {
    expect(requireConfiguredSecret('JWT_SECRET', REAL)).toBe(REAL);
  });

  it('throws naming the secret but never echoing the value', () => {
    const value = 'change-me-openssl-rand-hex-32';
    let message = '';
    try {
      requireConfiguredSecret('JWT_SECRET', value);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('JWT_SECRET');
    expect(message).not.toContain(value);
  });
});
