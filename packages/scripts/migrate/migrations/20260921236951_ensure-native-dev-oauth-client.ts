import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { NATIVE_DEV_OAUTH_CLIENT_ID } from '@bike4mind/common';
import { OAuthClientModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

export const NATIVE_DEV_OAUTH_REDIRECT_URI = 'com.bike4mind.app://auth-callback';

/** The production stage name. Note PRODUCTION_STAGES also includes staging, so it is the wrong test here. */
const PRODUCTION_STAGE = 'production';

/** The deploy's stage: SEED_STAGE_NAME on the migrator Lambda, STAGE for CLI runs. */
export function currentStage(): string {
  return (process.env.SEED_STAGE_NAME ?? process.env.STAGE ?? '').trim();
}

/** Fails closed: an unknown stage counts as production. */
export function shouldSeedNativeDevClient(stage = currentStage()): boolean {
  const normalized = stage.trim();
  return normalized !== '' && normalized !== PRODUCTION_STAGE;
}

/**
 * Registers the native app's development client on non-production stages only. It redirects to a
 * private-use scheme (RFC 8252), which any app can claim, and first-party clients skip consent, so
 * it must never exist where real accounts live. It has to be first-party all the same: a
 * relying-party token is refused by every app route that declares no OAuth scopes.
 * Insert-only like 20260921236950, so operator edits (deactivation) survive a re-run. Backdated below
 * the fail-closed OAuth backfill (20260922000001), which must stay the highest core id.
 */
const migration: MigrationFile = {
  id: 20260921236951,
  name: 'ensure-native-dev-oauth-client',

  up: async () => {
    if (!shouldSeedNativeDevClient()) {
      console.log(`Skipping native dev OAuth client on stage "${currentStage() || 'unknown'}"`);
      return;
    }
    const throwawayHash = await bcrypt.hash(crypto.randomBytes(32).toString('base64url'), 10);
    await OAuthClientModel.updateOne(
      { clientId: NATIVE_DEV_OAUTH_CLIENT_ID },
      {
        $setOnInsert: {
          clientId: NATIVE_DEV_OAUTH_CLIENT_ID,
          clientSecretHash: throwawayHash,
          name: 'Bike4Mind Native App (development)',
          redirectUris: [NATIVE_DEV_OAUTH_REDIRECT_URI],
          allowedScopes: ['openid', 'email', 'profile'],
          tokenEndpointAuthMethod: 'none',
          clientType: 'first-party',
          isActive: true,
        },
      },
      { upsert: true }
    );
  },

  // Sessions it issued may still be live; deactivate it by hand if needed.
  down: async () => {},
};

export default migration;
