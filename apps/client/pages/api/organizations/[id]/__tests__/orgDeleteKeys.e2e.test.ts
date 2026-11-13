// @vitest-environment node
/**
 * Deleting an organization through DELETE /api/organizations/[id], against a real replica set: the org's
 * own API keys stop authenticating and its service account is retired, while members' personal keys
 * keep working.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ApiKeyScope, ApiKeyStatus, Permission, type IOrgApiKeySecretResponse } from '@bike4mind/common';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';
import { Organization, User } from '@bike4mind/database';
import { userApiKeyRepository, userRepository } from '@bike4mind/database/auth';
import { organizationRepository } from '@bike4mind/database/infra';
import { userApiKeyService } from '@bike4mind/services';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    type Handler = (req: unknown, res: unknown) => unknown;
    const routes: Record<string, Handler> = {};
    const chain = {
      routes,
      use: () => chain,
      get: (handler: Handler) => ((routes.GET = handler), chain),
      put: (handler: Handler) => ((routes.PUT = handler), chain),
      post: (handler: Handler) => ((routes.POST = handler), chain),
      delete: (handler: Handler) => ((routes.DELETE = handler), chain),
    };
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  recordAdminActionFromRequest: vi.fn().mockResolvedValue(null),
  parseAdminActionReason: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/utils/apiKeyAccessGate', () => ({
  assertApiKeyAccessAllowed: vi.fn().mockResolvedValue(undefined),
}));
const endKeyRealtimeConnections = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@server/utils/adminApiKeyActions', () => ({ endKeyRealtimeConnections }));

const { default: orgHandler } = await import('@pages/api/organizations/[id]/index');
const { default: orgKeysHandler } = await import('@pages/api/organizations/[id]/api-keys/index');

type Route = { routes: Record<string, (req: unknown, res: unknown) => Promise<unknown>> };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

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
  vi.clearAllMocks();
  await mongoose.connection.dropDatabase();
});

const newUser = (name: string) =>
  User.create({ name, username: `${name}-${new mongoose.Types.ObjectId()}`, password: null, hasUsablePassword: false });

async function call<T>(
  route: unknown,
  method: 'POST' | 'DELETE',
  userId: string,
  query: Record<string, string>,
  body?: unknown
): Promise<{ statusCode: number; data: T }> {
  const { req, res } = createMocks({ method, query, body });
  Object.assign(req, { user: await User.findById(userId), logger });
  await (route as Route).routes[method]!(req, res);
  return { statusCode: res._getStatusCode(), data: res._getJSONData() as T };
}

const validate = (key: string) =>
  userApiKeyService.validateUserApiKey(key, { db: { userApiKeys: userApiKeyRepository } });

async function seedOrgWithKey() {
  const [owner, member] = await Promise.all([newUser('owner'), newUser('member')]);
  const org = await Organization.create({
    name: 'Acme',
    userId: owner.id,
    seats: 5,
    users: [{ userId: member.id, permissions: [Permission.read] }],
  });
  const orgId = String(org._id);
  const created = await call<IOrgApiKeySecretResponse>(
    orgKeysHandler,
    'POST',
    owner.id,
    { id: orgId },
    { name: 'Reporting service', scopes: [ApiKeyScope.AI_CHAT] }
  );
  expect(created.statusCode).toBe(201);
  return { owner, member, orgId, created: created.data };
}

describe('DELETE /api/organizations/[id] with org-owned API keys', () => {
  it("revokes the org's keys, retires its service account, and leaves a member's personal key alone", async () => {
    const { owner, member, orgId, created } = await seedOrgWithKey();
    const personal = await userApiKeyService.createUserApiKey(
      member.id,
      { name: 'Personal', scopes: [ApiKeyScope.AI_CHAT], metadata: { createdFrom: 'dashboard' } },
      {
        db: { userApiKeys: userApiKeyRepository, agents: { findById: async () => null } },
        trust: { status: 'trusted' },
      }
    );
    expect((await validate(created.key)).isValid).toBe(true);
    const serviceAccountId = (await userApiKeyRepository.findById(created.apiKey.id))!.userId;

    const deleted = await call<{ id: string }>(orgHandler, 'DELETE', owner.id, { id: orgId });
    expect(deleted.statusCode).toBe(200);

    // A disabled key is never found by prefix, so apiKeyAuth answers 'Invalid API key', not a billing error.
    expect(await validate(created.key)).toEqual({ isValid: false, reason: 'not_found' });
    expect(await userApiKeyRepository.findById(created.apiKey.id)).toMatchObject({
      status: ApiKeyStatus.DISABLED,
      revokedBy: owner.id,
      revokedReason: 'organization_deleted',
      revokedAt: expect.any(Date),
    });
    const serviceAccount = await userRepository.findById(String(serviceAccountId));
    expect(serviceAccount?.serviceAccountRetiredAt).toBeInstanceOf(Date);
    expect(serviceAccount?.isBanned).toBeFalsy();
    expect(endKeyRealtimeConnections).toHaveBeenCalledWith(created.apiKey.id, logger);

    expect((await validate(personal.key)).isValid).toBe(true);
  });

  it('refuses to mint into the retired service account if the org is restored', async () => {
    const { owner, orgId } = await seedOrgWithKey();
    await call(orgHandler, 'DELETE', owner.id, { id: orgId });
    await Organization.updateOne({ _id: orgId }, { $set: { deletedAt: null } }, { includeDeleted: true });

    await expect(
      call(orgKeysHandler, 'POST', owner.id, { id: orgId }, { name: 'Again', scopes: [ApiKeyScope.AI_CHAT] })
    ).rejects.toThrow(/retired/);
  });

  it('rolls the key revoke back when the org delete fails, so the keys stay live with the org', async () => {
    const { owner, orgId, created } = await seedOrgWithKey();
    const spy = vi.spyOn(organizationRepository, 'delete').mockRejectedValueOnce(new Error('write failed'));

    await expect(call(orgHandler, 'DELETE', owner.id, { id: orgId })).rejects.toThrow('write failed');
    spy.mockRestore();

    expect((await validate(created.key)).isValid).toBe(true);
    const serviceAccountId = (await userApiKeyRepository.findById(created.apiKey.id))!.userId;
    expect((await userRepository.findById(String(serviceAccountId)))?.serviceAccountRetiredAt).toBeUndefined();
  });

  it('deletes an org that never created a key', async () => {
    const owner = await newUser('owner');
    const org = await Organization.create({ name: 'Plain', userId: owner.id, seats: 1, users: [] });

    const deleted = await call(orgHandler, 'DELETE', owner.id, { id: String(org._id) });

    expect(deleted.statusCode).toBe(200);
    expect(endKeyRealtimeConnections).not.toHaveBeenCalled();
  });
});
