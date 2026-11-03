import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { NATIVE_OAUTH_CLIENT_ID } from '@bike4mind/common';
import { OAuthClientModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

const NATIVE_OAUTH_REDIRECT_PATH = '/ios/auth-callback';
export const NATIVE_OAUTH_REDIRECT_URI = `https://app.bike4mind.com${NATIVE_OAUTH_REDIRECT_PATH}`;

/**
 * The prod URI plus, on non-prod deploys, the one on this deploy's own origin (APP_URL). Without the
 * latter a preview/dev/staging DB would carry a redirect URI that can never match, and $setOnInsert
 * could not repair it later.
 */
export function resolveNativeOAuthRedirectUris(appUrl = process.env.APP_URL): string[] {
  const origin = appUrl?.trim().replace(/\/+$/, '');
  const uris = origin
    ? [`${origin}${NATIVE_OAUTH_REDIRECT_PATH}`, NATIVE_OAUTH_REDIRECT_URI]
    : [NATIVE_OAUTH_REDIRECT_URI];
  return [...new Set(uris)];
}

/**
 * Registers the first-party native client for the OAuth authorization-code + PKCE flow.
 * Public client (PKCE, no usable secret), exact-match universal-link redirect. $setOnInsert keeps
 * the write idempotent and leaves any operator edits (deactivation, extra redirect URIs) alone.
 * Id is backdated below the fail-closed OAuth backfill (20260922000001) so its throw cannot block this.
 */
const migration: MigrationFile = {
  id: 20260921236950,
  name: 'ensure-first-party-native-oauth-client',

  up: async () => {
    const throwawayHash = await bcrypt.hash(crypto.randomBytes(32).toString('base64url'), 10);
    await OAuthClientModel.updateOne(
      { clientId: NATIVE_OAUTH_CLIENT_ID },
      {
        $setOnInsert: {
          clientId: NATIVE_OAUTH_CLIENT_ID,
          clientSecretHash: throwawayHash,
          name: 'Bike4Mind Native App',
          redirectUris: resolveNativeOAuthRedirectUris(),
          allowedScopes: ['openid', 'email', 'profile'],
          tokenEndpointAuthMethod: 'none',
          clientType: 'first-party',
          isActive: true,
        },
      },
      { upsert: true }
    );
  },

  // The client may already have issued sessions; leave it in place.
  down: async () => {},
};

export default migration;
