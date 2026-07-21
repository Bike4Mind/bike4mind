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

  describe('ownerUsageSummary', () => {
    const orgEvent = (overrides: Partial<IUsageEventInput> = {}) =>
      record({ ownerId: 'org-1', ownerType: CreditHolderType.Organization, ...overrides });

    it('rolls up an owner spend by day, member, model, and feature', async () => {
      await orgEvent({ userId: 'user-a', feature: 'chat', costUsd: 0.01, creditsCharged: 50 });
      await orgEvent({ userId: 'user-a', feature: 'agent_execution', costUsd: 0.02, creditsCharged: 100 });
      await orgEvent({
        userId: 'user-b',
        feature: 'chat',
        provider: 'openai',
        model: 'gpt-4o',
        costUsd: 0.05,
        creditsCharged: 250,
      });

      const summary = await usageEventRepository.ownerUsageSummary('org-1', CreditHolderType.Organization);

      expect(summary.totals).toMatchObject({ requests: 3, creditsCharged: 400 });
      expect(summary.totals.cogsUsd).toBeCloseTo(0.08, 10);

      // Breakdowns are ordered biggest-spender first.
      expect(summary.byMember).toMatchObject([
        { userId: 'user-b', creditsCharged: 250, requests: 1 },
        { userId: 'user-a', creditsCharged: 150, requests: 2 },
      ]);
      expect(summary.byModel).toMatchObject([
        { provider: 'openai', model: 'gpt-4o', creditsCharged: 250 },
        { provider: 'bedrock', model: 'claude-sonnet-4-5', creditsCharged: 150 },
      ]);
      expect(summary.byFeature).toMatchObject([
        { feature: 'chat', creditsCharged: 300 },
        { feature: 'agent_execution', creditsCharged: 100 },
      ]);

      expect(summary.overTime).toHaveLength(1);
      expect(summary.overTime[0]).toMatchObject({ requests: 3, creditsCharged: 400 });
      expect(summary.overTime[0].day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('scopes strictly to the given owner id and type', async () => {
      await orgEvent({ userId: 'user-a', creditsCharged: 100 });
      // Same id, different type: an agent that happens to share the org id.
      await record({ ownerId: 'org-1', ownerType: CreditHolderType.Agent, creditsCharged: 999 });
      // Different owner entirely.
      await record({ ownerId: 'org-2', ownerType: CreditHolderType.Organization, creditsCharged: 999 });

      const summary = await usageEventRepository.ownerUsageSummary('org-1', CreditHolderType.Organization);

      expect(summary.totals).toMatchObject({ requests: 1, creditsCharged: 100 });
    });

    it('excludes events outside the trailing window', async () => {
      await orgEvent({ creditsCharged: 100 });
      await UsageEvent.collection.updateMany({}, { $set: { createdAt: new Date('2020-01-01') } });
      const summary = await usageEventRepository.ownerUsageSummary('org-1', CreditHolderType.Organization, 30);
      expect(summary.overTime).toHaveLength(0);
      expect(summary.byMember).toHaveLength(0);
      expect(summary.totals).toEqual({ requests: 0, cogsUsd: 0, creditsCharged: 0 });
    });

    it('returns zeroed totals for an owner with no events', async () => {
      const summary = await usageEventRepository.ownerUsageSummary('org-empty', CreditHolderType.Organization);
      expect(summary).toEqual({
        overTime: [],
        byMember: [],
        byModel: [],
        byFeature: [],
        totals: { requests: 0, cogsUsd: 0, creditsCharged: 0 },
      });
    });
  });

  describe('sessionUsageSummary', () => {
    it('rolls up a session by quest and by model with token totals', async () => {
      await record({
        sessionId: 's-1',
        requestId: 'quest-a',
        model: 'claude-sonnet-4-5',
        provider: 'bedrock',
        inputTokens: 1000,
        outputTokens: 400,
        cachedInputTokens: 100,
        costUsd: 0.01,
        creditsCharged: 50,
      });
      await record({
        sessionId: 's-1',
        requestId: 'quest-a',
        model: 'claude-sonnet-4-5',
        provider: 'bedrock',
        inputTokens: 500,
        outputTokens: 200,
        cachedInputTokens: 0,
        costUsd: 0.02,
        creditsCharged: 100,
      });
      await record({
        sessionId: 's-1',
        requestId: 'quest-b',
        model: 'gpt-4o',
        provider: 'openai',
        inputTokens: 2000,
        outputTokens: 800,
        cachedInputTokens: 0,
        costUsd: 0.05,
        creditsCharged: 250,
      });

      const summary = await usageEventRepository.sessionUsageSummary('s-1');

      expect(summary.totals).toMatchObject({
        requests: 3,
        creditsCharged: 400,
        inputTokens: 3500,
        outputTokens: 1400,
        cachedInputTokens: 100,
      });
      expect(summary.totals.cogsUsd).toBeCloseTo(0.08, 10);

      // Biggest spender first: quest-b (250) before quest-a (150).
      expect(summary.byQuest).toMatchObject([
        { requestId: 'quest-b', creditsCharged: 250, inputTokens: 2000 },
        { requestId: 'quest-a', creditsCharged: 150, inputTokens: 1500 },
      ]);
      expect(summary.byModel).toMatchObject([
        { provider: 'openai', model: 'gpt-4o', creditsCharged: 250 },
        { provider: 'bedrock', model: 'claude-sonnet-4-5', creditsCharged: 150 },
      ]);
    });

    it('scopes strictly to the session id', async () => {
      await record({ sessionId: 's-1', creditsCharged: 100 });
      await record({ sessionId: 's-2', creditsCharged: 999 });

      const summary = await usageEventRepository.sessionUsageSummary('s-1');
      expect(summary.totals).toMatchObject({ requests: 1, creditsCharged: 100 });
      expect(summary.byQuest).toHaveLength(1);
    });

    it('returns zeroed totals for a session with no events', async () => {
      const summary = await usageEventRepository.sessionUsageSummary('s-empty');
      expect(summary).toEqual({
        byQuest: [],
        byModel: [],
        totals: { requests: 0, cogsUsd: 0, creditsCharged: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      });
    });

    it('scopes to a single owner when one is given (mixed-owner session)', async () => {
      // Same session, spend billed to two different owners - the org owner must
      // only ever see their org's slice, never the other owner's.
      await record({
        sessionId: 's-mix',
        ownerId: 'org-1',
        ownerType: CreditHolderType.Organization,
        creditsCharged: 100,
      });
      await record({ sessionId: 's-mix', ownerId: 'user-x', ownerType: CreditHolderType.User, creditsCharged: 999 });

      const scoped = await usageEventRepository.sessionUsageSummary('s-mix', {
        ownerId: 'org-1',
        ownerType: CreditHolderType.Organization,
      });
      expect(scoped.totals).toMatchObject({ requests: 1, creditsCharged: 100 });

      // Unscoped (admin) still sees the whole session.
      const all = await usageEventRepository.sessionUsageSummary('s-mix');
      expect(all.totals).toMatchObject({ requests: 2, creditsCharged: 1099 });
    });
  });

  describe('sessionBelongsToOwner', () => {
    it('is true when the session has an event billed to the owner', async () => {
      await record({ sessionId: 's-1', ownerId: 'org-1', ownerType: CreditHolderType.Organization });

      const belongs = await usageEventRepository.sessionBelongsToOwner('s-1', 'org-1', CreditHolderType.Organization);
      expect(belongs).toBe(true);
    });

    it('is false for a different owner id', async () => {
      await record({ sessionId: 's-1', ownerId: 'org-1', ownerType: CreditHolderType.Organization });

      const belongs = await usageEventRepository.sessionBelongsToOwner('s-1', 'org-2', CreditHolderType.Organization);
      expect(belongs).toBe(false);
    });

    it('is false when the owner type differs (user pool vs org pool)', async () => {
      await record({ sessionId: 's-1', ownerId: 'org-1', ownerType: CreditHolderType.User });

      const belongs = await usageEventRepository.sessionBelongsToOwner('s-1', 'org-1', CreditHolderType.Organization);
      expect(belongs).toBe(false);
    });

    it('is false for a session with no events', async () => {
      const belongs = await usageEventRepository.sessionBelongsToOwner(
        's-none',
        'org-1',
        CreditHolderType.Organization
      );
      expect(belongs).toBe(false);
    });
  });
});
