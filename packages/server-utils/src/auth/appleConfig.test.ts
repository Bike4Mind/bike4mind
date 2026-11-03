import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { config } = vi.hoisted(() => ({
  config: {
    APPLE_CLIENT_ID: 'com.example.services' as string | undefined,
    APPLE_TEAM_ID: 'TEAM' as string | undefined,
    APPLE_KEY_ID: 'KEY' as string | undefined,
    APPLE_PRIVATE_KEY: '' as string | undefined,
  },
}));
vi.mock('../utils/config', () => ({ Config: config }));

const pkcs8Pem = (key: { export: (options: { format: 'pem'; type: 'pkcs8' }) => string | Buffer }): string =>
  key.export({ format: 'pem', type: 'pkcs8' }).toString();

const p256Pem = pkcs8Pem(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey);

// The module remembers that it reported a bad key, so each test gets a fresh copy.
const loadModule = async () => {
  vi.resetModules();
  return import('./appleConfig');
};

describe('getAppleConfig', () => {
  const errorSpy = vi.spyOn(console, 'error');

  beforeEach(() => {
    config.APPLE_CLIENT_ID = 'com.example.services';
    config.APPLE_TEAM_ID = 'TEAM';
    config.APPLE_KEY_ID = 'KEY';
    config.APPLE_PRIVATE_KEY = p256Pem;
    errorSpy.mockReset().mockImplementation(() => undefined);
  });
  afterEach(() => errorSpy.mockReset());

  it('returns the config for a valid P-256 key, and the key signs', async () => {
    const { getAppleConfig, generateAppleClientSecret } = await loadModule();
    const appleConfig = getAppleConfig();
    expect(appleConfig).toEqual({
      clientId: 'com.example.services',
      teamId: 'TEAM',
      keyId: 'KEY',
      privateKey: p256Pem.trim(),
    });
    if (!appleConfig) throw new Error('expected a config');
    expect(() => generateAppleClientSecret(appleConfig)).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('accepts a PEM flattened onto one line with literal \\n escapes', async () => {
    config.APPLE_PRIVATE_KEY = p256Pem.replace(/\n/g, '\\n');
    const { getAppleConfig } = await loadModule();
    expect(getAppleConfig()?.privateKey).toBe(p256Pem.trim());
  });

  it.each([
    ['unset', undefined],
    ['blank', '   '],
    ['the not-configured placeholder', 'not-configured'],
  ])('returns null without logging an error when the key is %s', async (_label, value) => {
    config.APPLE_PRIVATE_KEY = value;
    const { getAppleConfig } = await loadModule();
    expect(getAppleConfig()).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('returns null without logging an error when another credential is unset', async () => {
    config.APPLE_TEAM_ID = undefined;
    const { getAppleConfig } = await loadModule();
    expect(getAppleConfig()).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['a file path instead of the PEM', 'AuthKey_ABC123.p8'],
    ['a key body without its header lines', p256Pem.split('\n').slice(1, -2).join('\n')],
    ['an RSA key', pkcs8Pem(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey)],
    ['an EC key on the wrong curve', pkcs8Pem(generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey)],
  ])('treats %s as not configured: null, no throw, one error log', async (_label, value) => {
    config.APPLE_PRIVATE_KEY = value;
    const { getAppleConfig } = await loadModule();
    expect(() => getAppleConfig()).not.toThrow();
    expect(getAppleConfig()).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('APPLE_PRIVATE_KEY is set but is not a valid');
  });
});
