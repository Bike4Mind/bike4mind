import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { CreditHolderType, PlatformUsageEvent } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { UsageEvent, usageEventRepository } from './UsageEventModel';
import { usageTimeMatch } from './platformUsageReporting';

let mongod: MongoMemoryServer;
let sequence = 0;
const from = new Date('2026-01-31T00:00:00Z');
const to = new Date('2026-02-01T00:00:00Z');
const segmentIds = { internal: [], partner: [] };

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await UsageEvent.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await UsageEvent.deleteMany({});
});

async function insert(platform: boolean, overrides: Record<string, unknown> = {}) {
  const id = `call-${++sequence}`;
  const usageOccurredAt =
    overrides.usageOccurredAt instanceof Date ? overrides.usageOccurredAt : new Date('2026-01-31T23:59:59Z');
  const costUsd = typeof overrides.costUsd === 'number' ? overrides.costUsd : platform ? 2 : 3;
  const document = {
    requestId: platform ? 'execution' : id,
    ...(platform
      ? {
          providerCallId: id,
          attribution: {
            kind: 'platform_operation',
            operation: 'sre_diagnosis',
            logicalJobId: 'job',
            executionId: 'execution',
            environment: 'test',
          },
          usageOccurredAt,
          dispatchedAt: usageOccurredAt,
          completedAt: new Date(usageOccurredAt.getTime() + 100),
          recordedAt: new Date(Math.max(new Date('2026-02-05T00:00:00Z').getTime(), usageOccurredAt.getTime() + 1000)),
          timestampSource: 'dispatch',
          settledBasis: 'provider',
          priceSource: 'literal',
          keySource: 'platform',
          rates: { tierKey: 0, input: costUsd / 2, output: 0 },
        }
      : { userId: 'user', ownerId: 'user', ownerType: CreditHolderType.User }),
    provider: 'openai',
    model: 'model',
    feature: 'operations',
    source: 'system',
    inputTokens: platform ? 0 : 2,
    outputTokens: platform ? 0 : 1,
    ...(platform ? { providerInputTokens: 2, providerOutputTokens: 1 } : {}),
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    costUsd,
    creditsCharged: 0,
    status: platform ? 'error' : 'ok',
    createdAt: new Date(platform ? '2026-02-05T00:00:00Z' : '2026-01-31T12:00:00Z'),
    updatedAt: new Date('2026-02-05T00:00:00Z'),
    ...overrides,
  };
  return UsageEvent.collection.insertOne(platform ? PlatformUsageEvent.parse(document) : document);
}

