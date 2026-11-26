import type { Model } from 'mongoose';
import { AgentExecutionModel, Inbox, Loop, LoopDirective, LoopEvent, WorkItem } from '@bike4mind/database';
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

/**
 * The indexes the loop scheduler, loop tickets and loop notices read through. Loop and LoopEvent are new and small;
 * they are listed so every loop index exists before the scheduler runs, not only once autoIndex gets to it.
 */
export const LOOP_INDEXES: Record<
  'agentExecution' | 'workItem' | 'inbox' | 'loop' | 'loopEvent' | 'loopDirective',
  IndexKey[]
> = {
  agentExecution: [
    { runnerLeaseUntil: 1 },
    { loopId: 1, ticketPriority: 1, createdAt: 1 },
    { loopId: 1, createdAt: 1 },
  ],
  workItem: [
    { loopId: 1, deletedAt: 1, status: 1, stage: 1 },
    { status: 1, loopId: 1 },
    { blockedOn: 1, status: 1 },
    { priority: 1, status: 1 },
    { executionId: 1 },
    { 'origin.ticketId': 1, 'origin.stage': 1, loopId: 1 },
  ],
  inbox: [{ sourceKey: 1 }],
  loop: [
    { status: 1, nextRunAt: 1 },
    { activeExecutionIds: 1 },
    { userId: 1, updatedAt: -1 },
    { 'alarm.kind': 1 },
    { 'hold.kind': 1 },
    { 'triggers.fromLoopId': 1 },
  ],
  loopEvent: [
    { loopId: 1, createdAt: -1 },
    { executionId: 1, requestedAt: 1 },
    { 'resolution.outcome': 1, foldedAt: 1 },
    { workItemId: 1, createdAt: -1 },
  ],
  loopDirective: [
    { loopId: 1, createdAt: -1 },
    { fromLoopId: 1, createdAt: -1 },
    { loopId: 1, state: 1, createdAt: 1 },
    { executionId: 1 },
  ],
};

const migration: MigrationFile = {
  id: 20261120044925,
  name: 'ensure loop indexes',

  up: async () => {
    await ensureIndexes(AgentExecutionModel, LOOP_INDEXES.agentExecution);
    await ensureIndexes(WorkItem, LOOP_INDEXES.workItem);
    await ensureIndexes(Inbox, LOOP_INDEXES.inbox);
    await ensureIndexes(Loop, LOOP_INDEXES.loop);
    await ensureIndexes(LoopEvent, LOOP_INDEXES.loopEvent);
    await ensureIndexes(LoopDirective, LOOP_INDEXES.loopDirective);
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
