import { NATIVE_OAUTH_CLIENT_ID } from '@bike4mind/common';
import { OAuthClientModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Private-use scheme redirect (RFC 8252 section 7.1) for development builds of the native app, which
 * cannot claim the https universal link. PKCE binds the code to the app's verifier.
 */
export const NATIVE_OAUTH_DEV_REDIRECT_URI = 'com.bike4mind.app://auth-callback';

/**
 * Adds the development redirect to the first-party native client. 20260921236950 seeds that client
 * with $setOnInsert, so a client that already exists never picks up a new URI from it; this updates
 * it in place. No upsert: on a fresh DB the seed runs first (lower id). Backdated below the
 * fail-closed OAuth backfill (20260922000001), which must stay the highest core id.
 */
const migration: MigrationFile = {
  id: 20260921236951,
  name: 'add-native-oauth-dev-redirect-uri',

  up: async () => {
    await OAuthClientModel.updateOne(
      { clientId: NATIVE_OAUTH_CLIENT_ID },
      { $addToSet: { redirectUris: NATIVE_OAUTH_DEV_REDIRECT_URI } }
    );
  },

  down: async () => {
    await OAuthClientModel.updateOne(
      { clientId: NATIVE_OAUTH_CLIENT_ID },
      { $pull: { redirectUris: NATIVE_OAUTH_DEV_REDIRECT_URI } }
    );
  },
};

export default migration;
