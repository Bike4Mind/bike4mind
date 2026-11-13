// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Organization, OrganizationAuditEventModel } from '@bike4mind/database/infra';
import { User, OrgAdminNotificationPrefModel } from '@bike4mind/database';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const captured = vi.hoisted(() => ({ routes: [] as Record<string, Handler>[], platformAudit: vi.fn() }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, Handler> = {};
    captured.routes.push(routes);
    const chain = {
      get: (handler: Handler) => {
        routes.get = handler;
        return chain;
      },
      put: (handler: Handler) => {
        routes.put = handler;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: <T>(handler: T) => handler }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest: captured.platformAudit }));
import '../alert-settings';
import '../my-notification-prefs';
let replica: MongoMemoryReplSet;
const ownerId = new mongoose.Types.ObjectId();
const settings = { enabled: true, monthlyBudgetCredits: 1000, percentThresholds: [80], lowBalanceCredits: 0 };
beforeAll(async () => {
  replica = await createMongoReplSet();
  await mongoose.connect(replica.getUri());
  await settleAutoIndexBuilds(mongoose);
});
beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  await Promise.all([
    Organization.createCollection(),
    OrganizationAuditEventModel.createCollection(),
    OrgAdminNotificationPrefModel.createCollection(),
  ]);
  await OrgAdminNotificationPrefModel.ensureIndexes();
  await User.collection.insertOne({ _id: ownerId });
  captured.platformAudit.mockClear();
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await mongoose.disconnect();
  await replica.stop();
});
async function request(route: number, method: string, id: string, body?: unknown, userId = ownerId.toHexString()) {
  const { req, res } = createMocks({ query: { id }, body });
  Object.assign(req, { user: { id: userId, impersonatedBy: 'real-admin' } });
  await captured.routes[route][method](req, res);
  return res;
}
const team = () => Organization.create({ name: 'Team', personal: false, userId: ownerId.toHexString() });
describe('organization alert HTTP transaction boundaries', () => {
  it('commits exactly one bounded policy audit for the real actor, using the canonical organization', async () => {
    const org = await team();
    await request(0, 'put', org.id.toUpperCase(), settings);
    expect((await Organization.findById(org.id).lean())?.budgetAlerts).toMatchObject(settings);
    const events = await OrganizationAuditEventModel.find({}).lean();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      organizationId: org.id,
      actorUserId: 'real-admin',
      action: 'policy.updated',
      targetId: 'budget-alerts',
    });
    expect(captured.platformAudit).toHaveBeenCalledOnce();
  });
  it('rolls policy back when strict audit insertion fails, then retries without a duplicate event', async () => {
    const org = await team();
    vi.spyOn(OrganizationAuditEventModel, 'create').mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(request(0, 'put', org.id, settings)).rejects.toThrow('audit unavailable');
    expect((await Organization.findById(org.id).lean())?.budgetAlerts?.enabled).not.toBe(true);
    expect(await OrganizationAuditEventModel.countDocuments({})).toBe(0);
    expect(captured.platformAudit).not.toHaveBeenCalled();
    await request(0, 'put', org.id, settings);
    expect(await OrganizationAuditEventModel.countDocuments({})).toBe(1);
  });
  it('round-trips uppercase ingress and legacy aliases without losing an owner opt-out', async () => {
    const org = await team();
    await OrgAdminNotificationPrefModel.collection.insertOne({
      organizationId: org.id.toUpperCase(),
      userId: ownerId.toHexString(),
      kinds: { low_balance: false },
    });
    expect((await request(1, 'get', org.id))._getJSONData().kinds.low_balance).toBe(false);
    await request(1, 'put', org.id.toUpperCase(), { kinds: { seat_limit: false } });
    expect(await OrgAdminNotificationPrefModel.findOne({ organizationId: org.id }).lean()).toMatchObject({
      kinds: { seat_limit: false, low_balance: false },
    });
    expect((await request(1, 'get', org.id.toUpperCase()))._getJSONData().kinds.low_balance).toBe(false);
  });
  it('refuses new preferences after permanent purge has started', async () => {
    const org = await team();
    await User.collection.updateOne({ _id: ownerId }, { $set: { deletion: { purgeStartedAt: new Date() } } });
    await expect(request(1, 'put', org.id, { kinds: { low_balance: true } })).rejects.toThrow('Account unavailable');
    expect(await OrgAdminNotificationPrefModel.countDocuments({})).toBe(0);
  });
  it('preserves organization recipient gates for outsiders and personal teams', async () => {
    const org = await team();
    await expect(request(1, 'put', org.id, { kinds: {} }, new mongoose.Types.ObjectId().toHexString())).rejects.toThrow(
      'Organization not found'
    );
    await Organization.updateOne({ _id: org.id }, { $set: { personal: true } });
    await expect(request(1, 'put', org.id, { kinds: {} })).rejects.toThrow('Organization not found');
  });
});