describe('platform accounting reporting', () => {
  it('uses occurrence time for platform rows and insertion time for legacy rows in adjacent windows', async () => {
    await insert(true);
    await insert(false, { usageOccurredAt: new Date('2026-02-01T00:00:00Z') });
    await insert(true, { usageOccurredAt: to, costUsd: 7 });
    const january = await usageEventRepository.spendTimeline({
      from,
      to,
      bucket: 'day',
      splitBy: 'segment',
      segmentIds,
    });
    expect(january).toEqual([
      { bucket: '2026-01-31', key: 'customer', costUsd: 3, requests: 1 },
      { bucket: '2026-01-31', key: 'platform', costUsd: 2, requests: 1 },
    ]);
    const february = await usageEventRepository.spendTimeline({
      from: to,
      to: new Date('2026-02-02T00:00:00Z'),
      bucket: 'day',
      splitBy: 'provider',
      segmentIds,
    });
    expect(february).toEqual([{ bucket: '2026-02-01', key: 'openai', costUsd: 7, requests: 1 }]);
    const modelDays = await usageEventRepository.marginByModelDay(from);
    expect(modelDays.find(row => row.day === '2026-01-31')).toMatchObject({ cogsUsd: 5, requests: 2 });
    const months = await usageEventRepository.monthlyCogsByProvider(1200);
    expect(months.find(row => row.month === '2026-01')).toMatchObject({
      cogsUsd: 5,
      requests: 2,
      inputTokens: 4,
      outputTokens: 2,
    });
    expect(months.find(row => row.month === '2026-02')).toMatchObject({ cogsUsd: 7, requests: 1 });
  });

  it('separates platform funding and preserves total known cost without a null actor', async () => {
    await insert(true);
    await insert(false);
    const funding = await usageEventRepository.spendTimeline({
      from,
      to,
      bucket: 'day',
      splitBy: 'funding',
      segmentIds,
    });
    expect(funding.find(row => row.key === 'platform')).toMatchObject({ costUsd: 2, requests: 1 });
    expect(funding.find(row => row.key === 'unknown')).toMatchObject({ costUsd: 3 });
    expect(funding.reduce((sum, row) => sum + row.costUsd, 0)).toBe(5);
    expect(funding.reduce((sum, row) => sum + row.requests, 0)).toBe(2);
    const breakdown = await usageEventRepository.spendBreakdown({ from, to, limit: 10, segmentIds });
    expect(breakdown.totalCostUsd).toBe(5);
    expect(breakdown.bySegment).toEqual([
      { segment: 'customer', costUsd: 3 },
      { segment: 'platform', costUsd: 2 },
    ]);
    expect(breakdown.topActors).toEqual([
      { userId: 'user', costUsd: 3, requests: 1, payers: [{ ownerId: 'user', ownerType: 'User', costUsd: 3 }] },
    ]);
    const cohorts = await usageEventRepository.costByFundingCohort(1000);
    expect(cohorts).toEqual([
      expect.objectContaining({ cohortWeek: null, accounts: 1, unattributedCostUsd: 3, platformCostUsd: 2 }),
    ]);
  });

  it('includes measured platform failures in feature totals and spikes while preserving legacy error exclusion', async () => {
    await insert(true);
    await insert(false);
    await insert(false, { status: 'error', costUsd: 9 });
    await insert(true, { usageOccurredAt: new Date('2026-01-30T12:00:00Z'), costUsd: 4 });
    const params = { from, to, spikeEnd: to };
    const features = await usageEventRepository.spendFeatures(params);
    expect(features).toEqual([
      expect.objectContaining({
        feature: 'operations',
        requests: 3,
        failedRequests: 2,
        distinctUsers: 1,
        costUsd: 5,
        lastDayUsd: 5,
        trailingUsd: 4,
        daily: [{ day: '2026-01-31', costUsd: 5 }],
      }),
    ]);
    expect(await usageEventRepository.spendActorIds(params)).toEqual(['user']);
    const users = await usageEventRepository.spendFeatureUsers({
      ...params,
      feature: 'operations',
      offset: 0,
      limit: 10,
    });
    expect(users.totalUsers).toBe(1);
    expect(users.users).toEqual([expect.objectContaining({ userId: 'user', costUsd: 3 })]);
    const external = await usageEventRepository.spendFeatures({
      ...params,
      userFilter: { mode: 'exclude', userIds: [] },
    });
    expect(external).toEqual([expect.objectContaining({ distinctUsers: 1, costUsd: 3 })]);
  });

  it('keeps platform-only cost visible without inventing account or member counts', async () => {
    await insert(true, { settledBasis: 'provider' });
    expect(await usageEventRepository.settlementBreakdown(1000)).toEqual([]);
    const summary = await usageEventRepository.spendSummary({ from, to });
    expect(summary.totals).toMatchObject({ cogsUsd: 2, requests: 1, creditsCharged: 0 });
    expect(summary.activeAccounts).toBe(0);
    expect(summary.byAccount).toEqual([]);
    expect(summary.dailyCost).toEqual([{ day: '2026-01-31', cogsUsd: 2 }]);
    const features = await usageEventRepository.spendFeatures({ from, to, spikeEnd: to });
    expect(features).toEqual([expect.objectContaining({ distinctUsers: 0, costUsd: 2 })]);
    const cohorts = await usageEventRepository.costByFundingCohort(1000);
    expect(cohorts).toEqual([expect.objectContaining({ accounts: 0, platformCostUsd: 2, unattributedCostUsd: 0 })]);
    expect(await usageEventRepository.marginByUser(1000)).toEqual([]);
    expect(await usageEventRepository.userTokensSince('user', from)).toEqual({ tokens: 0 });
    expect(await usageEventRepository.systemCostUsdByUserSince('user', from)).toBe(0);
    expect((await usageEventRepository.ownerUsageSummary('user', CreditHolderType.User, 1000)).totals.cogsUsd).toBe(0);
    expect((await usageEventRepository.sessionUsageSummary('session')).totals.cogsUsd).toBe(0);
    expect((await usageEventRepository.lakeUsageSummary('lake', 1000)).totals.cogsUsd).toBe(0);
  });

  it('filters platform/global summaries and unit exports by usage time and uses the occurrence index', async () => {
    const occurred = new Date(Date.now() - 60_000);
    await insert(true, { usageOccurredAt: occurred, createdAt: new Date(0) });
    const summary = await usageEventRepository.platformUsageSummary({ days: 1 });
    expect(summary.totals).toMatchObject({ cogsUsd: 2, requests: 1 });
    const units = await usageEventRepository.providerUnitsBreakdown({
      provider: 'openai',
      from: occurred,
      to: new Date(),
    });
    expect(units).toEqual([expect.objectContaining({ units: 0, requests: 1 })]);
    const explanation = await UsageEvent.collection
      .find({ 'attribution.kind': 'platform_operation', usageOccurredAt: { $gte: occurred } })
      .hint({ usageOccurredAt: -1 })
      .explain('executionStats');
    expect(explanation.executionStats.totalDocsExamined).toBe(1);
    expect(explanation.executionStats.totalKeysExamined).toBe(1);
    const found = await UsageEvent.collection.find(usageTimeMatch(occurred, new Date())).toArray();
    expect(found).toHaveLength(1);
  });
});
