// @vitest-environment node
/**
 * Changing an org-owned key's access in place (PATCH /api/organizations/:id/api-keys/:keyId) and the
 * picker options it is chosen from (GET .../api-keys/options), against a real replica set. Scopes are
 * judged on the org's entitlement, grants must name this org or one of its live groups, and a real
 * change commits with its org.api_key.access_updated audit row. Same harness as apiKeys.e2e.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  ApiKeyScope,
  ApiKeyStatus,
  Permission,
  type IOrgApiKeySecretResponse,
  type IOrgApiKeyView,
  type OrgApiKeyGrant,
} from '@bike4mind/common';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';
import { Group, Organization, User } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { GATED_API_KEY_SCOPES, type ApiKeyScopeAccess } from '@bike4mind/server-utils/app/constants/apiKeyScopes';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    type Handler = (req: unknown, res: unknown) => unknown;
    const routes: Record<string, Handler> = {};
    const chain = {
      routes,
      get: (handler: Handler) => ((routes.GET = handler), chain),
      post: (handler: Handler) => ((routes.POST = handler), chain),
      patch: (handler: Handler) => ((routes.PATCH = handler), chain),
    };
    return chain;
  },
}));
const recordAdminActionFromRequest = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest }));
vi.mock('@bike4mind/server-utils/utils/apiKeyAccessGate', () => ({
  assertApiKeyAccessAllowed: vi.fn().mockResolvedValue(undefined),
}));
// The org's product access, real by default; a test grants an entitlement by overriding it once.
const resolveOrgScopeAccess = vi.hoisted(() => vi.fn());
vi.mock('@server/entitlements/apiKeyScopeAccess', async orig => {
  const actual = await orig<typeof import('@server/entitlements/apiKeyScopeAccess')>();
  resolveOrgScopeAccess.mockImplementation(actual.resolveApiKeyScopeAccessForOrganization);
  return { ...actual, resolveApiKeyScopeAccessForOrganization: resolveOrgScopeAccess };
});

const { default: createHandler } = await import('@pages/api/organizations/[id]/api-keys/index');
const { default: updateHandler } = await import('@pages/api/organizations/[id]/api-keys/[keyId]/index');
const { default: optionsHandler } = await import('@pages/api/organizations/[id]/api-keys/options');

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
  method: 'GET' | 'POST' | 'PATCH',
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
  return { statusCode: res._getStatusCode(), data: res._getJSONData() as T };
}

const entitled: ApiKeyScopeAccess = {
  hasOptiAccess: true,
  hasOverwatchAccess: true,
  hearthEnabled: true,
  bypass: false,
  entitlements: new Set<string>(),
};
const [gatedScope] = Object.keys(GATED_API_KEY_SCOPES);

/** Owner, a manager who administers the keys, a plain member, two org groups and a foreign one. */
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
  const orgId = String(org._id);
  const [research, sales, foreign] = await Promise.all([
    Group.create({ name: 'Research', type: 'research', organizationId: orgId }),
    Group.create({ name: 'Sales', type: 'sales', organizationId: orgId }),
    Group.create({ name: 'Elsewhere', type: 'sales', organizationId: String(new mongoose.Types.ObjectId()) }),
  ]);
  return {
    creator,
    member,
    orgId,
    researchId: String(research.id),
    salesId: String(sales.id),
    foreignGroupId: String(foreign.id),
  };
}

const groupGrant = (resourceId: string): OrgApiKeyGrant => ({ resourceType: 'group', resourceId, permission: 'read' });

async function mintKey(creatorId: string, orgId: string, grants: OrgApiKeyGrant[] = []) {
  const created = await call<IOrgApiKeySecretResponse>(
    createHandler,
    'POST',
    creatorId,
    { id: orgId },
    { name: 'Svc', scopes: [ApiKeyScope.AI_CHAT], grants }
  );
  expect(created.statusCode).toBe(201);
  recordAdminActionFromRequest.mockClear();
  return created.data.apiKey;
}

const patch = (userId: string, orgId: string, keyId: string, body: unknown) =>
  call<IOrgApiKeyView>(updateHandler, 'PATCH', userId, { id: orgId, keyId }, body);

const storedKey = async (keyId: string) => (await userApiKeyRepository.findById(keyId))!;

