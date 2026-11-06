import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  AdminAuditLogModel,
  ErasureRecordModel,
  Organization,
  Session,
  User,
  erasureRecordRepository,
  type IErasureRecord,
} from '@bike4mind/database';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../database/src/__test__/createMongoServer';

vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { JWT_SECRET: 'test-jwt-secret' } }));
const effects = vi.hoisted(() => ({ storage: vi.fn(), cancel: vi.fn(), billingEvent: vi.fn(), email: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getGeneratedImageStorage: () => ({ delete: effects.storage, deletePermanently: effects.storage }),
  getPublishedArtifactsStorage: () => ({ deletePrefix: effects.storage, deletePrefixPermanently: effects.storage }),
  getFilesStorage: () => ({
    delete: effects.storage,
    deletePermanently: effects.storage,
    deletePrefix: effects.storage,
    deletePrefixPermanently: effects.storage,
  }),
  getAppFilesStorage: () => ({ delete: effects.storage, deletePermanently: effects.storage }),
}));
vi.mock('@server/services/publish/purgeUserPublishedArtifacts', () => ({ purgeUserPublishedArtifacts: vi.fn() }));
vi.mock('@bike4mind/server-utils/skillMarket/market', () => ({ withdrawAuthorListings: vi.fn() }));
vi.mock('@server/auth/signupNetworkLimits', () => ({ retainDeletedSignupTraces: vi.fn() }));
vi.mock('@server/analytics/signupEvents', () => ({ emitBillingEvent: effects.billingEvent }));
vi.mock('@server/users/accountDeletionEmail', () => ({ sendAccountDeletionCompleteEmail: effects.email }));
vi.mock('@server/billing/cancelAccountSubscriptions', () => ({
  cancelAccountSubscriptions: effects.cancel,
  readAccountSubscriptionCustomerIds: vi.fn(async () => []),
  SINGLE_USER_CANCEL_BUDGET_MS: 1000,
  NO_SUBSCRIPTIONS_CANCELED: { canceled: [], failed: [] },
}));

import { hardDeleteUser } from '@server/services/hardDeleteUser';
import { erasureIdHash } from '@bike4mind/server-utils/privacy/erasureHash';
import { backfillErasureRecords, exportErasureRecords, parseErasureExport, reapplyErasures } from './reapplyErasures';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let database: MongoMemoryReplSet;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const raw = (model: { collection: { name: string } }) => mongoose.connection.collection(model.collection.name);

