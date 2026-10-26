// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';
import { UserApiKey } from '@bike4mind/database/auth';

/**
 * A contributed scope end to end: a literal in the generated module's shape feeds the real merged
 * catalog, the real mint route screens against it through the real access resolver, the real
 * createUserApiKey validates with the route's predicate, the key is saved through the real model,
 * and the minted key is then presented to the real apiKeyAuth gate. The request plumbing,
 * analytics and the minting user's entitlement lookup are stubbed.
 */

const mockRefs = vi.hoisted(() => ({ postHandler: null as null | ((req: any, res: any) => unknown) }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    get: () => chain,
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/utils/analyticsLog', () => ({ logEventSafe: vi.fn().mockResolvedValue(undefined) }));
const scopeAccess = vi.hoisted(() => ({ entitlements: new Set<string>() }));
vi.mock('@server/entitlements', () => ({
  getUserEntitlements: vi.fn(async () => [...scopeAccess.entitlements]),
  getRequestEntitlements: vi.fn(async () => [...scopeAccess.entitlements]),
}));

vi.mock('@client/app/premium-generated/premiumApiKeyScopes.generated', () => ({
  premiumApiKeyScopes: [
    {
      value: 'acme:read',
      label: 'Acme: Read',
      description: 'Read Acme records',
      endpoints: ['GET /api/acme'],
      requiredEntitlement: 'acme:pro',
    },
  ],
}));

import '@pages/api/user-api-keys/index';
import { apiKeyAuth } from '@server/middlewares/apiKeyAuth';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

afterEach(async () => {
  scopeAccess.entitlements = new Set();
  await mongoose.connection.dropDatabase();
});

function post(body: unknown) {
  const userId = new mongoose.Types.ObjectId().toString();
  const { req, res } = createMocks({ method: 'POST', body });
  // Scope tests start from a verified, trusted account so the trust gate stays real.
  (req as any).user = { id: userId, isAdmin: false, emailVerified: true, apiKeyTrustApproved: true };
  (req as any).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { req, res, userId };
}

describe('contributed API-key scope, end to end', () => {
  it('mints and stores a contributed scope for a user holding its entitlement', async () => {
    scopeAccess.entitlements = new Set(['acme:pro']);
    const { req, res, userId } = post({ name: 'acme key', scopes: ['acme:read', 'notebooks:read'] });

    await mockRefs.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(201);
    const stored = await UserApiKey.find({ userId }).lean();
    expect(stored).toHaveLength(1);
    expect(stored[0].scopes).toEqual(['acme:read', 'notebooks:read']);
  });

  it('refuses the contributed scope without its entitlement and stores nothing', async () => {
    const { req, res, userId } = post({ name: 'acme key', scopes: ['acme:read'] });
    await expect(mockRefs.postHandler!(req, res)).rejects.toMatchObject({ statusCode: 403 });
    expect(await UserApiKey.countDocuments({ userId })).toBe(0);
  });

  it('refuses an unknown scope of the same shape at the route allowlist', async () => {
    scopeAccess.entitlements = new Set(['acme:pro']);
    const { req, res, userId } = post({ name: 'acme key', scopes: ['acme:write'] });
    await expect(mockRefs.postHandler!(req, res)).rejects.toMatchObject({ statusCode: 400 });
    expect(await UserApiKey.countDocuments({ userId })).toBe(0);
  });

  it.each([[[]], ['acme:read']])('leaves %j to the service, which refuses it', async scopes => {
    scopeAccess.entitlements = new Set(['acme:pro']);
    const { req, res, userId } = post({ name: 'acme key', scopes });
    await expect(mockRefs.postHandler!(req, res)).rejects.toMatchObject({ statusCode: 422 });
    expect(await UserApiKey.countDocuments({ userId })).toBe(0);
  });

  describe('the minted key at the real apiKeyAuth gate', () => {
    async function mintAcmeKey(): Promise<string> {
      scopeAccess.entitlements = new Set(['acme:pro']);
      const { req, res } = post({ name: 'acme key', scopes: ['acme:read'] });
      await mockRefs.postHandler!(req, res);
      expect(res._getStatusCode()).toBe(201);
      return res._getJSONData().key;
    }

    function present(key: string) {
      const { req, res } = createMocks({ method: 'GET', url: '/api/acme', headers: { 'x-api-key': key } });
      (req as any).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      return { req, res, next: vi.fn() };
    }

    // The key's owner has no User row here, so a key that clears the scope gate stops at the
    // owner lookup that follows it; a scope miss stops before that lookup with a 403.
    it('clears the scope gate on a route requiring the contributed scope', async () => {
      const { req, res, next } = present(await mintAcmeKey());
      await expect(apiKeyAuth(['acme:read'])(req as any, res as any, next)).rejects.toMatchObject({
        statusCode: 401,
        message: 'User not found or banned',
      });
    });

    it('is refused by the scope gate on a route requiring a different scope', async () => {
      const { req, res, next } = present(await mintAcmeKey());
      await expect(apiKeyAuth(['notebooks:read'])(req as any, res as any, next)).rejects.toMatchObject({
        statusCode: 403,
        message: 'Insufficient API key permissions',
      });
      expect(next).not.toHaveBeenCalled();
    });
  });
});
