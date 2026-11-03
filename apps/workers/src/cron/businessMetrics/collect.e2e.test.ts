import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose, { Types } from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { Agent, ApiKeyUsageLog, Organization, Quest, Session, UsageEvent, User, UserApiKey } from '@bike4mind/database';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { comparisonWindow, DAY_MS } from '@bike4mind/server-utils/analytics/businessMetricAnomalies';

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
import { Subscription } from '@bike4mind/server-utils/models/Subscription';
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
  vi.restoreAllMocks();
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

  it('resolves agent credit pools to eligible owners while preserving actor exclusions', async () => {
    const at = new Date('2026-10-26T11:00:00Z');
    const actor = new Types.ObjectId();
    const externalOwner = new Types.ObjectId();
    const excludedOwner = new Types.ObjectId();
    await User.collection.insertMany([
      { _id: actor, email: 'actor@example.org', createdAt: at },
      { _id: externalOwner, email: 'owner@example.org', createdAt: at },
      { _id: excludedOwner, email: 'synthetic@example.org', isSynthetic: true, createdAt: at },
    ]);
    const organization = new Types.ObjectId();
    const excludedOrganization = new Types.ObjectId();
    await Organization.collection.insertMany([
      { _id: organization, userId: String(externalOwner) },
      { _id: excludedOrganization, userId: String(excludedOwner) },
    ]);
    const userAgent = new Types.ObjectId();
    const organizationAgent = new Types.ObjectId();
    const excludedAgent = new Types.ObjectId();
    const excludedOrganizationAgent = new Types.ObjectId();
    const systemAgent = new Types.ObjectId();
    const orphanAgent = new Types.ObjectId();
    await Agent.collection.insertMany([
      { _id: userAgent, userId: String(externalOwner) },
      { _id: organizationAgent, organizationId: String(organization) },
      { _id: excludedAgent, userId: String(excludedOwner) },
      { _id: excludedOrganizationAgent, organizationId: String(excludedOrganization) },
      { _id: systemAgent, isSystem: true },
      { _id: orphanAgent, userId: String(new Types.ObjectId()) },
    ]);
    const base = {
      userId: String(actor),
      ownerType: 'Agent',
      provider: 'example',
      model: 'model',
      feature: 'completion_api',
      source: 'api',
      apiKeyId: String(new Types.ObjectId()),
      status: 'ok',
      createdAt: at,
      costUsd: 5,
      creditsCharged: 100,
    };
    await UsageEvent.collection.insertMany([
      ...[
        userAgent,
        organizationAgent,
        excludedAgent,
        excludedOrganizationAgent,
        systemAgent,
        orphanAgent,
        new Types.ObjectId(),
      ].map(ownerId => ({ ...base, ownerId: String(ownerId) })),
      { ...base, ownerId: String(userAgent), userId: String(excludedOwner) },
      { ...base, ownerId: String(externalOwner), ownerType: 'User' },
      { ...base, ownerId: String(organization), ownerType: 'Organization' },
      { ...base, ownerId: String(excludedOwner), ownerType: 'User' },
      { ...base, ownerId: String(excludedOrganization), ownerType: 'Organization' },
    ]);
    const { metrics } = await collectBusinessMetrics(comparisonWindow(new Date('2026-10-26T12:05:00Z')));
    expect(metrics.find(metric => metric.name === 'spendUsd')).toMatchObject({
      values: [20, 0, 0, 0, 0, 0, 0, 0],
      contributors: expect.arrayContaining([
        { label: `user:${String(actor)}`, value: 20 },
        { label: `org:${String(organization)}`, value: 10 },
      ]),
    });
    expect(metrics.find(metric => metric.name === 'credits')?.values[0]).toBe(400);
    expect(metrics.find(metric => metric.name === 'completions:user')?.values[0]).toBe(4);
  });

  it('counts a signup only once its cohort has had equal time to verify', async () => {
    const window = comparisonWindow(new Date('2026-10-26T12:05:00Z'));
    const cutoff = window.end.getTime() - DAY_MS;
    const createdAt = new Date(cutoff - 60 * 60 * 1000);
    await User.collection.insertMany([
      {
        _id: new Types.ObjectId(),
        email: 'early@example.org',
        emailVerified: true,
        createdAt,
        emailVerifiedAt: new Date(cutoff - 1000),
      },
      {
        _id: new Types.ObjectId(),
        email: 'late@example.org',
        emailVerified: true,
        createdAt,
        emailVerifiedAt: new Date(cutoff + 1000),
      },
    ]);
    const { metrics } = await collectBusinessMetrics(window);
    expect(metrics.find(metric => metric.name === 'verifiedSignups')?.values[1]).toBe(1);
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
    const sameMetric = {
      metricName: 'same metric',
      direction: 'increase' as const,
      message: 'same metric\n120 vs 100',
    };
    const failedMetric = {
      metricName: 'failed metric',
      direction: 'increase' as const,
      message: 'failed metric\n120 vs 100',
    };
    await Promise.all(Array.from({ length: 5 }, () => deliverAnomalies(window, [sameMetric], post)));
    expect(post).toHaveBeenCalledTimes(1);
    expect(await deliverAnomalies(window, [sameMetric], post)).toBe(0);
    expect(post).toHaveBeenCalledTimes(1);
    await expect(deliverAnomalies(window, [failedMetric], async () => false)).rejects.toThrow();
    expect(await deliverAnomalies(window, [failedMetric], post)).toBe(1);
    expect(await deliverAnomalies(comparisonWindow(new Date('2026-10-26T14:05:00Z')), [sameMetric], post)).toBe(0);
    expect(await deliverAnomalies(comparisonWindow(new Date('2026-10-27T00:05:00Z')), [sameMetric], post)).toBe(1);
    expect(await deliverAnomalies(window, [{ ...sameMetric, direction: 'decrease' }], post)).toBe(1);
    expect(await deliverAnomalies(comparisonWindow(new Date('2026-10-27T13:05:00Z')), [sameMetric], post)).toBe(1);
    await deliveryStore.claim('pending-delivery', 'crashed-worker', new Date());
    expect(await deliveryStore.claim('pending-delivery', 'retry-worker', new Date())).toBe(false);
    await deliveryStore.release('pending-delivery', 'crashed-worker');
    expect(await deliveryStore.claim('pending-delivery', 'retry-worker', new Date())).toBe(true);
  });

  it('reclaims an expired lease and skips a live one', async () => {
    const now = new Date();
    await deliveryStore.claim('lease-check', 'first', now);
    expect(await deliveryStore.claim('lease-check', 'second', new Date(now.getTime() + 14 * 60_000))).toBe(false);
    expect(await deliveryStore.claim('lease-check', 'second', new Date(now.getTime() + 16 * 60_000))).toBe(true);
    const state = await BusinessMetricState.findById('lease-check').lean();
    expect(state?.leaseToken).toBe('second');
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

  it('hydrates old accounts and window-referenced sessions in bounded batches', async () => {
    const at = new Date('2026-10-26T11:00:00Z');
    const old = new Date('2025-01-01T00:00:00Z');
    const accounts = Array.from({ length: 501 }, (_, index) => ({
      _id: new Types.ObjectId(),
      email: `customer-${index}@example.org`,
      createdAt: old,
    }));
    const sessions = accounts.map((account, index) => ({
      _id: new Types.ObjectId(),
      userId: String(account._id),
      createdAt: old,
      ...(index < 2 ? { origin: { channel: 'api', apiKeyId: index === 0 ? 'public-key' : 'internal-key' } } : {}),
    }));
    await User.collection.insertMany(accounts);
    await UserApiKey.collection.insertOne({
      _id: new Types.ObjectId('123456789012345678901234'),
      productId: 'internal',
    });
    sessions[1].origin = { channel: 'api', apiKeyId: '123456789012345678901234' };
    await Session.collection.insertMany(sessions);
    await Quest.collection.insertMany(
      accounts.map((account, index) => ({
        _id: new Types.ObjectId(Math.floor(at.getTime() / 1000).toString(16) + index.toString(16).padStart(16, '0')),
        type: 'message',
        timestamp: at,
        sessionId: String(sessions[index]._id),
        promptMeta: { session: { userId: String(account._id) } },
        deletedAt: null,
      }))
    );
    await UsageEvent.collection.insertMany(
      accounts.map(account => ({
        userId: String(account._id),
        ownerId: String(account._id),
        ownerType: 'User',
        provider: 'example',
        model: 'model',
        feature: 'chat',
        source: 'web',
        createdAt: at,
        costUsd: 1,
        creditsCharged: 1,
        // A failed paid attempt contributes cost, while the Quest independently supplies activity.
        status: 'error',
      }))
    );
    const userFind = vi.spyOn(User, 'find');
    const organizationFind = vi.spyOn(Organization, 'find');
    const sessionFind = vi.spyOn(Session, 'find');
    const result = await collectBusinessMetrics(comparisonWindow(new Date('2026-10-26T12:05:00Z')));
    expect(result.metrics.find(metric => metric.name === 'activeUsers')?.values[0]).toBe(499);
    expect(result.metrics.find(metric => metric.name === 'spendUsd')?.values[0]).toBe(501);
    expect(result.metrics.find(metric => metric.name === 'verifiedSignups')?.values[0]).toBe(0);
    // Guard the operational requirement: these lookups must not become whole-collection scans.
    expect(userFind.mock.calls.every(([filter]) => filter && Object.keys(filter).length > 0)).toBe(true);
    expect(organizationFind.mock.calls.every(([filter]) => filter && Object.keys(filter).length > 0)).toBe(true);
    expect(sessionFind.mock.calls).toHaveLength(2);
    for (const [filter] of sessionFind.mock.calls) {
      expect(filter?._id.$in.length).toBeLessThanOrEqual(500);
      expect(filter?._id.$in.length).toBeGreaterThan(0);
    }
  });

  it('resolves old Stripe customers and subscriber owners with fresh exclusions on each run', async () => {
    const at = new Date('2026-10-26T11:00:00Z');
    const old = new Date('2025-01-01T00:00:00Z');
    const user = new Types.ObjectId();
    const excluded = new Types.ObjectId();
    const organization = new Types.ObjectId();
    const excludedOrganization = new Types.ObjectId();
    await User.collection.insertMany([
      { _id: user, email: 'old-payer@example.org', stripeCustomerId: 'cus_old_user', createdAt: old },
      { _id: excluded, email: 'synthetic-owner@example.org', isSynthetic: true, createdAt: old },
    ]);
    await Organization.collection.insertMany([
      { _id: organization, userId: String(user), stripeCustomerId: 'cus_old_org', createdAt: old },
      { _id: excludedOrganization, userId: String(excluded), stripeCustomerId: 'cus_excluded_org', createdAt: old },
    ]);
    payments.push(
      ...['cus_old_user', 'cus_old_org', 'cus_excluded_org', 'cus_orphan'].map(customer => ({
        type: 'charge.succeeded',
        created: at.getTime() / 1000,
        data: { object: { id: `charge-${customer}`, paid: true, customer, amount: 1000, currency: 'usd' } },
      }))
    );
    await Subscription.collection.insertMany(
      [
        { ownerType: 'User', ownerId: String(user) },
        { ownerType: 'Organization', ownerId: String(organization) },
        { ownerType: 'Organization', ownerId: String(excludedOrganization) },
        { ownerType: 'User', ownerId: String(new Types.ObjectId()) },
      ].map(owner => ({
        ...owner,
        source: 'stripe',
        status: 'active',
        periodEndsAt: new Date(Date.now() + 86_400_000),
      }))
    );
    const window = comparisonWindow(new Date('2026-10-26T12:05:00Z'));
    const first = await collectBusinessMetrics(window);
    expect(first.metrics.find(metric => metric.name === 'revenueMinor:usd')?.values[0]).toBe(2000);
    expect(first.subscribers).toBe(2);
    await User.collection.updateOne({ _id: user }, { $set: { isSynthetic: true } });
    const second = await collectBusinessMetrics(window);
    expect(second.metrics.find(metric => metric.name === 'revenueMinor:usd')).toBeUndefined();
    expect(second.subscribers).toBe(0);
  });

  it('counts only active, unexpired, non-granted subscriptions', async () => {
    const future = new Date(Date.now() + 86_400_000);
    const past = new Date(Date.now() - 86_400_000);
    const owner = async () => {
      const id = new Types.ObjectId();
      await User.collection.insertOne({ _id: id, email: `${id}@example.org`, createdAt: new Date('2025-01-01') });
      return { ownerType: 'User', ownerId: String(id) };
    };
    await Subscription.collection.insertMany([
      { ...(await owner()), source: 'stripe', status: 'active', periodEndsAt: future },
      { ...(await owner()), source: 'admin_grant', status: 'active', periodEndsAt: future },
      { ...(await owner()), source: 'stripe', status: 'trialing', periodEndsAt: future },
      { ...(await owner()), source: 'stripe', status: 'active', periodEndsAt: past },
    ]);
    const result = await collectBusinessMetrics(comparisonWindow(new Date('2026-10-26T12:05:00Z')));
    expect(result.subscribers).toBe(1);
  });

  it('does not write a subscriber sample for a window more than an hour old', async () => {
    const stale = comparisonWindow(new Date(Date.now() - 3 * 3_600_000));
    const metric = await subscriberMetric(stale, 7);
    expect(metric.values[0]).toBeNull();
    expect(await BusinessMetricState.findById(`subscribers:${stale.end.toISOString()}`).lean()).toBeNull();
  });

  it('keeps missing subscriber history unknown and preserves the first sample on retry', async () => {
    const window = comparisonWindow(new Date());
    const first = await subscriberMetric(window, 20);
    const retry = await subscriberMetric(window, 99);
    expect(first.values.slice(0, 2)).toEqual([20, null]);
    expect(retry.values[0]).toBe(20);
  });
});
