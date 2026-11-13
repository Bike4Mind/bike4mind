// @vitest-environment node
/**
 * POST /api/organizations/[id]/api-keys/[keyId]/callback-secret against a real replica set: an org
 * admin gets the plaintext once, the stored secret is the one generation callbacks are signed with,
 * and the audit row never carries it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ApiKeyScope, Permission, type IOrgApiKeySecretResponse } from '@bike4mind/common';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';
import { Organization, User } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';

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
vi.mock('@bike4mind/server-utils/utils/apiKeyAccessGate', () => ({
  assertApiKeyAccessAllowed: vi.fn().mockResolvedValue(undefined),
}));

const { default: listHandler } = await import('@pages/api/organizations/[id]/api-keys/index');
const { default: revokeHandler } = await import('@pages/api/organizations/[id]/api-keys/[keyId]/revoke');
const { default: secretHandler } = await import('@pages/api/organizations/[id]/api-keys/[keyId]/callback-secret');

type Route = { routes: Record<string, (req: unknown, res: unknown) => Promise<unknown>> };
type SecretResponse = { id: string; name: string; callbackSigningSecret: string };
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

const newUser = (name: string, extra: Record<string, unknown> = {}) =>
  User.create({
    name,
    username: `${name}-${new mongoose.Types.ObjectId()}`,
    password: null,
    hasUsablePassword: false,
    ...extra,
  });

async function call<T>(
  route: unknown,
  userId: string,
  query: Record<string, string>
): Promise<{ statusCode: number; data: T; headers: Record<string, unknown> }> {
  const { req, res } = createMocks({ method: 'POST', query, body: {} });
  Object.assign(req, { user: await User.findById(userId), logger });
  try {
    await (route as Route).routes.POST!(req, res);
  } catch (err) {
    const { statusCode } = err as { statusCode?: number };
    if (statusCode === undefined) throw err;
    return { statusCode, data: undefined as T, headers: {} };
  }
  return { statusCode: res._getStatusCode(), data: res._getJSONData() as T, headers: res._getHeaders() };
}

async function seedOrgWithKey() {
  const [owner, manager, member] = await Promise.all([newUser('owner'), newUser('manager'), newUser('member')]);
  const org = await Organization.create({
    name: 'Acme',
    userId: owner.id,
    seats: 5,
    adminUserIds: [manager.id],
    users: [
      { userId: manager.id, permissions: [Permission.read, Permission.update] },
      { userId: member.id, permissions: [Permission.read] },
    ],
  });
  const orgId = String(org._id);
  const { req, res } = createMocks({
    method: 'POST',
    query: { id: orgId },
    body: { name: 'Webhook service', scopes: [ApiKeyScope.AI_GENERATE] },
  });
  Object.assign(req, { user: await User.findById(owner.id), logger });
  await (listHandler as unknown as Route).routes.POST!(req, res);
  const keyId = (res._getJSONData() as IOrgApiKeySecretResponse).apiKey.id;
  return { owner, manager, member, orgId, keyId };
}

describe('POST /api/organizations/[id]/api-keys/[keyId]/callback-secret', () => {
  it('accepts a session only, never an API key', () => {
    expect(baseApiOptions).toContainEqual({ auth: 'jwtOnly' });
    expect(baseApiOptions.every(options => (options as { auth?: string }).auth === 'jwtOnly')).toBe(true);
  });

  it('hands the owner and a manager the plaintext once; the stored secret is the latest one', async () => {
    const { owner, manager, orgId, keyId } = await seedOrgWithKey();

    const first = await call<SecretResponse>(secretHandler, owner.id, { id: orgId, keyId });
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.data).toMatchObject({ id: keyId, name: 'Webhook service' });
    expect(first.data.callbackSigningSecret).toMatch(/^whsec_/);
    expect((await userApiKeyRepository.findCallbackSigningSecret(keyId))?.secret).toBe(
      first.data.callbackSigningSecret
    );

    const second = await call<SecretResponse>(secretHandler, manager.id, { id: orgId, keyId });
    expect(second.statusCode).toBe(200);
    expect(second.data.callbackSigningSecret).not.toBe(first.data.callbackSigningSecret);
    expect((await userApiKeyRepository.findCallbackSigningSecret(keyId))?.secret).toBe(
      second.data.callbackSigningSecret
    );

    expect(recordAdminActionFromRequest).toHaveBeenCalledTimes(2);
    const [, audit] = recordAdminActionFromRequest.mock.calls[0];
    expect(audit).toMatchObject({
      action: 'org.api_key.callback_secret_rotated',
      actorScope: 'organization',
      target: { kind: 'organization', id: orgId },
      details: { keyId },
    });
    expect(JSON.stringify(audit)).not.toContain(first.data.callbackSigningSecret);
  });

  it("refuses a plain member and another org's admin, without minting", async () => {
    const { member, orgId, keyId } = await seedOrgWithKey();
    const other = await seedOrgWithKey();

    expect((await call(secretHandler, member.id, { id: orgId, keyId })).statusCode).toBe(404);
    expect((await call(secretHandler, other.owner.id, { id: orgId, keyId })).statusCode).toBe(404);
    // Naming this org's key under the org the caller does administer does not reach it either.
    expect((await call(secretHandler, other.owner.id, { id: other.orgId, keyId })).statusCode).toBe(404);

    expect(await userApiKeyRepository.findCallbackSigningSecret(keyId)).toBeNull();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('refuses a revoked key', async () => {
    const { owner, orgId, keyId } = await seedOrgWithKey();
    expect((await call(revokeHandler, owner.id, { id: orgId, keyId })).statusCode).toBe(200);
    recordAdminActionFromRequest.mockClear();

    expect((await call(secretHandler, owner.id, { id: orgId, keyId })).statusCode).toBe(400);
    expect(await userApiKeyRepository.findCallbackSigningSecret(keyId)).toBeNull();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('commits no secret when the audit row cannot be written', async () => {
    const { owner, orgId, keyId } = await seedOrgWithKey();
    recordAdminActionFromRequest.mockRejectedValueOnce(new Error('audit down'));

    await expect(call(secretHandler, owner.id, { id: orgId, keyId })).rejects.toThrow('audit down');
    expect(await userApiKeyRepository.findCallbackSigningSecret(keyId)).toBeNull();
  });
});
