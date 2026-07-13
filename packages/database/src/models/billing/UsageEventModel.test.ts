import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { UsageEvent, usageEventRepository } from './UsageEventModel';
import { CreditHolderType, IUsageEventInput } from '@bike4mind/common';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await UsageEvent.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await UsageEvent.deleteMany({});
});

const baseEvent: IUsageEventInput = {
  requestId: 'quest-1',
  userId: 'user-1',
  ownerId: 'user-1',
  ownerType: CreditHolderType.User,
  sessionId: 'session-1',
  feature: 'chat',
  provider: 'bedrock',
  model: 'claude-sonnet-4-5',
  inputTokens: 1000,
  outputTokens: 500,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.01,
  creditsCharged: 50,
  status: 'ok',
};

const record = (overrides: Partial<IUsageEventInput> = {}) =>
  usageEventRepository.record({ ...baseEvent, ...overrides });

describe('UsageEventRepository', () => {
  describe('record', () => {
    it('persists an event with all quantities and money fields', async () => {
      const doc = await record({
        providerInputTokens: 900,
        providerOutputTokens: 480,
        latencyMs: 1234,
      });

      expect(doc).not.toBeNull();
      expect(doc!.costUsd).toBe(0.01);
      expect(doc!.creditsCharged).toBe(50);
      expect(doc!.providerInputTokens).toBe(900);
      expect(doc!.createdAt).toBeInstanceOf(Date);
    });

    it('rejects an unknown feature', async () => {
      await expect(record({ feature: 'nonsense' as IUsageEventInput['feature'] })).rejects.toThrow();
    });
  });

  describe('marginByModelDay', () => {
    it('groups cost and credits per provider/model per UTC day', async () => {
      await record({ costUsd: 0.01, creditsCharged: 50 });
      await record({ costUsd: 0.02, creditsCharged: 100 });
      await record({ model: 'gpt-4o', provider: 'openai', costUsd: 0.05, creditsCharged: 250 });

      const rows = await usageEventRepository.marginByModelDay();

      expect(rows).toHaveLength(2);
      const sonnet = rows.find(r => r.model === 'claude-sonnet-4-5');
      expect(sonnet).toMatchObject({ provider: 'bedrock', requests: 2 });
      expect(sonnet!.cogsUsd).toBeCloseTo(0.03, 10);
      expect(sonnet!.creditsCharged).toBe(150);
      expect(sonnet!.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('excludes events older than the since date', async () => {
      await record();
      const rows = await usageEventRepository.marginByModelDay(new Date(Date.now() + 60_000));
      expect(rows).toHaveLength(0);
    });
  });

  describe('marginByUser', () => {
    it('sorts worst margin (lowest credits per USD) first', async () => {
      // user-cheap pays 10 credits per $0.01 (1000 credits/$); user-rich pays 100 (10000 credits/$)
      await record({ userId: 'user-cheap', ownerId: 'user-cheap', costUsd: 0.01, creditsCharged: 10 });
      await record({ userId: 'user-rich', ownerId: 'user-rich', costUsd: 0.01, creditsCharged: 100 });

      const rows = await usageEventRepository.marginByUser();

      expect(rows.map(r => r.userId)).toEqual(['user-cheap', 'user-rich']);
      expect(rows[0]).toMatchObject({ requests: 1, creditsCharged: 10 });
    });

    it('excludes events outside the trailing window', async () => {
      await record();
      // Raw driver update: mongoose timestamps make createdAt immutable via the model.
      await UsageEvent.collection.updateMany({}, { $set: { createdAt: new Date('2020-01-01') } });
      const rows = await usageEventRepository.marginByUser(30);
      expect(rows).toHaveLength(0);
    });
  });

  describe('monthlyCogsByProvider', () => {
    it('sums cost and token quantities per provider per month, newest first', async () => {
      await record({ inputTokens: 1000, outputTokens: 500, cachedInputTokens: 200 });
      await record({ inputTokens: 2000, outputTokens: 700, cachedInputTokens: 0 });
      await record({ provider: 'openai', model: 'gpt-4o', inputTokens: 10, outputTokens: 5 });

      const rows = await usageEventRepository.monthlyCogsByProvider();

      expect(rows).toHaveLength(2);
      const bedrock = rows.find(r => r.provider === 'bedrock');
      expect(bedrock).toMatchObject({
        requests: 2,
        inputTokens: 3000,
        outputTokens: 1200,
        cachedInputTokens: 200,
      });
      expect(bedrock!.month).toMatch(/^\d{4}-\d{2}$/);
    });

    it('sums cacheWriteTokens', async () => {
      await record({ cacheWriteTokens: 300 });
      await record({ cacheWriteTokens: 50 });

      const rows = await usageEventRepository.monthlyCogsByProvider();

      expect(rows[0].cacheWriteTokens).toBe(350);
    });

    // Reconciliation invariant: providers invoice ALL traffic, so the COGS
    // baseline must include org-pool-billed and operational rows. A future
    // owner/feature filter here would silently understate recorded COGS.
    it('includes Organization-owned and operations-feature rows in the baseline', async () => {
      await record({ costUsd: 0.01 });
      await record({ costUsd: 0.02, ownerType: CreditHolderType.Organization, ownerId: 'org-1' });
      await record({ costUsd: 0.04, feature: 'operations', creditsCharged: 0 });

      const rows = await usageEventRepository.monthlyCogsByProvider();

      expect(rows).toHaveLength(1);
      expect(rows[0].requests).toBe(3);
      expect(rows[0].cogsUsd).toBeCloseTo(0.07, 10);
    });
  });

  describe('settlementBreakdown', () => {
    it('buckets by settledBasis and sums credits, write-offs, and token deltas', async () => {
      await record({
        settledBasis: 'provider',
        inputTokens: 1000,
        outputTokens: 500,
        providerInputTokens: 950,
        providerOutputTokens: 480,
        creditsCharged: 50,
        writtenOffCredits: 5,
      });
      await record({
        settledBasis: 'provider',
        inputTokens: 800,
        outputTokens: 400,
        providerInputTokens: 820,
        providerOutputTokens: 410,
        creditsCharged: 40,
      });
      await record({
        settledBasis: 'local',
        inputTokens: 300,
        outputTokens: 150,
        creditsCharged: 15,
        writtenOffCredits: 2,
      });
      // Provider reported input but not output (e.g. a stream that dropped before
      // completion): settledBasis stays 'local' since hasProviderUsage requires both.
      // The literal 0 is a partial report, not a real comparison point, so this row
      // must NOT contribute to the delta despite having a providerInputTokens value.
      await record({
        settledBasis: 'local',
        inputTokens: 300,
        outputTokens: 140,
        providerInputTokens: 290,
        providerOutputTokens: 0,
        creditsCharged: 10,
      });

      const rows = await usageEventRepository.settlementBreakdown();

      expect(rows).toHaveLength(2);
      const provider = rows.find(r => r.settledBasis === 'provider');
      expect(provider).toMatchObject({
        requests: 2,
        creditsCharged: 90,
        writtenOffCredits: 5,
        deltaSampleSize: 2,
      });
      // provider counts vs local estimate: (950-1000)+(820-800) = -30, (480-500)+(410-400) = -10
      expect(provider!.inputTokenDelta).toBe(-30);
      expect(provider!.outputTokenDelta).toBe(-10);

      const local = rows.find(r => r.settledBasis === 'local');
      expect(local).toMatchObject({
        requests: 2,
        creditsCharged: 25,
        writtenOffCredits: 2,
        // Neither local row has both provider counts as real positive values.
        deltaSampleSize: 0,
        inputTokenDelta: 0,
        outputTokenDelta: 0,
      });
    });

    it('excludes events with no settledBasis (rows predating the field)', async () => {
      await record();
      const rows = await usageEventRepository.settlementBreakdown();
      expect(rows).toHaveLength(0);
    });

    it('excludes events outside the trailing window', async () => {
      await record({ settledBasis: 'local' });
      await UsageEvent.collection.updateMany({}, { $set: { createdAt: new Date('2020-01-01') } });
      const rows = await usageEventRepository.settlementBreakdown(30);
      expect(rows).toHaveLength(0);
    });
  });
});
