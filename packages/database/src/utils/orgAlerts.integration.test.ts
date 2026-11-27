import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { withTransaction } from '@bike4mind/db-core';
import { User } from '../models/auth/UserModel';
import { Inbox } from '../models/social/InboxModel';
import {
  OrgAdminNotificationPrefModel,
  orgAdminNotificationPrefRepository,
} from '../models/infra/admin/OrgAdminNotificationPrefModel';
import {
  OrgAlertNotificationModel,
  orgAlertNotificationRepository,
} from '../models/infra/admin/OrgAlertNotificationModel';
import { deleteOrgAlertsForUser } from './orgAlertErasure';
import { createMongoReplSet, MONGO_TEST_TIMEOUT_MS, settleAutoIndexBuilds } from '../__test__/createMongoServer';
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let replica: MongoMemoryReplSet;
const user = new mongoose.Types.ObjectId();
const other = new mongoose.Types.ObjectId();
const orgId = new mongoose.Types.ObjectId().toHexString();
const claim = (subjectUserId?: string) =>
  orgAlertNotificationRepository.claim({
    organizationId: orgId,
    kind: 'member_cap',
    scope: subjectUserId ? `user:${subjectUserId}` : 'organization',
    periodKey: '2026-11',
    subjectUserId,
  });
beforeAll(async () => {
  replica = await createMongoReplSet();
  await mongoose.connect(replica.getUri());
  await settleAutoIndexBuilds(mongoose);
});
beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  await OrgAlertNotificationModel.ensureIndexes();
  await OrgAdminNotificationPrefModel.ensureIndexes();
  await Inbox.createCollection();
  await User.collection.insertMany([{ _id: user, __v: 7 }, { _id: other }]);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await mongoose.disconnect();
  await replica.stop();
});
async function erase(id: string, fail = false) {
  await withTransaction(async session => {
    await deleteOrgAlertsForUser(id, { session });
    await User.deleteOne({ _id: id }, { session });
    if (fail) throw new Error('abort deletion');
  });
}
describe('alert ownership and subject erasure fences', () => {
  it('rolls cleanup back with deletion and preserves foreign, organization-wide and ordinary Inbox rows', async () => {
    await orgAdminNotificationPrefRepository.upsertForUser(orgId, user.toHexString(), { low_balance: false });
    await orgAdminNotificationPrefRepository.upsertForUser(orgId, other.toHexString(), { low_balance: false });
    await claim(user.toHexString());
    await claim(other.toHexString());
    await claim();
    await Inbox.collection.insertMany([
      { receiverId: user.toHexString(), organizationAlert: true },
      { receiverId: other.toHexString(), organizationAlert: true },
      { receiverId: user.toHexString(), message: 'ordinary retained Inbox' },
      { userId: user.toHexString(), receiverId: other.toHexString(), message: 'sent message' },
    ]);
    await expect(erase(user.toHexString(), true)).rejects.toThrow('abort deletion');
    expect(await OrgAdminNotificationPrefModel.countDocuments({ userId: user.toHexString() })).toBe(1);
    expect(await OrgAlertNotificationModel.countDocuments({ subjectUserId: user.toHexString() })).toBe(1);
    expect(await Inbox.collection.countDocuments({ receiverId: user.toHexString(), organizationAlert: true })).toBe(1);
    await erase(user.toHexString());
    expect(await OrgAdminNotificationPrefModel.countDocuments({ userId: user.toHexString() })).toBe(0);
    expect(await OrgAdminNotificationPrefModel.countDocuments({ userId: other.toHexString() })).toBe(1);
    expect(await OrgAlertNotificationModel.countDocuments({ subjectUserId: user.toHexString() })).toBe(0);
    expect(await OrgAlertNotificationModel.countDocuments({})).toBe(2);
    expect(await Inbox.collection.countDocuments({ receiverId: user.toHexString(), organizationAlert: true })).toBe(0);
    expect(await Inbox.collection.countDocuments({})).toBe(3);
  });
  it.each(['preferences', 'claim'])('rejects a delayed %s write whose user was erased before admission', async kind => {
    let reached: () => void = () => {
      throw new Error('Barrier uninitialized');
    };
    let release: () => void = () => {
      throw new Error('Barrier uninitialized');
    };
    const ready = new Promise<void>(resolve => {
      reached = resolve;
    });
    const barrier = new Promise<void>(resolve => {
      release = resolve;
    });
    const update = User.updateOne.bind(User);
    vi.spyOn(User, 'updateOne').mockImplementationOnce((...args) => {
      const query = update(...args);
      const execute = query.exec.bind(query);
      vi.spyOn(query, 'exec').mockImplementationOnce(async () => {
        reached();
        await barrier;
        return execute();
      });
      return query;
    });
    const pending =
      kind === 'preferences'
        ? orgAdminNotificationPrefRepository.upsertForUser(orgId, user.toHexString(), { low_balance: true })
        : claim(user.toHexString());
    const outcome = pending.then(
      value => ({ value }),
      error => ({ error })
    );
    await ready;
    await erase(user.toHexString());
    release();
    const result = await outcome;
    if (kind === 'preferences') expect(result).toHaveProperty('error');
    else expect(result).toEqual({ value: { claimed: false } });
    expect(await OrgAdminNotificationPrefModel.countDocuments({})).toBe(0);
    expect(await OrgAlertNotificationModel.countDocuments({})).toBe(0);
  });
  it('lets a duplicate-key error abort the subject transaction before returning lost', async () => {
    vi.spyOn(OrgAlertNotificationModel, 'findOneAndUpdate').mockRejectedValueOnce(
      Object.assign(new Error('duplicate'), { code: 11000 })
    );
    expect(await claim(user.toHexString())).toEqual({ claimed: false });
    expect((await User.findById(user).lean())?.__v).toBe(7);
  });
  it('does not write claims before unique-index initialization completes or after it fails', async () => {
    let release: () => void = () => {
      throw new Error('Barrier uninitialized');
    };
    const barrier = new Promise<void>(resolve => {
      release = resolve;
    });
    const initialized = vi.spyOn(OrgAlertNotificationModel, 'init').mockImplementationOnce(async () => {
      await barrier;
      return OrgAlertNotificationModel;
    });
    const write = vi.spyOn(OrgAlertNotificationModel, 'findOneAndUpdate');
    const pending = claim();
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();
    release();
    expect((await pending).claimed).toBe(true);
    initialized.mockRejectedValueOnce(new Error('index unavailable'));
    await expect(claim()).rejects.toThrow('index unavailable');
    expect(write).toHaveBeenCalledTimes(1);
  });
});
