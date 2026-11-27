import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { mongoose, Organization, PaymentAttemptModel, User } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../database/src/__test__/createMongoServer';
import { defaultAccountContextDeps, resolveAccountContexts } from './accountContext';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const NOW = new Date('2026-11-07T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);
const OWNER_ID = new mongoose.Types.ObjectId();
const CREATOR_ID = new mongoose.Types.ObjectId();
const ORGANIZATION_ID = new mongoose.Types.ObjectId();

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  // Retention is exercised through the query window; a TTL sweep must not delete a boundary fixture.
  await mongoose.connect(mongoServer.getUri(), { autoIndex: false });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

afterEach(async () => {
  await Promise.all([
    User.collection.deleteMany({}),
    Organization.collection.deleteMany({}),
    PaymentAttemptModel.collection.deleteMany({}),
  ]);
});

describe('account context database adapters', () => {
  it('preserves all projected risk facts and uses the organization billing owner rather than another member', async () => {
    await User.collection.insertMany([
      {
        _id: OWNER_ID,
        createdAt: ago(60),
        emailVerified: true,
        riskScore: { score: 90, reviewState: 'pending', computedAt: ago(1), signals: [] },
        riskReviewReopenedAt: ago(2),
        paymentRiskEventAt: ago(3),
        lastCreditsPurchasedAt: ago(20),
        riskEvidence: { summary: { computedAt: ago(0.25) } },
        password: 'fixture-only-secret',
      },
      {
        _id: CREATOR_ID,
        createdAt: ago(365),
        emailVerified: false,
        riskScore: { score: 0, reviewState: 'approved', computedAt: ago(1), signals: [] },
      },
    ]);
    await Organization.collection.insertOne({
      _id: ORGANIZATION_ID,
      userId: String(OWNER_ID),
      createdAt: ago(10),
      lastCreditsPurchasedAt: ago(5),
      adminUserIds: [String(CREATOR_ID)],
      users: [{ userId: String(CREATOR_ID), permissions: ['read', 'write'] }],
    });
    await PaymentAttemptModel.collection.insertMany([
      {
        paymentIntentId: 'pi_owner_fixture',
        userId: String(OWNER_ID),
        createdAt: ago(4),
        outcome: 'succeeded',
        radarBlocked: false,
        riskLevel: 'normal',
      },
      {
        paymentIntentId: 'pi_creator_fixture',
        userId: String(CREATOR_ID),
        createdAt: ago(1),
        outcome: 'failed',
        radarBlocked: true,
        riskLevel: 'highest',
      },
    ]);

    const deps = defaultAccountContextDeps();
    const contexts = await resolveAccountContexts(
      [
        { ownerType: 'Organization', ownerId: String(ORGANIZATION_ID) },
        { ownerType: 'User', ownerId: String(OWNER_ID) },
      ],
      NOW,
      deps
    );

    const organization = contexts.get(`Organization:${String(ORGANIZATION_ID)}`);
    expect(organization).toEqual({
      accountAgeDays: 10,
      responsibleAccountAgeDays: 60,
      emailVerified: true,
      reviewState: 'pending',
      riskScore: 90,
      reviewReopened: true,
      banned: false,
      paymentRiskEvent: true,
      hasCreditPurchase: true,
      lastCreditPurchaseAgeDays: 5,
      payments: {
        status: 'observed',
        succeeded: 1,
        failed: 0,
        radarBlocked: 0,
        elevatedRisk: 0,
        latestSucceededAgeDays: 4,
      },
      evidence: { status: 'observed', ageHours: 6 },
    });
    expect(contexts.get(`User:${String(OWNER_ID)}`)).toMatchObject({
      accountAgeDays: 60,
      responsibleAccountAgeDays: 60,
      lastCreditPurchaseAgeDays: 20,
      reviewState: 'pending',
      riskScore: 90,
      reviewReopened: true,
      banned: false,
      paymentRiskEvent: true,
    });
    const [projectedOwner] = await deps.findUsers([String(OWNER_ID)]);
    expect(projectedOwner).not.toHaveProperty('password');
  });

  it('projects the ban flag so a banned account context reports banned', async () => {
    await User.collection.insertMany([
      { _id: OWNER_ID, createdAt: ago(60), emailVerified: true, isBanned: true },
      { _id: CREATOR_ID, createdAt: ago(60), emailVerified: true },
    ]);

    const contexts = await resolveAccountContexts(
      [
        { ownerType: 'User', ownerId: String(OWNER_ID) },
        { ownerType: 'User', ownerId: String(CREATOR_ID) },
      ],
      NOW,
      defaultAccountContextDeps()
    );

    expect(contexts.get(`User:${String(OWNER_ID)}`)).toMatchObject({ banned: true });
    expect(contexts.get(`User:${String(CREATOR_ID)}`)).toMatchObject({ banned: false });
  });

  it('aggregates only the requested users and retained time window, including both boundary dates', async () => {
    const since = ago(90);
    const payment = (
      paymentIntentId: string,
      createdAt: Date,
      outcome: 'started' | 'succeeded' | 'failed',
      riskLevel: string | null = 'normal',
      radarBlocked = false,
      userId = String(OWNER_ID)
    ) => ({ paymentIntentId, userId, createdAt, outcome, riskLevel, radarBlocked });
    await PaymentAttemptModel.collection.insertMany([
      payment('pi_at_start', since, 'succeeded'),
      payment('pi_at_end', NOW, 'succeeded'),
      payment('pi_elevated', ago(1), 'failed', 'elevated', true),
      payment('pi_highest', ago(2), 'failed', 'highest'),
      payment('pi_started', ago(3), 'started', null),
      payment('pi_too_old', new Date(since.getTime() - 1), 'succeeded', 'highest', true),
      payment('pi_future', new Date(NOW.getTime() + 1), 'succeeded', 'highest', true),
      payment('cs_test_visit_only', ago(1), 'failed', 'highest', true),
      payment('pi_other', ago(1), 'failed', 'highest', true, String(CREATOR_ID)),
    ]);

    const history = await defaultAccountContextDeps().findPaymentHistory([String(OWNER_ID)], since, NOW);
    expect(history).toEqual([
      {
        userId: String(OWNER_ID),
        succeeded: 2,
        failed: 2,
        radarBlocked: 1,
        elevatedRisk: 2,
        latestSucceededAt: NOW,
      },
    ]);
    await expect(
      defaultAccountContextDeps().findPaymentHistory([String(ORGANIZATION_ID)], since, NOW)
    ).resolves.toEqual([]);
  });
});
