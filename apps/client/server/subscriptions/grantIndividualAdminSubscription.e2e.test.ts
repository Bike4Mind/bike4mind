import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { User } from '@bike4mind/database';
import { SUBSCRIPTION_PLANS } from '@client/lib/userSubscriptions/constants';
import { Subscription } from '@bike4mind/server-utils/models/Subscription';
import { grantIndividualAdminSubscription } from './grantIndividualAdminSubscription';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// The deterministic subscriptionId is the idempotency key: the unique index on the row insert
// must stop a repeat or concurrent grant before any credits are added.

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

// dropDatabase removes the unique subscriptionId index along with the data.
beforeEach(async () => {
  await Subscription.createIndexes();
});

afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

const plan = SUBSCRIPTION_PLANS[0];
const durationMonths = 2;
const startingCredits = 100;
const subscriptionId = 'partner_grant_rule-1_user-1';

const seedUser = async () =>
  User.create({
    name: 'Partner User',
    username: `partner-${Math.random().toString(36).slice(2, 10)}`,
    password: null,
    hasUsablePassword: false,
    currentCredits: startingCredits,
  });

const grant = (userId: string) =>
  grantIndividualAdminSubscription({
    userId,
    priceId: plan.priceId,
    durationMonths,
    grantedBy: 'partner-rule:rule-1',
    subscriptionId,
  });

const balanceOf = async (userId: string) => (await User.findById(userId).lean())?.currentCredits;
const rowCount = () => Subscription.countDocuments({ subscriptionId });

describe('grantIndividualAdminSubscription with a deterministic subscriptionId on a real replica set', () => {
  it('grants once and reports already_active on a repeat', async () => {
    const user = await seedUser();

    expect((await grant(user.id)).status).toBe('granted');
    expect(await grant(user.id)).toEqual({ status: 'already_active' });

    expect(await rowCount()).toBe(1);
    expect(await balanceOf(user.id)).toBe(startingCredits + plan.credits * durationMonths);
  });

  it('does not grant again after the first grant expires', async () => {
    const user = await seedUser();
    expect((await grant(user.id)).status).toBe('granted');

    // With the row no longer active the already-active pre-check passes, so only the unique index stops it.
    await Subscription.updateMany({ subscriptionId }, { $set: { status: 'canceled' } });

    expect(await grant(user.id)).toEqual({ status: 'already_granted' });
    expect(await rowCount()).toBe(1);
    expect(await balanceOf(user.id)).toBe(startingCredits + plan.credits * durationMonths);
  });

  it('grants once when two calls race on the same subscriptionId', async () => {
    const user = await seedUser();

    const results = await Promise.all([grant(user.id), grant(user.id)]);

    const statuses = results.map(result => result.status);
    expect(statuses.filter(status => status === 'granted')).toHaveLength(1);
    expect(statuses.filter(status => status === 'already_active' || status === 'already_granted')).toHaveLength(1);
    expect(await rowCount()).toBe(1);
    expect(await balanceOf(user.id)).toBe(startingCredits + plan.credits * durationMonths);
  });
});
