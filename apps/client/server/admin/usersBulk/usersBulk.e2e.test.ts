import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { ApiKeyScope, ApiKeyStatus } from '@bike4mind/common';
import { AdminAuditLogModel, Cache, CreditTransaction, User, UserApiKey } from '@bike4mind/database';
import { AdminSettings } from '@bike4mind/database/infra';
import {
  ADMIN_USERS_BULK_MAX,
  ADMIN_USERS_BULK_MAX_CREDIT_ADD,
  ADMIN_USERS_BULK_UNDO_WINDOW_MS,
  type AdminUsersBulkAction,
  type AdminUsersBulkExecuteRequest,
} from '@client/app/utils/adminUsersBulk';
import { usersBulkExecuteDeps, usersBulkUndoDeps } from './adapters';
import { executeAdminUsersBulk, type ExecuteDeps } from './execute';
import { SUPERSEDED_MESSAGE, undoAdminUsersBulk } from './undo';
import { cohortHashOf, type BulkUser } from './resolve';

const invalidateSettingsCache = vi.fn();
const cancelAccountSubscriptions = vi.hoisted(() =>
  vi.fn(async (_input: { userId: string; reason: string }, _logger: unknown) => ({
    canceled: [] as string[],
    failed: [] as { customerId: string; subscriptionId: string | null; reason: string }[],
  }))
);
vi.mock('@server/billing/cancelAccountSubscriptions', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/billing/cancelAccountSubscriptions')>()),
  cancelAccountSubscriptions,
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  invalidateSettingsCache: (...args: unknown[]) => invalidateSettingsCache(...args),
}));

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// Real transactions need a replica set: per-user rollback and the in-transaction audit are only
// exercised for real here.
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

afterEach(async () => {
  invalidateSettingsCache.mockClear();
  cancelAccountSubscriptions.mockReset();
  await mongoose.connection.dropDatabase();
});

const REASON = 'Coordinated abuse from one campaign';
let keySeq = 0;

const seedUser = async (overrides: Record<string, unknown> = {}) => {
  const tag = Math.random().toString(36).slice(2, 10);
  const doc = await User.create({
    name: `User ${tag}`,
    username: `user-${tag}`,
    email: `user-${tag}@example.com`,
    password: null,
    hasUsablePassword: false,
    currentCredits: 100,
    ...overrides,
  });
  return doc.id as string;
};

const seedKey = async (userId: string, status = ApiKeyStatus.ACTIVE) => {
  keySeq += 1;
  const key = await UserApiKey.create({
    userId,
    name: 'key',
    keyHash: '$2b$12$abcdefghijklmnopqrstuv',
    keyPrefix: `b4m_live_bulk${String(keySeq).padStart(4, '0')}`,
    scopes: [ApiKeyScope.AI_GENERATE],
    metadata: { createdFrom: 'dashboard' as const },
    status,
  });
  return key.id as string;
};

const reqFor = (adminId: string) =>
  ({
    user: { id: adminId, username: 'admin', name: 'Admin', email: 'admin@example.com', isAdmin: true },
    headers: {},
    url: '/api/admin/users/bulk/execute',
    requestId: 'req-1',
  }) as unknown as Parameters<typeof usersBulkExecuteDeps>[0];

/** A request confirming `eligibleIds` as the cohort, as the client sends after a preview. */
const request = (
  userIds: string[],
  action: AdminUsersBulkAction,
  eligibleIds: string[],
  idempotencyKey = randomUUID()
): AdminUsersBulkExecuteRequest => ({
  target: { kind: 'ids', userIds },
  action,
  reason: REASON,
  idempotencyKey,
  expectedCount: eligibleIds.length,
  cohortHash: cohortHashOf(eligibleIds.map(id => ({ id }))),
});

const run = (adminId: string, body: AdminUsersBulkExecuteRequest, overrides: Partial<ExecuteDeps> = {}) =>
  executeAdminUsersBulk(
    body,
    { id: adminId, selfIds: [adminId] },
    { ...usersBulkExecuteDeps(reqFor(adminId), body.reason), ...overrides }
  );

