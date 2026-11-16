// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Organization, OrganizationAuditEventModel } from '@bike4mind/database/infra';
import { BriefcasePrompt, OrganizationLibrary } from '@bike4mind/database/content';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const routes = vi.hoisted(() => ({ handlers: {} as Record<string, Handler> }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const register = (method: string, handler: Handler) => {
      routes.handlers[method] = handler;
      return chain;
    };
    const chain = {
      get: (handler: Handler) => register('get', handler),
      post: (_csrf: unknown, handler: Handler) => register('post', handler),
      patch: (_csrf: unknown, handler: Handler) => register('patch', handler),
      delete: (_csrf: unknown, handler: Handler) => register('delete', handler),
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: vi.fn() }));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: <T>(handler: T) => handler }));
import '../library';

let replica: MongoMemoryReplSet;
beforeAll(async () => {
  replica = await createMongoReplSet();
  await mongoose.connect(replica.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
beforeEach(async () => {
  await Promise.all(
    [Organization, OrganizationLibrary, OrganizationAuditEventModel, BriefcasePrompt].map(model =>
      model.createCollection()
    )
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await mongoose.connection.dropDatabase();
});
afterAll(async () => {
  await mongoose.disconnect();
  await replica?.stop();
});
async function request(method: string, organizationId: string, body: unknown = {}, userId = 'owner') {
  const { req, res } = createMocks({ query: { id: organizationId }, body });
  Object.assign(req, { user: { id: userId, impersonatedBy: 'real-admin' } });
  await routes.handlers[method](req, res);
  return res;
}
async function fixture() {
  const organization = await Organization.create({ name: 'Team', userId: 'owner', personal: false });
  const source = await BriefcasePrompt.create({
    userId: 'owner',
    name: 'Helper',
    description: 'Help',
    type: 'writing',
    promptText: 'PRIVATE SOURCE CONTENT',
    tags: [],
    executionMode: 'auto-fire',
    requiredTools: [],
  });
  return { organization, source };
}
async function publishedItem() {
  const { organization, source } = await fixture();
  await request('post', organization.id, { kind: 'prompt', sourceId: source.id });
  const item = await OrganizationLibrary.findOne({ organizationId: organization.id }).orFail();
  await OrganizationAuditEventModel.collection.deleteMany({});
  return { organization, item };
}
describe('library strict organization audit transaction', () => {
  it('publishes, pins, unpins and removes with canonical organization IDs and bounded events', async () => {
    const { organization, source } = await fixture();
    const ingress = organization.id.toUpperCase();
    expect((await request('post', ingress, { kind: 'prompt', sourceId: source.id }))._getStatusCode()).toBe(201);
    const item = await OrganizationLibrary.findOne({ organizationId: organization.id }).orFail();
    await request('patch', ingress, { itemId: item.id, pinned: true });
    await request('patch', ingress, { itemId: item.id, pinned: true });
    await request('patch', ingress, { itemId: item.id, pinned: false });
    expect((await request('delete', ingress, { itemId: item.id }))._getStatusCode()).toBe(204);
    const events = await OrganizationAuditEventModel.find({}).sort({ occurredAt: 1 }).lean();
    expect(events.map(event => event.action)).toEqual([
      'library.published',
      'library.pinned',
      'library.unpinned',
      'library.removed',
    ]);
    for (const event of events) {
      expect(event).toMatchObject({ organizationId: organization.id, actorUserId: 'real-admin', targetId: item.id });
      expect(Object.keys(event).sort()).toEqual(
        ['_id', 'organizationId', 'actorUserId', 'action', 'targetId', 'occurredAt'].sort()
      );
    }
    expect(await OrganizationLibrary.countDocuments({})).toBe(0);
  });
  it('rolls back publication when strict audit insertion fails', async () => {
    const { organization, source } = await fixture();
    vi.spyOn(OrganizationAuditEventModel, 'create').mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(request('post', organization.id, { kind: 'prompt', sourceId: source.id })).rejects.toThrow(
      'audit unavailable'
    );
    expect(await OrganizationLibrary.countDocuments({})).toBe(0);
    expect(await OrganizationAuditEventModel.countDocuments({})).toBe(0);
  });
  it.each(['patch', 'delete'])('rolls back %s when strict audit insertion fails', async method => {
    const { organization, item } = await publishedItem();
    vi.spyOn(OrganizationAuditEventModel, 'create').mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(request(method, organization.id, { itemId: item.id, pinned: true })).rejects.toThrow(
      'audit unavailable'
    );
    expect(await OrganizationLibrary.findById(item.id).lean()).toMatchObject({ pinned: false });
    expect(await OrganizationAuditEventModel.countDocuments({})).toBe(0);
  });
  it('does not emit success events for no-ops, absent or cross-organization items', async () => {
    const { organization, item } = await publishedItem();
    await request('patch', organization.id, { itemId: item.id, pinned: false });
    const other = await Organization.create({ name: 'Other', userId: 'owner', personal: false });
    for (const method of ['patch', 'delete']) {
      await expect(request(method, other.id, { itemId: item.id, pinned: true })).rejects.toThrow(
        'Library item not found'
      );
      await expect(
        request(method, organization.id, { itemId: new mongoose.Types.ObjectId().toString(), pinned: true })
      ).rejects.toThrow('Library item not found');
    }
    expect(await OrganizationAuditEventModel.countDocuments({})).toBe(0);
    expect(await OrganizationLibrary.countDocuments({})).toBe(1);
  });
  it('rejects nonmembers and personal sources belonging to another author', async () => {
    const { organization, source } = await fixture();
    await expect(request('post', organization.id, { kind: 'prompt', sourceId: source.id }, 'outsider')).rejects.toThrow(
      'Organization not found'
    );
    await BriefcasePrompt.updateOne({ _id: source.id }, { $set: { userId: 'outsider' } });
    await expect(request('post', organization.id, { kind: 'prompt', sourceId: source.id })).rejects.toThrow(
      'Owned source not found'
    );
    expect(await OrganizationLibrary.countDocuments({})).toBe(0);
    expect(await OrganizationAuditEventModel.countDocuments({})).toBe(0);
  });
});
