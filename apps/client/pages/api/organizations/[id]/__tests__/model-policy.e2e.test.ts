// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Organization, OrganizationAuditEventModel, AdminAuditLogModel } from '@bike4mind/database/infra';
import { organizationRepository, User } from '@bike4mind/database';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const captured = vi.hoisted(() => ({ handlers: {} as Record<string, Handler>, auth: undefined as unknown }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (auth: unknown) => {
    captured.auth = auth;
    const chain = {
      get: (handler: Handler) => {
        captured.handlers.get = handler;
        return chain;
      },
      put: (handler: Handler) => {
        captured.handlers.put = handler;
        return chain;
      },
      delete: (handler: Handler) => {
        captured.handlers.delete = handler;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: <T>(handler: T) => handler }));
import '../model-policy';

let replica: MongoMemoryReplSet;
const ownerId = new mongoose.Types.ObjectId();
const adminId = new mongoose.Types.ObjectId();
const owner = { id: ownerId.toHexString(), username: 'policy-owner', name: 'Owner', isAdmin: false };
const unrestricted = { allowedProviders: null, allowedModels: null, allowedTools: null };

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
    AdminAuditLogModel.createCollection(),
    User.createCollection(),
  ]);
  await User.collection.insertMany([
    { _id: ownerId, username: owner.username, name: owner.name, email: 'policy-owner@example.test', isAdmin: false },
    {
      _id: adminId,
      username: 'policy-admin',
      name: 'Administrator',
      email: 'policy-admin@example.test',
      isAdmin: true,
    },
  ]);
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await mongoose.disconnect();
  await replica.stop();
});

const team = (modelPolicy?: unknown) =>
  Organization.create({
    name: 'Policy team',
    userId: owner.id,
    personal: false,
    modelPolicy,
  });

async function request(
  method: string,
  id: string,
  body?: unknown,
  identity = { ...owner, impersonatedBy: adminId.toHexString() }
) {
  const { req, res } = createMocks({
    method: method.toUpperCase() as 'GET',
    url: `/api/organizations/${id}/model-policy`,
    query: { id },
    body,
  });
  Object.assign(req, { user: identity, logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } });
  await captured.handlers[method](req, res);
  return res;
}

const platformEntries = () => AdminAuditLogModel.find({ action: 'org.model_policy.updated' }).lean();

