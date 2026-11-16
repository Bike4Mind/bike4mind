// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Organization, OrganizationAuditEventModel } from '@bike4mind/database/infra';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const routes = vi.hoisted(() => ({ put: undefined as Handler | undefined }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = {
      get: () => chain,
      put: (handler: Handler) => {
        routes.put = handler;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: <T>(handler: T) => handler }));
import '../mfa-policy';

let replica: MongoMemoryReplSet;
beforeAll(async () => {
  replica = await createMongoReplSet();
  await mongoose.connect(replica.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
beforeEach(async () => {
  await Organization.createCollection();
  await OrganizationAuditEventModel.createCollection();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await mongoose.connection.dropDatabase();
});
afterAll(async () => {
  await mongoose.disconnect();
  await replica?.stop();
});

async function changePolicy(id: string, required: boolean, impersonatedBy?: string) {
  const { req, res } = createMocks({
    method: 'PUT',
    query: { id },
    body: { required, graceDays: 0 },
  });
  Object.assign(req, { user: { id: 'owner', impersonatedBy } });
  if (!routes.put) throw new Error('MFA policy route not registered');
  await routes.put(req, res);
  return res;
}

describe('MFA policy and organization audit transaction', () => {
  it('commits the policy with a bounded organization-visible event', async () => {
    const organization = await Organization.create({ name: 'Team', userId: 'owner', personal: false });
    const response = await changePolicy(organization.id, true);
    expect(response._getStatusCode()).toBe(200);
    expect((await Organization.findById(organization.id).lean())?.mfaPolicy?.required).toBe(true);
    const events = await OrganizationAuditEventModel.find({ organizationId: organization.id }).lean();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      organizationId: organization.id,
      actorUserId: 'owner',
      action: 'policy.updated',
      targetId: 'mfa',
    });
    expect(events[0].occurredAt).toBeInstanceOf(Date);
    expect(Object.keys(events[0]).sort()).toEqual(
      ['_id', 'organizationId', 'actorUserId', 'action', 'targetId', 'occurredAt'].sort()
    );
  });

  it('records the trusted real admin when the owner is impersonated', async () => {
    const organization = await Organization.create({
      name: 'Team',
      userId: 'owner',
      personal: false,
      mfaPolicy: { required: true, graceEndsAt: new Date() },
    });
    await changePolicy(organization.id, false, 'real-admin');
    expect((await Organization.findById(organization.id).lean())?.mfaPolicy).toEqual({
      required: false,
      graceEndsAt: null,
    });
    expect(await OrganizationAuditEventModel.findOne({ organizationId: organization.id }).lean()).toMatchObject({
      actorUserId: 'real-admin',
      action: 'policy.updated',
      targetId: 'mfa',
    });
  });

  it('rolls back a policy change when the audit write fails', async () => {
    const policy = { required: false, graceEndsAt: null };
    const organization = await Organization.create({
      name: 'Team',
      userId: 'owner',
      personal: false,
      mfaPolicy: policy,
    });
    vi.spyOn(OrganizationAuditEventModel, 'create').mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(changePolicy(organization.id, true)).rejects.toThrow('audit unavailable');
    expect((await Organization.findById(organization.id).lean())?.mfaPolicy).toEqual(policy);
    expect(await OrganizationAuditEventModel.countDocuments({})).toBe(0);
  });
});
