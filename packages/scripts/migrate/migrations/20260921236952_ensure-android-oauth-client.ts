import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { ANDROID_OAUTH_CLIENT_ID } from '@bike4mind/common';
import { OAuthClientModel } from '@bike4mind/database';
import { resolveNativeOAuthRedirectUris } from './20260921236950_ensure-first-party-native-oauth-client';
import { type MigrationFile } from './index';

// Must match the App Link the Android release build registers and assetlinks.json verifies.
export const ANDROID_OAUTH_REDIRECT_PATH = '/android/auth-callback';

/**
 * Registers the Android app's release client for the authorization-code + PKCE flow, the twin of
 * 20260921236950 for iOS: public client, first-party, verified https App Link redirect only. The
 * private-use scheme stays on the non-production dev client (20260921236951). Insert-only, so
 * operator edits survive a re-run; backdated below the fail-closed OAuth backfill (20260922000001).
 */
const migration: MigrationFile = {
  id: 20260921236952,
  name: 'ensure-android-oauth-client',

  up: async () => {
    const throwawayHash = await bcrypt.hash(crypto.randomBytes(32).toString('base64url'), 10);
    await OAuthClientModel.updateOne(
      { clientId: ANDROID_OAUTH_CLIENT_ID },
      {
        $setOnInsert: {
          clientId: ANDROID_OAUTH_CLIENT_ID,
          clientSecretHash: throwawayHash,
          name: 'Bike4Mind Android App',
          redirectUris: resolveNativeOAuthRedirectUris(process.env.APP_URL, ANDROID_OAUTH_REDIRECT_PATH),
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
