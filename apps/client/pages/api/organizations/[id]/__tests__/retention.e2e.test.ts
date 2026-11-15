import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMocks } from 'node-mocks-http';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { foreverRetention } from '@bike4mind/common';
import {
  Organization,
  OrganizationAuditEventModel,
  OrganizationRetentionEstimate,
  Quest,
  Session,
  User,
  userRepository,
  organizationRepository,
} from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = vi.hoisted(() => ({ handlers: {} as Record<string, Handler> }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = {
      get: (fn: Handler) => {
        h.handlers.GET = fn;
        return chain;
      },
      post: (fn: Handler) => {
        h.handlers.POST = fn;
        return chain;
      },
      put: (fn: Handler) => {
        h.handlers.PUT = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (handler: Handler) => handler }));
import '@pages/api/organizations/[id]/retention';
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let database: Awaited<ReturnType<typeof createMongoReplSet>>;
const ownerId = 'abcdefabcdefabcdefabcdef';
const administratorId = 'fedcbafedcbafedcbafedcba';
const organizationId = 'aabbccddaabbccddaabbccdd';
const next = { chats: 1, files: null, media: null };
const estimateSchema = z.object({
  token: z.string().uuid(),
  counts: z.object({ chats: z.number(), files: z.number(), media: z.number() }),
});
async function request(
  method: 'GET' | 'POST' | 'PUT',
  id = organizationId,
  body?: unknown,
  actor = ownerId,
  impersonatedBy?: string
): Promise<unknown> {
  const user = await userRepository.findById(actor);
  if (!user) throw new Error('Fixture user missing');
  const { req, res } = createMocks({ method, query: { id }, body });
  await h.handlers[method](
    Object.assign(req, { user: { ...user, ...(impersonatedBy ? { impersonatedBy } : {}) } }) as unknown as Request,
    res as unknown as Response
  );
  return res._getJSONData();
}
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
  vi.restoreAllMocks();
  for (const model of [User, Organization, OrganizationRetentionEstimate, OrganizationAuditEventModel, Session, Quest])
    await model.collection.deleteMany({});
  await User.collection.insertMany([
    { _id: new mongoose.Types.ObjectId(ownerId), username: 'owner', name: 'Owner' },
    {
      _id: new mongoose.Types.ObjectId(administratorId),
      username: 'administrator',
      name: 'Administrator',
      isAdmin: true,
    },
  ]);
  await Organization.create({
    _id: new mongoose.Types.ObjectId(organizationId),
    name: 'Retention team',
    userId: ownerId,
    personal: false,
    retentionVersion: 1,
    retentionPolicy: foreverRetention,
  });
  const sessionId = new mongoose.Types.ObjectId();
  await Session.collection.insertOne({
    _id: sessionId,
    userId: ownerId,
    retentionOrganizationId: organizationId,
    deletedAt: null,
    name: 'retained notebook',
  });
  await Quest.collection.insertOne({
    sessionId: String(sessionId),
    timestamp: new Date(Date.now() - 2 * 86400_000),
    deletedAt: null,
    prompt: 'old message',
  });
});
function barrier() {
  let release: (() => void) | undefined;
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return {
    promise,
    release: () => {
      if (!release) throw new Error('Barrier not initialized');
      release();
    },
  };
}

