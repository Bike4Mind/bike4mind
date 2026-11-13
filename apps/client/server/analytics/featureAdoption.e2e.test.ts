import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { UsageEvent } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { featureAdoptionQuerySchema, featureAdoptionResponseSchema } from '@client/app/utils/featureAdoption';
import {
  ADOPTION_GROUP_LIMIT,
  adoptionPipeline,
  adoptionWindow,
  getFeatureAdoption,
  summarizeAdoption,
} from './featureAdoption';

vi.mock('@bike4mind/server-utils/analytics/signupCohort', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/server-utils/analytics/signupCohort')>();
  return {
    ...actual,
    loadCountingContext: async () => ({ staffRegex: /@staff\.example$/, testDomains: ['test.example'] }),
  };
});
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
const now = new Date('2026-06-15T12:00:00Z');
let mongo: MongoMemoryServer;
const ids = {
  external: new mongoose.Types.ObjectId(),
  internal: new mongoose.Types.ObjectId(),
  banned: new mongoose.Types.ObjectId(),
};
const query = featureAdoptionQuerySchema.parse({});
const window = adoptionWindow(query, now);
const seed = (requestId: string, at: string, extra: Record<string, unknown> = {}) =>
  UsageEvent.collection.insertOne({
    requestId,
    userId: String(ids.external),
    feature: 'chat',
    source: 'web',
    status: 'ok',
    createdAt: new Date(at),
    ...extra,
  });

beforeAll(async () => {
  mongo = await createMongoServer();
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await UsageEvent.deleteMany({});
  await mongoose.connection.collection('users').deleteMany({});
  await mongoose.connection.collection('users').insertMany([
    { _id: ids.external, email: 'person@external.example', emailVerified: true },
    { _id: ids.internal, email: 'person@staff.example', emailVerified: true },
    { _id: ids.banned, emailVerified: true, isBanned: true },
  ]);
});

describe('feature adoption ledger aggregation', () => {
  it('deduplicates retries across models and periods, excludes subevents and failed attempts, and counts each feature per person', async () => {
    await seed('previous', '2026-06-03');
    await seed('current', '2026-06-10');
    await seed('current', '2026-06-11', { model: 'different' });
    await seed('boundary', '2026-06-07');
    await seed('boundary', '2026-06-08');
    await seed('image', '2026-06-11', { feature: 'image_generation', source: undefined });
    for (const extra of [
      { status: 'error' },
      { status: 'timeout' },
      { feature: 'tool' },
      { feature: 'operations' },
      { source: 'system' },
      { run: { role: 'worker' } },
      { run: { purpose: 'title' } },
      { requestMeta: { operation: 'memento' } },
      { requestId: '' },
    ])
      await seed(String(new mongoose.Types.ObjectId()), '2026-06-11', extra);
    await seed('partial', '2026-06-15');
    const result = featureAdoptionResponseSchema.parse(await getFeatureAdoption(query, now));
    expect(result.window).toEqual({
      from: '2026-06-08',
      to: '2026-06-14',
      previousFrom: '2026-06-01',
      previousTo: '2026-06-07',
    });
    expect(result.features[0]).toMatchObject({
      successfulUsers: 1,
      previousUsers: 1,
      userChange: 0,
      successfulOperations: 1,
      repeatUsers: 1,
      repeatDenominator: 1,
    });
    expect(result.features[1]).toMatchObject({
      feature: 'image_generation',
      label: 'Image generation',
      successfulUsers: 1,
      previousUsers: null,
      userChange: null,
      repeatUsers: null,
    });
    expect(result.coverage).toBe('unknown');
    for (const feature of result.features) {
      expect(feature.users.filter(user => user.operations > 0)).toHaveLength(feature.successfulUsers);
      expect(feature.users.reduce((sum, user) => sum + user.operations, 0)).toBe(feature.successfulOperations);
    }
  });

  it('uses Analytics classification and access exclusions for External, Internal and Everyone', async () => {
    await seed('external', '2026-06-10');
    await seed('internal', '2026-06-10', { userId: String(ids.internal) });
    await seed('banned', '2026-06-10', { userId: String(ids.banned) });
    for (const [accounts, count] of [
      ['external', 1],
      ['internal', 1],
      ['all', 2],
    ] as const) {
      const result = await getFeatureAdoption({ ...query, accounts }, now);
      expect(result.features[0].successfulUsers).toBe(count);
      expect(result.features[0].users.some(user => user.userId === String(ids.banned))).toBe(false);
    }
  });

  it('preserves unknown/mixed attribution and keeps API and agent populations separate', async () => {
    await seed('api', '2026-06-10', { source: 'api' });
    await seed('agent', '2026-06-10', { source: 'agent' });
    await seed('desktop', '2026-06-10', { source: 'desktop' });
    await seed('unknown', '2026-06-10', { source: null });
    await seed('mixed', '2026-06-10', { source: 'web' });
    await seed('mixed', '2026-06-10', { source: 'api' });
    for (const [client, count] of [
      ['all', 5],
      ['api', 1],
      ['agent', 1],
      ['desktop', 1],
      ['unknown', 2],
      ['web', 0],
    ] as const) {
      expect((await getFeatureAdoption({ ...query, client }, now)).features[0].successfulOperations).toBe(count);
    }
  });

  it('shows absent history as unavailable and never manufactures maturity or eligibility', async () => {
    const result = await getFeatureAdoption(query, now);
    expect(result.features.every(feature => feature.previousUsers === null && feature.repeatDenominator === null)).toBe(
      true
    );
    expect(result.features.every(feature => feature.successfulUsers === 0)).toBe(true);
    expect(result.coverage).toBe('unknown');
    for (const end of ['2026-06-15', '2026-06-16', '2026-02-30']) {
      expect(() => adoptionWindow({ ...query, end }, now)).toThrow('complete UTC day');
    }
    expect(featureAdoptionQuerySchema.safeParse({ days: 366 }).success).toBe(false);
    expect(featureAdoptionQuerySchema.safeParse({ accounts: ['external', 'internal'] }).success).toBe(false);
  });

  it('fails explicitly rather than returning truncated cohorts and keeps query budgets', () => {
    expect(adoptionPipeline(query, window).at(-1)).toEqual({ $limit: ADOPTION_GROUP_LIMIT + 1 });
    const groups = Array.from({ length: ADOPTION_GROUP_LIMIT + 1 }, () => ({
      _id: { userId: 'u', feature: 'chat' as const, previous: false },
      operations: 1,
    }));
    expect(() => summarizeAdoption(query, window, groups, new Map(), { staffRegex: null, testDomains: [] })).toThrow(
      'Too many user groups'
    );
  });
});
