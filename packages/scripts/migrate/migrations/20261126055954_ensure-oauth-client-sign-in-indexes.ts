import { OAuthClientSignInModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the OAuthClientSignIn indexes: the unique (clientId, userId) pair recordSignIn upserts on,
 * and the per-user listing. `autoIndex` is off in the deployed environments, so without this two
 * concurrent first sign-ins could create duplicate rows for one pair.
 *
 * Idempotent: createIndexes is a no-op for an index that already matches.
 */
const migration: MigrationFile = {
  id: 20261126055954,
  name: 'ensure oauth client sign-in indexes',

  up: async () => {
    await OAuthClientSignInModel.createIndexes();
  },

  down: async () => {
    // One-way. Dropping the unique index would let duplicate rows accumulate.
  },
};

export default migration;
