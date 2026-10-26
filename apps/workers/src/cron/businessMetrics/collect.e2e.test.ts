import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose, { Types } from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { ApiKeyUsageLog, Quest, UsageEvent, User, UserApiKey } from '@bike4mind/database';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { comparisonWindow } from '@bike4mind/server-utils/analytics/businessMetricAnomalies';

const payments = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  getStripe: () => ({
    events: {
      list: async function* () {
        yield* payments;
      },
    },
  }),
}));
import { collectBusinessMetrics } from './collect';
import { deliverAnomalies, deliveryStore, subscriberMetric } from './deliver';
import { BusinessMetricState } from '@bike4mind/database';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: MongoMemoryServer;
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri(), { autoIndex: false, autoCreate: false });
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
afterEach(async () => {
  await mongoose.connection.db?.dropDatabase();
  payments.length = 0;
  vi.unstubAllEnvs();
});

describe('business metric persisted behavior', () => {
  it('excludes synthetic, internal-key and system traffic while comparing equal intraday periods', async () => {
    const user = new Types.ObjectId();
    const synthetic = new Types.ObjectId();
    const normalKey = new Types.ObjectId();
    const productKey = new Types.ObjectId();
    const at = new Date('2026-10-26T11:00:00Z');
    await User.collection.insertMany([
      { _id: user, email: 'real@example.org', emailVerified: true, emailVerifiedAt: at, createdAt: at },
      { _id: synthetic, email: 'synthetic@example.org', isSynthetic: true, emailVerified: true, createdAt: at },
      {
        _id: new Types.ObjectId(),
        email: 'changed-email@example.org',
        emailVerified: true,
        emailVerifiedAt: at,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    await UserApiKey.collection.insertMany([
      { _id: normalKey },
      { _id: productKey, productId: 'internal-ingestion', deletedAt: at },
    ]);
    const base = {
      userId: String(user),
      ownerId: String(user),
      ownerType: 'User',
      provider: 'example',
      model: 'model',
      feature: 'completion_api',
      status: 'ok',
      source: 'api',
      apiKeyId: String(normalKey),
      createdAt: at,
      costUsd: 5,
      creditsCharged: 100,
    };
    await UsageEvent.collection.insertMany([
      base,
      { ...base, source: 'cli' },
      { ...base, userId: String(synthetic), ownerId: String(synthetic) },
      { ...base, apiKeyId: String(productKey) },
      { ...base, source: 'system' },
      { ...base, createdAt: new Date('2026-10-25T15:00:00Z') },
      { ...base, createdAt: new Date('2026-10-25T11:00:00Z'), costUsd: 3 },
    ]);
    await ApiKeyUsageLog.collection.insertMany([
      { userId: String(user), keyId: String(normalKey), source: 'api', timestamp: at },
      { userId: String(user), keyId: String(normalKey), source: 'desktop', timestamp: at },
      { userId: String(user), keyId: String(productKey), source: 'api', timestamp: at },
    ]);
    const result = await collectBusinessMetrics(comparisonWindow(new Date('2026-10-26T12:05:00Z')));
    const values = (name: string) => result.metrics.find(metric => metric.name === name)?.values.slice(0, 2);
    expect(values('spendUsd')).toEqual([10, 3]);
    expect(values('requests:user')).toEqual([1, 0]);
    expect(values('requests:firstParty')).toEqual([1, 0]);
    expect(values('completions:user')).toEqual([1, 1]);
    expect(values('completions:firstParty')).toEqual([1, 0]);
    expect(values('verifiedSignups')).toEqual([1, 0]);
    expect(values('activeUsers')).toEqual([1, 0]);
  });

  it('includes real email aliases by default and honors explicitly configured test patterns', async () => {
    const at = new Date('2026-10-26T11:00:00Z');
    const accounts = [
      { _id: new Types.ObjectId(), email: 'customer+test@example.org', isSynthetic: false },
      { _id: new Types.ObjectId(), email: 'customer+testing@example.org', isSynthetic: false },
      { _id: new Types.ObjectId(), email: 'synthetic@example.org', isSynthetic: true },
    ];
    await User.collection.insertMany(accounts.map(account => ({ ...account, emailVerified: true, createdAt: at })));
    await UsageEvent.collection.insertMany(
      accounts.map(account => ({
        userId: String(account._id),
        ownerId: String(account._id),
        ownerType: 'User',
        provider: 'example',
        model: 'model',
        feature: 'chat',
        source: 'web',
        status: 'ok',
        createdAt: at,
        costUsd: 5,
        creditsCharged: 100,
      }))
    );
    const window = comparisonWindow(new Date('2026-10-26T12:05:00Z'));
    const current = (metrics: Awaited<ReturnType<typeof collectBusinessMetrics>>['metrics'], name: string) =>
      metrics.find(metric => metric.name === name)?.values[0];
    const defaults = await collectBusinessMetrics(window);
    expect(current(defaults.metrics, 'verifiedSignups')).toBe(2);
    expect(current(defaults.metrics, 'activeUsers')).toBe(2);
    expect(current(defaults.metrics, 'spendUsd')).toBe(10);
    expect(current(defaults.metrics, 'credits')).toBe(200);
    vi.stubEnv('ANALYTICS_TEST_PATTERN', String.raw`\+test`);
    const configured = await collectBusinessMetrics(window);
    expect(current(configured.metrics, 'verifiedSignups')).toBe(0);
    expect(current(configured.metrics, 'spendUsd')).toBe(0);
  });

  it('allows one concurrent Slack sender and retries after rejected delivery', async () => {
    const window = comparisonWindow(new Date('2026-10-26T13:05:00Z'));
    await BusinessMetricState.create({ _id: 'unused', expiresAt: new Date(Date.now() + 86_400_000) });
    const post = vi.fn(async () => true);
    await Promise.allSettled(
      Array.from({ length: 5 }, () => deliverAnomalies(window, ['same metric\n120 vs 100'], post))
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(await deliverAnomalies(window, ['same metric\n120 vs 100'], post)).toBe(0);
    expect(post).toHaveBeenCalledTimes(1);
    await expect(deliverAnomalies(window, ['failed metric\n120 vs 100'], async () => false)).rejects.toThrow();
    expect(await deliverAnomalies(window, ['failed metric\n120 vs 100'], post)).toBe(1);
    await deliveryStore.claim('pending-delivery', 'crashed-worker', new Date());
    await expect(deliveryStore.claim('pending-delivery', 'retry-worker', new Date())).rejects.toThrow('leased');
    await deliveryStore.release('pending-delivery', 'crashed-worker');
    expect(await deliveryStore.claim('pending-delivery', 'retry-worker', new Date())).toBe(true);
  });

  it("counts a new app message when its execution started outside yesterday's elapsed slice", async () => {
    const user = new Types.ObjectId();
    const execution = new Types.ObjectId();
    const at = new Date('2026-10-26T11:00:00Z');
    await User.collection.insertOne({ _id: user, email: 'long-run@example.org', createdAt: at });
    await mongoose
      .model('AgentExecution')
      .collection.insertOne({ _id: execution, userId: String(user), createdAt: new Date('2026-10-25T15:00:00Z') });
    await Quest.collection.insertOne({
      _id: Types.ObjectId.createFromTime(at.getTime() / 1000),
      type: 'message',
      timestamp: at,
      agentExecutionId: String(execution),
      promptMeta: { session: { userId: String(user) } },
      deletedAt: null,
    });
    const result = await collectBusinessMetrics(comparisonWindow(new Date('2026-10-26T12:05:00Z')));
    expect(result.metrics.find(metric => metric.name === 'activeUsers')?.values[0]).toBe(1);
  });

  it('counts eligible Stripe charges once and never combines currencies or foreign customers', async () => {
    const user = new Types.ObjectId();
    const at = new Date('2026-10-26T11:00:00Z');
    await User.collection.insertOne({
      _id: user,
      email: 'payer@example.org',
      createdAt: at,
      stripeCustomerId: 'cus_eligible',
    });
    const charge = { id: 'charge-one', paid: true, customer: 'cus_eligible', amount: 2000, currency: 'usd' };
    const event = { type: 'charge.succeeded', created: at.getTime() / 1000, data: { object: charge } };
    payments.push(
      event,
      event,
      { ...event, data: { object: { ...charge, id: 'charge-two', amount: 100, currency: 'jpy' } } },
      { ...event, data: { object: { ...charge, id: 'charge-foreign', customer: 'cus_foreign' } } }
    );
    const result = await collectBusinessMetrics(comparisonWindow(new Date('2026-10-26T12:05:00Z')));
    expect(result.metrics.find(metric => metric.name === 'revenueMinor:usd')?.values[0]).toBe(2000);
    expect(result.metrics.find(metric => metric.name === 'revenueMinor:jpy')?.values[0]).toBe(100);
    payments.length = 0;
  });

  it('keeps missing subscriber history unknown and preserves the first sample on retry', async () => {
    const window = comparisonWindow(new Date());
    const first = await subscriberMetric(window, 20);
    const retry = await subscriberMetric(window, 99);
    expect(first.values.slice(0, 2)).toEqual([20, null]);
    expect(retry.values[0]).toBe(20);
  });
});
