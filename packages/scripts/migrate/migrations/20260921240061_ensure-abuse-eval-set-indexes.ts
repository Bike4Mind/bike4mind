import { AbuseEvalSetModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the AbuseEvalSet indexes exist: the createdAt TTL that retires a set 365 days after its
 * draw, and examples.userId, which account deletion uses to pull a person's examples. autoIndex
 * builds are fire-and-forget, so this builds them in the deploy instead. The collection is new, so
 * the build is cheap.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20260921240061,
  name: 'ensure abuse eval set indexes',

  up: async () => {
    await AbuseEvalSetModel.createIndexes();
  },

  down: async () => {
    // Dropping the TTL would keep sets forever; removal is a forward migration.
  },
};

export default migration;
