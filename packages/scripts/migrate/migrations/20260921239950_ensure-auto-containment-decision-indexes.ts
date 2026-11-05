import { AutoContainmentDecisionModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the AutoContainmentDecision indexes exist before the first decision is written.
 *
 * The unique `detectionId` index is load-bearing: it is the only thing keeping automated
 * containment (apps/client/server/security/autoContainment/executor.ts) from deciding, and in
 * enforce mode acting, twice on one detection. autoIndex builds are fire-and-forget, so a silent
 * build failure would leave that guard missing; this migration builds it in the deploy instead.
 * The collection is new, so the build is cheap.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20260921239950,
  name: 'ensure auto containment decision indexes',

  up: async () => {
    await AutoContainmentDecisionModel.createIndexes();
  },

  down: async () => {
    // Dropping the unique index would remove the once-per-detection guard; removal is a forward migration.
  },
};

export default migration;