describe('model policy HTTP transaction boundaries', () => {
  it('commits one strict event and one real platform audit with the actual impersonator', async () => {
    const org = await team();
    expect(captured.auth).toEqual({ auth: 'jwtOnly' });
    await request('put', org.id.toUpperCase(), { allowedTools: [] });
    expect((await Organization.findById(org.id).lean())?.modelPolicy).toEqual({ allowedTools: [] });
    const events = await OrganizationAuditEventModel.find({}).lean();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      organizationId: org.id,
      actorUserId: adminId.toHexString(),
      action: 'policy.updated',
      targetId: 'model-policy',
    });
    const platform = await platformEntries();
    expect(platform).toHaveLength(1);
    expect(platform[0]).toMatchObject({
      actor: { userId: adminId.toHexString(), impersonatedUserId: owner.id },
      target: { id: org.id },
    });
  });

  it('rolls back the policy when the strict persistence sink fails, then retries once', async () => {
    const before = { allowedModels: ['old-model'] };
    const org = await team(before);
    vi.spyOn(OrganizationAuditEventModel, 'create').mockRejectedValueOnce(new Error('strict audit unavailable'));
    await expect(request('put', org.id, { allowedModels: ['new-model'] })).rejects.toThrow('strict audit unavailable');
    expect((await Organization.findById(org.id).lean())?.modelPolicy).toEqual(before);
    expect(await OrganizationAuditEventModel.countDocuments({})).toBe(0);
    expect(await platformEntries()).toHaveLength(0);
    await request('put', org.id, { allowedModels: ['new-model'] });
    expect((await Organization.findById(org.id).lean())?.modelPolicy).toEqual({ allowedModels: ['new-model'] });
    expect(await OrganizationAuditEventModel.countDocuments({})).toBe(1);
    expect(await platformEntries()).toHaveLength(1);
  });

  it('does not emit events for reordered no-op PUT or repeated DELETE', async () => {
    const org = await team({ allowedProviders: ['openai', 'anthropic'] });
    await request('put', org.id, { allowedProviders: ['anthropic', 'openai'] });
    expect(await OrganizationAuditEventModel.countDocuments({})).toBe(0);
    expect(await platformEntries()).toHaveLength(0);
    await request('delete', org.id);
    await request('delete', org.id);
    expect((await Organization.findById(org.id).lean())?.modelPolicy).toBeUndefined();
    expect(await OrganizationAuditEventModel.countDocuments({})).toBe(1);
    expect(await platformEntries()).toHaveLength(1);
  });

  it('repairs a malformed raw policy to unrestricted with exactly one event despite an empty diff', async () => {
    const org = await team();
    await Organization.collection.updateOne(
      { _id: org._id },
      { $set: { modelPolicy: { allowedProviders: 'openai' } } }
    );
    expect((await request('get', org.id))._getJSONData()).toEqual({ policy: unrestricted, invalidStored: true });
    await request('put', org.id, {});
    await request('put', org.id, {});
    expect((await Organization.findById(org.id).lean())?.modelPolicy).toBeUndefined();
    expect(await OrganizationAuditEventModel.countDocuments({})).toBe(1);
    const platform = await platformEntries();
    expect(platform).toHaveLength(1);
    expect(platform[0].changes ?? []).toEqual([]);
  });

  it('round-trips obsolete selections but rejects them on strict writes until repaired', async () => {
    const stored = { allowedProviders: ['retired-provider'], allowedTools: ['removed_tool'] };
    const org = await team(stored);
    expect((await request('get', org.id))._getJSONData()).toEqual({
      policy: { ...unrestricted, ...stored },
      invalidStored: false,
    });
    await expect(request('put', org.id, stored)).rejects.toMatchObject({ statusCode: 400 });
    expect((await Organization.findById(org.id).lean())?.modelPolicy).toEqual(stored);
    expect(await OrganizationAuditEventModel.countDocuments({})).toBe(0);
    await request('put', org.id, { allowedProviders: ['openai'] });
    expect(await OrganizationAuditEventModel.countDocuments({})).toBe(1);
  });

  it('retains the committed strict event when the platform best-effort append fails', async () => {
    const org = await team();
    vi.spyOn(AdminAuditLogModel, 'create').mockRejectedValueOnce(new Error('platform audit unavailable'));
    await request('put', org.id, { allowedTools: [] });
    expect((await Organization.findById(org.id).lean())?.modelPolicy).toEqual({ allowedTools: [] });
    expect(await OrganizationAuditEventModel.countDocuments({})).toBe(1);
    expect(await platformEntries()).toHaveLength(0);
    await request('delete', org.id);
    expect(await OrganizationAuditEventModel.countDocuments({})).toBe(2);
    expect(await platformEntries()).toHaveLength(1);
  });

  it('re-reads the before value on a real write-conflict retry without duplicate audit events', async () => {
    const org = await team({ allowedModels: ['original'] });
    const update = organizationRepository.update.bind(organizationRepository);
    let enter: (() => void) | undefined;
    let release: (() => void) | undefined;
    const entered = new Promise<void>(resolve => {
      enter = resolve;
    });
    const resume = new Promise<void>(resolve => {
      release = resolve;
    });
    let intercepted = false;
    vi.spyOn(organizationRepository, 'update').mockImplementation(async (...args) => {
      if (!intercepted) {
        intercepted = true;
        enter?.();
        await resume;
      }
      return update(...args);
    });
    const first = request('put', org.id, { allowedModels: ['first'] });
    await entered;
    try {
      await request('put', org.id, { allowedModels: ['second'] });
    } finally {
      release?.();
    }
    await first;
    expect((await Organization.findById(org.id).lean())?.modelPolicy).toEqual({ allowedModels: ['first'] });
    expect(await OrganizationAuditEventModel.countDocuments({})).toBe(2);
    const platform = await platformEntries();
    expect(platform).toHaveLength(2);
    expect(platform.map(entry => entry.changes)).toEqual(
      expect.arrayContaining([
        [{ field: 'allowedModels', before: ['original'], after: ['second'] }],
        [{ field: 'allowedModels', before: ['second'], after: ['first'] }],
      ])
    );
  });

  it('refuses an outsider through the real authorization gate without changing state or audits', async () => {
    const org = await team();
    await expect(
      request(
        'put',
        org.id,
        { allowedTools: [] },
        {
          ...owner,
          id: new mongoose.Types.ObjectId().toHexString(),
          impersonatedBy: adminId.toHexString(),
        }
      )
    ).rejects.toMatchObject({ statusCode: 404 });
    expect((await Organization.findById(org.id).lean())?.modelPolicy).toBeUndefined();
    expect(await OrganizationAuditEventModel.countDocuments({})).toBe(0);
    expect(await platformEntries()).toHaveLength(0);
  });
});
