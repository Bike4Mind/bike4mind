/**
 * Initialize System Secrets for Existing Deployments
 *
 * NOTE: This migration previously auto-generated JWT_SECRET, but that behavior
 * has been removed. JWT_SECRET is now a Tier 1 secret that must be configured
 * via SST CLI like SECRET_ENCRYPTION_KEY and SESSION_SECRET.
 *
 * This migration is kept as a no-op for backwards compatibility with deployments
 * that have already run it.
 */

import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20260116140000,
  name: 'initialize system secrets',

  up: async () => {
    // This migration previously auto-generated JWT_SECRET.
    // JWT_SECRET is now a Tier 1 secret and must be set via SST CLI.
    // No action needed - SystemSecretsSeeder will validate all Tier 1 secrets.
    console.log(
      '[Migration] System secrets migration is now a no-op. ' +
        'All Tier 1 secrets (SECRET_ENCRYPTION_KEY, SESSION_SECRET, JWT_SECRET) ' +
        'must be configured via SST CLI.'
    );
  },

  down: async () => {
    // No action needed - this migration no longer creates any database records
    console.log('[Migration Rollback] No action needed - migration was a no-op');
  },
};

export default migration;
