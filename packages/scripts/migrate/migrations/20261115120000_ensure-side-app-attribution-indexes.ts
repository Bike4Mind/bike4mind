import type { Model } from 'mongoose';
import { AgentExecutionModel, ApiKeyUsageLog, CreditTransaction, Quest } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the partial `oauthClientId` indexes behind per-app usage reads on credit transactions, API
 * key usage logs, quests and agent executions. Each is partial on the field existing, so only
 * federated exchange-key rows are indexed.
 *
 * Builds only those indexes, deliberately not each model's other declared ones: an environment's
 * existing index can differ from the schema, and the resulting conflict would fail the deploy.
 * Idempotent: createIndex is a no-op for an identical index that already exists.
 */
export const ensureOauthClientIdIndexes = async <T>(model: Model<T>): Promise<void> => {
  const specs = model.schema.indexes().filter(([fields]) => 'oauthClientId' in fields);
  if (specs.length === 0) {
    throw new Error(`${model.modelName} declares no oauthClientId index; this migration no longer matches its schema`);
  }
  for (const [fields, options] of specs) {
    // mongoose and the driver type index keys and options differently; the values are the same.
    type CreateIndexArgs = Parameters<typeof model.collection.createIndex>;
    await model.collection.createIndex(fields as CreateIndexArgs[0], options as CreateIndexArgs[1]);
  }
};

const migration: MigrationFile = {
  id: 20261115120000,
  name: 'ensure side app attribution indexes',

  up: async () => {
    await ensureOauthClientIdIndexes(CreditTransaction);
    await ensureOauthClientIdIndexes(ApiKeyUsageLog);
    await ensureOauthClientIdIndexes(Quest);
    await ensureOauthClientIdIndexes(AgentExecutionModel);
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
