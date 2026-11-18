import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { UsageEvent, usageEventRepository } from './UsageEventModel';
import { CreditHolderType, type SpendSegmentIds, type SpendTimelineParams } from '@bike4mind/common';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await UsageEvent.deleteMany({});
});

const NO_SEGMENTS: SpendSegmentIds = { internal: [], partner: [] };

type SeedEvent = {
  at: string;
  costUsd: number;
  ownerId?: string;
  ownerType?: CreditHolderType;
  userId?: string;
  provider?: string;
  executedProvider?: string;
  model?: string;
  executedModel?: string;
  feature?: string;
  source?: string;
  fundingBreakdown?: { granted: number; purchased: number; subscription: number; unknown: number };
};

// Raw insert: mongoose timestamps would overwrite createdAt on create().
async function seed(events: SeedEvent[]) {
  await UsageEvent.collection.insertMany(
    events.map(e => ({
      requestId: 'req',
      userId: e.userId ?? e.ownerId ?? 'user-1',
      ownerId: e.ownerId ?? 'user-1',
      ownerType: e.ownerType ?? CreditHolderType.User,
      feature: e.feature ?? 'chat',
      provider: e.provider ?? 'anthropic',
      model: e.model ?? 'sonnet',
      ...(e.executedProvider ? { executedProvider: e.executedProvider } : {}),
      ...(e.executedModel ? { executedModel: e.executedModel } : {}),
      ...(e.source ? { source: e.source } : {}),
      ...(e.fundingBreakdown ? { fundingBreakdown: e.fundingBreakdown } : {}),
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      costUsd: e.costUsd,
      creditsCharged: 0,
      status: 'ok',
      createdAt: new Date(e.at),
      updatedAt: new Date(e.at),
    }))
  );
}

const timeline = (overrides: Partial<SpendTimelineParams> = {}) =>
  usageEventRepository.spendTimeline({
    from: new Date('2026-11-10T00:00:00Z'),
    to: new Date('2026-11-13T00:00:00Z'),
    bucket: 'day',
    splitBy: 'provider',
    segmentIds: NO_SEGMENTS,
    ...overrides,
  });

describe('spendTimeline', () => {
  it('buckets by UTC day and splits by executed provider, honoring the half-open window', async () => {
    await seed([
      { at: '2026-11-09T23:59:59Z', costUsd: 100 }, // before window
      { at: '2026-11-10T01:00:00Z', costUsd: 2 },
      { at: '2026-11-10T23:00:00Z', costUsd: 3, provider: 'anthropic', executedProvider: 'bedrock' },
      { at: '2026-11-12T12:00:00Z', costUsd: 5, provider: 'openai' },
      { at: '2026-11-13T00:00:00Z', costUsd: 100 }, // at `to`: excluded
    ]);

    const rows = await timeline();

    expect(rows).toEqual([
      { bucket: '2026-11-10', key: 'anthropic', costUsd: 2, requests: 1 },
      { bucket: '2026-11-10', key: 'bedrock', costUsd: 3, requests: 1 },
      { bucket: '2026-11-12', key: 'openai', costUsd: 5, requests: 1 },
    ]);
  });

  it('buckets by UTC hour', async () => {
    await seed([
      { at: '2026-11-10T05:10:00Z', costUsd: 1 },
      { at: '2026-11-10T05:50:00Z', costUsd: 1 },
      { at: '2026-11-10T06:00:00Z', costUsd: 1 },
    ]);
    const rows = await timeline({ bucket: 'hour' });
    expect(rows.map(r => [r.bucket, r.costUsd])).toEqual([
      ['2026-11-10T05', 2],
      ['2026-11-10T06', 1],
    ]);
  });

  it('splits by segment: user tag first, then payer tag', async () => {
    await seed([
      { at: '2026-11-10T01:00:00Z', costUsd: 1, ownerId: 'org-internal', userId: 'u-a' },
      { at: '2026-11-10T01:00:00Z', costUsd: 2, ownerId: 'org-partner', userId: 'u-internal' },
      { at: '2026-11-10T01:00:00Z', costUsd: 4, ownerId: 'org-x', userId: 'u-internal' },
      { at: '2026-11-10T01:00:00Z', costUsd: 8, ownerId: 'org-x', userId: 'u-b' },
      // Both tagged: the user's own tag beats the payer's.
      { at: '2026-11-10T01:00:00Z', costUsd: 16, ownerId: 'org-internal', userId: 'u-partner' },
    ]);
    const rows = await timeline({
      splitBy: 'segment',
      segmentIds: { internal: ['org-internal', 'u-internal'], partner: ['org-partner', 'u-partner'] },
    });
    expect(Object.fromEntries(rows.map(r => [r.key, r.costUsd]))).toEqual({
      internal: 7,
      partner: 16,
      customer: 8,
    });
  });

  it('splits by model, feature and source, coalescing missing values', async () => {
    await seed([
      { at: '2026-11-10T01:00:00Z', costUsd: 1, model: 'sonnet', executedModel: 'haiku', source: 'cli' },
      { at: '2026-11-10T01:00:00Z', costUsd: 2, model: 'opus', feature: 'embed' },
    ]);
    const byModel = await timeline({ splitBy: 'model' });
    expect(byModel.map(r => r.key).sort()).toEqual(['haiku', 'opus']);
    const byFeature = await timeline({ splitBy: 'feature' });
    expect(byFeature.map(r => r.key).sort()).toEqual(['chat', 'embed']);
    const bySource = await timeline({ splitBy: 'source' });
    expect(bySource.map(r => r.key).sort()).toEqual(['cli', 'unclassified']);
  });

  it('apportions cost by funding source; events without a breakdown are unknown', async () => {
    await seed([
      {
        at: '2026-11-10T01:00:00Z',
        costUsd: 4,
        fundingBreakdown: { granted: 30, purchased: 10, subscription: 0, unknown: 0 },
      },
      { at: '2026-11-10T02:00:00Z', costUsd: 1 },
    ]);
    const rows = await timeline({ splitBy: 'funding' });
    const byKey = Object.fromEntries(rows.map(r => [r.key, r]));
    expect(byKey.granted.costUsd).toBeCloseTo(3);
    expect(byKey.paid.costUsd).toBeCloseTo(1);
    expect(byKey.unknown.costUsd).toBeCloseTo(1);
    // Each event counts once, on the granted part.
    expect(byKey.granted.requests).toBe(2);
  });

  it('restricts to the calls one user ran, whoever paid', async () => {
    await seed([
      { at: '2026-11-10T01:00:00Z', costUsd: 1, userId: 'u-a', ownerId: 'u-a' },
      {
        at: '2026-11-10T01:00:00Z',
        costUsd: 2,
        userId: 'u-a',
        ownerId: 'org-a',
        ownerType: CreditHolderType.Organization,
      },
      {
        at: '2026-11-10T01:00:00Z',
        costUsd: 5,
        userId: 'u-b',
        ownerId: 'org-a',
        ownerType: CreditHolderType.Organization,
      },
    ]);
    const rows = await timeline({ actorUserId: 'u-a' });
    expect(rows.map(r => r.costUsd)).toEqual([3]);
  });
});

