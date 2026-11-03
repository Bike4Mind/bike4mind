import { AuthStrategy } from '@bike4mind/common';
import { User } from '@bike4mind/database';
import { decryptAtRest } from '@bike4mind/utils/security';
import { APPLE_ISSUER, generateAppleClientSecret, getAppleConfig } from './appleConfig';

const APPLE_REVOKE_URL = `${APPLE_ISSUER}/auth/revoke`;

export type RevokeAppleTokensResult =
  | { status: 'revoked' }
  /** No Apple identity or no stored token: nothing to revoke. */
  | { status: 'no_token' }
  /** A token exists but this stage has no Apple credentials, so it cannot be revoked here. */
  | { status: 'not_configured' };

/**
 * Revokes the user's Apple grant (Apple requires revoking the grant when the account is deleted). Prefers the refresh token, which
 * also ends the access token. Throws when Apple refuses, so a caller that must guarantee revocation
 * can fail loudly; on success the stored tokens are dropped and the `sub` stays for identity matching.
 */
export async function revokeAppleTokens(userId: string): Promise<RevokeAppleTokensResult> {
  const user = await User.findById(userId).lean();
  const provider = user?.authProviders?.find(p => p.strategy === AuthStrategy.Apple);
  const stored = provider?.refreshToken || provider?.accessToken;
  if (!provider || !stored) return { status: 'no_token' };

  const config = getAppleConfig();
  if (!config) return { status: 'not_configured' };

  const token = provider.encrypted ? decryptAtRest(stored) : stored;
  if (!token) throw new Error('Apple token could not be decrypted for revocation');

  const response = await fetch(APPLE_REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: generateAppleClientSecret(config, 60),
      token,
      token_type_hint: provider.refreshToken ? 'refresh_token' : 'access_token',
    }),
  });
  if (!response.ok) {
    throw new Error(`Apple token revocation failed with status ${response.status}`);
  }

  await User.updateOne(
    { _id: userId },
    { $unset: { 'authProviders.$[apple].refreshToken': '', 'authProviders.$[apple].accessToken': '' } },
    { arrayFilters: [{ 'apple.strategy': AuthStrategy.Apple }] }
  );
  return { status: 'revoked' };
}
