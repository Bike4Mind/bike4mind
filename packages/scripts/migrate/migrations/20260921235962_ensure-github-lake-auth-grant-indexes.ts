import { GitHubLakeAuthGrant } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the GitHubLakeAuthGrant indexes exist: the unique `nonceHash` that makes a flow's grant
 * one row, and the `expiresAt` TTL that sweeps abandoned grants (each holds an encrypted GitHub
 * user token). Migration rather than autoIndex for the same reason as
 * 20260902000000_ensure-quest-retrieval-index: autoIndex builds are fire-and-forget, so a failure
 * would leave grants unswept with nothing reporting it.
 *
 * Numbered below 20260922000001 on purpose: that fail-closed backfill must keep the highest id.
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20260921235962,
  name: 'ensure github lake auth grant indexes',

  up: async () => {
    await GitHubLakeAuthGrant.createIndexes();
  },

  down: async () => {
    // Additive; dropping the TTL index would stop abandoned grants from being swept.
  },
};

export default migration;