describe('spendBreakdown', () => {
  it('returns totals, provider and segment cuts and the capped top acting users with their payers', async () => {
    await seed([
      { at: '2026-11-10T01:00:00Z', costUsd: 5, userId: 'a', ownerId: 'a' },
      // The same user's team-plan calls bill to the org but stay attributed to them.
      {
        at: '2026-11-10T02:00:00Z',
        costUsd: 6,
        userId: 'a',
        ownerId: 'org-1',
        ownerType: CreditHolderType.Organization,
        provider: 'openai',
      },
      { at: '2026-11-10T03:00:00Z', costUsd: 3, userId: 'b', ownerId: 'b' },
      {
        at: '2026-11-10T04:00:00Z',
        costUsd: 1,
        userId: 'c',
        ownerId: 'org-1',
        ownerType: CreditHolderType.Organization,
      },
      { at: '2026-11-11T04:00:00Z', costUsd: 50, userId: 'd', ownerId: 'd' }, // outside
    ]);

    const result = await usageEventRepository.spendBreakdown({
      from: new Date('2026-11-10T00:00:00Z'),
      to: new Date('2026-11-11T00:00:00Z'),
      limit: 2,
      segmentIds: { internal: ['b'], partner: [] },
    });

    expect(result.totalCostUsd).toBe(15);
    expect(result.byProvider).toEqual([
      { provider: 'anthropic', costUsd: 9 },
      { provider: 'openai', costUsd: 6 },
    ]);
    expect(result.bySegment).toEqual([
      { segment: 'customer', costUsd: 12 },
      { segment: 'internal', costUsd: 3 },
    ]);
    expect(result.topActors).toEqual([
      {
        userId: 'a',
        costUsd: 11,
        requests: 2,
        payers: [
          { ownerId: 'org-1', ownerType: CreditHolderType.Organization, costUsd: 6 },
          { ownerId: 'a', ownerType: CreditHolderType.User, costUsd: 5 },
        ],
      },
      {
        userId: 'b',
        costUsd: 3,
        requests: 1,
        payers: [{ ownerId: 'b', ownerType: CreditHolderType.User, costUsd: 3 }],
      },
    ]);
  });

  it('returns zeros for an empty window', async () => {
    const result = await usageEventRepository.spendBreakdown({
      from: new Date('2026-11-10T00:00:00Z'),
      to: new Date('2026-11-11T00:00:00Z'),
      limit: 10,
      segmentIds: NO_SEGMENTS,
    });
    expect(result).toEqual({ totalCostUsd: 0, byProvider: [], bySegment: [], topActors: [] });
  });
});
