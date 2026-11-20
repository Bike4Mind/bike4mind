import type { Model } from 'mongoose';
import { AgentExecutionModel, Inbox, WorkItem } from '@bike4mind/database';
import { type MigrationFile } from './index';

type IndexKey = Record<string, 1 | -1>;

/**
 * Builds the named indexes of `model` with their schema options, and no others: an environment's existing index can
 * differ from the schema, and the conflict would fail the deploy. Throws when the schema no longer declares one.
 * Idempotent: createIndex is a no-op for an identical index that already exists.
 */
export const ensureIndexes = async <T>(model: Model<T>, keys: IndexKey[]): Promise<void> => {
  const specs = model.schema.indexes();
  for (const key of keys) {
    const spec = specs.find(([fields]) => JSON.stringify(fields) === JSON.stringify(key));
    if (!spec) {
      throw new Error(`${model.modelName} declares no ${JSON.stringify(key)} index; this migration no longer matches`);
    }
    // mongoose and the driver type index keys and options differently; the values are the same.
    type CreateIndexArgs = Parameters<typeof model.collection.createIndex>;
    await model.collection.createIndex(spec[0] as CreateIndexArgs[0], spec[1] as CreateIndexArgs[1]);
  }
};

/** The indexes the loop scheduler, loop tickets and loop notices read through, on collections that are large. */
export const LOOP_INDEXES = {
  agentExecution: [
    { runnerLeaseUntil: 1 },
    { loopId: 1, ticketPriority: 1, createdAt: 1 },
    { loopId: 1, createdAt: 1 },
  ] satisfies IndexKey[],
  workItem: [
    { loopId: 1, deletedAt: 1, status: 1, stage: 1 },
    { status: 1, loopId: 1 },
    { blockedOn: 1, status: 1 },
    { priority: 1, status: 1 },
    { executionId: 1 },
    { 'origin.ticketId': 1, 'origin.stage': 1, loopId: 1 },
  ] satisfies IndexKey[],
  inbox: [{ sourceKey: 1 }] satisfies IndexKey[],
};

const migration: MigrationFile = {
  id: 20261120044925,
  name: 'ensure loop indexes',

  up: async () => {
    await ensureIndexes(AgentExecutionModel, LOOP_INDEXES.agentExecution);
    await ensureIndexes(WorkItem, LOOP_INDEXES.workItem);
    await ensureIndexes(Inbox, LOOP_INDEXES.inbox);
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
