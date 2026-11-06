import type { IAuthProviders } from '@bike4mind/common';
import { encryptAtRest, isSecretsAtRestConfigured } from '@bike4mind/utils/security';

type ProviderTokens = Pick<IAuthProviders, 'accessToken' | 'refreshToken' | 'encrypted'>;

/**
 * Encrypts the provider tokens a sign-in persists on `authProviders[]` / `oauthCredentials`.
 * `encrypted` is set only when a key actually sealed them, so the flag stays truthful on a
 * keyless install (which stores plaintext by design, as `encryptAtRest` does). Readers decrypt
 * with `decryptAtRest`, which passes legacy plaintext through - see revokeAppleTokens.ts.
 * The backfill for rows written before this is migration 20260921240020.
 */
export function sealProviderTokens(accessToken: string | undefined, refreshToken: string | undefined): ProviderTokens {
  if (!isSecretsAtRestConfigured()) {
    return { accessToken, refreshToken };
  }
  return {
    accessToken: accessToken ? encryptAtRest(accessToken) : accessToken,
    refreshToken: refreshToken ? encryptAtRest(refreshToken) : refreshToken,
    encrypted: true,
  };
}
