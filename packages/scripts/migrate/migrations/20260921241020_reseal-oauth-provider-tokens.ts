import EncryptOAuthProviderTokens from './20260921240020_encrypt-oauth-provider-tokens';
import { type MigrationFile } from './index';

/**
 * Re-runs the OAuth provider token seal (20260921240020). That backfill runs before the deploy
 * that encrypts tokens on write takes traffic, so sign-ins served by the outgoing code during the
 * cutover can still land plaintext after its scan. The seal is idempotent: it only touches
 * non-empty tokens that are not already ciphertext.
 */
const migration: MigrationFile = {
  id: 20260921241020,
  name: 'Re-seal OAuth provider sign-in tokens written during the encryption cutover',
  up: EncryptOAuthProviderTokens.up,
  down: EncryptOAuthProviderTokens.down,
};

export default migration;
