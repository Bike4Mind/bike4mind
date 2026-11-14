import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  Organization,
  OrgAlertNotificationModel,
  User,
  inboxRepository,
  mongoose,
  withTransaction,
} from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { handleOrgEvent } from './orgAlertDispatcher';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const { publish } = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock('../utils/eventBus', () => ({ EmailEvents: { Send: { publish } } }));

// Events raised inside a transaction: refusals escape its rollback, everything else waits for its
// commit. Only a replica set can tell the two apart.

const orgId = new mongoose.Types.ObjectId();
const ownerId = new mongoose.Types.ObjectId();
const memberId = new mongoose.Types.ObjectId().toHexString();
const joinerId = new mongoose.Types.ObjectId().toHexString();
const cappedOrgId = new mongoose.Types.ObjectId();
let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  process.env.APP_URL = 'https://app.example.com';
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri());
  await settleAutoIndexBuilds(mongoose);
  await User.collection.insertOne({ _id: ownerId, username: 'owner', email: 'owner@example.com' });
  await User.collection.insertMany([
    { _id: new mongoose.Types.ObjectId(memberId), username: 'member', email: 'member@example.com' },
    { _id: new mongoose.Types.ObjectId(joinerId), username: 'joiner', email: 'joiner@example.com' },
  ]);
  await Organization.collection.insertOne({
    _id: orgId,
    name: 'Acme',
    personal: false,
    userId: ownerId.toHexString(),
    adminUserIds: [],
    users: [],
  });
  await Organization.collection.insertOne({
    _id: cappedOrgId,
    name: 'Capped',
    personal: false,
    userId: ownerId.toHexString(),
    adminUserIds: [],
    users: [{ userId: memberId }],
    maxCreditsPerMember: 100,
    userDetails: [{ id: memberId, name: 'Sam', usedCredits: 0, periodStart: new Date() }],
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await replSet.stop();
});

describe('handleOrgEvent inside an aborted transaction', () => {
  it('keeps the claim and Inbox entry, so a retry does not email again', async () => {
    const event = { type: 'seat_limit' as const, organizationId: orgId.toHexString(), seats: 3 };

    await expect(
      withTransaction(async () => {
        await handleOrgEvent(event);
        throw new Error('refused');
      })
    ).rejects.toThrow('refused');
    await handleOrgEvent(event);

    expect(await OrgAlertNotificationModel.countDocuments({ kind: 'seat_limit' })).toBe(1);
    expect(await inboxRepository.findByReceiverId(ownerId.toHexString())).toHaveLength(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('sends nothing for a member_joined whose transaction rolled back', async () => {
    const event = { type: 'member_joined' as const, organizationId: orgId.toHexString(), userId: joinerId };

    await expect(
      withTransaction(async () => {
        await handleOrgEvent(event);
        throw new Error('rolled back');
      })
    ).rejects.toThrow('rolled back');
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(await OrgAlertNotificationModel.countDocuments({ kind: 'member_joined' })).toBe(0);
  });

  it('evaluates a usage event after commit and before withTransaction returns', async () => {
    const organizationId = cappedOrgId.toHexString();
    let emailed = false;
    publish.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      emailed = true;
    });

    await withTransaction(async () => {
      await Organization.updateOne({ _id: cappedOrgId }, { $set: { 'userDetails.0.usedCredits': 100 } });
      await handleOrgEvent({ type: 'member_cap_check', organizationId, userId: memberId });
    });

    // No wait: a Lambda may freeze as soon as the handler's transaction returns.
    expect(emailed).toBe(true);
    expect(await OrgAlertNotificationModel.countDocuments({ organizationId, kind: 'member_cap' })).toBe(1);
  });
});
