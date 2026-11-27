// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import type { Request } from 'express';
import {
  Organization,
  AdminAuditLogModel,
  AdminGateReservationModel,
  adminGateReservationRepository,
} from '@bike4mind/database';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { checkGrantSubscriptionCap, GrantSubscriptionParamsSchema } from './grantSubscription';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
const ORGANIZATION_ID = 'abcdefabcdefabcdefabcdef';
const ACTOR_ID = 'cccccccccccccccccccccccc';
const RECIPIENT_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const req = {
  user: { id: ACTOR_ID, isAdmin: true, name: 'Approver', email: 'approver@example.test' },
  headers: {},
  url: '/api/admin/subscriptions',
  logger: { error: vi.fn() },
} as unknown as Request;
const paramsFor = (organizationId: string) =>
  GrantSubscriptionParamsSchema.parse({
    subscriptionType: 'team',
    organizationId,
    userId: RECIPIENT_ID,
    seats: 1,
    durationMonths: 1,
    reason: 'Approved team subscription grant',
    confirmLargeGrant: true,
  });
let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await createMongoServer();
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await Promise.all([
    Organization.collection.deleteMany({}),
    AdminAuditLogModel.collection.deleteMany({}),
    AdminGateReservationModel.deleteMany({}),
  ]);
  await Organization.collection.insertOne({
    _id: new mongoose.Types.ObjectId(ORGANIZATION_ID),
    name: 'Test organization',
    userId: RECIPIENT_ID,
    users: [],
  });
});

describe('team grant cap canonical organization identity', () => {
  it('counts canonical grant history for both valid ObjectId spellings in a read-only check', async () => {
    await AdminAuditLogModel.collection.insertOne({
      action: 'user.subscription.granted',
      organizationId: ORGANIZATION_ID,
      occurredAt: new Date(),
      details: { credits: 200_000 },
    });
    for (const organizationId of [ORGANIZATION_ID, ORGANIZATION_ID.toUpperCase()]) {
      const result = await checkGrantSubscriptionCap(
        req,
        paramsFor(organizationId),
        100_000,
        { id: RECIPIENT_ID },
        { targetIds: [RECIPIENT_ID], reserve: false, approvalAvailable: true }
      );
      expect(result, organizationId).toEqual({ outcome: 'approval' });
    }
    expect(await AdminGateReservationModel.countDocuments()).toBe(0);
  });

  it('counts canonical outstanding reservations when the incoming ID is uppercase', async () => {
    const hold = await adminGateReservationRepository.reserve(
      ORGANIZATION_ID,
      'organizationCredits',
      60_000,
      new Date(Date.now() + 86_400_000)
    );
    try {
      const result = await checkGrantSubscriptionCap(
        req,
        paramsFor(ORGANIZATION_ID.toUpperCase()),
        60_000,
        { id: RECIPIENT_ID },
        { targetIds: [RECIPIENT_ID], approvalAvailable: true }
      );
      expect(result).toEqual({ outcome: 'approval' });
      expect(await AdminGateReservationModel.countDocuments()).toBe(1);
    } finally {
      await adminGateReservationRepository.release(hold);
    }
  });

  it('does not reserve against an organization that does not exist', async () => {
    await expect(
      checkGrantSubscriptionCap(
        req,
        paramsFor('ffffffffffffffffffffffff'),
        10_000,
        { id: RECIPIENT_ID },
        { targetIds: [RECIPIENT_ID], approvalAvailable: true }
      )
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(await AdminGateReservationModel.countDocuments()).toBe(0);
  });
});