describe('retention route over real authorization, Mongo and strict audit', () => {
  it('returns identical nonzero estimates for uppercase paths and persists canonical ownership and the true impersonator', async () => {
    const estimate = estimateSchema.parse(
      await request('POST', organizationId.toUpperCase(), { policy: next, version: 1 })
    );
    expect(estimate.counts).toEqual({ chats: 1, files: 0, media: 0 });
    expect(await OrganizationRetentionEstimate.findOne({ token: estimate.token }).lean()).toMatchObject({
      organizationId,
      actorUserId: ownerId,
    });
    const lower = estimateSchema.parse(await request('POST', organizationId, { policy: next, version: 1 }));
    expect(lower.counts).toEqual(estimate.counts);
    await request(
      'PUT',
      organizationId.toUpperCase(),
      { policy: next, version: 1, confirmationToken: estimate.token },
      ownerId,
      administratorId
    );
    expect(await OrganizationAuditEventModel.find({}).lean()).toMatchObject([
      { organizationId, actorUserId: administratorId, targetId: 'retention:2', action: 'policy.updated' },
    ]);
    expect((await Organization.findById(organizationId).lean())?.retentionVersion).toBe(2);
  });
  it('does not let another authorized administrator consume the subject-bound confirmation', async () => {
    const estimate = estimateSchema.parse(await request('POST', organizationId, { policy: next, version: 1 }));
    await expect(
      request('PUT', organizationId, { policy: next, version: 1, confirmationToken: estimate.token }, administratorId)
    ).rejects.toThrow('estimate');
    expect(await OrganizationRetentionEstimate.countDocuments({ token: estimate.token })).toBe(1);
    expect((await Organization.findById(organizationId).lean())?.retentionVersion).toBe(1);
  });
  it('rolls back policy, version and token consumption when the real strict audit persistence fails', async () => {
    const estimate = estimateSchema.parse(await request('POST', organizationId, { policy: next, version: 1 }));
    vi.spyOn(OrganizationAuditEventModel, 'create').mockRejectedValueOnce(new Error('strict audit unavailable'));
    await expect(
      request('PUT', organizationId, { policy: next, version: 1, confirmationToken: estimate.token })
    ).rejects.toThrow('strict audit unavailable');
    expect((await Organization.findById(organizationId).lean())?.retentionPolicy).toMatchObject(foreverRetention);
    expect((await Organization.findById(organizationId).lean())?.retentionVersion).toBe(1);
    expect(await OrganizationRetentionEstimate.countDocuments({ token: estimate.token })).toBe(1);
    expect(await OrganizationAuditEventModel.countDocuments({})).toBe(0);
    await request('PUT', organizationId, { policy: next, version: 1, confirmationToken: estimate.token });
    expect(await OrganizationAuditEventModel.countDocuments({})).toBe(1);
  });
  it.each(['GET', 'POST', 'PUT'] as const)('rejects malformed %s paths before mutating records', async method => {
    await expect(request(method, 'not-an-organization', { policy: next, version: 1 })).rejects.toThrow(
      'Invalid organization id'
    );
    expect(await OrganizationRetentionEstimate.countDocuments({})).toBe(0);
    expect(await OrganizationAuditEventModel.countDocuments({})).toBe(0);
  });
  it('rechecks current authority after an admitted outer read becomes stale', async () => {
    const estimate = estimateSchema.parse(await request('POST', organizationId, { policy: next, version: 1 }));
    const admitted = barrier();
    const proceed = barrier();
    const find = organizationRepository.findById.bind(organizationRepository);
    vi.spyOn(organizationRepository, 'findById').mockImplementationOnce(async (...args) => {
      const result = await find(...args);
      admitted.release();
      await proceed.promise;
      return result;
    });
    const pending = request('PUT', organizationId, { policy: next, version: 1, confirmationToken: estimate.token });
    await admitted.promise;
    await Organization.updateOne({ _id: organizationId }, { $set: { userId: administratorId, adminUserIds: [] } });
    proceed.release();
    await expect(pending).rejects.toThrow('Organization not found');
    expect(await OrganizationRetentionEstimate.countDocuments({ token: estimate.token })).toBe(1);
    expect((await Organization.findById(organizationId).lean())?.retentionVersion).toBe(1);
    expect(await OrganizationAuditEventModel.countDocuments({})).toBe(0);
  });
  it('rechecks authority on an actual write-conflict retry before consuming the token or auditing', async () => {
    const estimate = estimateSchema.parse(await request('POST', organizationId, { policy: next, version: 1 }));
    const writing = barrier();
    const proceed = barrier();
    const update = Organization.collection.updateOne.bind(Organization.collection);
    vi.spyOn(Organization.collection, 'updateOne').mockImplementationOnce(async (...args) => {
      writing.release();
      await proceed.promise;
      return update(...args);
    });
    const pending = request('PUT', organizationId, { policy: next, version: 1, confirmationToken: estimate.token });
    await writing.promise;
    await Organization.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(organizationId) },
      { $set: { userId: administratorId, adminUserIds: [] } }
    );
    proceed.release();
    await expect(pending).rejects.toThrow('Organization not found');
    expect(await OrganizationRetentionEstimate.countDocuments({ token: estimate.token })).toBe(1);
    expect((await Organization.findById(organizationId).lean())?.retentionVersion).toBe(1);
    expect(await OrganizationAuditEventModel.countDocuments({})).toBe(0);
  });
});
