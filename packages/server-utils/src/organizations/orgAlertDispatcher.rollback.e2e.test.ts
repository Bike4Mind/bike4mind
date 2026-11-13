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

// Seat and cap refusals raise their event inside a transaction that then aborts; only a replica set
// can tell a claim that escaped the rollback from one that was undone with it.

const orgId = new mongoose.Types.ObjectId();
const ownerId = new mongoose.Types.ObjectId();
let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  process.env.APP_URL = 'https://app.example.com';
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri());
  await settleAutoIndexBuilds(mongoose);
  await User.collection.insertOne({ _id: ownerId, email: 'owner@example.com' });
  await Organization.collection.insertOne({
    _id: orgId,
    name: 'Acme',
    personal: false,
    userId: ownerId.toHexString(),
    adminUserIds: [],
    users: [],
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
});
