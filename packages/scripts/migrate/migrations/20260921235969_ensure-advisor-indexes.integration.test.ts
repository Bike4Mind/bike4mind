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

/** Index names the winning plan reads, so a test can prove the planner picks the new index. */
const winningIndexes = (explain: unknown): string[] =>
  [...JSON.stringify(explain).matchAll(/"indexName":"([^"]+)"/g)].map(match => match[1]);

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

        await migration.up();

        expect(await indexNames(model.collection)).toContain('stale_prefix');
        await model.collection.dropIndex('stale_prefix');
        await model.collection.createIndex(coveredBy);
      }
    );
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

      const explain = await Session.find({ userId, 'slackMetadata.channelId': { $exists: true } }).explain();

      expect(winningIndexes(explain)).toContain('userId_1_slackNotebook');
    });

    it('findAllWithKnowledgeId uses knowledgeIds_1_deletedAt_1', async () => {
      await Session.collection.insertMany(
        Array.from({ length: 50 }, (_, i) => ({ userId, deletedAt: null, knowledgeIds: [`file-${i}`] }))
      );

      const explain = await Session.find({ knowledgeIds: { $in: ['file-7'] } }).explain();

      expect(winningIndexes(explain)).toContain('knowledgeIds_1_deletedAt_1');
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

      const explain = await Quest.find({
        'promptMeta.contextTelemetry.anonymousSessionId.hash': { $in: ['h1', 'h2'] },
      })
        .setOptions({ includeDeleted: true })
        .explain();

      expect(winningIndexes(explain)).toContain('contextTelemetry_anonymousSessionHash');
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

      const explain = await CounterLog.find({ userId, metadata: { $exists: true } })
        .sort({ createdAt: -1 })
        .limit(10)
        .explain();

      expect(winningIndexes(explain)).toContain('userId_1_createdAt_-1');
    });
  });
});
