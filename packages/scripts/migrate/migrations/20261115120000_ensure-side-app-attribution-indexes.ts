import { AgentExecutionModel, ApiKeyUsageLog, CreditTransaction, Quest } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the partial `oauthClientId` indexes behind per-app usage reads on credit transactions, API
 * key usage logs, quests and agent executions. Each is partial on the field existing, so only
 * federated exchange-key rows are indexed.
 *
 * Migration rather than autoIndex: autoIndex builds are fire-and-forget (a failure is silent) and
 * these are high-volume collections.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist, and also backfills any of
 * each model's other declared indexes an environment is missing.
 */
const migration: MigrationFile = {
  id: 20261115120000,
  name: 'ensure side app attribution indexes',

  up: async () => {
    await CreditTransaction.createIndexes();
    await ApiKeyUsageLog.createIndexes();
    await Quest.createIndexes();
    await AgentExecutionModel.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
