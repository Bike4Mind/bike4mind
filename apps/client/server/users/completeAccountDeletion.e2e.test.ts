import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { AdminAuditLogModel, Invite, Organization, PartnerSignupRule, User } from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { InviteType } from '@bike4mind/common';
import { SubscriptionOwnerType, SubscriptionSource } from '@bike4mind/server-utils/lib/subscriptions/types';
import { Subscription } from '@bike4mind/server-utils/models/Subscription';
import { organizationService } from '@bike4mind/services';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../packages/database/src/__test__/createMongoServer';
const h = vi.hoisted(() => ({ purgeFiles: vi.fn(), purgeContent: vi.fn(), sendComplete: vi.fn() }));
vi.mock('@bike4mind/server-utils/users/purgeAccountFiles', () => ({ purgeAccountFiles: h.purgeFiles }));
vi.mock('./purgeAccountContent', () => ({ purgeAccountContent: h.purgeContent }));
vi.mock('./accountDeletionEmail', () => ({ sendAccountDeletionCompleteEmail: h.sendComplete }));
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return {
    adminAuditService: actual.adminAuditService,
    organizationService: { ...actual.organizationService },
    authSessionService: { endRealtimeConnections: vi.fn() },
  };
});
vi.mock('@server/services/hardDeleteUser', async () => {
  const { User: UserModel } = await import('@bike4mind/database');
  return {
    hardDeleteUser: async (
      id: string,
      context: { assertInTransaction: () => Promise<void>; recordInTransaction: () => Promise<void> },
      commit: (users: { delete: (userId: string) => Promise<unknown> }) => Promise<unknown>
    ) => {
      await context.assertInTransaction();
      await commit({ delete: userId => UserModel.deleteOne({ _id: userId }) });
      await context.recordInTransaction();
      return { result: id, subscriptionCancellation: null };
    },
  };
});
import { completeAccountDeletion } from './completeAccountDeletion';
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let database: MongoMemoryReplSet;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const now = new Date();
beforeAll(async () => {
  database = await createMongoReplSet();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
beforeEach(() => {
  vi.resetAllMocks();
});
async function seedUser() {
  const id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({
    _id: id,
    username: `purge-${id}`,
    email: `purge-${id}@example.test`,
    deletion: { requestedAt: new Date(now.getTime() - 86_400_000), scheduledFor: now, source: 'self' },
  });
  return String(id);
}
const complete = (userId: string) => completeAccountDeletion(userId, { logger: logger as never, now });
describe('account deletion purge claims with Mongo', () => {
  it.each(['first', 'retry'] as const)('waits for an active export lease on the %s purge claim', async phase => {
    const userId = await seedUser();
    await User.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(userId) },
      {
        $set: {
          accountDataExportLease: { id: 'active-export', expiresAt: new Date(Date.now() + 60_000) },
          ...(phase === 'retry' ? { 'deletion.purgeStartedAt': new Date(Date.now() - 60_000) } : {}),
        },
      }
    );
    await expect(complete(userId)).resolves.toEqual({ deleted: false, reason: 'busy' });
    expect(h.purgeFiles).not.toHaveBeenCalled();
    expect(h.purgeContent).not.toHaveBeenCalled();
    expect(h.sendComplete).not.toHaveBeenCalled();
    expect(await User.exists({ _id: userId })).not.toBeNull();
    if (phase === 'first') {
      await User.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(userId) },
        { $unset: { accountDataExportLease: 1 } }
      );
    } else {
      await User.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(userId) },
        { $set: { 'accountDataExportLease.expiresAt': new Date(Date.now() - 1) } }
      );
    }
    await expect(complete(userId)).resolves.toEqual({ deleted: true });
    expect(h.purgeFiles).toHaveBeenCalledTimes(1);
    expect(h.sendComplete).toHaveBeenCalledTimes(1);
  });
  it('records the completed deletion in the admin audit log under a system actor', async () => {
    const userId = await seedUser();
    await expect(complete(userId)).resolves.toEqual({ deleted: true });
    const entries = await AdminAuditLogModel.find({ 'target.id': userId }).lean();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'user.deletion.completed',
      category: 'account',
      severity: 'notice',
      actor: { kind: 'system', name: 'account-deletion-sweep' },
      target: { kind: 'user', id: userId },
      context: { source: 'worker' },
    });
  });
  it('deletes an organization the user owns alone, then deletes the user', async () => {
    const userId = await seedUser();
    const org = await Organization.create({ name: 'Solo', userId, personal: false });
    await expect(complete(userId)).resolves.toEqual({ deleted: true });
    expect(await Organization.exists({ _id: org.id })).toBeNull();
    expect(await Organization.exists({ _id: org.id }).setOptions({ includeDeleted: true } as never)).not.toBeNull();
    expect(await User.exists({ _id: userId })).toBeNull();
  });

  it('cancels only the admin grant of a sole-owner organization and leaves its Stripe row and other organizations alone', async () => {
    const userId = await seedUser();
    const org = await Organization.create({ name: 'Granted', userId, personal: false });
    const otherOrg = await Organization.create({
      name: 'Other',
      userId: new mongoose.Types.ObjectId().toString(),
    });
    const base = {
      ownerType: SubscriptionOwnerType.Organization,
      priceId: 'price_test',
      status: 'active',
      quantity: 1,
      periodStartsAt: new Date(),
      periodEndsAt: new Date(Date.now() + 86_400_000),
    };
    await Subscription.create({
      ...base,
      ownerId: String(org.id),
      subscriptionId: 'admin_grant_purge-test',
      source: SubscriptionSource.AdminGrant,
    });
    await Subscription.create({
      ...base,
      ownerId: String(otherOrg.id),
      subscriptionId: 'admin_grant_other-org',
      source: SubscriptionSource.AdminGrant,
    });
    await Subscription.create({
      ...base,
      ownerId: String(org.id),
      subscriptionId: 'sub_stripe_purge-test',
      source: SubscriptionSource.Stripe,
    });
    await expect(complete(userId)).resolves.toEqual({ deleted: true });
    expect((await Subscription.findOne({ subscriptionId: 'admin_grant_purge-test' }).lean())!.status).toBe('canceled');
    expect((await Subscription.findOne({ subscriptionId: 'admin_grant_other-org' }).lean())!.status).toBe('active');
    expect((await Subscription.findOne({ subscriptionId: 'sub_stripe_purge-test' }).lean())!.status).toBe('active');
  });
  it('deletes an organization whose only manager entry is the owner and clears partner rules pointing at it', async () => {
    const userId = await seedUser();
    const org = await Organization.create({ name: 'Solo', userId, personal: false, adminUserIds: [userId] });
    await PartnerSignupRule.collection.insertOne({ domain: 'solo.example.test', organizationId: String(org.id) });
    await expect(complete(userId)).resolves.toEqual({ deleted: true });
    expect(await Organization.exists({ _id: org.id })).toBeNull();
    expect(await PartnerSignupRule.collection.countDocuments({ organizationId: String(org.id) })).toBe(0);
  });
  it.each([
    [
      'a member row',
      (id: string) => ({ users: { userId: new mongoose.Types.ObjectId().toString(), permissions: ['read'] } }),
    ],
    ['a manager entry', (id: string) => ({ adminUserIds: new mongoose.Types.ObjectId().toString() })],
  ] as const)('leaves an organization that gains %s between the check and the delete', async (_label, push) => {
    const userId = await seedUser();
    const org = await Organization.create({ name: 'Racing', userId, personal: false });
    const original = organizationRepository.findById.bind(organizationRepository);
    vi.spyOn(organizationRepository, 'findById').mockImplementationOnce(async (id: string) => {
      await Organization.collection.updateOne({ _id: org._id }, { $push: push(id) as never });
      return original(id);
    });
    const { deleteSoleOwnedOrganizations } = await import('./ownedOrganizations');
    const deleted = await deleteSoleOwnedOrganizations(userId, { logger: logger as never });
    expect(deleted).toEqual([]);
    expect(await Organization.exists({ _id: org.id })).not.toBeNull();
    vi.restoreAllMocks();
  });
  it('clears references for an organization already deleted when a later one fails', async () => {
    const userId = await seedUser();
    const orgs = await Promise.all(['A', 'B'].map(name => Organization.create({ name, userId, personal: false })));
    for (const org of orgs) {
      await PartnerSignupRule.collection.insertOne({
        domain: `${org.id}.example.test`,
        organizationId: String(org.id),
      });
      await Invite.collection.insertOne({
        type: InviteType.Organization,
        documentId: String(org.id),
        remaining: 3,
        recipients: { pending: ['someone@example.test'], accepted: [], refused: [] },
      });
    }
    const realDelete = organizationService.deleteOrganization.bind(organizationService);
    let calls = 0;
    vi.spyOn(organizationService, 'deleteOrganization').mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 2) throw new Error('delete failed');
      return realDelete(...args);
    });
    const { deleteSoleOwnedOrganizations } = await import('./ownedOrganizations');
    await expect(deleteSoleOwnedOrganizations(userId, { logger: logger as never })).rejects.toThrow('delete failed');
    vi.restoreAllMocks();
    const survivorIds = new Set(
      (await Organization.find({ _id: { $in: orgs.map(o => o._id) } })).map(o => String(o.id))
    );
    expect(survivorIds.size).toBe(1);
    for (const org of orgs) {
      const rule = await PartnerSignupRule.collection.findOne({ domain: `${org.id}.example.test` });
      const invite = await Invite.collection.findOne({ documentId: String(org.id) });
      const removed = !survivorIds.has(String(org.id));
      expect(rule?.organizationId).toBe(removed ? null : String(org.id));
      expect(invite?.recipients.pending).toEqual(removed ? [] : ['someone@example.test']);
    }
  });
  it('refuses an owner of an organization with other members and keeps both the user and the organization', async () => {
    const userId = await seedUser();
    const org = await Organization.create({
      name: 'Shared',
      userId,
      personal: false,
      users: [{ userId: new mongoose.Types.ObjectId().toString(), permissions: ['read'] }],
    });
    await expect(complete(userId)).rejects.toThrow('still owns an organization with other members');
    expect(await Organization.exists({ _id: org.id })).not.toBeNull();
    expect(await User.exists({ _id: userId })).not.toBeNull();
    expect(h.purgeFiles).not.toHaveBeenCalled();
  });
  it('admits one worker and skips a competing live claim', async () => {
    const userId = await seedUser();
    let unblock: (() => void) | undefined;
    let started: (() => void) | undefined;
    const claimed = new Promise<void>(resolve => {
      started = resolve;
    });
    const proceed = new Promise<void>(resolve => {
      unblock = resolve;
    });
    h.purgeFiles.mockImplementationOnce(async () => {
      started?.();
      await proceed;
    });
    const first = complete(userId);
    await claimed;
    await expect(complete(userId)).resolves.toEqual({ deleted: false, reason: 'busy' });
    expect(h.purgeFiles).toHaveBeenCalledTimes(1);
    unblock?.();
    await expect(first).resolves.toEqual({ deleted: true });
    expect(await User.exists({ _id: userId })).toBeNull();
  });
  it('keeps irreversible state after a failed purge and resumes with a new lease', async () => {
    const userId = await seedUser();
    h.purgeContent.mockRejectedValueOnce(new Error('temporary storage failure'));
    await expect(complete(userId)).rejects.toThrow('temporary storage failure');
    const pending = await User.findById(userId).lean();
    expect(pending?.deletion?.purgeStartedAt).toBeInstanceOf(Date);
    expect(pending?.deletion?.purgeLeaseId).toBeUndefined();
    expect(pending?.deletion?.purgeLeaseExpiresAt).toBeUndefined();
    expect(h.sendComplete).not.toHaveBeenCalled();
    h.purgeFiles.mockImplementationOnce(async () => {
      expect((await User.findById(userId).lean())?.deletion?.purgeStartedAt).toEqual(pending?.deletion?.purgeStartedAt);
    });
    await expect(complete(userId)).resolves.toEqual({ deleted: true });
    expect(h.purgeContent).toHaveBeenCalledTimes(2);
    expect(h.sendComplete).toHaveBeenCalledTimes(1);
  });
  it('reclaims an abandoned expired lease without changing the first purge time', async () => {
    const userId = await seedUser();
    const startedAt = new Date(now.getTime() - 3_600_000);
    await User.updateOne(
      { _id: userId },
      {
        $set: {
          'deletion.purgeStartedAt': startedAt,
          'deletion.purgeLeaseId': 'abandoned-worker',
          'deletion.purgeLeaseExpiresAt': new Date(now.getTime() - 1),
        },
      }
    );
    h.purgeFiles.mockImplementationOnce(async () => {
      const pending = await User.findById(userId).lean();
      expect(pending?.deletion?.purgeStartedAt).toEqual(startedAt);
      expect(pending?.deletion?.purgeLeaseId).not.toBe('abandoned-worker');
    });
    await expect(complete(userId)).resolves.toEqual({ deleted: true });
  });
});
