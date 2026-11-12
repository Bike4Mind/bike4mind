// @vitest-environment node
/**
 * Members' org-billed API keys as the org's owner and managers see them, against a real replica set:
 * the list's scoping and projection, and the usage fields real traffic writes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ApiKeyScope, CreditHolderType, Permission, type IOrgMemberApiKeyView } from '@bike4mind/common';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';
import { Organization, User } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { userApiKeyService } from '@bike4mind/services';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const baseApiOptions = vi.hoisted(() => [] as unknown[]);
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    baseApiOptions.push(options);
    type Handler = (req: unknown, res: unknown) => unknown;
    const routes: Record<string, Handler> = {};
    const chain = {
      routes,
      get: (handler: Handler) => ((routes.GET = handler), chain),
      post: (handler: Handler) => ((routes.POST = handler), chain),
    };
    return chain;
  },
}));

const { default: listHandler } = await import('@pages/api/organizations/[id]/api-keys/members/index');

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
  method: 'GET' | 'POST',
  userId: string,
  query: Record<string, string>,
  body?: unknown
): Promise<{ statusCode: number; data: T }> {
  const { req, res } = createMocks({ method, query, body });
  Object.assign(req, { user: await User.findById(userId), logger });
  try {
    await (route as Route).routes[method]!(req, res);
  } catch (err) {
    const { statusCode } = err as { statusCode?: number };
    if (statusCode === undefined) throw err;
    return { statusCode, data: undefined as T };
  }
  return { statusCode: res._getStatusCode(), data: JSON.parse(JSON.stringify(res._getJSONData())) as T };
}

/** Owner, a manager, a key-holding member and a plain member in one org, plus another org's owner. */
async function seedOrg() {
  const [owner, manager, holder, member, otherOwner] = await Promise.all(
    ['owner', 'manager', 'holder', 'member', 'other-owner'].map(newUser)
  );
  const org = await Organization.create({
    name: 'Acme',
    userId: owner.id,
    seats: 5,
    adminUserIds: [manager.id],
    users: [
      { userId: manager.id, permissions: [Permission.read, Permission.update] },
      { userId: holder.id, permissions: [Permission.read] },
      { userId: member.id, permissions: [Permission.read] },
    ],
  });
  const otherOrg = await Organization.create({ name: 'Other', userId: otherOwner.id, seats: 5, users: [] });
  return { owner, manager, holder, member, otherOwner, orgId: String(org._id), otherOrgId: String(otherOrg._id) };
}

const mintKey = (
  userId: string,
  name: string,
  billing: { organizationId: string; orgOwned?: { createdByUserId: string } } | null
) =>
  userApiKeyService.createUserApiKey(
    userId,
    {
      name,
      scopes: [ApiKeyScope.AI_CHAT],
      metadata: { createdFrom: 'dashboard' },
      ...(billing ? { billingOwnerType: CreditHolderType.Organization, ...billing } : {}),
    },
    { db: { userApiKeys: userApiKeyRepository, agents: { findById: async () => null } } }
  );

describe('org member API keys', () => {
  it('accept a session only, never an API key', () => {
    expect(baseApiOptions).toEqual([{ auth: 'jwtOnly' }]);
  });

  it('lists only members keys billed to this org, to its owner and managers', async () => {
    const { owner, manager, holder, member, otherOwner, orgId, otherOrgId } = await seedOrg();
    const billed = await mintKey(holder.id, 'Billed to Acme', { organizationId: orgId });
    await mintKey(holder.id, 'Personal', null);
    await mintKey(holder.id, 'Billed elsewhere', { organizationId: otherOrgId });
    await mintKey(manager.id, 'Org-owned', { organizationId: orgId, orgOwned: { createdByUserId: manager.id } });
    // A user-billed row that still carries the org id must not leak onto the org's surface.
    await userApiKeyRepository.create({
      userId: holder.id,
      name: 'User-billed with org id',
      keyHash: '$2b$12$abcdefghijklmnopqrstuv',
      keyPrefix: 'b4m_live_e2e00002',
      scopes: [ApiKeyScope.AI_CHAT],
      metadata: { createdFrom: 'dashboard' },
      billingOwnerType: CreditHolderType.User,
      organizationId: orgId,
    });

    for (const viewer of [owner, manager]) {
      const listed = await call<IOrgMemberApiKeyView[]>(listHandler, 'GET', viewer.id, { id: orgId });
      expect(listed.statusCode).toBe(200);
      expect(listed.data.map(key => key.id)).toEqual([billed.id]);
      expect(listed.data[0]).toMatchObject({
        name: 'Billed to Acme',
        keyPrefix: billed.keyPrefix,
        scopes: [ApiKeyScope.AI_CHAT],
        status: 'ACTIVE',
        creditsUsed: 0,
        createdBy: { id: holder.id, name: 'holder' },
      });
      expect(Object.keys(listed.data[0]).sort()).toEqual(
        ['createdAt', 'createdBy', 'creditsUsed', 'id', 'keyPrefix', 'name', 'scopes', 'status'].sort()
      );
    }

    expect((await call(listHandler, 'GET', member.id, { id: orgId })).statusCode).toBe(404);
    expect((await call(listHandler, 'GET', otherOwner.id, { id: orgId })).statusCode).toBe(404);
  });

  it('reports the last use and settled spend that real traffic writes, and survives the holder leaving', async () => {
    const { owner, holder, orgId } = await seedOrg();
    const billed = await mintKey(holder.id, 'Busy', { organizationId: orgId });

    const validation = await userApiKeyService.validateUserApiKey(billed.key, {
      db: { userApiKeys: userApiKeyRepository },
    });
    expect(validation.isValid).toBe(true);
    // validate stamps lastUsedAt fire-and-forget.
    await vi.waitFor(async () => expect((await userApiKeyRepository.findById(billed.id))?.lastUsedAt).toBeDefined());
    await userApiKeyRepository.incrementSpend(billed.id, 12.5);

    await Organization.updateOne({ _id: orgId }, { $pull: { users: { userId: holder.id } } });
    await User.deleteOne({ _id: holder.id });

    const listed = await call<IOrgMemberApiKeyView[]>(listHandler, 'GET', owner.id, { id: orgId });
    expect(listed.data).toEqual([
      expect.objectContaining({
        id: billed.id,
        creditsUsed: 12.5,
        lastUsedAt: expect.any(String),
        createdBy: { id: holder.id, name: null },
      }),
    ]);
  });
});