beforeAll(async () => {
  database = await createMongoReplSet();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
beforeEach(async () => {
  vi.clearAllMocks();
  effects.cancel.mockResolvedValue({ canceled: [], failed: [] });
  await mongoose.connection.dropDatabase();
});

async function seedAccount() {
  const userId = new mongoose.Types.ObjectId();
  const orgId = new mongoose.Types.ObjectId();
  const insertRows = async () => {
    await raw(User).insertOne({ _id: userId, username: `u-${userId}`, email: `u-${userId}@example.test` });
    await raw(Organization).insertOne({ _id: orgId, name: 'Personal', userId: String(userId), personal: true });
    await raw(Session).insertOne({
      _id: new mongoose.Types.ObjectId(),
      userId: String(userId),
      name: 'chat',
      organizationId: String(orgId),
    });
  };
  await insertRows();
  return { id: String(userId), insertRows };
}
const counts = async () => ({
  users: await raw(User).countDocuments(),
  orgs: await raw(Organization).countDocuments(),
  sessions: await raw(Session).countDocuments(),
});
// The self-serve path removes content and the personal org around the shared delete (completeAccountDeletion).
const erase = async (id: string) => {
  await hardDeleteUser(id, { deletedBy: id, initiatedBy: 'self', logger }, users => users.delete(id));
  await raw(Organization).deleteMany({ userId: id });
  await raw(Session).deleteMany({ userId: id });
};
const allRecords = async (): Promise<IErasureRecord[]> => {
  const out: IErasureRecord[] = [];
  for await (const r of erasureRecordRepository.cursor()) out.push(r);
  return out;
};
/** The restore: every row of the erased account comes back; the live erasure records are what survived elsewhere. */
const restore = async (insertRows: () => Promise<void>) => {
  await insertRows();
  vi.clearAllMocks();
};

describe('reapplyErasures', () => {
  it('re-erases a restored account, leaves others, sends nothing, and is a no-op the second time', async () => {
    const erased = await seedAccount();
    const bystander = await seedAccount();
    await erase(erased.id);
    const records = await allRecords();
    expect(records).toHaveLength(1);
    await restore(erased.insertRows);
    expect(await counts()).toEqual({ users: 2, orgs: 2, sessions: 2 });

    const first = await reapplyErasures({ records, dryRun: false });
    expect(first).toMatchObject({ scanned: 2, matched: 1, reapplied: 1, failed: 0, unmatchableKey: 0 });
    expect(await counts()).toEqual({ users: 1, orgs: 1, sessions: 1 });
    expect(await raw(User).countDocuments({ _id: new mongoose.Types.ObjectId(bystander.id) })).toBe(1);
    expect(effects.cancel).not.toHaveBeenCalled();
    expect(effects.billingEvent).not.toHaveBeenCalled();
    expect(effects.email).not.toHaveBeenCalled();

    const second = await reapplyErasures({ records, dryRun: false });
    expect(second).toMatchObject({ scanned: 1, matched: 0, reapplied: 0 });
    expect(await counts()).toEqual({ users: 1, orgs: 1, sessions: 1 });
  });

  it('changes nothing in a dry run and prints no raw id', async () => {
    const erased = await seedAccount();
    await erase(erased.id);
    const records = await allRecords();
    await restore(erased.insertRows);
    const lines: string[] = [];
    const result = await reapplyErasures({ records, dryRun: true, log: m => lines.push(m) });
    expect(result).toMatchObject({ matched: 1, reapplied: 0 });
    expect(await counts()).toEqual({ users: 1, orgs: 1, sessions: 1 });
    expect(lines.join('\n')).toContain('would re-erase');
    expect(lines.join('\n')).not.toContain(erased.id);
  });

  it('reports records hashed under another key instead of skipping them silently', async () => {
    const erased = await seedAccount();
    await erase(erased.id);
    const [record] = await allRecords();
    await restore(erased.insertRows);
    const result = await reapplyErasures({ records: [{ ...record, keyId: 'other-key' }], dryRun: false });
    expect(result).toMatchObject({ matched: 0, unmatchableKey: 1 });
    expect(await counts()).toEqual({ users: 1, orgs: 1, sessions: 1 });
  });

  it('works from records exported before the restore, after the record collection was lost', async () => {
    const erased = await seedAccount();
    await erase(erased.id);
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'erasure-')), 'erasures.json');
    expect(await exportErasureRecords(erasureRecordRepository.cursor(), file)).toBe(1);
    expect(await readFile(file, 'utf8')).not.toContain(erased.id);

    await ErasureRecordModel.deleteMany({}); // the restored database has no record of the erasure
    await restore(erased.insertRows);
    const result = await reapplyErasures({ records: parseErasureExport(await readFile(file, 'utf8')), dryRun: false });
    expect(result).toMatchObject({ matched: 1, reapplied: 1 });
    expect(await counts()).toEqual({ users: 0, orgs: 0, sessions: 0 });
  });

  it('rejects a malformed export', () => {
    expect(() => parseErasureExport(JSON.stringify([{ idHash: 'x' }]))).toThrow();
  });
});

describe('backfillErasureRecords', () => {
  const audit = (action: string, targetId: string) =>
    raw(AdminAuditLogModel).insertOne({
      action,
      occurredAt: new Date('2026-03-01T00:00:00Z'),
      target: { kind: 'user', id: targetId, displayName: 'x' },
    });

  it('records erased targets by action, skips existing users, and creates no duplicates', async () => {
    const live = await seedAccount();
    const selfGone = String(new mongoose.Types.ObjectId());
    const adminGone = String(new mongoose.Types.ObjectId());
    await audit('user.deletion.completed', selfGone);
    await audit('user.deleted', adminGone);
    await audit('user.deleted', live.id);
    await audit('user.deleted', adminGone);

    expect(await backfillErasureRecords({ dryRun: true })).toEqual({ candidates: 2, created: 0 });
    expect(await ErasureRecordModel.countDocuments()).toBe(0);

    expect(await backfillErasureRecords({ dryRun: false })).toEqual({ candidates: 2, created: 2 });
    const byHash = new Map((await allRecords()).map(r => [r.idHash, r]));
    expect(byHash.get(erasureIdHash(selfGone))?.initiatedBy).toBe('self');
    expect(byHash.get(erasureIdHash(adminGone))?.initiatedBy).toBe('admin');
    expect(byHash.has(erasureIdHash(live.id))).toBe(false);

    expect(await backfillErasureRecords({ dryRun: false })).toEqual({ candidates: 2, created: 0 });
    expect(await ErasureRecordModel.countDocuments()).toBe(2);
  });
});
