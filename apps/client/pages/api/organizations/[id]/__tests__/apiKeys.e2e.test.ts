// @vitest-environment node
/**
 * Org-owned API keys end to end against a real replica set: the org routes mint, list, rotate and
 * revoke (each mutation committing with its audit row), and the key is then checked the way apiKeyAuth
 * and the org-billing rule check it (validate the secret, load its holder, resolve the billing org).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  ApiKeyScope,
  CreditHolderType,
  Permission,
  isOrgServiceAccountOf,
  organizationSeatUsage,
  type IOrgApiKeySecretResponse,
  type IOrgApiKeyView,
} from '@bike4mind/common';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';
import {
  Organization,
  Project,
  User,
  dataLakeAccessGrantRepository,
  dataLakeRepository,
  projectRepository,
  realtimeConnectionRepository,
} from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { userApiKeyRepository, userRepository } from '@bike4mind/database/auth';
import { groupRepository } from '@bike4mind/database/social';
import { lakeConfigAuditDb } from '@bike4mind/server-utils/dataLakes/lakeConfigAuditDb';
import { assertAccountStateUsable } from '@bike4mind/server-utils/auth/assertAccountStateUsable';
import { GATED_API_KEY_SCOPES } from '@bike4mind/server-utils/app/constants/apiKeyScopes';
import { organizationService, userApiKeyService } from '@bike4mind/services';

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
// The paid-only switch has its own suite; here it always admits.
vi.mock('@bike4mind/server-utils/utils/apiKeyAccessGate', () => ({
  assertApiKeyAccessAllowed: vi.fn().mockResolvedValue(undefined),
}));

const { default: listHandler } = await import('@pages/api/organizations/[id]/api-keys/index');
const { default: rotateHandler } = await import('@pages/api/organizations/[id]/api-keys/[keyId]/rotate');
const { default: revokeHandler } = await import('@pages/api/organizations/[id]/api-keys/[keyId]/revoke');
const { resolveApiKeyBillingOrg } = await import('@server/billing/apiKeyBillingOrg');

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
  // createMocks drops a falsy body; a bodyless POST reaches the handler as ''.
  Object.assign(req, { user: await User.findById(userId), logger, ...(body === '' ? { body } : {}) });
  try {
    await (route as Route).routes[method]!(req, res);
  } catch (err) {
    const { statusCode } = err as { statusCode?: number };
    if (statusCode === undefined) throw err;
    return { statusCode, data: undefined as T };
  }
  return { statusCode: res._getStatusCode(), data: res._getJSONData() as T };
}

/** Owner, plus a manager who creates the keys and a plain member, each holding a seat. */
async function seedOrg() {
  const [owner, creator, member] = await Promise.all([newUser('owner'), newUser('creator'), newUser('member')]);
  const org = await Organization.create({
    name: 'Acme',
    userId: owner.id,
    seats: 5,
    adminUserIds: [creator.id],
    users: [
      { userId: creator.id, permissions: [Permission.read, Permission.update] },
      { userId: member.id, permissions: [Permission.read] },
    ],
  });
  return { owner, creator, member, orgId: String(org._id) };
}

/** What apiKeyAuth does with a presented secret, plus the org-billing rule every metered route applies. */
async function authenticate(key: string, orgId: string) {
  const validation = await userApiKeyService.validateUserApiKey(key, { db: { userApiKeys: userApiKeyRepository } });
  if (!validation.isValid) return { ok: false as const, reason: validation.reason };
  const holder = await User.findById(validation.userId);
  if (!holder) return { ok: false as const, reason: 'ownerNotFound' };
  assertAccountStateUsable(holder);
  const billing = await resolveApiKeyBillingOrg({
    apiKeyInfo: { billingOwnerType: validation.billingOwnerType, organizationId: validation.organizationId },
    user: holder,
    requestedOrgId: undefined,
  });
  expect(validation.organizationId).toBe(orgId);
  return { ok: true as const, holder, billing };
}

const departureAdapters = {
  db: {
    organizations: organizationRepository,
    users: userRepository,
    userApiKeys: userApiKeyRepository,
    groups: groupRepository,
    dataLakes: dataLakeRepository,
    dataLakeAccessGrants: dataLakeAccessGrantRepository,
    ...lakeConfigAuditDb,
  },
  logger,
};

