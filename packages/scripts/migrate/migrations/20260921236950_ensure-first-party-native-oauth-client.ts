import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { OAuthClientModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

export const NATIVE_OAUTH_CLIENT_ID = 'b4m-ios-app';
export const NATIVE_OAUTH_REDIRECT_URI = 'https://app.bike4mind.com/ios/auth-callback';

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
          redirectUris: [NATIVE_OAUTH_REDIRECT_URI],
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