describe('PATCH /api/organizations/:id/api-keys/:keyId', () => {
  it('changes scopes and grants in place and audits both before and after', async () => {
    const { creator, orgId, researchId, salesId } = await seedOrg();
    const key = await mintKey(creator.id, orgId, [groupGrant(researchId)]);

    const updated = await patch(creator.id, orgId, key.id, {
      scopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.READ_PROJECTS],
      grants: [groupGrant(salesId), groupGrant(salesId)],
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.data.scopes).toEqual([ApiKeyScope.AI_CHAT, ApiKeyScope.READ_PROJECTS]);
    expect(updated.data.grants).toEqual([groupGrant(salesId)]);
    const stored = await storedKey(key.id);
    expect(stored.orgOwned?.grants).toEqual([groupGrant(salesId)]);
    expect(stored.orgOwned?.createdByUserId).toBe(creator.id);

    expect(recordAdminActionFromRequest).toHaveBeenCalledTimes(1);
    const audit = recordAdminActionFromRequest.mock.calls[0]![1] as Record<string, unknown>;
    expect(audit).toMatchObject({
      action: 'org.api_key.access_updated',
      actorScope: 'organization',
      target: { kind: 'organization', id: orgId },
    });
    // JSON round trip: the "before" side is read off the stored key, as Mongoose subdocuments.
    expect(JSON.parse(JSON.stringify(audit.details))).toMatchObject({
      keyId: key.id,
      scopes: { before: [ApiKeyScope.AI_CHAT], after: [ApiKeyScope.AI_CHAT, ApiKeyScope.READ_PROJECTS] },
      grants: { before: [groupGrant(researchId)], after: [groupGrant(salesId)] },
    });
  });

  it('audits only the part that changed', async () => {
    const { creator, orgId, researchId } = await seedOrg();
    const key = await mintKey(creator.id, orgId);

    expect((await patch(creator.id, orgId, key.id, { grants: [groupGrant(researchId)] })).statusCode).toBe(200);

    const details = recordAdminActionFromRequest.mock.calls[0]![1].details as Record<string, unknown>;
    expect(JSON.parse(JSON.stringify(details.grants))).toEqual({ before: [], after: [groupGrant(researchId)] });
    expect(details).not.toHaveProperty('scopes');
  });

  it('records nothing when nothing changed (same set, any order)', async () => {
    const { creator, orgId, researchId, salesId } = await seedOrg();
    const key = await mintKey(creator.id, orgId, [groupGrant(researchId), groupGrant(salesId)]);

    const same = await patch(creator.id, orgId, key.id, {
      scopes: [ApiKeyScope.AI_CHAT],
      grants: [groupGrant(salesId), groupGrant(researchId)],
    });

    expect(same.statusCode).toBe(200);
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('refuses a gated scope the org is not entitled to (403) and changes nothing', async () => {
    const { creator, orgId } = await seedOrg();
    const key = await mintKey(creator.id, orgId);

    expect((await patch(creator.id, orgId, key.id, { scopes: [gatedScope] })).statusCode).toBe(403);
    expect((await storedKey(key.id)).scopes).toEqual([ApiKeyScope.AI_CHAT]);
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('accepts a gated scope once the org is entitled to it', async () => {
    const { creator, orgId } = await seedOrg();
    const key = await mintKey(creator.id, orgId);
    resolveOrgScopeAccess.mockResolvedValueOnce(entitled);

    const updated = await patch(creator.id, orgId, key.id, { scopes: [gatedScope] });

    expect(updated.statusCode).toBe(200);
    expect((await storedKey(key.id)).scopes).toEqual([gatedScope]);
    expect(resolveOrgScopeAccess).toHaveBeenCalledWith(orgId);
  });

  it('rolls the change back when its audit row cannot be written', async () => {
    const { creator, orgId, researchId, salesId } = await seedOrg();
    const key = await mintKey(creator.id, orgId, [groupGrant(researchId)]);
    recordAdminActionFromRequest.mockRejectedValueOnce(new Error('audit down'));

    await expect(
      patch(creator.id, orgId, key.id, {
        scopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.READ_PROJECTS],
        grants: [groupGrant(salesId)],
      })
    ).rejects.toThrow('audit down');

    const stored = await storedKey(key.id);
    expect(stored.scopes).toEqual([ApiKeyScope.AI_CHAT]);
    expect(stored.orgOwned?.grants.map(({ resourceId }) => resourceId)).toEqual([researchId]);
  });

  it('refuses a key that is no longer live: disabled or past its expiry (400)', async () => {
    const { creator, orgId, researchId } = await seedOrg();
    const disabled = await mintKey(creator.id, orgId);
    const expired = await mintKey(creator.id, orgId);
    await userApiKeyRepository.update({ id: disabled.id, status: ApiKeyStatus.DISABLED });
    await userApiKeyRepository.update({ id: expired.id, expiresAt: new Date(Date.now() - 60_000) });

    expect((await patch(creator.id, orgId, disabled.id, { grants: [groupGrant(researchId)] })).statusCode).toBe(400);
    expect((await patch(creator.id, orgId, expired.id, { grants: [groupGrant(researchId)] })).statusCode).toBe(400);
    expect((await storedKey(expired.id)).orgOwned?.grants ?? []).toHaveLength(0);
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('drops a held grant whose group was deleted, without blocking the rest of the edit', async () => {
    const { creator, orgId, researchId, salesId } = await seedOrg();
    const key = await mintKey(creator.id, orgId, [groupGrant(researchId), groupGrant(salesId)]);
    await Group.deleteOne({ _id: researchId });

    const updated = await patch(creator.id, orgId, key.id, {
      scopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.READ_PROJECTS],
      grants: [groupGrant(researchId), groupGrant(salesId)],
    });

    expect(updated.statusCode).toBe(200);
    expect((await storedKey(key.id)).orgOwned?.grants.map(({ resourceId }) => resourceId)).toEqual([salesId]);
  });

  it('still refuses a new grant on a deleted group the key did not hold (400)', async () => {
    const { creator, orgId, researchId } = await seedOrg();
    const key = await mintKey(creator.id, orgId);
    await Group.deleteOne({ _id: researchId });

    expect((await patch(creator.id, orgId, key.id, { grants: [groupGrant(researchId)] })).statusCode).toBe(400);
  });

  it('judges only newly added scopes on the plan: a held gated scope survives a grants-only edit', async () => {
    const { creator, orgId, researchId } = await seedOrg();
    const key = await mintKey(creator.id, orgId);
    await userApiKeyRepository.update({ id: key.id, scopes: [ApiKeyScope.AI_CHAT, gatedScope] });

    const kept = await patch(creator.id, orgId, key.id, {
      scopes: [ApiKeyScope.AI_CHAT, gatedScope],
      grants: [groupGrant(researchId)],
    });
    expect(kept.statusCode).toBe(200);
    expect((await storedKey(key.id)).scopes).toEqual([ApiKeyScope.AI_CHAT, gatedScope]);

    const otherGated = Object.keys(GATED_API_KEY_SCOPES)[1]!;
    const added = await patch(creator.id, orgId, key.id, { scopes: [ApiKeyScope.AI_CHAT, gatedScope, otherGated] });
    expect(added.statusCode).toBe(403);
    expect((await storedKey(key.id)).scopes).toEqual([ApiKeyScope.AI_CHAT, gatedScope]);
  });

  it('stores duplicate scopes once', async () => {
    const { creator, orgId } = await seedOrg();
    const key = await mintKey(creator.id, orgId);

    const updated = await patch(creator.id, orgId, key.id, {
      scopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.READ_PROJECTS, ApiKeyScope.READ_PROJECTS],
    });

    expect(updated.statusCode).toBe(200);
    expect((await storedKey(key.id)).scopes).toEqual([ApiKeyScope.AI_CHAT, ApiKeyScope.READ_PROJECTS]);
  });

  it('refuses a grant naming another org or a group outside the org (400)', async () => {
    const { creator, orgId, foreignGroupId } = await seedOrg();
    const key = await mintKey(creator.id, orgId);
    const otherOrg: OrgApiKeyGrant = {
      resourceType: 'organization',
      resourceId: String(new mongoose.Types.ObjectId()),
      permission: 'read',
    };

    expect((await patch(creator.id, orgId, key.id, { grants: [otherOrg] })).statusCode).toBe(400);
    expect((await patch(creator.id, orgId, key.id, { grants: [groupGrant(foreignGroupId)] })).statusCode).toBe(400);
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('refuses an empty body, a write grant and a member who does not administer the org', async () => {
    const { creator, member, orgId, researchId } = await seedOrg();
    const key = await mintKey(creator.id, orgId);

    expect((await patch(creator.id, orgId, key.id, {})).statusCode).toBe(400);
    expect(
      (await patch(creator.id, orgId, key.id, { grants: [{ ...groupGrant(researchId), permission: 'write' }] }))
        .statusCode
    ).toBe(400);
    expect((await patch(member.id, orgId, key.id, { grants: [groupGrant(researchId)] })).statusCode).toBe(404);
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });
});

describe('GET /api/organizations/:id/api-keys/options', () => {
  it("lists the org's live groups and only the scopes the org is offered", async () => {
    const { creator, orgId, researchId, salesId } = await seedOrg();

    const options = await call<{ scopes: string[]; groups: { id: string; name: string }[] }>(
      optionsHandler,
      'GET',
      creator.id,
      { id: orgId }
    );

    expect(options.statusCode).toBe(200);
    expect(options.data.groups.map(group => group.id).sort()).toEqual([researchId, salesId].sort());
    expect(options.data.scopes).toContain(ApiKeyScope.AI_CHAT);
    expect(options.data.scopes).not.toContain(gatedScope);
    expect(options.data.scopes).not.toContain(ApiKeyScope.EMBED_CHAT);
  });

  it('offers a gated scope once the org is entitled to it', async () => {
    const { creator, orgId } = await seedOrg();
    resolveOrgScopeAccess.mockResolvedValueOnce(entitled);

    const options = await call<{ scopes: string[] }>(optionsHandler, 'GET', creator.id, { id: orgId });

    expect(options.data.scopes).toContain(gatedScope);
  });

  it('refuses a member who does not administer the org (404, like the other key routes)', async () => {
    const { member, orgId } = await seedOrg();
    expect((await call(optionsHandler, 'GET', member.id, { id: orgId })).statusCode).toBe(404);
  });
});
