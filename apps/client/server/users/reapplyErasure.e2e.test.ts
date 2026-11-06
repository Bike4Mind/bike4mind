import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ErasureRecordModel, Organization, Session, User } from '@bike4mind/database';
import { erasureIdHash } from '@bike4mind/server-utils/privacy/erasureHash';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';

vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { JWT_SECRET: 'test-jwt-secret' } }));
const effects = vi.hoisted(() => ({
  storage: vi.fn(),
  cancel: vi.fn(),
  billingEvent: vi.fn(),
  email: vi.fn(),
  purge: vi.fn(),
}));
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
vi.mock('./accountDeletionEmail', () => ({ sendAccountDeletionCompleteEmail: effects.email }));
// Spy, not replace: the revokes are called from inside this module, so only the arguments can show them skipped.
vi.mock('@server/services/purgeDeletedUserData', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/services/purgeDeletedUserData')>();
  effects.purge.mockImplementation(actual.purgeDeletedUserData);
  return { ...actual, purgeDeletedUserData: effects.purge };
});
vi.mock('@server/billing/cancelAccountSubscriptions', () => ({
  cancelAccountSubscriptions: effects.cancel,
  readAccountSubscriptionCustomerIds: vi.fn(async () => []),
  SINGLE_USER_CANCEL_BUDGET_MS: 1000,
  NO_SUBSCRIPTIONS_CANCELED: { canceled: [], failed: [] },
}));

import { hardDeleteUser } from '@server/services/hardDeleteUser';
import { reapplyErasure } from './reapplyErasure';

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
  for (const name of mongoose.modelNames())
    await mongoose.connection.collection(mongoose.model(name).collection.name).deleteMany({});
});

/** Seeds an account with a personal org and a notebook; returns a function that puts the same rows back. */
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
/** The restore overwrites the erased account's rows with their pre-erasure state. */
const restoreAccount = async (id: string, insertRows: () => Promise<void>) => {
  await raw(User).deleteMany({ _id: new mongoose.Types.ObjectId(id) });
  await raw(Organization).deleteMany({ userId: id });
  await raw(Session).deleteMany({ userId: id });
  await insertRows();
};
const rowCounts = async () => ({
  users: await raw(User).countDocuments(),
  orgs: await raw(Organization).countDocuments(),
  sessions: await raw(Session).countDocuments(),
});

describe('reapplyErasure after a simulated restore', () => {
  it.each(['self', 'admin'] as const)('re-erases a %s-erased account and sends nothing', async initiatedBy => {
    const { id, insertRows } = await seedAccount();
    const bystander = await seedAccount();
    await hardDeleteUser(id, { deletedBy: id, initiatedBy, logger }, users => users.delete(id));
    const record = await ErasureRecordModel.findOne({ idHash: erasureIdHash(id) }).lean();
    expect(record?.initiatedBy).toBe(initiatedBy);
    expect(JSON.stringify(record)).not.toContain(id);

    // The restore: the user row (and, for a self erasure that removed them, its content) come back.
    await ErasureRecordModel.deleteMany({}); // the restored database has no record of the erasure
    await restoreAccount(id, insertRows);
    vi.clearAllMocks();

    const result = await reapplyErasure(id, { record: record!, logger });

    expect(result.ownedOrganizationIds).toEqual([]);
    // The repeat leaves the restored database holding the record again.
    expect(await ErasureRecordModel.countDocuments({ idHash: record!.idHash })).toBe(1);
    const counts = await rowCounts();
    // The bystander keeps every row. A self erasure removed content and the personal org; an admin one
    // never did, so neither does the repeat.
    const mine = initiatedBy === 'self' ? 0 : 1;
    expect(counts).toEqual({ users: 1, orgs: 1 + mine, sessions: 1 + mine });
    expect(await raw(User).countDocuments({ _id: new mongoose.Types.ObjectId(id) })).toBe(0);
    expect(await raw(User).countDocuments({ _id: new mongoose.Types.ObjectId(bystander.id) })).toBe(1);
    expect(await raw(Organization).countDocuments({ userId: id })).toBe(mine);
    expect(await raw(Organization).countDocuments({ userId: bystander.id })).toBe(1);
    expect(await raw(Session).countDocuments({ userId: bystander.id })).toBe(1);
    expect(effects.cancel).not.toHaveBeenCalled();
    expect(effects.billingEvent).not.toHaveBeenCalled();
    expect(effects.email).not.toHaveBeenCalled();
    expect(effects.purge).toHaveBeenCalledTimes(1);
    expect(effects.purge).toHaveBeenCalledWith(id, expect.objectContaining({ integrationGrants: null }));
  });

  it('reports a non-personal organisation the restored account still owned, by org id', async () => {
    const { id, insertRows } = await seedAccount();
    await hardDeleteUser(id, { deletedBy: id, initiatedBy: 'admin', logger }, users => users.delete(id));
    const record = (await ErasureRecordModel.findOne({ idHash: erasureIdHash(id) }).lean())!;
    await restoreAccount(id, insertRows);
    const teamOrg = new mongoose.Types.ObjectId();
    await raw(Organization).insertOne({ _id: teamOrg, name: 'Team', userId: id, personal: false, deletedAt: null });

    const result = await reapplyErasure(id, { record, logger });
    expect(result.ownedOrganizationIds).toEqual([String(teamOrg)]);
  });
});
