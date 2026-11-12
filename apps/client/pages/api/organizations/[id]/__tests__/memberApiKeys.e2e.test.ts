// @vitest-environment node
/**
 * Members' org-billed API keys as the org's owner and managers see them, against a real replica set:
 * the list's scoping and projection, the usage fields real traffic writes, and revoke (committing with
 * its audit row, then refused the way apiKeyAuth refuses it).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ApiKeyScope, ApiKeyStatus, CreditHolderType, Permission, type IOrgMemberApiKeyView } from '@bike4mind/common';
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

const recordAdminActionFromRequest = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest }));
const notifyApiKeyOrgRevoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@server/utils/apiKeyRotationNotifier', () => ({ notifyApiKeyOrgRevoke }));

const { default: listHandler } = await import('@pages/api/organizations/[id]/api-keys/members/index');
const { default: revokeHandler } = await import('@pages/api/organizations/[id]/api-keys/members/[keyId]/revoke');

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
    {
      db: { userApiKeys: userApiKeyRepository, agents: { findById: async () => null } },
      trust: { status: 'trusted' },
    }
  );

describe('org member API keys', () => {
  it('accept a session only, never an API key', () => {
    expect(baseApiOptions).toEqual([{ auth: 'jwtOnly' }, { auth: 'jwtOnly' }]);
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
        status: ApiKeyStatus.ACTIVE,
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

  it('revokes a member key once, audited in the same transaction, and emails its holder', async () => {
    const { owner, holder, orgId } = await seedOrg();
    const billed = await mintKey(holder.id, 'Leaky', { organizationId: orgId });
    const validate = (key: string) =>
      userApiKeyService.validateUserApiKey(key, { db: { userApiKeys: userApiKeyRepository } });

    const revoked = await call(revokeHandler, 'POST', owner.id, { id: orgId, keyId: billed.id }, { reason: 'left' });
    expect(revoked.statusCode).toBe(200);
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'org.api_key.member_revoked',
        actorScope: 'organization',
        target: { kind: 'organization', id: orgId, displayName: 'Acme' },
        details: { keyId: billed.id, keyPrefix: billed.keyPrefix, creatorUserId: holder.id, reason: 'left' },
      })
    );
    expect(notifyApiKeyOrgRevoke).toHaveBeenCalledWith(holder.id, 'Leaky', 'Acme', logger);
    expect(await validate(billed.key)).toMatchObject({ isValid: false, reason: 'not_found' });
    expect(await userApiKeyRepository.findById(billed.id)).toMatchObject({
      revokedBy: owner.id,
      revokedReason: 'left',
    });

    const again = await call(revokeHandler, 'POST', owner.id, { id: orgId, keyId: billed.id });
    expect(again.statusCode).toBe(200);
    expect(recordAdminActionFromRequest).toHaveBeenCalledTimes(1);
    expect(notifyApiKeyOrgRevoke).toHaveBeenCalledTimes(1);

    const listed = await call<IOrgMemberApiKeyView[]>(listHandler, 'GET', owner.id, { id: orgId });
    expect(listed.data[0]).toMatchObject({ status: ApiKeyStatus.DISABLED, revokedAt: expect.any(String) });
  });

  it('leaves the key live when the audit write fails', async () => {
    const { owner, holder, orgId } = await seedOrg();
    const billed = await mintKey(holder.id, 'Kept', { organizationId: orgId });
    recordAdminActionFromRequest.mockRejectedValueOnce(new Error('audit store down'));

    await expect(call(revokeHandler, 'POST', owner.id, { id: orgId, keyId: billed.id })).rejects.toThrow(
      'audit store down'
    );
    const validation = await userApiKeyService.validateUserApiKey(billed.key, {
      db: { userApiKeys: userApiKeyRepository },
    });
    expect(validation.isValid).toBe(true);
    expect(notifyApiKeyOrgRevoke).not.toHaveBeenCalled();
  });

  it('emails nobody when a manager revokes their own org-billed key', async () => {
    const { manager, orgId } = await seedOrg();
    const own = await mintKey(manager.id, 'Mine', { organizationId: orgId });
    const revoked = await call(revokeHandler, 'POST', manager.id, { id: orgId, keyId: own.id });
    expect(revoked.statusCode).toBe(200);
    expect(recordAdminActionFromRequest).toHaveBeenCalledTimes(1);
    expect(notifyApiKeyOrgRevoke).not.toHaveBeenCalled();
  });

  it('refuses a plain member, another org, an org-owned key and a malformed id with 404', async () => {
    const { manager, holder, member, otherOwner, orgId, otherOrgId } = await seedOrg();
    const billed = await mintKey(holder.id, 'Billed', { organizationId: orgId });
    const elsewhere = await mintKey(holder.id, 'Elsewhere', { organizationId: otherOrgId });
    const orgOwned = await mintKey(manager.id, 'Org-owned', {
      organizationId: orgId,
      orgOwned: { createdByUserId: manager.id },
    });

    const statusOf = async (userId: string, id: string, keyId: string) =>
      (await call(revokeHandler, 'POST', userId, { id, keyId })).statusCode;
    expect(await statusOf(member.id, orgId, billed.id)).toBe(404);
    expect(await statusOf(otherOwner.id, orgId, billed.id)).toBe(404);
    expect(await statusOf(manager.id, orgId, elsewhere.id)).toBe(404);
    expect(await statusOf(manager.id, orgId, orgOwned.id)).toBe(404);
    expect(await statusOf(manager.id, orgId, 'not-an-id')).toBe(404);
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
    expect((await userApiKeyRepository.findById(billed.id))?.status).toBe(ApiKeyStatus.ACTIVE);
  });
});
