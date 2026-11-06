import { afterEach, describe, expect, it } from 'vitest';
import { configureSecretsAtRest, decryptAtRest, generateEncryptionKey, isEncrypted } from '@bike4mind/utils/security';
import { sealProviderTokens } from './providerTokensAtRest';

afterEach(() => configureSecretsAtRest(undefined));

describe('sealProviderTokens', () => {
  it('encrypts both tokens and flags the entry when a key is configured', () => {
    configureSecretsAtRest(generateEncryptionKey());

    const sealed = sealProviderTokens('access-plain', 'refresh-plain');

    expect(sealed.encrypted).toBe(true);
    expect(isEncrypted(sealed.accessToken ?? '')).toBe(true);
    expect(decryptAtRest(sealed.accessToken ?? '')).toBe('access-plain');
    expect(decryptAtRest(sealed.refreshToken ?? '')).toBe('refresh-plain');
  });

  it('keeps empty tokens empty rather than sealing an empty string', () => {
    configureSecretsAtRest(generateEncryptionKey());

    expect(sealProviderTokens('access-plain', '').refreshToken).toBe('');
    expect(sealProviderTokens(undefined, undefined)).toEqual({
      accessToken: undefined,
      refreshToken: undefined,
      encrypted: true,
    });
  });

  it('stores plaintext without the encrypted flag on a keyless install', () => {
    expect(sealProviderTokens('access-plain', 'refresh-plain')).toEqual({
      accessToken: 'access-plain',
      refreshToken: 'refresh-plain',
    });
  });
});
