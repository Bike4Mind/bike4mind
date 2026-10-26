import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { CounterLog, FabFile, Quest, Session, UserApiKey, safeDropIndex } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

// Mirrors the sibling ensure-* integration tests' guard against evaluating SST config.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration, { REDUNDANT_INDEXES } from './20260921235969_ensure-advisor-indexes';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const NEW_INDEXES = [
  { model: Session, name: 'knowledgeIds_1_deletedAt_1' },
  { model: Session, name: 'userId_1_slackNotebook' },
  { model: Quest, name: 'contextTelemetry_anonymousSessionHash' },
  { model: CounterLog, name: 'userId_1_createdAt_-1' },
] as const;

const indexNames = async (collection: mongoose.Collection) => (await collection.indexes()).map(index => index.name);

type ExecutionExplain = {
  queryPlanner: { winningPlan: unknown };
  executionStats: { nReturned: number; totalDocsExamined: number };
};

/**
 * The winning plan only (rejectedPlans also name every candidate index, which would let a test pass
 * when the new index lost), serialized so stage and index names can be matched under SBE or classic.
 */
function winner(raw: unknown) {
  const explain = (Array.isArray(raw) ? raw[0] : raw) as ExecutionExplain;
  return { winningPlan: JSON.stringify(explain.queryPlanner.winningPlan), stats: explain.executionStats };
}

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // Settle autoIndex before the hooks below drop indexes - see createMongoServer's autoIndex note.
  await Promise.all([Session, Quest, CounterLog, FabFile, UserApiKey].map(model => model.init()));
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  for (const { model, name } of NEW_INDEXES) {
    await model.collection.deleteMany({});
    await safeDropIndex(model.collection, name);
  }
});

describe('ensure-advisor-indexes migration (real DB)', () => {
  it('builds every new index', async () => {
    await migration.up();

    for (const { model, name } of NEW_INDEXES) {
      expect(await indexNames(model.collection)).toContain(name);
    }
  });

  it('is idempotent on re-run', async () => {
    await migration.up();
    await migration.up();

    for (const { model, name } of NEW_INDEXES) {
      expect(await indexNames(model.collection)).toContain(name);
    }
  });

  describe('redundant indexes', () => {
    it.each(REDUNDANT_INDEXES.map(entry => [entry.model.collection.collectionName, entry] as const))(
      'drops the stale prefix index on %s once its covering index exists',
      async (_name, { model, key, coveredBy }) => {
        await model.collection.createIndex(coveredBy);
        await model.collection.createIndex(key, { name: 'stale_prefix' });

        await migration.up();

        const names = await indexNames(model.collection);
        expect(names).not.toContain('stale_prefix');
        expect((await model.collection.indexes()).some(i => JSON.stringify(i.key) === JSON.stringify(coveredBy))).toBe(
          true
        );
      }
    );

    it.each(REDUNDANT_INDEXES.map(entry => [entry.model.collection.collectionName, entry] as const))(
      'keeps the prefix index on %s when no covering index exists',
      async (_name, { model, key, coveredBy }) => {
        const covering = (await model.collection.indexes()).find(
          i => JSON.stringify(i.key) === JSON.stringify(coveredBy)
        );
        if (covering?.name) await model.collection.dropIndex(covering.name);
        await model.collection.createIndex(key, { name: 'stale_prefix' });

        try {
          await migration.up();

          expect(await indexNames(model.collection)).toContain('stale_prefix');
        } finally {
          await safeDropIndex(model.collection, 'stale_prefix');
          await model.collection.createIndex(coveredBy);
        }
      }
    );

    const CONSTRAINTS = [
      ['sparse', { sparse: true }],
      ['partial', { partialFilterExpression: { createdAt: { $exists: true } } }],
      ['unique', { unique: true }],
    ] as const;

    it.each(
      REDUNDANT_INDEXES.flatMap(entry =>
        CONSTRAINTS.map(([label, options]) => [entry.model.collection.collectionName, label, entry, options] as const)
      )
    )('keeps a constrained index on %s with the same key (%s)', async (_name, _label, entry, options) => {
      const { model, key, coveredBy } = entry;
      await model.collection.createIndex(coveredBy);
      await model.collection.createIndex(key, { name: 'stale_prefix', ...options });

      try {
        await migration.up();

        expect(await indexNames(model.collection)).toContain('stale_prefix');
      } finally {
        await safeDropIndex(model.collection, 'stale_prefix');
      }
    });
  });

  // A partial or sparse index the query does not imply is silently skipped by the planner, so pin
  // each production query shape to the index it was built for.
  describe('query shapes use the new indexes', () => {
    const userId = new mongoose.Types.ObjectId().toString();

    beforeEach(async () => {
      await migration.up();
    });

    it('the Slack gear check uses userId_1_slackNotebook', async () => {
      await Session.collection.insertMany([
        ...Array.from({ length: 50 }, () => ({ userId, deletedAt: null, lastUpdated: new Date() })),
        { userId, deletedAt: null, slackMetadata: { channelId: 'C1', createdFromSlack: true } },
      ]);

      const { winningPlan, stats } = winner(
        await Session.find({ userId, 'slackMetadata.channelId': { $exists: true } }).explain('executionStats')
      );

      expect(winningPlan).toContain('userId_1_slackNotebook');
      expect(stats.totalDocsExamined).toBe(stats.nReturned);
    });

    it('findAllWithKnowledgeId uses knowledgeIds_1_deletedAt_1', async () => {
      await Session.collection.insertMany(
        Array.from({ length: 50 }, (_, i) => ({ userId, deletedAt: null, knowledgeIds: [`file-${i}`] }))
      );

      const { winningPlan, stats } = winner(
        await Session.find({ knowledgeIds: { $in: ['file-7'] } }).explain('executionStats')
      );

      expect(winningPlan).toContain('knowledgeIds_1_deletedAt_1');
      expect(stats.totalDocsExamined).toBe(stats.nReturned);
    });

    it('the telemetry opt-out delete uses contextTelemetry_anonymousSessionHash', async () => {
      await Quest.collection.insertMany([
        ...Array.from({ length: 50 }, () => ({ sessionId: 's', timestamp: new Date() })),
        {
          sessionId: 's',
          timestamp: new Date(),
          promptMeta: { contextTelemetry: { anonymousSessionId: { hash: 'h1' } } },
        },
      ]);

      const { winningPlan, stats } = winner(
        await Quest.find({ 'promptMeta.contextTelemetry.anonymousSessionId.hash': { $in: ['h1', 'h2'] } })
          .setOptions({
            includeDeleted: true,
          })
          .explain('executionStats')
      );

      expect(winningPlan).toContain('contextTelemetry_anonymousSessionHash');
      expect(stats.totalDocsExamined).toBe(stats.nReturned);
    });

    it('findRecentByUserIdAndHasMetadata uses userId_1_createdAt_-1', async () => {
      await CounterLog.collection.insertMany(
        Array.from({ length: 50 }, (_, i) => ({
          userId,
          counterName: 'c',
          counterValue: 1,
          datetime: new Date(),
          createdAt: new Date(Date.now() - i * 1000),
          ...(i % 2 ? { metadata: { a: i } } : {}),
        }))
      );

      const { winningPlan } = winner(
        await CounterLog.find({ userId, metadata: { $exists: true } })
          .sort({ createdAt: -1 })
          .limit(10)
          .explain('executionStats')
      );

      expect(winningPlan).toContain('userId_1_createdAt_-1');
      // The index supplies the order; a blocking SORT stage means the read still sorts in memory.
      expect(winningPlan).not.toMatch(/"stage":"SORT"/);
    });
  });
});