const undo = (adminId: string, batchId: string, now?: Date) =>
  undoAdminUsersBulk(batchId, adminId, { ...usersBulkUndoDeps(reqFor(adminId)), ...(now ? { now: () => now } : {}) });

const userState = async (id: string) => User.findById(id).lean();
const auditCount = (action: string) => AdminAuditLogModel.countDocuments({ action });
const blockedList = async () =>
  (await AdminSettings.findOne({ settingName: 'blockedEmailDomains' }).lean())?.settingValue;

describe('users bulk actions on a real replica set', () => {
  it('contains users: suspends, zeroes credits through the ledger and revokes keys, one audit each', async () => {
    const adminId = await seedUser({ isAdmin: true });
    const otherAdmin = await seedUser({ isAdmin: true });
    const first = await seedUser();
    const second = await seedUser({ currentCredits: 30 });
    const firstKey = await seedKey(first);
    const disabledKey = await seedKey(first, ApiKeyStatus.DISABLED);

    const result = await run(
      adminId,
      request([first, second, otherAdmin, adminId], { type: 'contain' }, [first, second])
    );

    expect(result).toMatchObject({ applied: 2, skipped: 0, failed: [] });
    for (const id of [first, second]) {
      expect(await userState(id)).toMatchObject({ isBanned: true, currentCredits: 0 });
    }
    expect(await userState(otherAdmin)).toMatchObject({ isBanned: false, currentCredits: 100 });
    const ledger = await CreditTransaction.find({ ownerId: { $in: [first, second] } }).lean();
    expect(ledger.map(row => [row.type, row.credits]).sort()).toEqual(
      [
        ['generic_deduct', -100],
        ['generic_deduct', -30],
      ].sort()
    );
    expect(await UserApiKey.findById(firstKey).lean()).toMatchObject({
      status: ApiKeyStatus.DISABLED,
      revokedBy: adminId,
      revokedReason: REASON,
    });
    expect(await auditCount('user.bulk.contained')).toBe(2);
    expect(await auditCount('user.bulk.executed')).toBe(1);
    const entry = await AdminAuditLogModel.findOne({ action: 'user.bulk.contained', 'target.id': first }).lean();
    expect(entry?.related?.creditTransactionId).toBeTruthy();
    expect(entry?.reason).toBe(REASON);

    const undone = await undo(adminId, result.batchId);
    expect(undone).toEqual({
      restored: 2,
      failed: [],
      partial: false,
      remaining: 0,
      unblockedDomains: [],
      stillBlockedDomains: [],
      subscriptionsNotRestored: [],
    });
    expect(await userState(first)).toMatchObject({ isBanned: false, currentCredits: 100 });
    expect(await userState(second)).toMatchObject({ isBanned: false, currentCredits: 30 });
    const restoredKey = await UserApiKey.findById(firstKey).lean();
    expect(restoredKey).toMatchObject({ status: ApiKeyStatus.ACTIVE });
    expect(restoredKey?.revokedBy).toBeUndefined();
    expect(await UserApiKey.findById(disabledKey).lean()).toMatchObject({ status: ApiKeyStatus.DISABLED });
    expect(await CreditTransaction.countDocuments({ ownerId: first, type: 'generic_add' })).toBe(1);
    expect(await auditCount('user.bulk.undone')).toBe(2);

    // Taken once: a second undo finds no record.
    await expect(undo(adminId, result.batchId)).rejects.toMatchObject({ statusCode: 410 });
    expect(await auditCount('user.bulk.undone')).toBe(2);
  });

  it('sets credits to 0 through the ledger and skips users already at the target', async () => {
    const adminId = await seedUser({ isAdmin: true });
    const rich = await seedUser({ currentCredits: 250 });
    const empty = await seedUser({ currentCredits: 0 });

    const result = await run(
      adminId,
      request([rich, empty], { type: 'adjustCredits', mode: 'set', amount: 0 }, [rich, empty])
    );

    expect(result).toMatchObject({ applied: 1, skipped: 1 });
    expect(await userState(rich)).toMatchObject({ currentCredits: 0 });
    expect(await CreditTransaction.find({ ownerId: rich }).lean()).toMatchObject([
      { type: 'generic_deduct', credits: -250, reason: 'admin_adjustment' },
    ]);
    expect(await auditCount('user.bulk.credits_adjusted')).toBe(1);
  });

  it('suspends with the blocked-state side effects and undoes a tag only where it added it', async () => {
    const adminId = await seedUser({ isAdmin: true });
    const target = await seedUser();
    const banned = await seedUser({ isBanned: true });
    const key = await seedKey(target);

    const suspend = await run(adminId, request([target, banned], { type: 'suspend' }, [target, banned]));
    expect(suspend).toMatchObject({ applied: 1, skipped: 1 });
    expect(await UserApiKey.findById(key).lean()).toMatchObject({ status: ApiKeyStatus.DISABLED });

    const tagged = await seedUser({ tags: ['vip'] });
    const tag = await run(adminId, request([target, tagged], { type: 'addTag', tag: 'vip' }, [target, tagged]));
    expect(tag).toMatchObject({ applied: 1, skipped: 1 });
    await undo(adminId, tag.batchId);
    expect((await userState(target))?.tags).toEqual([]);
    expect((await userState(tagged))?.tags).toEqual(['vip']);
  });

  it('cancels Stripe subscriptions after a suspend commits, audits it, and undo says they stay canceled', async () => {
    const adminId = await seedUser({ isAdmin: true });
    const paying = await seedUser();
    const refused = await seedUser();
    cancelAccountSubscriptions.mockImplementation(async ({ userId }) =>
      userId === paying
        ? { canceled: ['sub_paying'], failed: [] }
        : {
            canceled: [],
            failed: [{ customerId: 'cus_refused', subscriptionId: 'sub_refused', reason: 'stripe down' }],
          }
    );

    const result = await run(adminId, request([paying, refused], { type: 'suspend' }, [paying, refused]));

    expect(result).toMatchObject({
      applied: 2,
      canceledSubscriptions: 1,
      subscriptionCancelFailures: [{ userId: refused, error: 'stripe down' }],
    });
    expect(cancelAccountSubscriptions).toHaveBeenCalledWith({ userId: paying, reason: 'suspended' }, expect.anything());
    // The ban stands even where Stripe refused the cancel.
    expect(await userState(refused)).toMatchObject({ isBanned: true });
    const entries = await AdminAuditLogModel.find({ action: 'user.subscriptions.canceled' }).lean();
    expect(entries.map(entry => entry.target.id).sort()).toEqual([paying, refused].sort());
    expect(entries.find(entry => entry.target.id === paying)?.details).toMatchObject({
      canceledSubscriptions: ['sub_paying'],
      batchId: result.batchId,
    });

    const undone = await undo(adminId, result.batchId);
    expect(undone).toMatchObject({ restored: 2, subscriptionsNotRestored: ['sub_paying'] });
    expect(await userState(paying)).toMatchObject({ isBanned: false });
    const undoEntry = await AdminAuditLogModel.findOne({ action: 'user.bulk.undone', 'target.id': paying }).lean();
    expect(undoEntry?.details).toMatchObject({ subscriptionsNotRestored: ['sub_paying'] });
  });

  it('cancels subscriptions on contain even for an already-suspended user, and never on other actions', async () => {
    const adminId = await seedUser({ isAdmin: true });
    const banned = await seedUser({ isBanned: true, currentCredits: 10 });
    const other = await seedUser();

    await run(adminId, request([banned], { type: 'contain' }, [banned]));
    expect(cancelAccountSubscriptions).toHaveBeenCalledWith({ userId: banned, reason: 'contained' }, expect.anything());

    cancelAccountSubscriptions.mockClear();
    await run(adminId, request([other], { type: 'restrict' }, [other]));
    expect(cancelAccountSubscriptions).not.toHaveBeenCalled();
  });

  it('rolls back only the user whose audit write fails', async () => {
    const adminId = await seedUser({ isAdmin: true });
    const good = await seedUser();
    const bad = await seedUser();
    const real = usersBulkExecuteDeps(reqFor(adminId), REASON);

    const result = await run(adminId, request([good, bad], { type: 'restrict' }, [good, bad]), {
      audit: async entry => {
        if (entry.user.id === bad) throw new Error('audit down');
        return real.audit(entry);
      },
    });

    expect(result.applied).toBe(1);
    expect(result.failed).toEqual([{ userId: bad, error: 'audit down' }]);
    expect(await userState(good)).toMatchObject({ isModerated: true });
    expect(await userState(bad)).toMatchObject({ isModerated: false });
  });

  it('replays the first result for a reused idempotency key without acting again', async () => {
    const adminId = await seedUser({ isAdmin: true });
    const target = await seedUser();
    const body = request([target], { type: 'adjustCredits', mode: 'add', amount: 10 }, [target]);

    const first = await run(adminId, body);
    const replayed = await run(adminId, body);

    expect(replayed).toEqual(first);
    expect(await userState(target)).toMatchObject({ currentCredits: 110 });
    expect(await auditCount('user.bulk.credits_adjusted')).toBe(1);
    expect(await auditCount('user.bulk.executed')).toBe(1);
  });

  it('refuses a changed eligible count with 409 and frees the key for a retry', async () => {
    const adminId = await seedUser({ isAdmin: true });
    const target = await seedUser();
    const key = randomUUID();

    await expect(run(adminId, request([target], { type: 'suspend' }, [target, adminId], key))).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(await userState(target)).toMatchObject({ isBanned: false });

    expect(await run(adminId, request([target], { type: 'suspend' }, [target], key))).toMatchObject({ applied: 1 });
  });

  it('refuses an over-cap cohort naming the cap, touching nobody', async () => {
    const adminId = await seedUser({ isAdmin: true });
    const target = await seedUser();
    const many: BulkUser[] = Array.from({ length: ADMIN_USERS_BULK_MAX + 1 }, (_, i) => ({
      id: i.toString(16).padStart(24, '0'),
      name: null,
      email: null,
      username: null,
      isAdmin: false,
      isBanned: false,
      isModerated: false,
      tags: [],
      currentCredits: 0,
      disputePending: false,
      moderationStatus: null,
    }));

    await expect(
      run(adminId, request([target], { type: 'suspend' }, [target]), {
        findUsersByIds: async () => many,
      })
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining(String(ADMIN_USERS_BULK_MAX)) });
    expect(await auditCount('user.bulk.suspended')).toBe(0);
  });

  it('lets only the same admin undo, and only inside the window', async () => {
    const adminId = await seedUser({ isAdmin: true });
    const otherAdmin = await seedUser({ isAdmin: true });
    const target = await seedUser();
    const result = await run(adminId, request([target], { type: 'restrict' }, [target]));

    await expect(undo(otherAdmin, result.batchId)).rejects.toMatchObject({ statusCode: 403 });
    const late = new Date(new Date(result.undoExpiresAt).getTime() + 1);
    await expect(undo(adminId, result.batchId, late)).rejects.toMatchObject({ statusCode: 410 });
    expect(await userState(target)).toMatchObject({ isModerated: true });
    // Neither refusal consumed the record.
    expect(await Cache.countDocuments({ key: `admin-users-bulk:undo:${result.batchId}` })).toBe(1);
    expect(await undo(adminId, result.batchId)).toEqual({
      restored: 1,
      failed: [],
      unblockedDomains: [],
      partial: false,
      remaining: 0,
      stillBlockedDomains: [],
      subscriptionsNotRestored: [],
    });
    expect(await userState(target)).toMatchObject({ isModerated: false });
    expect(ADMIN_USERS_BULK_UNDO_WINDOW_MS).toBe(30_000);
  });

  it('never lets undo of an older batch revert a user a newer batch changed, and retries it later', async () => {
    const adminId = await seedUser({ isAdmin: true });
    const target = await seedUser();
    const firstKey = await seedKey(target);

    const suspend = await run(adminId, request([target], { type: 'suspend' }, [target]));
    const laterKey = await seedKey(target);
    const revoke = await run(adminId, request([target], { type: 'revokeApiKeys' }, [target]));

    const blocked = await undo(adminId, suspend.batchId);
    expect(blocked).toEqual({
      restored: 0,
      failed: [{ userId: target, error: SUPERSEDED_MESSAGE }],
      unblockedDomains: [],
      partial: false,
      remaining: 0,
      stillBlockedDomains: [],
      subscriptionsNotRestored: [],
    });
    expect(await userState(target)).toMatchObject({ isBanned: true });
    expect(await UserApiKey.findById(firstKey).lean()).toMatchObject({ status: ApiKeyStatus.DISABLED });

    // Undoing the newer batch while the older ban holds keeps its key off, and says why.
    expect(await undo(adminId, revoke.batchId)).toEqual({
      restored: 1,
      failed: [],
      unblockedDomains: [],
      partial: false,
      remaining: 0,
      stillBlockedDomains: [],
      subscriptionsNotRestored: [],
    });
    expect(await UserApiKey.findById(laterKey).lean()).toMatchObject({ status: ApiKeyStatus.DISABLED });
    const kept = await AdminAuditLogModel.findOne({
      action: 'user.bulk.undone',
      'details.batchId': revoke.batchId,
    }).lean();
    expect(kept?.details).toMatchObject({ keysKeptDisabled: { count: 1, blockedBy: ['banned'] } });

    // The failed user was written back, so retrying the older undo now finishes it.
    expect(await undo(adminId, suspend.batchId)).toEqual({
      restored: 1,
      failed: [],
      unblockedDomains: [],
      partial: false,
      remaining: 0,
      stillBlockedDomains: [],
      subscriptionsNotRestored: [],
    });
    expect(await userState(target)).toMatchObject({ isBanned: false });
    expect(await UserApiKey.findById(firstKey).lean()).toMatchObject({ status: ApiKeyStatus.ACTIVE });
    expect(await UserApiKey.findById(laterKey).lean()).toMatchObject({ status: ApiKeyStatus.DISABLED });
  });

  it('stops at the time budget with a partial, undoable result', async () => {
    const adminId = await seedUser({ isAdmin: true });
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(await seedUser());
    const body = request(ids, { type: 'restrict' }, ids);

    const result = await run(adminId, body, { budgetMs: 0 });

    expect(result).toMatchObject({ applied: 8, partial: true, remaining: 2, failed: [] });
    expect(await User.countDocuments({ _id: { $in: ids }, isModerated: true })).toBe(8);
    const summary = await AdminAuditLogModel.findOne({ action: 'user.bulk.executed' }).lean();
    expect(summary?.details).toMatchObject({ partial: true, remaining: 2, applied: 8 });
    expect(await run(adminId, body)).toEqual(result);
    expect(await undo(adminId, result.batchId)).toEqual({
      restored: 8,
      failed: [],
      unblockedDomains: [],
      partial: false,
      remaining: 0,
      stillBlockedDomains: [],
      subscriptionsNotRestored: [],
    });
    expect(await User.countDocuments({ _id: { $in: ids }, isModerated: true })).toBe(0);
  });

  it('stops an undo at the time budget, then a second undo restores the rest', async () => {
    const adminId = await seedUser({ isAdmin: true });
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(await seedUser());
    const result = await run(adminId, request(ids, { type: 'suspend' }, ids));
    expect(result.applied).toBe(10);

    const partial = await undoAdminUsersBulk(result.batchId, adminId, {
      ...usersBulkUndoDeps(reqFor(adminId)),
      budgetMs: 0,
    });

    expect(partial).toEqual({
      restored: 8,
      failed: [],
      partial: true,
      remaining: 2,
      unblockedDomains: [],
      stillBlockedDomains: [],
      subscriptionsNotRestored: [],
    });
    expect(await User.countDocuments({ _id: { $in: ids.slice(0, 8) }, isBanned: true })).toBe(0);
    expect(await User.countDocuments({ _id: { $in: ids.slice(8) }, isBanned: true })).toBe(2);

    expect(await undo(adminId, result.batchId)).toEqual({
      restored: 2,
      failed: [],
      partial: false,
      remaining: 0,
      unblockedDomains: [],
      stillBlockedDomains: [],
      subscriptionsNotRestored: [],
    });
    expect(await User.countDocuments({ _id: { $in: ids }, isBanned: true })).toBe(0);
  });

  it('refuses the loser of two concurrent undos with 409', async () => {
    const adminId = await seedUser({ isAdmin: true });
    const target = await seedUser();
    const result = await run(adminId, request([target], { type: 'restrict' }, [target]));
    const deps = usersBulkUndoDeps(reqFor(adminId));

    // The other undo took the record between this one's read and its take.
    await expect(
      undoAdminUsersBulk(result.batchId, adminId, {
        ...deps,
        // The store is a class instance: keep its prototype methods and override only the take.
        store: Object.assign(Object.create(deps.store) as typeof deps.store, {
          deleteByKeyAndReturn: async () => null,
        }),
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await userState(target)).toMatchObject({ isModerated: true });
  });

  it('undoes a positive set only down to zero after the user spent credits', async () => {
    const adminId = await seedUser({ isAdmin: true });
    const target = await seedUser({ currentCredits: 100 });
    const result = await run(adminId, request([target], { type: 'adjustCredits', mode: 'set', amount: 200 }, [target]));
    expect(await userState(target)).toMatchObject({ currentCredits: 200 });
    await User.updateOne({ _id: target }, { $inc: { currentCredits: -160 } });

    await undo(adminId, result.batchId);

    expect(await userState(target)).toMatchObject({ currentCredits: 0 });
    const reversal = await CreditTransaction.findOne({ ownerId: target, type: 'generic_deduct' }).lean();
    expect(reversal).toMatchObject({ credits: -40 });
  });

  it('refuses a cohort hash that no longer matches with 409', async () => {
    const adminId = await seedUser({ isAdmin: true });
    const target = await seedUser();
    const other = await seedUser();
    const body = { ...request([target], { type: 'suspend' }, [target]), cohortHash: cohortHashOf([{ id: other }]) };

    await expect(run(adminId, body)).rejects.toMatchObject({ statusCode: 409 });
    expect(await userState(target)).toMatchObject({ isBanned: false });
  });

  it('refuses a batch that would add more than the credit total', async () => {
    const adminId = await seedUser({ isAdmin: true });
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) ids.push(await seedUser());

    await expect(
      run(adminId, request(ids, { type: 'adjustCredits', mode: 'add', amount: ADMIN_USERS_BULK_MAX_CREDIT_ADD }, ids))
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await CreditTransaction.countDocuments({})).toBe(0);
  });

  describe('contain with blockEmailDomains', () => {
    const CONTAIN_AND_BLOCK: AdminUsersBulkAction = { type: 'contain', blockEmailDomains: true };

    it('blocks the owned domains only, reports them, and undo removes exactly those', async () => {
      const adminId = await seedUser({ isAdmin: true });
      const fresh = await seedUser({ email: 'a@fresh-campaign.com' });
      const sibling = await seedUser({ email: 'b@Fresh-Campaign.com' });
      const mailbox = await seedUser({ email: 'c@gmail.com' });
      const covered = await seedUser({ email: 'd@mail.listed-parent.com' });
      const ids = [fresh, sibling, mailbox, covered];
      await AdminSettings.create({
        settingName: 'blockedEmailDomains',
        settingValue: ['listed-parent.com', 'keep.com'],
      });

      const result = await run(adminId, request(ids, CONTAIN_AND_BLOCK, ids));

      expect(result.blockedDomains).toEqual(['fresh-campaign.com']);
      expect(await blockedList()).toEqual(['listed-parent.com', 'keep.com', 'fresh-campaign.com']);
      expect(invalidateSettingsCache).toHaveBeenCalledWith('blockedEmailDomains');
      expect(await auditCount('settings.admin_settings.updated')).toBe(1);
      const summary = await AdminAuditLogModel.findOne({ action: 'user.bulk.executed' }).lean();
      expect(summary?.details).toMatchObject({ blockedDomains: ['fresh-campaign.com'] });

      const undone = await undo(adminId, result.batchId);
      expect(undone).toEqual({
        restored: 4,
        failed: [],
        unblockedDomains: ['fresh-campaign.com'],
        partial: false,
        remaining: 0,
        stillBlockedDomains: [],
        subscriptionsNotRestored: [],
      });
      expect(await blockedList()).toEqual(['listed-parent.com', 'keep.com']);
      expect(await auditCount('settings.admin_settings.updated')).toBe(2);
    });

    it('touches no user and releases the idempotency key when blocking the domains fails', async () => {
      const adminId = await seedUser({ isAdmin: true });
      const target = await seedUser({ email: 'a@fresh-campaign.com' });
      const body = request([target], CONTAIN_AND_BLOCK, [target]);

      await expect(
        run(adminId, body, { blockEmailDomains: () => Promise.reject(new Error('settings write failed')) })
      ).rejects.toThrow('settings write failed');
      expect((await User.findById(target).lean())?.isBanned).toBeFalsy();

      const retried = await run(adminId, body);
      expect(retried).toMatchObject({ applied: 1, blockedDomains: ['fresh-campaign.com'] });
    });

    it('does not touch the list when the toggle is off', async () => {
      const adminId = await seedUser({ isAdmin: true });
      const target = await seedUser({ email: 'a@fresh-campaign.com' });

      const result = await run(adminId, request([target], { type: 'contain' }, [target]));

      expect(result.blockedDomains).toEqual([]);
      expect(await blockedList()).toBeUndefined();
    });

    it('still blocks the domain, undoably, when every user is already contained', async () => {
      const adminId = await seedUser({ isAdmin: true });
      const contained = await seedUser({ email: 'a@fresh-campaign.com', isBanned: true, currentCredits: 0 });

      const result = await run(adminId, request([contained], CONTAIN_AND_BLOCK, [contained]));

      expect(result).toMatchObject({ applied: 0, skipped: 1, blockedDomains: ['fresh-campaign.com'] });
      expect(await blockedList()).toEqual(['fresh-campaign.com']);

      const undone = await undo(adminId, result.batchId);
      expect(undone).toEqual({
        restored: 0,
        failed: [],
        unblockedDomains: ['fresh-campaign.com'],
        partial: false,
        remaining: 0,
        stillBlockedDomains: [],
        subscriptionsNotRestored: [],
      });
      expect(await blockedList()).toEqual([]);
    });

    it('keeps a domain in the retry record when releasing it fails, and a retry finishes it', async () => {
      const adminId = await seedUser({ isAdmin: true });
      const target = await seedUser({ email: 'a@fresh-campaign.com' });
      const result = await run(adminId, request([target], CONTAIN_AND_BLOCK, [target]));

      const failing = await undoAdminUsersBulk(result.batchId, adminId, {
        ...usersBulkUndoDeps(reqFor(adminId)),
        unblockEmailDomains: async () => {
          throw new Error('settings down');
        },
      });
      expect(failing).toEqual({
        restored: 1,
        failed: [],
        unblockedDomains: [],
        partial: false,
        remaining: 0,
        stillBlockedDomains: ['fresh-campaign.com'],
        subscriptionsNotRestored: [],
      });
      expect(await blockedList()).toEqual(['fresh-campaign.com']);

      expect(await undo(adminId, result.batchId)).toMatchObject({ unblockedDomains: ['fresh-campaign.com'] });
      expect(await blockedList()).toEqual([]);
    });
  });
});