describe('org-owned API keys', () => {
  it('accept a session only, never an API key', () => {
    expect(baseApiOptions).toEqual([{ auth: 'jwtOnly' }, { auth: 'jwtOnly' }, { auth: 'jwtOnly' }]);
  });

  it('keep working and billing the org after the creator is removed from the org and then deleted', async () => {
    const { owner, creator, orgId } = await seedOrg();

    const created = await call<IOrgApiKeySecretResponse>(
      listHandler,
      'POST',
      creator.id,
      { id: orgId },
      { name: 'Reporting service', scopes: [ApiKeyScope.AI_CHAT] }
    );
    expect(created.statusCode).toBe(201);
    expect(created.data.apiKey.createdBy).toEqual({ id: creator.id, name: 'creator' });
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'org.api_key.created', actorScope: 'organization' })
    );

    // The holder is the org's service account: off the roster, so no seat and not a listed member.
    const before = await authenticate(created.data.key, orgId);
    expect(before.ok && isOrgServiceAccountOf(before.holder, orgId)).toBe(true);
    expect(before.ok && before.holder.isSystem).toBe(true);
    expect(before.ok && before.billing).toEqual({ kind: 'org', organizationId: orgId });
    const org = await organizationRepository.findById(orgId);
    expect(organizationSeatUsage(org!).used).toBe(3);
    // Recorded so the per-member credit cap can exempt it (creditService/memberCreditCap.ts).
    expect(before.ok && org!.serviceAccountUserId).toBe(before.ok ? before.holder.id : undefined);

    // Contrast: a personal org-billed key minted by the same creator, the pre-existing kind.
    const personal = await userApiKeyService.createUserApiKey(
      creator.id,
      {
        name: 'Personal org-billed',
        scopes: [ApiKeyScope.AI_CHAT],
        metadata: { createdFrom: 'dashboard' },
        billingOwnerType: CreditHolderType.Organization,
        organizationId: orgId,
      },
      { db: { userApiKeys: userApiKeyRepository, agents: { findById: async () => null } } }
    );

    await organizationService.revokeAccess(owner, { id: orgId, userId: creator.id }, departureAdapters);

    const afterRemoval = await authenticate(created.data.key, orgId);
    expect(afterRemoval.ok && afterRemoval.billing).toEqual({ kind: 'org', organizationId: orgId });
    const personalAfterRemoval = await authenticate(personal.key, orgId);
    expect(personalAfterRemoval).toEqual({ ok: false, reason: 'not_found' });
    expect(await userApiKeyRepository.findById(personal.id)).toMatchObject({
      revokedBy: owner.id,
      revokedReason: 'org-membership-ended',
    });

    await User.deleteOne({ _id: creator.id });

    const afterDeletion = await authenticate(created.data.key, orgId);
    expect(afterDeletion.ok && afterDeletion.billing).toEqual({ kind: 'org', organizationId: orgId });

    // The owner still manages it, and the list still names the (now deleted) creator by id.
    const listed = await call<IOrgApiKeyView[]>(listHandler, 'GET', owner.id, { id: orgId });
    expect(listed.data).toEqual([
      expect.objectContaining({ id: created.data.apiKey.id, createdBy: { id: creator.id, name: null } }),
    ]);
    // Validation stamps lastUsedAt without awaiting it, so poll for the write.
    await vi.waitFor(async () => {
      const relisted = await call<IOrgApiKeyView[]>(listHandler, 'GET', owner.id, { id: orgId });
      expect(relisted.data[0].lastUsedAt).toBeTruthy();
    });
    await userApiKeyRepository.incrementSpend(created.data.apiKey.id, 7.25);
    const charged = await call<IOrgApiKeyView[]>(listHandler, 'GET', owner.id, { id: orgId });
    expect(charged.data[0].creditsUsed).toBe(7.25);
  });

  it('rotates without handing the key to the rotating admin, and refuses a revoked key', async () => {
    const { owner, creator, orgId } = await seedOrg();
    const created = await call<IOrgApiKeySecretResponse>(
      listHandler,
      'POST',
      creator.id,
      { id: orgId },
      { name: 'Svc', scopes: [ApiKeyScope.AI_CHAT] }
    );
    const keyId = created.data.apiKey.id;

    const rotated = await call<IOrgApiKeySecretResponse>(rotateHandler, 'POST', owner.id, { id: orgId, keyId });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.data.key).not.toBe(created.data.key);
    expect((await authenticate(created.data.key, orgId)).ok).toBe(false);
    const afterRotate = await authenticate(rotated.data.key, orgId);
    expect(afterRotate.ok && isOrgServiceAccountOf(afterRotate.holder, orgId)).toBe(true);

    // Only the org routes manage an org-owned key: the generic services behind the personal routes,
    // which an org admin also reaches, treat it as not found.
    const genericAdapters = {
      db: {
        userApiKeys: userApiKeyRepository,
        organizations: organizationRepository,
        realtimeConnections: realtimeConnectionRepository,
      },
    };
    await expect(userApiKeyService.rotateUserApiKey(owner.id, { keyId }, genericAdapters)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(userApiKeyService.revokeUserApiKey(owner.id, { keyId }, genericAdapters)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect((await authenticate(rotated.data.key, orgId)).ok).toBe(true);

    const revoked = await call(revokeHandler, 'POST', owner.id, { id: orgId, keyId }, {});
    expect(revoked.statusCode).toBe(200);
    expect(await authenticate(rotated.data.key, orgId)).toEqual({ ok: false, reason: expect.any(String) });
    const stored = await userApiKeyRepository.findById(keyId);
    expect(stored?.revokedBy).toBe(owner.id);
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'org.api_key.revoked' })
    );

    // A revoked key cannot be rotated back to life, and revoking it again is a no-op; neither audits.
    recordAdminActionFromRequest.mockClear();
    expect((await call(rotateHandler, 'POST', owner.id, { id: orgId, keyId })).statusCode).toBe(400);
    expect((await call(revokeHandler, 'POST', owner.id, { id: orgId, keyId }, {})).statusCode).toBe(200);
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('revokes on a bodyless POST that arrives as an empty string', async () => {
    const { owner, creator, orgId } = await seedOrg();
    const created = await call<IOrgApiKeySecretResponse>(
      listHandler,
      'POST',
      creator.id,
      { id: orgId },
      { name: 'Svc', scopes: [ApiKeyScope.AI_CHAT] }
    );
    const keyId = created.data.apiKey.id;

    expect((await call(revokeHandler, 'POST', owner.id, { id: orgId, keyId }, '')).statusCode).toBe(200);
    expect((await authenticate(created.data.key, orgId)).ok).toBe(false);
    expect((await userApiKeyRepository.findById(keyId))?.revokedBy).toBe(owner.id);
  });

  it('refuses to rotate an expired key, without an audit row', async () => {
    const { owner, creator, orgId } = await seedOrg();
    const created = await call<IOrgApiKeySecretResponse>(
      listHandler,
      'POST',
      creator.id,
      { id: orgId },
      { name: 'Svc', scopes: [ApiKeyScope.AI_CHAT] }
    );
    const keyId = created.data.apiKey.id;
    await userApiKeyRepository.update({ id: keyId, expiresAt: new Date(Date.now() - 1000) });
    recordAdminActionFromRequest.mockClear();

    expect((await call(rotateHandler, 'POST', owner.id, { id: orgId, keyId })).statusCode).toBe(400);
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('commits nothing when the audit row cannot be written', async () => {
    const { owner, creator, orgId } = await seedOrg();
    const created = await call<IOrgApiKeySecretResponse>(
      listHandler,
      'POST',
      creator.id,
      { id: orgId },
      { name: 'Svc', scopes: [ApiKeyScope.AI_CHAT] }
    );
    const keyId = created.data.apiKey.id;
    const auditDown = () => recordAdminActionFromRequest.mockRejectedValueOnce(new Error('audit store down'));

    auditDown();
    await expect(
      call(listHandler, 'POST', creator.id, { id: orgId }, { name: 'Lost', scopes: [ApiKeyScope.AI_CHAT] })
    ).rejects.toThrow('audit store down');
    expect((await call<IOrgApiKeyView[]>(listHandler, 'GET', owner.id, { id: orgId })).data).toHaveLength(1);

    auditDown();
    await expect(call(rotateHandler, 'POST', owner.id, { id: orgId, keyId })).rejects.toThrow('audit store down');
    expect((await authenticate(created.data.key, orgId)).ok).toBe(true);

    auditDown();
    await expect(call(revokeHandler, 'POST', owner.id, { id: orgId, keyId }, {})).rejects.toThrow('audit store down');
    expect((await authenticate(created.data.key, orgId)).ok).toBe(true);
  });

  it('refuses a member who does not administer the org, and another org admin', async () => {
    const { creator, member, orgId } = await seedOrg();
    const other = await seedOrg();
    const created = await call<IOrgApiKeySecretResponse>(
      listHandler,
      'POST',
      creator.id,
      { id: orgId },
      { name: 'Svc', scopes: [ApiKeyScope.AI_CHAT] }
    );
    const keyId = created.data.apiKey.id;
    // Give the other org a service account and key of its own, so a refusal below can only come from
    // the key lookup, not from that org having no service account to resolve.
    const otherKey = await call(
      listHandler,
      'POST',
      other.creator.id,
      { id: other.orgId },
      { name: 'Other svc', scopes: [ApiKeyScope.AI_CHAT] }
    );
    expect(otherKey.statusCode).toBe(201);

    for (const userId of [member.id, other.creator.id]) {
      expect((await call(listHandler, 'GET', userId, { id: orgId })).statusCode).toBe(404);
      expect(
        (await call(listHandler, 'POST', userId, { id: orgId }, { name: 'x', scopes: [ApiKeyScope.AI_CHAT] }))
          .statusCode
      ).toBe(404);
      expect((await call(rotateHandler, 'POST', userId, { id: orgId, keyId })).statusCode).toBe(404);
      expect((await call(revokeHandler, 'POST', userId, { id: orgId, keyId }, {})).statusCode).toBe(404);
    }
    // Naming the key under an org the caller does administer does not reach it either.
    expect((await call(revokeHandler, 'POST', other.creator.id, { id: other.orgId, keyId }, {})).statusCode).toBe(404);
    expect((await authenticate(created.data.key, orgId)).ok).toBe(true);
  });

  // Gated on the holder's entitlement at use, and the service account holds none.
  const [gatedScope] = Object.keys(GATED_API_KEY_SCOPES);

  it('has an entitlement-gated scope to refuse', () => {
    expect(gatedScope).toBeDefined();
  });

  it.each([
    ['a dedicated-flow scope', ApiKeyScope.EMBED_CHAT],
    ['an entitlement-gated scope', gatedScope],
  ])('refuses %s', async (_label, scope) => {
    const { creator, orgId } = await seedOrg();
    const refused = await call(listHandler, 'POST', creator.id, { id: orgId }, { name: 'Svc', scopes: [scope] });
    expect(refused.statusCode).toBe(400);
  });

  it("acts as the service account, which reaches none of a member's own resources", async () => {
    const { creator, orgId } = await seedOrg();
    await Project.create({ name: 'Creator private', userId: creator.id, sessionIds: [], fileIds: [] });
    const created = await call<IOrgApiKeySecretResponse>(
      listHandler,
      'POST',
      creator.id,
      { id: orgId },
      { name: 'Svc', scopes: [ApiKeyScope.AI_CHAT] }
    );
    const auth = await authenticate(created.data.key, orgId);
    if (!auth.ok) throw new Error('expected a valid key');

    const creatorView = await projectRepository.listAccessibleAfterId(creator, { limit: 10 });
    expect(creatorView.data).toHaveLength(1);
    const keyView = await projectRepository.listAccessibleAfterId(auth.holder, { limit: 10 });
    expect(keyView.data).toEqual([]);
  });

  it('bills a different org only as a mismatch, never silently', async () => {
    const { creator, orgId } = await seedOrg();
    const created = await call<IOrgApiKeySecretResponse>(
      listHandler,
      'POST',
      creator.id,
      { id: orgId },
      { name: 'Svc', scopes: [ApiKeyScope.AI_CHAT] }
    );
    const auth = await authenticate(created.data.key, orgId);
    if (!auth.ok) throw new Error('expected a valid key');
    const other = await seedOrg();
    const billing = await resolveApiKeyBillingOrg({
      apiKeyInfo: { billingOwnerType: CreditHolderType.Organization, organizationId: orgId },
      user: auth.holder,
      requestedOrgId: other.orgId,
    });
    expect(billing.kind).toBe('mismatch');
  });
});
